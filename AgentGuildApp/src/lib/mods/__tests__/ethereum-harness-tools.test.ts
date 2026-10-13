import { describe, it, expect, vi } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { ethUtil, mappingSlot, parseStateOverride } from "../../../../mods/ethereum/chaintools";
import { compileSolidity, contractAbi, gatherSources, importsOf, packageUrl, parseSources, pickContract, resolveImportPath, verifyOnSourcify } from "../../../../mods/ethereum/solidity";

const A = "0x6ac7ea33f8831ea9dcc53393aaa88b25a785dbf0";

describe("eth_util: exact math with known vectors", () => {
  it("hashes and selectors", () => {
    expect(ethUtil("keccak256", { text: "" }).hash).toBe("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(ethUtil("selector", { signature: "transfer(address,uint256)" })).toMatchObject({ kind: "function", selector: "0xa9059cbb" });
    expect(ethUtil("selector", { signature: "function balanceOf(address owner) view returns (uint256)" }).selector).toBe("0x70a08231");
    expect(ethUtil("selector", { signature: "event Transfer(address indexed from, address indexed to, uint256 value)" }).topic0)
      .toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  });

  it("derives CREATE and CREATE2 addresses", () => {
    expect(ethUtil("create_address", { from: A, nonce: "0" }).address.toLowerCase()).toBe("0xcd234a471b72ba2f1ccf0a70fcaba648a5eecd8d");
    // EIP-1014 example 1.
    expect(ethUtil("create2_address", { from: "0x0000000000000000000000000000000000000000", salt: "0x00", bytecode: "0x00" }).address.toLowerCase())
      .toBe("0x4d1a2e2bb4f88f0250f26ffff098b0b30b26bf38");
  });

  it("encodes, decodes and converts units", () => {
    const { data } = ethUtil("encode", { types: "address, uint256", values: [A, "1000000"] }) as { data: string };
    expect(ethUtil("decode", { types: ["address", "uint256"], data }).values).toEqual([expect.stringMatching(/^0x6ac7/i), "1000000"]);
    expect(ethUtil("encode_packed", { types: ["uint8", "string"], values: ["1", "a"] }).data).toBe("0x0161");
    expect(ethUtil("to_units", { amount: "1.5", decimals: 6 }).raw).toBe("1500000");
    expect(ethUtil("from_units", { raw: "1500000000000000000" }).amount).toBe("1.5");
  });

  it("computes mapping slots, nested ones outermost first", () => {
    const expected = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [A, 9n]));
    expect(mappingSlot("address", A, 9)).toBe(expected);
    const nested = ethUtil("mapping_slot", { slot: "1", keys: [{ type: "address", value: A }, { type: "address", value: A }] }).slot;
    expect(nested).toBe(mappingSlot("address", A, mappingSlot("address", A, 1)));
  });

  it("rejects unknown ops and junk", () => {
    expect(() => ethUtil("nope", {})).toThrow(/op must be one of/);
    expect(() => ethUtil("to_units", { amount: "-1" })).toThrow(/decimal/);
  });

  it("parses state overrides", () => {
    const [o] = parseStateOverride({ [A]: { balance: "100", stateDiff: { "0x1": "5" } } })!;
    expect(o.balance).toBe(100n * 10n ** 18n);
    expect(o.stateDiff![0].slot).toMatch(/^0x0{63}1$/);
    expect(() => parseStateOverride({ [A]: { balance: "lots" } })).toThrow(/decimal/);
  });
});

describe("Solidity compile", () => {
  it("resolves imports and only fetches allowlisted packages", async () => {
    expect(importsOf(`// import "nope.sol";\nimport {A} from "./A.sol";\nimport "@openzeppelin/contracts/x.sol";`)).toEqual(["./A.sol", "@openzeppelin/contracts/x.sol"]);
    expect(importsOf('pragma solidity ^0.8.20; import "./A.sol"; import * as L from "./L.sol";')).toEqual(["./A.sol", "./L.sol"]);
    expect(resolveImportPath("src/b/C.sol", "../A.sol")).toBe("src/A.sol");
    expect(() => resolveImportPath("C.sol", "../../etc/passwd")).toThrow(/above the project root/);
    expect(packageUrl("@openzeppelin/contracts/token/ERC20/ERC20.sol")).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@openzeppelin\/contracts@5\.4\.0\//);
    expect(packageUrl("https://evil.example/x.sol")).toBeNull();
    await expect(gatherSources({ "A.sol": 'import "forge-std/Test.sol";' }, vi.fn() as never)).rejects.toThrow(/isn't in the request/);

    const fetchImpl = vi.fn(async (url: string) => new Response(url.endsWith("Base.sol") ? "pragma solidity ^0.8.0; contract Base {}" : 'import "./Base.sol";'));
    const all = await gatherSources({ "A.sol": 'import "@openzeppelin/contracts/utils/Thing.sol";' }, fetchImpl as never);
    expect(Object.keys(all).sort()).toEqual(["@openzeppelin/contracts/utils/Base.sol", "@openzeppelin/contracts/utils/Thing.sol", "A.sol"]);
  });

  it("validates sources", () => {
    expect(() => parseSources(undefined, undefined)).toThrow(/Pass `source`/);
    expect(() => parseSources(undefined, { "a.txt": "x" })).toThrow(/\.sol/);
    expect(Object.keys(parseSources("contract A {}", undefined))).toEqual(["Contract.sol"]);
  });

  it("compiles with the real solc: ABI, signatures, constructor, errors", async () => {
    const out = await compileSolidity({
      "Counter.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface ICounter { function count() external view returns (uint256); }
contract Counter is ICounter {
  uint256 public count;
  address public owner;
  constructor(uint256 start) { count = start; owner = msg.sender; }
  function inc(uint256 by) external returns (uint256) { count += by; return count; }
}`,
    });
    expect(out.ok).toBe(true);
    expect(out.compilerVersion).toMatch(/^0\.8\.\d+\+commit\.[0-9a-f]+$/);
    // The interface isn't deployable, so only Counter is listed.
    expect(out.contracts.map((c) => c.name)).toEqual(["Counter"]);
    const c = pickContract(out);
    expect(c.identifier).toBe("Counter.sol:Counter");
    expect(c.constructorSignature).toBe("constructor(uint256 start)");
    expect(c.functions).toContain("inc(uint256 by) returns (uint256)");
    expect(c.functions).toContain("count() view returns (uint256)");
    expect(c.bytecode).toMatch(/^0x60/);

    const bad = await compileSolidity({ "Bad.sol": "pragma solidity ^0.8.20; contract Bad { function f() public { undefinedThing(); } }" });
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].message).toMatch(/Undeclared identifier/);
    expect(() => pickContract(bad)).toThrow(/Nothing deployable/);
  }, 60_000);
});

describe("Sourcify", () => {
  it("submits and polls a verification job", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ verificationId: "job-1" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ isJobCompleted: false }))
      .mockResolvedValueOnce(Response.json({ isJobCompleted: true, contract: { match: "exact_match" } }));
    const out = await verifyOnSourcify({ chainId: 11155111, address: A, stdJsonInput: {}, compilerVersion: "0.8.37+commit.x", identifier: "C.sol:C" }, fetchImpl as never, 0, 5);
    expect(out).toMatchObject({ status: "verified", match: "exact_match", verificationId: "job-1" });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ compilerVersion: "0.8.37+commit.x", contractIdentifier: "C.sol:C" });
  });

  it("reports a failure without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json({ message: "bad input" }, { status: 400 }));
    expect(await verifyOnSourcify({ chainId: 1, address: A, stdJsonInput: {}, compilerVersion: "v", identifier: "x" }, fetchImpl as never, 0, 1))
      .toMatchObject({ status: "failed", error: "bad input" });
  });

  it("looks up an ABI and follows a proxy to its implementation", async () => {
    const IMPL = "0x1111111111111111111111111111111111111111";
    const fetchImpl = vi.fn(async (url: string) => url.includes(IMPL)
      ? Response.json({ abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address", name: "a" }], outputs: [{ type: "uint256" }], stateMutability: "view" }], compilation: { name: "Token" } })
      : Response.json({ abi: [{ type: "event", name: "Upgraded", inputs: [{ type: "address", name: "implementation", indexed: true }] }], compilation: { name: "Proxy" }, proxyResolution: { isProxy: true, implementations: [{ address: IMPL }] } }));
    const out = await contractAbi(1, A, null, fetchImpl as never);
    expect(out).toMatchObject({ verified: true, source: "sourcify", name: "Token", implementation: IMPL });
    expect(out.functions).toEqual(["balanceOf(address a) view returns (uint256)"]);
    expect(out.events).toEqual(["Upgraded(address indexed implementation)"]);
  });

  it("says unverified instead of guessing", async () => {
    const out = await contractAbi(1, A, null, vi.fn(async () => new Response("", { status: 404 })) as never);
    expect(out).toMatchObject({ verified: false, abi: null, functions: [] });
  });
});
