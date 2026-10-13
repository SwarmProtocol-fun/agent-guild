import { describe, it, expect } from "vitest";
import { encodeAbiParameters, encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import {
  DevtoolsInputError, buildCall, coerceArgs, decodeCalldata, decodeRevert, isInsufficientFunds, parseEthAmount, parseFunctionSignature, revertDataOf, revertOutcome, toRaw,
} from "../../../../mods/ethereum/devtools";
import { detectInput } from "../../../../mods/ethereum/networks";

const ALICE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

/** A fake signature DB that knows one selector. */
const sigDb = (map: Record<string, string[]>) =>
  (async (url: string) => {
    const sels = new URL(url).searchParams.get("function")!.split(",");
    const fn = Object.fromEntries(sels.map((s) => [s, (map[s] ?? []).map((name) => ({ name }))]));
    return new Response(JSON.stringify({ ok: true, result: { function: fn } }));
  }) as unknown as typeof fetch;

describe("decodeRevert", () => {
  it("decodes Error(string)", async () => {
    const data = `0x08c379a0${encodeAbiParameters([{ type: "string" }], ["Not enough balance"]).slice(2)}` as const;
    const r = await decodeRevert(data);
    expect(r.kind).toBe("error-string");
    expect(r.message).toBe("Not enough balance");
  });

  it("decodes Panic(uint256) with the reason", async () => {
    const r = await decodeRevert("0x4e487b710000000000000000000000000000000000000000000000000000000000000011");
    expect(r.kind).toBe("panic");
    expect(r.message).toMatch(/overflow/);
  });

  it("explains an empty revert", async () => {
    expect((await decodeRevert("0x")).kind).toBe("empty");
  });

  it("decodes a custom error from the signature DB", async () => {
    const sig = "InsufficientBalance(uint256,uint256)";
    const selector = toFunctionSelector(`function ${sig}`);
    const data = `${selector}${encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [5n, 10n]).slice(2)}` as `0x${string}`;
    const r = await decodeRevert(data, undefined, sigDb({ [selector]: [sig] }));
    expect(r.kind).toBe("custom");
    expect(r.message).toBe("InsufficientBalance(5, 10)");
  });

  it("returns unknown when nothing matches", async () => {
    const r = await decodeRevert("0xdeadbeef", undefined, sigDb({}));
    expect(r.kind).toBe("unknown");
    expect(r.selector).toBe("0xdeadbeef");
  });
});

describe("decodeCalldata", () => {
  const data = encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), args: [ALICE, 1_000_000n] });

  it("decodes with a given signature, no lookup", async () => {
    const out = await decodeCalldata(data, { signature: "transfer(address to, uint256 amount)" }, (() => { throw new Error("no lookup"); }) as never);
    expect(out.functionName).toBe("transfer");
    expect(out.args).toEqual([ALICE, "1000000"]);
  });

  it("skips colliding candidates that don't decode", async () => {
    const out = await decodeCalldata(data, {}, sigDb({ "0xa9059cbb": ["workMyDirefulOwner(uint256,uint256,bytes)", "transfer(address,uint256)"] }));
    expect(out.signature).toBe("transfer(address,uint256)");
  });

  it("rejects data shorter than a selector", async () => {
    await expect(decodeCalldata("0x12", {})).rejects.toBeInstanceOf(DevtoolsInputError);
  });
});

describe("buildCall", () => {
  it("encodes signature + args, with ints as strings", () => {
    const built = buildCall({ to: ALICE.toLowerCase(), signature: "approve(address,uint256) returns (bool)", args: [ALICE, "115792089237316195423570985008687907853269984665640564039457584007913129639935"] });
    expect(built.to).toBe(ALICE);
    expect(built.data.slice(0, 10)).toBe("0x095ea7b3");
    expect(built.value).toBe(0n);
  });

  it("parses ETH value", () => {
    expect(buildCall({ to: ALICE, value: "0.5" }).value).toBe(500_000_000_000_000_000n);
  });

  it("appends encoded constructor args to deploy bytecode", () => {
    const built = buildCall({ bytecode: "0x6080", constructorSignature: "constructor(uint256 supply)", args: ["42"] });
    expect(built.to).toBeUndefined();
    expect(built.data).toBe(`0x6080${(42).toString(16).padStart(64, "0")}`);
  });

  it("rejects ambiguous or malformed specs", () => {
    expect(() => buildCall({ to: ALICE, data: "0x12", signature: "f()" })).toThrow(DevtoolsInputError);
    expect(() => buildCall({ to: "0x123" })).toThrow(/address/);
    expect(() => buildCall({ to: ALICE, bytecode: "0x60" })).toThrow(/deployment has no `to`/);
    expect(() => buildCall({ to: ALICE, value: "-1" })).toThrow(DevtoolsInputError);
    expect(() => buildCall({ to: ALICE, signature: "transfer(address,uint256)", args: [ALICE] })).toThrow(/Expected 2/);
  });
});

describe("parsing helpers", () => {
  it("coerces nested args", () => {
    const fn = parseFunctionSignature("f(uint256[] xs, (address a, uint8 b) t)");
    expect(coerceArgs(fn, [["1", 2], { a: ALICE, b: "3" }])).toEqual([[1n, 2n], { a: ALICE, b: 3n }]);
  });

  it("parses amounts without float error", () => {
    expect(toRaw("1.000001", 6)).toBe(1_000_001n);
    expect(() => toRaw("1.0000001", 6)).toThrow(/decimals/);
    expect(parseEthAmount("")).toBe(0n);
  });

  it("detects command-bar inputs", () => {
    expect(detectInput(`0x${"a".repeat(64)}`)).toBe("tx");
    expect(detectInput(ALICE)).toBe("address");
    expect(detectInput("vitalik.eth")).toBe("ens");
    expect(detectInput("0xa9059cbb")).toBe("data");
    expect(detectInput("hello")).toBeNull();
  });
});

describe("error chains", () => {
  // Shape of viem's CallExecutionError → ExecutionRevertedError → RpcRequestError.
  const chain = (data: unknown, msg = "execution reverted") => ({ shortMessage: "Execution reverted", cause: { name: "ExecutionRevertedError", cause: { name: "RpcRequestError", shortMessage: msg, data } } });

  it("finds revert data deep in the cause chain", () => {
    expect(revertDataOf(chain("0x4e487b710000000000000000000000000000000000000000000000000000000000000011"))).toMatch(/^0x4e487b71/);
  });

  it("treats bare 0x as a reason-less revert, not 'no data'", async () => {
    const data = revertDataOf(chain("0x"));
    expect(data).toBe("0x");
    expect((await decodeRevert(data!)).kind).toBe("empty");
    expect(revertDataOf(chain(undefined))).toBeNull();
  });

  it("recognises a node refusing a call for insufficient funds", () => {
    expect(isInsufficientFunds(chain(undefined, "The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account."))).toBe(true);
    expect(isInsufficientFunds(chain("0x"))).toBe(false);
  });

  // Real chains captured from Sepolia through publicnode (2026-10-12): no `data` anywhere.
  const real = (name: string, details: string) => ({ name: "CallExecutionError", shortMessage: "x", details, cause: { name, details, cause: { name: "RpcRequestError", details } } });

  it("a reason-less revert with no data at all is still a revert", async () => {
    const err = real("ExecutionRevertedError", "execution reverted");
    expect(revertDataOf(err)).toBeNull();
    expect(revertOutcome(err)).toBe("0x");
  });

  it("reth's OutOfFunds is insufficient funds, not a revert", () => {
    const err = real("TransactionRejectedRpcError", "EVM error: OutOfFunds");
    expect(isInsufficientFunds(err)).toBe(true);
    expect(revertOutcome(err)).toBeNull();
  });
});
