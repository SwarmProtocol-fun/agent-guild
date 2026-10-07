/**
 * Server-side verification of a gig order's upfront SOL payment.
 *
 * A gig escrow order pays half the price directly to the seller (a plain
 * SystemProgram.transfer) and locks the other half in the on-chain Task PDA.
 * The PDA half is enforced by the program, but the upfront half and the whole
 * `job.escrow` record were written by the buyer's browser and never checked —
 * a buyer could record any signature, or name their own wallet as
 * `claimantSolanaAddress` and "pay" themselves.
 *
 * This verifies against the gig listing (not the buyer-written escrow record)
 * that the seller's wallet really received at least half the gig's price, in
 * a finalized transaction that hasn't been used for another order, then
 * stamps `upfrontVerifiedAt` on the job (clients can't write that field —
 * see firestore.rules). Server-only.
 */
import { Connection, type ParsedInstruction, type PartiallyDecodedInstruction } from "@solana/web3.js";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { SOLANA_RPC_URL } from "@/lib/solana/client";
import { orderPriceLamports } from "@/lib/gig-packages";

const PAYMENT_TX_COLLECTION = "gigPaymentTxs";

export type UpfrontVerification =
  | { verified: true; lamports: number }
  | { verified: false; reason: string; retryable?: boolean };

/** Sum of lamports moved source → destination by system transfers in a parsed transaction. */
export function systemTransferLamports(
  instructions: (ParsedInstruction | PartiallyDecodedInstruction)[],
  source: string,
  destination: string,
): number {
  let total = 0;
  for (const ix of instructions) {
    if (!("parsed" in ix) || ix.program !== "system") continue;
    const parsed = ix.parsed as { type?: string; info?: { source?: string; destination?: string; lamports?: number } };
    if ((parsed.type === "transfer" || parsed.type === "transferWithSeed") &&
        parsed.info?.source === source && parsed.info?.destination === destination) {
      total += parsed.info.lamports ?? 0;
    }
  }
  return total;
}

export async function verifyGigUpfrontPayment(jobId: string): Promise<UpfrontVerification> {
  const db = adminDb();
  const jobRef = db.collection("jobs").doc(jobId);
  const job = (await jobRef.get()).data();
  if (!job?.gigId || !job.escrow) return { verified: false, reason: "This order has no escrow payment to verify" };
  if (job.upfrontVerifiedAt) return { verified: true, lamports: job.upfrontVerifiedLamports ?? 0 };

  const gig = (await db.collection("gigs").doc(job.gigId).get()).data();
  const seller = gig?.sellerSolanaAddress as string | undefined;
  // Package orders owe their tier's price, read from the listing — the job's
  // gigPackageId only picks which tier, it never carries an amount.
  const priceLamports = gig ? orderPriceLamports(gig, job.gigPackageId) : undefined;
  if (!seller || !priceLamports) return { verified: false, reason: "Gig has no Solana price or payout address" };

  const escrow = job.escrow as { upfrontTransferTxSig?: string; posterSolanaAddress?: string; claimantSolanaAddress?: string };
  if (escrow.claimantSolanaAddress !== seller) {
    return { verified: false, reason: "Order's payee does not match the gig's seller wallet" };
  }
  const txSig = escrow.upfrontTransferTxSig;
  const buyer = escrow.posterSolanaAddress;
  if (!txSig || !buyer) return { verified: false, reason: "Order has no upfront payment signature" };

  // Matches the order form: upfront = floor(price / 2). Compared to the gig's
  // (or ordered tier's) current price, so a seller who raised the price
  // after the order will see the shortfall here and can decide whether to
  // proceed.
  const requiredLamports = Math.floor(priceLamports / 2);

  const tx = await new Connection(SOLANA_RPC_URL, "finalized").getParsedTransaction(txSig, {
    maxSupportedTransactionVersion: 0,
    commitment: "finalized",
  });
  if (!tx) return { verified: false, reason: "Payment not found or not finalized yet — retry in a few seconds", retryable: true };
  if (tx.meta?.err) return { verified: false, reason: "Upfront payment transaction failed on-chain" };

  const received = systemTransferLamports(tx.transaction.message.instructions, buyer, seller);
  if (received < requiredLamports) {
    return { verified: false, reason: `Seller received ${received} lamports upfront; at least ${requiredLamports} required` };
  }

  try {
    await db.runTransaction(async (txn) => {
      // create() fails if this signature already paid for another order.
      txn.create(db.collection(PAYMENT_TX_COLLECTION).doc(txSig), {
        jobId, gigId: job.gigId, from: buyer, to: seller, lamports: received, claimedAt: FieldValue.serverTimestamp(),
      });
      txn.update(jobRef, { upfrontVerifiedAt: FieldValue.serverTimestamp(), upfrontVerifiedLamports: received });
    });
  } catch (err) {
    if ((err as { code?: number }).code === 6) {
      const prior = (await db.collection(PAYMENT_TX_COLLECTION).doc(txSig).get()).data();
      if (prior?.jobId === jobId) return { verified: true, lamports: received };
      return { verified: false, reason: "This payment signature was already used for a different order" };
    }
    throw err;
  }
  return { verified: true, lamports: received };
}
