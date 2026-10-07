/**
 * GET  /api/v1/lending/loans?agentId=X             — an agent's loan history
 * GET  /api/v1/lending/loans?open=solo             — open solo loan requests (marketplace browse)
 * GET  /api/v1/lending/loans?open=pending_disbursement — platform admin: pool loans awaiting real payout
 * GET  /api/v1/lending/loans?open=liquidating       — platform admin: market loans whose collateral awaits sale
 * GET  /api/v1/lending/loans?lenderWallet=X        — loans funded by a given wallet
 * POST /api/v1/lending/loans                       — request a new loan for an agent
 *   Body: { agentId, orgId, kind: "trust"|"unsecured", source: "pool"|"solo",
 *           amount, termDays?, poolId?, asset?, purpose?, requestedRateBps? }
 *   Pool loans are in the pool's asset (amount is in that asset's units);
 *   `asset` picks that asset's default pool when poolId is omitted.
 *   requestedRateBps only applies to source: "solo" — pool loans are always
 *   priced at the fixed tier rate. Solo rates still must fall within a band
 *   around that same tier rate (see eligibility.ts's validateSoloRateBps).
 */
import { isLendingAsset } from "@/lib/lending/assets";
import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requireOrgMember, requirePlatformAdmin, getWalletAddress, unauthorized, forbidden } from "@/lib/auth-guard";
import {
    listLoansForAgent,
    listOpenSoloRequests,
    listLoansFundedByWallet,
    listPendingDisbursements,
    requestLoan,
    listLiquidatingLoans,
} from "@/lib/lending/lending-service";
import type { LoanKind, LoanSource } from "@/lib/lending/types";

export async function GET(req: NextRequest) {
    try {
        const agentId = req.nextUrl.searchParams.get("agentId");
        const open = req.nextUrl.searchParams.get("open");
        const lenderWallet = req.nextUrl.searchParams.get("lenderWallet");

        if (agentId) {
            const loans = await listLoansForAgent(agentId);
            return NextResponse.json({ loans });
        }
        if (open === "solo") {
            const loans = await listOpenSoloRequests();
            return NextResponse.json({ loans });
        }
        if (open === "pending_disbursement") {
            const admin = requirePlatformAdmin(req);
            if (!admin.ok) return forbidden(admin.error || "Platform admin required");
            const loans = await listPendingDisbursements();
            return NextResponse.json({ loans });
        }
        if (open === "liquidating") {
            const admin = requirePlatformAdmin(req);
            if (!admin.ok) return forbidden(admin.error || "Platform admin required");
            const loans = await listLiquidatingLoans();
            return NextResponse.json({ loans });
        }
        if (lenderWallet) {
            const loans = await listLoansFundedByWallet(lenderWallet);
            return NextResponse.json({ loans });
        }
        return NextResponse.json({ error: "Provide agentId, open=solo, open=pending_disbursement, open=liquidating, or lenderWallet" }, { status: 400 });
    } catch (error) {
        console.error("[lending/loans] GET error:", error);
        return NextResponse.json({ error: "Failed to load loans" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    let body: {
        agentId?: string;
        orgId?: string;
        kind?: LoanKind;
        source?: LoanSource;
        amount?: number;
        /** @deprecated use `amount` */ amountUsd?: number;
        termDays?: number;
        poolId?: string;
        asset?: string;
        purpose?: string;
        requestedRateBps?: number;
    };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { agentId, orgId, kind, source } = body;
    const amount = body.amount ?? body.amountUsd;
    if (!agentId || !orgId || !kind || !source || !Number.isFinite(amount)) {
        return NextResponse.json({ error: "agentId, orgId, kind, source, and amount are required" }, { status: 400 });
    }
    if (kind !== "trust" && kind !== "unsecured") {
        return NextResponse.json({ error: 'kind must be "trust" or "unsecured"' }, { status: 400 });
    }
    if (source !== "pool" && source !== "solo") {
        return NextResponse.json({ error: 'source must be "pool" or "solo"' }, { status: 400 });
    }
    if (body.asset !== undefined && !isLendingAsset(body.asset)) {
        return NextResponse.json({ error: 'asset must be "usdc", "sol" or "eth"' }, { status: 400 });
    }
    if (source === "solo" && body.asset !== undefined && body.asset !== "usdc") {
        return NextResponse.json({ error: "Solo loans are USDC — borrow SOL or ETH from its pool instead" }, { status: 400 });
    }
    if (source === "pool" && body.requestedRateBps !== undefined) {
        return NextResponse.json({ error: "Pool loans are always priced at the fixed tier rate — requestedRateBps only applies to solo loans" }, { status: 400 });
    }

    const orgAuth = await requireOrgMember(req, orgId);
    if (!orgAuth.ok) return orgAuth.status === 401 ? unauthorized(orgAuth.error) : forbidden(orgAuth.error);

    const agentSnap = await adminDb().collection("agents").doc(agentId).get();
    if (!agentSnap.exists) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    if (agentSnap.data()?.orgId !== orgId) {
        return forbidden("Agent does not belong to this organization");
    }

    try {
        const loan = await requestLoan({
            agentId,
            orgId,
            kind,
            source,
            amount: amount as number,
            termDays: body.termDays,
            poolId: body.poolId,
            asset: isLendingAsset(body.asset) ? body.asset : undefined,
            purpose: body.purpose,
            requestedByWallet: getWalletAddress(req) || undefined,
            requestedRateBps: body.requestedRateBps,
        });
        return NextResponse.json({ loan }, { status: 201 });
    } catch (error) {
        console.error("[lending/loans] POST error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to request loan" }, { status: 400 });
    }
}
