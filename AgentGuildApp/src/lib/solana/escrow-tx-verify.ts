/**
 * Server-side verification of gig-escrow transactions recorded against a job.
 *
 * The dashboard signs approveDelivery() (buyer releases funds) and the
 * admin console signs resolveDispute() (authority splits them), then hands
 * the signature to the server to record. Recording it unchecked would let a
 * buyer pass any string as a "release", get the job marked approved, and
 * keep the seller's escrowed funds locked. This confirms the signature is a
 * successful agent_guild instruction of the right kind, on this order's
 * Task PDA, signed by the right party, before anything is recorded.
 *
 * Anchor instructions are identified by their 8-byte discriminator (from the
 * IDL), followed by Borsh-encoded args. Server-only.
 */
import { Connection, type ParsedInstruction, type PartiallyDecodedInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { AGENT_GUILD_PROGRAM_ID, SOLANA_RPC_URL } from "@/lib/solana/client";

/** Discriminators and account order from idl/agent_guild.json. */
const INSTRUCTIONS = {
  approve_delivery: { discriminator: [28, 233, 51, 115, 33, 220, 41, 28], taskAccountIndex: 1, signerIndex: 0 },
  resolve_dispute: { discriminator: [231, 6, 202, 6, 96, 103, 12, 230], taskAccountIndex: 2, signerIndex: 0 },
} as const;

export type EscrowInstruction = keyof typeof INSTRUCTIONS;

export type EscrowTxVerification =
  | { verified: true; signer: string; args: Uint8Array }
  | { verified: false; reason: string; retryable?: boolean };

/**
 * Find `name` on `taskPda` among a transaction's top-level instructions.
 * Pure — exported for tests. `expectedSigner`, when set, must be the
 * instruction's signer account (the poster for approve_delivery).
 */
export function findEscrowInstruction(
  instructions: (ParsedInstruction | PartiallyDecodedInstruction)[],
  name: EscrowInstruction,
  taskPda: string,
  expectedSigner?: string,
  programId: string = AGENT_GUILD_PROGRAM_ID.toBase58(),
): EscrowTxVerification {
  const spec = INSTRUCTIONS[name];
  for (const ix of instructions) {
    if ("parsed" in ix || ix.programId.toString() !== programId) continue;
    let data: Uint8Array;
    try {
      data = bs58.decode(ix.data);
    } catch {
      continue;
    }
    if (data.length < 8 || !spec.discriminator.every((b, i) => data[i] === b)) continue;
    if (ix.accounts[spec.taskAccountIndex]?.toString() !== taskPda) continue;
    const signer = ix.accounts[spec.signerIndex]?.toString() ?? "";
    if (expectedSigner && signer !== expectedSigner) {
      return { verified: false, reason: `${name} was signed by ${signer}, not the order's ${expectedSigner}` };
    }
    return { verified: true, signer, args: data.slice(8) };
  }
  return { verified: false, reason: `Transaction has no ${name} instruction for this order's escrow` };
}

/** resolve_dispute's only arg: agent_bps, a little-endian u16. */
export function decodeAgentBps(args: Uint8Array): number | null {
  return args.length >= 2 ? args[0] | (args[1] << 8) : null;
}

export async function verifyEscrowTx(
  txSig: string,
  name: EscrowInstruction,
  taskPda: string,
  expectedSigner?: string,
): Promise<EscrowTxVerification> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(txSig)) return { verified: false, reason: "Not a Solana transaction signature" };
  // "confirmed", not "finalized": the dashboard submits right after the wallet
  // signs, and a confirmed tx that later drops is vanishingly rare. A tx
  // that isn't visible yet gets a short retry before giving up.
  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  for (let attempt = 0; attempt < 3; attempt++) {
    const tx = await connection.getParsedTransaction(txSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx) {
      if (tx.meta?.err) return { verified: false, reason: `${name} transaction failed on-chain` };
      return findEscrowInstruction(tx.transaction.message.instructions, name, taskPda, expectedSigner);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
  }
  return { verified: false, reason: "Transaction not found or not confirmed yet — retry in a few seconds", retryable: true };
}
