/**
 * Rules shared by everything that pays an agent for a job (lib/job-payments,
 * tempo-settlement, solana-settlement): which jobs are payable, and what a job's free-text
 * reward is worth in dollars. The job record is the source of truth for
 * both — never an amount or recipient the caller sends.
 */
import type { Job } from "@/lib/firestore";

/**
 * A job's reward is free text ("150", "$50", "25 USDC", "0.5 SOL"). Only
 * dollar amounts become a payout; anything else is left for a person to
 * price, rather than guessing an exchange rate.
 */
export function parseUsdReward(reward: string | undefined): number | null {
  if (!reward) return null;
  const m = reward.trim().match(/^\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(usd|usdc|usdt|pathusd|dollars?)?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Approved jobs that went to an agent and were not already paid some other way. */
export function isPayable(job: Job): boolean {
  if (!job.takenByAgentId) return false;
  // Already paid through the core payment flow (lib/job-payments.ts).
  if (job.payment) return false;
  // Delivery marks a job "completed" with review pending — pay only once the
  // poster approved it (jobs from before reviews existed have no reviewStatus).
  if (job.reviewStatus && job.reviewStatus !== "approved") return false;
  // Escrowed or prepaid gig orders, and Hedera bounties, already moved money.
  if (job.escrow || job.upfrontVerifiedAt || job.hederaScheduledTxId) return false;
  return true;
}
