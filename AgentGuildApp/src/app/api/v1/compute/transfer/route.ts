/**
 * POST /api/v1/compute/transfer
 *
 * Transfer ownership of a compute instance (agent) to another user.
 * Used when selling agents on the marketplace.
 *
 * POST body: { computerId, toWallet, toOrgId, toWorkspaceId, priceCents }
 */
import { NextRequest, NextResponse } from "next/server";
import { unauthorized } from "@/lib/auth-guard";
import {
  transferComputer,
  getComputer,
  getTransfers,
  deductCredits,
} from "@/lib/compute/firestore";
import { TRANSFER_FEE_PERCENT } from "@/lib/compute/types";

export async function POST(req: NextRequest) {
  try {
    const wallet = req.headers.get("x-wallet-address");
    if (!wallet) return unauthorized("Wallet address required");

    const body = await req.json();
    const { computerId, toWallet, toOrgId, toWorkspaceId, priceCents } = body as {
      computerId: string;
      toWallet: string;
      toOrgId: string;
      toWorkspaceId: string;
      priceCents: number;
    };

    if (!computerId || !toWallet || !toOrgId || !toWorkspaceId) {
      return NextResponse.json(
        { error: "Missing required fields: computerId, toWallet, toOrgId, toWorkspaceId" },
        { status: 400 },
      );
    }

    // Verify ownership
    const computer = await getComputer(computerId);
    if (!computer) {
      return NextResponse.json({ error: "Computer not found" }, { status: 404 });
    }
    if (computer.ownerWallet.toLowerCase() !== wallet.toLowerCase()) {
      return NextResponse.json({ error: "You don't own this instance" }, { status: 403 });
    }
    if (!computer.transferable) {
      return NextResponse.json({ error: "This instance is not transferable" }, { status: 400 });
    }

    // Can't transfer to yourself
    if (toWallet.toLowerCase() === wallet.toLowerCase()) {
      return NextResponse.json({ error: "Cannot transfer to yourself" }, { status: 400 });
    }

    // If there's a price, deduct from buyer's credits
    if (priceCents > 0) {
      const deducted = await deductCredits(toOrgId, priceCents);
      if (!deducted) {
        return NextResponse.json(
          { error: "Buyer has insufficient credits", required: priceCents },
          { status: 402 },
        );
      }
    }

    // Execute the transfer
    const result = await transferComputer({
      computerId,
      fromWallet: wallet,
      fromOrgId: computer.ownerOrgId,
      toWallet,
      toOrgId,
      toWorkspaceId,
      priceCents: priceCents || 0,
    });

    const platformFee = Math.ceil((priceCents || 0) * (TRANSFER_FEE_PERCENT / 100));

    return NextResponse.json({
      ok: true,
      transferId: result.transferId,
      snapshotId: result.snapshotId,
      platformFeeCents: platformFee,
      sellerReceivesCents: (priceCents || 0) - platformFee,
      message: "Transfer complete. Instance ownership has been updated.",
    });
  } catch (err) {
    console.error("[compute/transfer] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Transfer failed" },
      { status: 500 },
    );
  }
}

/** GET /api/v1/compute/transfer — List transfer history */
export async function GET(req: NextRequest) {
  try {
    const wallet = req.headers.get("x-wallet-address");
    if (!wallet) return unauthorized("Wallet address required");

    const { searchParams } = new URL(req.url);
    const computerId = searchParams.get("computerId") || undefined;
    const direction = searchParams.get("direction") || "all";

    const transfers = await getTransfers({
      computerId,
      fromWallet: direction === "sold" ? wallet : undefined,
      toWallet: direction === "bought" ? wallet : undefined,
      limit: 50,
    });

    // If "all", get both directions
    if (direction === "all" && !computerId) {
      const sold = await getTransfers({ fromWallet: wallet, limit: 25 });
      const bought = await getTransfers({ toWallet: wallet, limit: 25 });
      const combined = [...sold, ...bought]
        .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i)
        .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
        .slice(0, 50);

      return NextResponse.json({ transfers: combined });
    }

    return NextResponse.json({ transfers });
  } catch (err) {
    console.error("[compute/transfer] GET Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch transfers" },
      { status: 500 },
    );
  }
}
