/**
 * Post a loan's collateral from the borrowing agent's own wallet.
 *
 * GET  — what it takes: amount, asset, and each of the agent's wallets on
 *        that chain with its balance and whether it can cover it.
 * POST — { walletId?, check? }: send exactly the collateral from that wallet
 *        (or the first one that can cover it) to the lending treasury and
 *        post it. `check: true` only re-verifies a transfer already sent.
 *        A loan that already has a broadcast transfer is never sent twice.
 *
 * Members of the borrowing org only, the same rule as posting by hand.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getLoan } from "@/lib/lending/lending-service";
import {
    AgentCollateralError, finishAgentCollateral, postCollateralFromAgentWallet, quoteAgentCollateral,
} from "@/lib/lending/agent-collateral";

type Ctx = { params: Promise<{ id: string }> };

async function authorize(req: NextRequest, id: string): Promise<{ error: Response } | { wallet: string }> {
    const loan = await getLoan(id);
    if (!loan) return { error: NextResponse.json({ error: "Loan not found" }, { status: 404 }) };
    const auth = await requireOrgMember(req, loan.borrowerOrgId);
    if (!auth.ok) return { error: auth.status === 401 ? unauthorized(auth.error) : forbidden(auth.error) };
    return { wallet: auth.walletAddress! };
}

function errorResponse(err: unknown, fallback: string) {
    if (err instanceof AgentCollateralError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[lending/collateral/agent-wallet]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : fallback }, { status: 400 });
}

export async function GET(req: NextRequest, { params }: Ctx) {
    const { id } = await params;
    const auth = await authorize(req, id);
    if ("error" in auth) return auth.error;
    try {
        return NextResponse.json(await quoteAgentCollateral(id));
    } catch (err) {
        return errorResponse(err, "Failed to read the agent's wallets");
    }
}

export async function POST(req: NextRequest, { params }: Ctx) {
    const { id } = await params;
    const auth = await authorize(req, id);
    if ("error" in auth) return auth.error;
    const body = (await req.json().catch(() => ({}))) as { walletId?: unknown; check?: unknown };
    try {
        const result = body.check === true
            ? await finishAgentCollateral(id)
            : await postCollateralFromAgentWallet(id, auth.wallet, typeof body.walletId === "string" ? body.walletId : undefined);
        return NextResponse.json(result, { status: result.status === "failed" ? 400 : 200 });
    } catch (err) {
        return errorResponse(err, "Failed to post collateral from the agent's wallet");
    }
}
