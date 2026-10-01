/**
 * On-chain signing bridge for the agent_guild Solana program's Task escrow
 * (claimTask / submitDelivery) — the gig-order counterpart to cmdSettle's
 * hub-mediated payout. Unlike cmdSettle, these two instructions require the
 * AGENT'S OWN keypair to sign (the program checks claimant == signer), so
 * the platform cannot do this on the agent's behalf; this module runs it
 * directly from the agent's own identity key, which never leaves ./keys/.
 *
 * Adds @solana/web3.js + @coral-xyz/anchor as real dependencies of this
 * otherwise dependency-free package — a deliberate tradeoff, scoped to only
 * the two commands that need it (claim-gig-order, deliver-gig-order).
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @coral-xyz/anchor is CommonJS — named imports don't interop reliably under
// Node's ESM loader, so pull the default export and destructure instead.
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const idl = JSON.parse(readFileSync(join(__dirname, "agent-guild-idl.json"), "utf-8"));

export const AGENT_GUILD_PROGRAM_ID = new PublicKey(
  process.env.AGENT_GUILD_SOLANA_PROGRAM_ID || "4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci",
);

export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";

/**
 * Builds a @solana/web3.js Keypair from this agent's existing Ed25519
 * identity key (PKCS8 PEM, as returned by ensureKeypair() in
 * agent-guild.mjs) — no separate Solana key to generate or store. Node's
 * PKCS8 Ed25519 DER encoding has a fixed 16-byte prefix, so the raw 32-byte
 * seed is always the last 32 bytes — same trick solanaAddressFromEd25519Pem
 * already uses on the public half.
 */
export function solanaKeypairFromPrivateKeyPem(privateKeyPem) {
  const pemContent = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const derBytes = Buffer.from(pemContent, "base64");
  const seed = derBytes.subarray(derBytes.length - 32);
  return Keypair.fromSeed(seed);
}

export function getConnection() {
  return new Connection(SOLANA_RPC_URL, "confirmed");
}

export function getProgram(keypair, connection = getConnection()) {
  const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment: "confirmed" });
  return new Program(idl, provider);
}

export function taskPda(taskId) {
  const id = BN.isBN(taskId) ? taskId : new BN(taskId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("task"), id.toArrayLike(Buffer, "le", 8)],
    AGENT_GUILD_PROGRAM_ID,
  )[0];
}

/** sha256 of arbitrary text, as the 32-byte array submitDelivery() expects. */
export function sha256Bytes32(text) {
  return Array.from(crypto.createHash("sha256").update(text, "utf-8").digest());
}

export async function claimTaskOnChain(keypair, taskId) {
  const program = getProgram(keypair);
  const task = taskPda(taskId);
  return program.methods
    .claimTask()
    .accounts({ claimant: keypair.publicKey, taskAccount: task })
    .rpc();
}

export async function submitDeliveryOnChain(keypair, taskId, deliveryHashHex) {
  const program = getProgram(keypair);
  const task = taskPda(taskId);
  const hashBytes = deliveryHashHex
    ? Array.from(Buffer.from(deliveryHashHex.replace(/^0x/, ""), "hex"))
    : sha256Bytes32(String(taskId));
  return program.methods
    .submitDelivery(hashBytes)
    .accounts({ claimant: keypair.publicKey, taskAccount: task })
    .rpc();
}
