import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  createMintToInstruction,
  createFreezeAccountInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
} from "@solana/spl-token";
import { createMemoInstruction } from "@solana/spl-memo";
import { getChain } from "@/lib/chains";
import type { IdentityAdapter, IdentityMintReceipt, MintIdentityParams } from "./types";

const MEMO_PREFIX = "swarm:identity:";

function loadPlatformKeypair(): Keypair {
  const raw = process.env.SOLANA_SETTLEMENT_SECRET_KEY;
  if (!raw) throw new Error("SOLANA_SETTLEMENT_SECRET_KEY not configured");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * No custom Anchor program, matching settlement/solana-adapter.ts's approach
 * — a fresh 0-decimal mint with supply capped at 1 (mint authority revoked
 * right after minting) is a standard SPL "NFT". The agent's token account is
 * frozen immediately after minting so it can never be transferred out of
 * that wallet (soulbound), and the ASN rides along as a Memo instruction in
 * the same transaction — the same receipt pattern settlement uses.
 *
 * Idempotency: unlike the EVM path (hasNFT view function on a shared
 * registry contract), there's no cheap on-chain way to ask "does this wallet
 * already have a Swarm identity mint" without an indexer. hasIdentity()
 * always returns false — the real "already minted" guard is the Firestore
 * flag at the call site (see identity/registry.ts / register/route.ts),
 * same idempotency model settlement's in-memory settledTaskChains uses.
 */
export class SolanaIdentityAdapter implements IdentityAdapter {
  async mintIdentity(p: MintIdentityParams): Promise<IdentityMintReceipt> {
    const chain = getChain("solana");
    if (!chain) throw new Error("Solana chain config missing");

    const connection = new Connection(chain.rpc, "confirmed");
    const platform = loadPlatformKeypair();
    const agentPubkey = new PublicKey(p.agentAddress);

    const mint = await createMint(
      connection,
      platform,
      platform.publicKey, // mint authority (revoked below after minting 1)
      platform.publicKey, // freeze authority (used below to soulbind, then revoked)
      0, // decimals — 0 = whole, indivisible token
    );

    const agentAta = await getOrCreateAssociatedTokenAccount(connection, platform, mint, agentPubkey);

    const tx = new Transaction()
      .add(createMintToInstruction(mint, agentAta.address, platform.publicKey, 1))
      .add(createFreezeAccountInstruction(agentAta.address, mint, platform.publicKey))
      .add(createSetAuthorityInstruction(mint, platform.publicKey, AuthorityType.MintTokens, null))
      .add(createMemoInstruction(`${MEMO_PREFIX}${p.asn}:${p.agentName}`, [platform.publicKey]));

    const txSig = await sendAndConfirmTransaction(connection, tx, [platform]);

    return {
      chain: "solana",
      txSig,
      explorerUrl: chain.explorer.txUrl(txSig),
    };
  }

  async hasIdentity(): Promise<boolean> {
    return false;
  }
}
