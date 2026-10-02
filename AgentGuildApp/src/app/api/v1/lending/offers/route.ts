/**
 * GET  /api/v1/lending/offers?open=1        — open loan offers (marketplace browse)
 * GET  /api/v1/lending/offers?lenderWallet=X — a lender's own offers (any status)
 * POST /api/v1/lending/offers                — post a new standing loan offer
 *   Body: { kind: "trust"|"unsecured", amountUsd, rateBps, termDays?, note? }
 *   Requires x-wallet-address header — the offer is funded by that wallet once accepted.
 */
import { NextRequest, NextResponse } from "next/server";
import { getWalletAddress, unauthorized, forbidden } from "@/lib/auth-guard";
import { createLoanOffer, listOpenLoanOffers, listLoanOffersForWallet } from "@/lib/lending/lending-service";
import type { LoanKind } from "@/lib/lending/types";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";

export async function GET(req: NextRequest) {
    try {
        const open = req.nextUrl.searchParams.get("open");
        const lenderWallet = req.nextUrl.searchParams.get("lenderWallet");

        if (open) {
            const offers = await listOpenLoanOffers();
            return NextResponse.json({ offers });
        }
        if (lenderWallet) {
            // A lender's full offer history (including withdrawn/non-open
            // offers and notes) is private — only the lender themselves may
            // request it, unlike the `open=1` marketplace browse above.
            const caller = getWalletAddress(req);
            if (!caller) return unauthorized("Missing x-wallet-address header");
            if (caller !== canonicalizeWalletAddress(lenderWallet)) {
                return forbidden("Can only list your own loan offers");
            }
            const offers = await listLoanOffersForWallet(lenderWallet);
            return NextResponse.json({ offers });
        }
        return NextResponse.json({ error: "Provide open=1 or lenderWallet" }, { status: 400 });
    } catch (error) {
        console.error("[lending/offers] GET error:", error);
        return NextResponse.json({ error: "Failed to load loan offers" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const wallet = getWalletAddress(req);
    if (!wallet) return unauthorized("Missing x-wallet-address header");

    let body: { kind?: LoanKind; amountUsd?: number; rateBps?: number; termDays?: number; note?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { kind, amountUsd, rateBps } = body;
    if (!kind || !Number.isFinite(amountUsd) || !Number.isFinite(rateBps)) {
        return NextResponse.json({ error: "kind, amountUsd, and rateBps are required" }, { status: 400 });
    }
    if (kind !== "trust" && kind !== "unsecured") {
        return NextResponse.json({ error: 'kind must be "trust" or "unsecured"' }, { status: 400 });
    }

    try {
        const offer = await createLoanOffer({
            lenderWalletAddress: wallet,
            kind,
            amountUsd: amountUsd as number,
            rateBps: rateBps as number,
            termDays: body.termDays,
            note: body.note,
        });
        return NextResponse.json({ offer }, { status: 201 });
    } catch (error) {
        console.error("[lending/offers] POST error:", error);
        return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to create loan offer" }, { status: 400 });
    }
}
