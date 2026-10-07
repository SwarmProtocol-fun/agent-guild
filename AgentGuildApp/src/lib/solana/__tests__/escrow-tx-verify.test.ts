import { describe, it, expect, vi, beforeEach } from "vitest";
import bs58 from "bs58";

vi.mock("@/lib/solana/client", () => ({
  SOLANA_RPC_URL: "http://rpc.test",
  AGENT_GUILD_PROGRAM_ID: { toBase58: () => "GuildProgram1111" },
}));
let parsedTx: unknown = null;
vi.mock("@solana/web3.js", () => ({
  Connection: vi.fn(function () { return { getParsedTransaction: async () => parsedTx }; }),
}));

import { decodeAgentBps, findEscrowInstruction, verifyEscrowTx } from "../escrow-tx-verify";

const PROGRAM = "GuildProgram1111", PDA = "TaskPda222", POSTER = "Poster333", OTHER = "Other444";
const APPROVE = [28, 233, 51, 115, 33, 220, 41, 28];
const RESOLVE = [231, 6, 202, 6, 96, 103, 12, 230];
const ix = (disc: number[], accounts: string[], args: number[] = [], programId = PROGRAM) =>
  ({ programId, accounts, data: bs58.encode(Uint8Array.from([...disc, ...args])) });
const SIG = "5".repeat(88);

describe("findEscrowInstruction", () => {
  it("accepts approve_delivery on this order's PDA signed by the poster", () => {
    const r = findEscrowInstruction([ix(APPROVE, [POSTER, PDA, "Claimant"])] as never, "approve_delivery", PDA, POSTER, PROGRAM);
    expect(r).toMatchObject({ verified: true, signer: POSTER });
  });

  it("rejects the wrong signer, PDA, instruction or program", () => {
    expect(findEscrowInstruction([ix(APPROVE, [OTHER, PDA, "C"])] as never, "approve_delivery", PDA, POSTER, PROGRAM))
      .toMatchObject({ verified: false, reason: expect.stringMatching(/signed by Other444/) });
    expect(findEscrowInstruction([ix(APPROVE, [POSTER, "OtherPda", "C"])] as never, "approve_delivery", PDA, POSTER, PROGRAM).verified).toBe(false);
    // dispute_delivery has the same accounts but a different discriminator
    expect(findEscrowInstruction([ix([4, 16, 98, 240, 151, 95, 239, 196], [POSTER, PDA])] as never, "approve_delivery", PDA, POSTER, PROGRAM).verified).toBe(false);
    expect(findEscrowInstruction([ix(APPROVE, [POSTER, PDA, "C"], [], "Impostor")] as never, "approve_delivery", PDA, POSTER, PROGRAM).verified).toBe(false);
    // parsed (system/spl) instructions are skipped, not crashed on
    expect(findEscrowInstruction([{ program: "system", parsed: {} }] as never, "approve_delivery", PDA, POSTER, PROGRAM).verified).toBe(false);
  });

  it("reads resolve_dispute's agent_bps from the instruction", () => {
    const r = findEscrowInstruction([ix(RESOLVE, ["Authority", "Config", PDA, POSTER, "C"], [0x88, 0x13])] as never, "resolve_dispute", PDA, undefined, PROGRAM);
    expect(r.verified).toBe(true);
    expect(r.verified && decodeAgentBps(r.args)).toBe(5000);
    expect(decodeAgentBps(new Uint8Array([1]))).toBeNull();
  });
});

describe("verifyEscrowTx", () => {
  beforeEach(() => { parsedTx = null; });

  it("rejects malformed signatures without a network call", async () => {
    expect(await verifyEscrowTx("not-a-sig", "approve_delivery", PDA, POSTER)).toMatchObject({ verified: false });
  });

  it("rejects failed transactions and verifies successful ones", async () => {
    parsedTx = { meta: { err: { InstructionError: [0, "Custom"] } }, transaction: { message: { instructions: [] } } };
    expect(await verifyEscrowTx(SIG, "approve_delivery", PDA, POSTER)).toMatchObject({ verified: false, reason: expect.stringMatching(/failed/) });
    parsedTx = { meta: { err: null }, transaction: { message: { instructions: [ix(APPROVE, [POSTER, PDA, "C"])] } } };
    // The mocked program id is "GuildProgram1111"; ix() uses the same.
    expect(await verifyEscrowTx(SIG, "approve_delivery", PDA, POSTER)).toMatchObject({ verified: true });
  });

  it("reports a missing transaction as retryable", async () => {
    vi.useFakeTimers();
    const p = verifyEscrowTx(SIG, "approve_delivery", PDA, POSTER);
    await vi.runAllTimersAsync();
    expect(await p).toMatchObject({ verified: false, retryable: true });
    vi.useRealTimers();
  });
});
