/**
 * POST /api/v1/compute/listing
 *
 * List or unlist a compute instance on the marketplace.
 *
 * POST body: { computerId, action: "list" | "unlist", priceCents?, description? }
 *
 * GET /api/v1/compute/listing — Get all listed instances
 */
import { NextRequest, NextResponse } from "next/server";
import { unauthorized } from "@/lib/auth-guard";
import {
  listComputerForSale,
  unlistComputer,
  getListedComputers,
} from "@/lib/compute/firestore";
import { TRANSFER_FEE_PERCENT, OPENCLAW_VARIANTS } from "@/lib/compute/types";

/** List or unlist an instance */
export async function POST(req: NextRequest) {
  try {
    const wallet = req.headers.get("x-wallet-address");
    if (!wallet) return unauthorized("Wallet address required");

    const body = await req.json();
    const { computerId, action, priceCents, description } = body as {
      computerId: string;
      action: "list" | "unlist";
      priceCents?: number;
      description?: string;
    };

    if (!computerId || !action) {
      return NextResponse.json({ error: "computerId and action required" }, { status: 400 });
    }

    if (action === "list") {
      if (!priceCents || priceCents <= 0) {
        return NextResponse.json({ error: "priceCents must be positive" }, { status: 400 });
      }
      await listComputerForSale(
        computerId,
        wallet,
        priceCents,
        description || "Agent instance for sale",
      );

      const platformFee = Math.ceil(priceCents * (TRANSFER_FEE_PERCENT / 100));

      return NextResponse.json({
        ok: true,
        message: "Instance listed for sale",
        priceCents,
        platformFeeCents: platformFee,
        sellerReceivesCents: priceCents - platformFee,
      });
    }

    if (action === "unlist") {
      await unlistComputer(computerId, wallet);
      return NextResponse.json({ ok: true, message: "Listing removed" });
    }

    return NextResponse.json({ error: `Invalid action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error("[compute/listing] Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Listing operation failed" },
      { status: 500 },
    );
  }
}

/** Get all listed instances on the marketplace */
export async function GET() {
  try {
    const listed = await getListedComputers();

    const items = listed.map((c) => {
      const variantInfo = c.openclawVariant ? OPENCLAW_VARIANTS[c.openclawVariant] : null;
      return {
        computerId: c.id,
        name: c.name,
        variant: c.openclawVariant,
        variantLabel: variantInfo?.label || "Custom Instance",
        sizeKey: c.sizeKey,
        region: c.region,
        provider: c.provider,
        ownerWallet: c.ownerWallet,
        priceCents: c.listingPriceCents,
        description: c.listingDescription,
        platformFeeCents: Math.ceil((c.listingPriceCents || 0) * (TRANSFER_FEE_PERCENT / 100)),
        createdAt: c.createdAt,
      };
    });

    return NextResponse.json({ listings: items, total: items.length });
  } catch (err) {
    console.error("[compute/listing] GET Error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch listings" },
      { status: 500 },
    );
  }
}
