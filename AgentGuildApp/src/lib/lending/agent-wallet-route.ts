/**
 * Shared plumbing for the routes that move a loan's money from the borrowing
 * agent's wallet: only members of the borrowing org may, and errors map to
 * the right status.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getLoan } from "./lending-service";
import { AgentSendError } from "./agent-wallet-send";

export async function authorizeLoanMember(req: NextRequest, id: string): Promise<{ error: Response } | { wallet: string }> {
    const loan = await getLoan(id);
    if (!loan) return { error: NextResponse.json({ error: "Loan not found" }, { status: 404 }) };
    const auth = await requireOrgMember(req, loan.borrowerOrgId);
    if (!auth.ok) return { error: auth.status === 401 ? unauthorized(auth.error) : forbidden(auth.error) };
    return { wallet: auth.walletAddress! };
}

export function agentSendErrorResponse(err: unknown, tag: string, fallback: string): Response {
    if (err instanceof AgentSendError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(`[${tag}]`, err);
    return NextResponse.json({ error: err instanceof Error ? err.message : fallback }, { status: 400 });
}

/** A positive finite number from a query string or body value, else null. */
export function positiveAmount(raw: unknown): number | null {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}
