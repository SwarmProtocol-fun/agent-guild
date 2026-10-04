import { describe, it, expect, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import type { ServerMod, RouteContext } from "../sdk";
import {
  derivePda, seedToBytes, pdaSnippet, parseErrorCode, decodeProgramError, detectInput, explorerUrl,
  toPlainJson, SYSTEM_PROGRAM, TOKEN_PROGRAM, DevtoolsInputError,
} from "../../../../mods/solana-settlement/devtools";

vi.mock("@/lib/skills", () => ({
  enforceCapability: vi.fn(async () => ({})), getAgentCapabilities: vi.fn(async () => []),
  getModInstallations: vi.fn(async () => []), toggleModCapability: vi.fn(),
}));
vi.mock("@/lib/firestore-admin", () => ({
  getAgent: vi.fn(), getAgentsByOrg: vi.fn(), getOrganizationsByWalletAdmin: vi.fn(),
  getAgentCapabilities: vi.fn(async () => []), getModInstallations: vi.fn(async () => []),
}));
vi.mock("@/lib/firebase-admin", () => ({ adminDb: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: vi.fn() }));
vi.mock("@/lib/agent-wallets", () => ({ listAgentWallets: vi.fn(), generateAgentWallet: vi.fn(), getAgentWalletKeypair: vi.fn() }));
vi.mock("@/lib/gateway/store", () => ({ enqueueTask: vi.fn(), getTask: vi.fn(), getAvailableWorkers: vi.fn() }));
vi.mock("@/lib/settlement/registry", () => ({
  settleOnChains: vi.fn(), hashJobResult: vi.fn(), getBalance: vi.fn(), verifyReceipt: vi.fn(),
}));
vi.mock("@/lib/solana/platform", () => ({
  agentAlreadyRegistered: vi.fn(), getAgentSlashingHistoryOnChain: vi.fn(), mintIdentityToken: vi.fn(),
}));
vi.mock("@/lib/solana/client", () => ({ getScoreEventHistoryForAsn: vi.fn() }));

const PROGRAM = "4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci";
const WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("seed encoding", () => {
  it("encodes integers little-endian at their width", () => {
    expect(Array.from(seedToBytes({ type: "u16", value: "258" }))).toEqual([2, 1]);
    expect(Array.from(seedToBytes({ type: "u64", value: "1" }))).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(seedToBytes({ type: "i64", value: "-1" }))).toEqual(Array(8).fill(255));
  });

  it("rejects out-of-range and malformed values as input errors", () => {
    expect(() => seedToBytes({ type: "u8", value: "256" })).toThrow(DevtoolsInputError);
    expect(() => seedToBytes({ type: "u32", value: "-1" })).toThrow(DevtoolsInputError);
    expect(() => seedToBytes({ type: "hex", value: "0xabc" })).toThrow(DevtoolsInputError);
    expect(() => seedToBytes({ type: "pubkey", value: "nope" })).toThrow(DevtoolsInputError);
  });
});

describe("derivePda", () => {
  it("matches findProgramAddressSync for mixed seeds", () => {
    const seeds = [{ type: "string" as const, value: "agent" }, { type: "pubkey" as const, value: WALLET }, { type: "u64" as const, value: "7" }];
    const [expected, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), new PublicKey(WALLET).toBuffer(), Buffer.from([7, 0, 0, 0, 0, 0, 0, 0])],
      new PublicKey(PROGRAM),
    );
    const out = derivePda(PROGRAM, seeds);
    expect(out.address).toBe(expected.toBase58());
    expect(out.bump).toBe(bump);
    expect(out.seedsHex[0]).toBe("6167656e74");
  });

  it("enforces the 32-byte seed limit", () => {
    expect(() => derivePda(PROGRAM, [{ type: "string", value: "x".repeat(33) }])).toThrow(/max 32/);
  });

  it("emits a snippet naming every seed", () => {
    const snippet = pdaSnippet(PROGRAM, [{ type: "string", value: "vault" }, { type: "u32", value: "3" }]);
    expect(snippet).toContain('Buffer.from("vault")');
    expect(snippet).toContain('toArrayLike(Buffer, "le", 4)');
    expect(snippet).toContain(PROGRAM);
  });
});

describe("error decoding", () => {
  it("parses decimal, hex and raw log lines", () => {
    expect(parseErrorCode("6001")).toBe(6001);
    expect(parseErrorCode("0x1771")).toBe(6001);
    expect(parseErrorCode("Program failed: custom program error: 0x7d6")).toBe(2006);
    expect(() => parseErrorCode("nothing here")).toThrow(DevtoolsInputError);
  });

  it("resolves Anchor framework codes", () => {
    const e = decodeProgramError(2006);
    expect(e).toMatchObject({ name: "ConstraintSeeds", source: "anchor-framework", hex: "0x7d6" });
  });

  it("prefers the program's IDL for custom codes", () => {
    const idl = { errors: [{ code: 6001, name: "VaultLocked", msg: "Vault is locked" }] } as unknown as Idl;
    expect(decodeProgramError(6001, PROGRAM, idl)).toMatchObject({ name: "VaultLocked", source: "program-idl" });
    expect(decodeProgramError(6001, PROGRAM, null).source).toBe("unknown");
  });

  it("uses native program tables when the program is known", () => {
    expect(decodeProgramError(1, TOKEN_PROGRAM)).toMatchObject({ name: "InsufficientFunds", source: "spl-token" });
    expect(decodeProgramError(0, SYSTEM_PROGRAM)).toMatchObject({ name: "AccountAlreadyInUse", source: "system" });
  });
});

describe("helpers", () => {
  it("classifies pasted input", () => {
    expect(detectInput(WALLET)).toBe("address");
    expect(detectInput("5".repeat(88))).toBe("tx");
    expect(detectInput("0x1771")).toBe("error");
    expect(detectInput("")).toBeNull();
  });

  it("builds explorer links per cluster", () => {
    expect(explorerUrl("tx", "abc", "mainnet-beta")).toBe("https://explorer.solana.com/tx/abc");
    expect(explorerUrl("address", "abc", "devnet")).toContain("?cluster=devnet");
    expect(explorerUrl("tx", "abc", "localnet")).toContain("customUrl=http%3A%2F%2F127.0.0.1%3A8899");
  });

  it("flattens Anchor-decoded values to JSON", () => {
    const bnLike = { toArrayLike: () => null, toString: () => "42" };
    expect(toPlainJson({ k: new PublicKey(WALLET), n: bnLike, b: 5n, bytes: new Uint8Array([1, 255]) }))
      .toEqual({ k: WALLET, n: "42", b: "5", bytes: "0x01ff" });
  });
});

describe("server /dev routes", () => {
  async function call(method: string, path: string, body?: unknown) {
    const { default: mod } = (await import("../../../../mods/solana-settlement/server")) as { default: ServerMod };
    const { matchRoute } = await import("../router");
    const url = new URL(`http://x/api/mods/solana-settlement${path}`);
    const m = matchRoute(mod.routes!, method, url.pathname.split("/").slice(4))!;
    const handler = typeof m.def === "function" ? m.def : m.def.handler;
    const req = new Request(url, { method, body: body ? JSON.stringify(body) : undefined });
    const ctx = { params: m.params, session: { address: WALLET, role: "operator" }, agent: null } as unknown as RouteContext;
    return (await handler(req, ctx)) as Response;
  }

  it("derives a PDA without touching the network", async () => {
    const res = await call("POST", "/dev/pda", { programId: PROGRAM, seeds: [{ type: "string", value: "guild_config" }] });
    expect(res.status).toBe(200);
    const [expected] = PublicKey.findProgramAddressSync([Buffer.from("guild_config")], new PublicKey(PROGRAM));
    expect((await res.json()).address).toBe(expected.toBase58());
  });

  it("maps bad input to 400", async () => {
    expect((await call("POST", "/dev/pda", { programId: PROGRAM, seeds: [{ type: "u8", value: "999" }] })).status).toBe(400);
    expect((await call("GET", "/dev/status?cluster=http://169.254.169.254")).status).toBe(400);
    expect((await call("GET", "/dev/tx/not-a-signature")).status).toBe(400);
  });

  it("decodes an error code with no program id offline", async () => {
    const res = await call("GET", "/dev/error/0x7d6");
    expect(res.status).toBe(200);
    expect((await res.json()).decoded).toMatchObject({ code: 2006, name: "ConstraintSeeds" });
  });
});
