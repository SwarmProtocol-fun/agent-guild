import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type ParsedTransactionWithMeta } from "@solana/web3.js";
import {
  assessToken, decodeInstruction, externalSignRefusal, paymentReceived, parseBase64Tx, readTokenAccount, riskFindings,
  type MintFacts, type TxPreview,
} from "../../../../mods/solana-settlement/chainchecks";
import { SYSTEM_PROGRAM, TOKEN_PROGRAM } from "../../../../mods/solana-settlement/devtools";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const clean: MintFacts = { program: "spl-token", decimals: 6, supplyRaw: "1000000000000", mintAuthority: null, freezeAuthority: null, extensions: [] };
const listed = { name: "Bonk", symbol: "BONK", isVerified: true, holderCount: 900_000, liquidityUsd: 5e6, organicScoreLabel: "high" };

describe("token safety", () => {
  it("passes a renounced, liquid, spread-out token", () => {
    const r = assessToken({ mint: MINT, facts: clean, largestRaw: ["50000000000", "40000000000"], info: listed, priceUsd: 0.00002, sellImpactPct: 0.1 });
    expect(r.verdict).toBe("no-red-flags");
    expect(r.facts.top10Pct).toBe(9);
    expect(r.facts.supplyUi).toBe("1000000");
  });

  it("flags live authorities, Token-2022 traps, a whale and no exit", () => {
    const r = assessToken({
      mint: MINT,
      facts: {
        ...clean, program: "spl-token-2022", mintAuthority: "Auth1", freezeAuthority: "Auth2",
        extensions: [{ extension: "permanentDelegate" }, { extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 300 } } }, { extension: "metadataPointer" }],
      },
      largestRaw: ["600000000000"], info: null, priceUsd: 1, sellImpactPct: null,
    });
    expect(r.verdict).toBe("high-risk");
    const codes = r.findings.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["mint-authority", "freeze-authority", "permanentDelegate", "transfer-fee", "whale", "no-route", "unlisted"]));
    expect(r.findings[0].severity).toBe("high");
    expect(r.findings.find((f) => f.code === "transfer-fee")?.severity).toBe("medium");
  });

  it("falls back to Jupiter's top-holders share when the RPC won't list holders", () => {
    const r = assessToken({ mint: MINT, facts: clean, largestRaw: [], info: { ...listed, topHoldersPct: 62.345 }, priceUsd: 1, sellImpactPct: 0.1 });
    expect(r.facts.top10Pct).toBe(62.35);
    expect(r.findings.map((f) => f.code)).toContain("concentration");
  });

  it("treats a regulated stablecoin's authorities as info", () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const r = assessToken({ mint: usdc, facts: { ...clean, mintAuthority: "Circle", freezeAuthority: "Circle" }, largestRaw: [], info: listed, priceUsd: 1, sellImpactPct: 0 });
    expect(r.verdict).toBe("no-red-flags");
  });
});

const RECIPIENT = Keypair.generate().publicKey.toBase58();
const PAYER = Keypair.generate().publicKey.toBase58();
const parsedTx = (meta: Partial<NonNullable<ParsedTransactionWithMeta["meta"]>>, instructions: unknown[] = []) => ({
  slot: 1, blockTime: 1_760_000_000,
  transaction: {
    signatures: ["SIG"],
    message: { accountKeys: [PAYER, RECIPIENT].map((k) => ({ pubkey: new PublicKey(k), signer: k === PAYER, writable: true })), instructions },
  },
  meta: { err: null, fee: 5000, preBalances: [], postBalances: [], logMessages: [], ...meta },
}) as unknown as ParsedTransactionWithMeta;

describe("payment received", () => {
  it("counts lamports gained by the recipient", () => {
    const p = paymentReceived(parsedTx({ preBalances: [5e9, 1e9], postBalances: [3.99e9, 2e9] }), RECIPIENT, null);
    expect(p).toMatchObject({ ok: true, receivedRaw: "1000000000", decimals: 9, payer: PAYER });
  });

  it("nets token balances the recipient owns and reads memos", () => {
    const bal = (idx: number, owner: string, amount: string) => ({ accountIndex: idx, mint: MINT, owner, uiTokenAmount: { amount, decimals: 6, uiAmount: 0, uiAmountString: "" } });
    const tx = parsedTx({
      preTokenBalances: [bal(2, RECIPIENT, "1000000"), bal(3, PAYER, "9000000")],
      postTokenBalances: [bal(2, RECIPIENT, "6000000"), bal(3, PAYER, "4000000")],
      logMessages: ['Program log: Memo (len 5): "inv-1"'],
    }, [{ program: "spl-memo", programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), parsed: "inv-1" }]);
    const p = paymentReceived(tx, RECIPIENT, MINT);
    expect(p.receivedRaw).toBe("5000000");
    expect(p.decimals).toBe(6);
    expect(p.memos).toEqual(["inv-1"]);
    expect(paymentReceived(tx, RECIPIENT, "So11111111111111111111111111111111111111112").receivedRaw).toBe("0");
  });

  it("marks a failed transaction not ok", () => {
    expect(paymentReceived(parsedTx({ err: { InstructionError: [0, "Custom"] } as never }), RECIPIENT, null).ok).toBe(false);
  });
});

describe("external transaction decoding", () => {
  const agent = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();

  it("names system transfers and token approvals", () => {
    const data = Buffer.alloc(12);
    data.writeUInt32LE(2, 0);
    data.writeBigUInt64LE(1_500_000_000n, 4);
    expect(decodeInstruction(0, SYSTEM_PROGRAM, [agent, other], data)).toMatchObject({ type: "transfer", summary: expect.stringMatching(/send 1.5 SOL/) });
    const approve = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(decodeInstruction(1, TOKEN_PROGRAM, ["ata", other, agent], approve).type).toBe("approve");
  });

  it("flags delegations, authority handovers, reassignment and unknown programs", () => {
    const ixs = [
      decodeInstruction(0, TOKEN_PROGRAM, ["ata", other, agent], Buffer.from([4, 0, 0, 0, 0, 0, 0, 0, 0])),
      decodeInstruction(1, TOKEN_PROGRAM, ["ata", agent], Buffer.from([6])),
      decodeInstruction(2, SYSTEM_PROGRAM, [agent], Buffer.from([1, 0, 0, 0])),
      decodeInstruction(3, Keypair.generate().publicKey.toBase58(), [], Buffer.from([9])),
    ];
    const codes = riskFindings(ixs, agent, [other]).map((f) => f.code);
    expect(codes).toEqual(["delegate", "authority", "assign", "unknown-program", "co-signers"]);
    // Someone else's approval is not the agent's problem.
    expect(riskFindings([decodeInstruction(0, TOKEN_PROGRAM, ["ata", agent, other], Buffer.from([4]))], agent, [])).toEqual([]);
  });

  it("reads the SPL token account layout", () => {
    const mint = Keypair.generate().publicKey, owner = Keypair.generate().publicKey;
    const data = Buffer.concat([mint.toBuffer(), owner.toBuffer(), Buffer.alloc(8)]);
    data.writeBigUInt64LE(42n, 64);
    expect(readTokenAccount(data)).toEqual({ mint: mint.toBase58(), owner: owner.toBase58(), amount: 42n });
    expect(readTokenAccount(Buffer.alloc(10))).toBeNull();
  });

  it("round-trips a base64 transaction and rejects junk", () => {
    const payer = Keypair.generate();
    const msg = new TransactionMessage({
      payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(other), lamports: 1 })],
    }).compileToV0Message();
    const b64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
    expect(parseBase64Tx(b64).message.staticAccountKeys[0].toBase58()).toBe(payer.publicKey.toBase58());
    expect(() => parseBase64Tx("aGVsbG8=")).toThrow(/base64/);
  });
});

describe("signing an external transaction", () => {
  const preview = (over: Partial<TxPreview>): TxPreview => ({
    version: 0, feePayer: "A", requiredSigners: ["A"], agentMustSign: true, instructions: [],
    simulation: { success: true, err: null, unitsConsumed: 1, logs: [] }, forAgent: { solDelta: -0.01, tokens: [] }, solChanges: [], findings: [], verdict: "no-red-flags", ...over,
  });

  it("signs a clean transaction", () => expect(externalSignRefusal(preview({}), 5, false)).toBeNull());

  it("never signs one that fails or reassigns the wallet, even with acceptRisks", () => {
    expect(externalSignRefusal(preview({ findings: [{ severity: "high", code: "sim-failed", message: "fails" }] }), 5, true)).toBe("fails");
    expect(externalSignRefusal(preview({ findings: [{ severity: "high", code: "assign", message: "reassigns" }] }), 5, true)).toBe("reassigns");
  });

  it("needs acceptRisks for other high findings and respects the SOL limit", () => {
    const risky = preview({ findings: [{ severity: "high", code: "delegate", message: "delegates" }] });
    expect(externalSignRefusal(risky, 5, false)).toMatch(/acceptRisks/);
    expect(externalSignRefusal(risky, 5, true)).toBeNull();
    expect(externalSignRefusal(preview({ forAgent: { solDelta: -6, tokens: [] } }), 5, false)).toMatch(/over the owner's 5 SOL/);
    expect(externalSignRefusal(preview({ agentMustSign: false }), 5, false)).toMatch(/isn't a required signer/);
  });
});
