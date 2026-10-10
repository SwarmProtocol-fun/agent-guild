/**
 * Proof-of-human for org owners (proofofhuman.ge). A verified owner gets a
 * larger agent quota (agent-standing.ts ownerAgentQuota) — it raises the
 * cost of farming ASNs through many throwaway owner wallets.
 *
 * Soft gate by design: UNCERTAIN, AI, or a POH outage never blocks anyone —
 * the owner just keeps the unverified quota.
 *
 * Env: POH_BASE_URL (default devnet), POH_API_KEY (else free-tier
 * walletAddress mode, 100 scans). Collection: humanVerifications/{wallet}.
 */

import { adminDb } from "@/lib/firebase-admin";

const COLLECTION = "humanVerifications";
const DEFAULT_BASE = "https://proofofhuman.ge/devnet";
export const HUMAN_MIN_CONFIDENCE = 0.7;
/** Re-check verified owners periodically; on-chain signals change. */
export const VERIFICATION_TTL_MS = 90 * 24 * 3600_000;

export type PohVerdict = "HUMAN" | "AI" | "UNCERTAIN";

export interface HumanVerification {
    wallet: string;
    status: "pending" | "done" | "error";
    verdict?: PohVerdict;
    confidence?: number;
    verified: boolean;
    brainKey?: string;
    checkedAt: number;
    error?: string;
}

export function isVerifiedHuman(verdict: PohVerdict | undefined, confidence: number | undefined): boolean {
    return verdict === "HUMAN" && (confidence ?? 0) >= HUMAN_MIN_CONFIDENCE;
}

export function isVerificationCurrent(v: HumanVerification | null, nowMs: number = Date.now()): boolean {
    return !!v && v.verified && nowMs - v.checkedAt < VERIFICATION_TTL_MS;
}

function base(): string {
    return (process.env.POH_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
}

export async function getHumanVerification(wallet: string): Promise<HumanVerification | null> {
    const snap = await adminDb().collection(COLLECTION).doc(wallet).get();
    return snap.exists ? (snap.data() as HumanVerification) : null;
}

export async function isOwnerHumanVerified(wallet: string): Promise<boolean> {
    try {
        return isVerificationCurrent(await getHumanVerification(wallet));
    } catch {
        return false;
    }
}

async function pollBrain(brainKey: string, attempts: number, delayMs: number): Promise<{ status: string; verdict?: PohVerdict; confidence?: number }> {
    let last: { status: string; verdict?: PohVerdict; confidence?: number } = { status: "pending" };
    for (let i = 0; i < attempts; i++) {
        const res = await fetch(`${base()}/checker/brain/${encodeURIComponent(brainKey)}`, { signal: AbortSignal.timeout(10_000) });
        if (res.ok) {
            last = await res.json();
            if (last.status !== "pending") return last;
        }
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
    return last;
}

/**
 * Start (or continue) a check for `wallet`. If a scan is already pending its
 * verdict is polled instead of spending another scan. Returns the stored record.
 */
export async function verifyHuman(wallet: string, opts: { pollAttempts?: number; pollDelayMs?: number } = {}): Promise<HumanVerification> {
    const ref = adminDb().collection(COLLECTION).doc(wallet);
    const existing = await getHumanVerification(wallet);
    if (isVerificationCurrent(existing)) return existing!;

    let brainKey = existing?.status === "pending" ? existing.brainKey : undefined;
    try {
        if (!brainKey) {
            const apiKey = process.env.POH_API_KEY;
            const res = await fetch(`${base()}/checker`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ input: wallet, ...(apiKey ? { apiKey } : { walletAddress: wallet }) }),
                signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) throw new Error(`Proof of Human returned HTTP ${res.status}`);
            const body = await res.json() as { brainKey?: string };
            if (!body.brainKey) throw new Error("Proof of Human returned no verdict key");
            brainKey = body.brainKey;
        }

        const brain = await pollBrain(brainKey, opts.pollAttempts ?? 6, opts.pollDelayMs ?? 2500);
        const record: HumanVerification = brain.status === "done"
            ? {
                wallet,
                status: "done",
                verdict: brain.verdict,
                confidence: brain.confidence,
                verified: isVerifiedHuman(brain.verdict, brain.confidence),
                checkedAt: Date.now(),
            }
            : { wallet, status: brain.status === "error" ? "error" : "pending", brainKey, verified: false, checkedAt: Date.now() };
        await ref.set(record);
        return record;
    } catch (err) {
        const record: HumanVerification = {
            wallet,
            status: "error",
            verified: false,
            checkedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
        };
        await ref.set(record).catch(() => {});
        return record;
    }
}
