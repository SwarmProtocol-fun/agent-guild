/**
 * GET /api/admin/gas-sponsor
 *
 * Returns the platform gas-sponsor wallet status:
 *  - address (derived from SOLANA_PLATFORM_KEYPAIR)
 *  - SOL balance
 *  - total registrations sponsored
 *  - estimated registrations remaining
 */
import { NextRequest, NextResponse } from "next/server";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { adminDb } from "@/lib/firebase-admin";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { getConnection } from "@/lib/solana/client";
import { getPlatformKeypair } from "@/lib/solana/platform";

/** Average fee for a register_agent_for tx on Solana devnet (in SOL) */
const AVG_REGISTRATION_COST_SOL = 0.001;

export async function GET(_req: NextRequest) {
  const adminCheck = requirePlatformAdmin(_req);
  if (!adminCheck.ok) {
    return NextResponse.json({ error: adminCheck.error }, { status: 403 });
  }

  const keypair = getPlatformKeypair();
  if (!keypair) {
    return NextResponse.json(
      { error: "SOLANA_PLATFORM_KEYPAIR not configured" },
      { status: 500 },
    );
  }

  try {
    const address = keypair.publicKey.toBase58();

    const connection = getConnection();
    const balanceLamports = await connection.getBalance(keypair.publicKey);
    const balanceSol = balanceLamports / LAMPORTS_PER_SOL;

    // Count agents that have been on-chain registered
    let totalSponsored = 0;
    try {
      const snap = await adminDb().collection("agents").where("onChainRegistered", "==", true).get();
      totalSponsored = snap.size;
    } catch {
      // Firestore may not have this field on all agents
    }

    // Estimate remaining registrations
    const estimatedRemaining = balanceSol > 0
      ? Math.floor(balanceSol / AVG_REGISTRATION_COST_SOL)
      : 0;

    return NextResponse.json({
      address,
      balanceSol: Math.round(balanceSol * 10000) / 10000,
      balanceLamports: balanceLamports.toString(),
      totalSponsored,
      estimatedRemaining,
      avgCostSol: AVG_REGISTRATION_COST_SOL,
      chain: "solana-devnet",
      chainId: 0,
      explorerUrl: `https://solscan.io/account/${address}?cluster=devnet`,
    });
  } catch (err: unknown) {
    console.error("Gas sponsor status error:", err);
    return NextResponse.json(
      { error: "Failed to fetch sponsor wallet status" },
      { status: 500 },
    );
  }
}
