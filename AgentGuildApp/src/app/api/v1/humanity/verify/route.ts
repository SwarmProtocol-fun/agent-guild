/**
 * GET  /api/v1/humanity/verify — the signed-in wallet's proof-of-human status.
 * POST /api/v1/humanity/verify — run (or keep polling) a Proof of Human check
 *      for the signed-in wallet. Verified org owners get a larger agent quota.
 *
 * Session wallet only (middleware sets x-wallet-address from the session).
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import { getHumanVerification, verifyHuman, isVerificationCurrent } from "@/lib/human-verification";
import { ownerAgentQuota } from "@/lib/agent-standing";

function shape(v: Awaited<ReturnType<typeof getHumanVerification>>) {
    const verified = isVerificationCurrent(v);
    return {
        verified,
        status: v?.status ?? "none",
        verdict: v?.verdict ?? null,
        confidence: v?.confidence ?? null,
        checkedAt: v?.checkedAt ?? null,
        error: v?.error ?? null,
        quota: ownerAgentQuota(verified),
    };
}

export async function GET(req: NextRequest) {
    const wallet = getWalletAddress(req);
    if (!wallet) return Response.json({ error: "Sign in first" }, { status: 401 });
    return Response.json(shape(await getHumanVerification(wallet)));
}

export async function POST(req: NextRequest) {
    const wallet = getWalletAddress(req);
    if (!wallet) return Response.json({ error: "Sign in first" }, { status: 401 });
    return Response.json(shape(await verifyHuman(wallet)));
}
