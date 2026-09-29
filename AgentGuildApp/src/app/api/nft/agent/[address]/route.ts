/**
 * Dynamic NFT Metadata API — Agent Identity NFT
 *
 * Returns ERC721 metadata JSON for SwarmAgentIdentityNFT.
 * Metadata updates dynamically based on current credit score and trust score.
 *
 * Endpoint: GET /api/nft/agent/{agentAddress}
 * Returns: OpenSea-compatible ERC721 metadata JSON
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

/**
 * GET /api/nft/agent/[address]
 * Returns dynamic NFT metadata for an agent
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    const { address } = await params;

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return NextResponse.json(
        { error: "Invalid agent address" },
        { status: 400 }
      );
    }

    // Normalize address to lowercase
    const normalizedAddress = address.toLowerCase();

    // Query Firestore for agent by wallet address or derived agent address
    const agentsRef = adminDb().collection("agents");
    let querySnapshot = await agentsRef.where("walletAddress", "==", normalizedAddress).get();
    if (querySnapshot.empty) {
      querySnapshot = await agentsRef.where("agentAddress", "==", normalizedAddress).get();
    }

    if (querySnapshot.empty) {
      // Agent not found in database - return default metadata
      return NextResponse.json({
        name: `Agent #${address.slice(0, 6)}...${address.slice(-4)}`,
        description: "Swarm Protocol Agent Identity — Unregistered",
        image: `https://swarmprotocol.fun/api/nft/badge/${address}`,
        external_url: `https://swarmprotocol.fun/agents`,
        attributes: [
          {
            trait_type: "Status",
            value: "Unregistered",
          },
          {
            trait_type: "Credit Score",
            value: 0,
            display_type: "number",
          },
          {
            trait_type: "Trust Score",
            value: 0,
            display_type: "number",
          },
          {
            trait_type: "Tier",
            value: "None",
          },
        ],
      });
    }

    // Get agent data
    const agentDoc = querySnapshot.docs[0];
    const agent = agentDoc.data();

    const creditScore = agent.creditScore ?? 680;
    const trustScore = agent.trustScore ?? 50;
    const asn = agent.asn || "ASN-PENDING";
    const name = agent.name || "Unknown Agent";
    const registeredAt = agent.createdAt?.toDate
      ? agent.createdAt.toDate().toISOString().split("T")[0]
      : "Unknown";

    // Calculate reputation tier
    const tier =
      creditScore >= 850
        ? "Platinum"
        : creditScore >= 700
        ? "Gold"
        : creditScore >= 550
        ? "Silver"
        : "Bronze";

    // Calculate trust level
    const trustLevel =
      trustScore >= 70
        ? "Trusted"
        : trustScore >= 40
        ? "Moderate"
        : "Risky";

    // Return OpenSea-compatible ERC721 metadata
    return NextResponse.json({
      name: `${name} #${asn}`,
      description: `Swarm Protocol Agent Identity\n\nThis NFT represents the on-chain identity and reputation of "${name}" on the Swarm Protocol. The credit score (300-900) and trust score (0-100) update automatically as the agent completes tasks and builds reputation.\n\nASN: ${asn}\nWallet: ${address}`,
      image: `https://swarmprotocol.fun/api/nft/badge/${address}`,
      external_url: `https://swarmprotocol.fun/agents/${agentDoc.id}`,
      attributes: [
        {
          trait_type: "Agent Name",
          value: name,
        },
        {
          trait_type: "ASN",
          value: asn,
        },
        {
          trait_type: "Credit Score",
          value: creditScore,
          max_value: 900,
          display_type: "number",
        },
        {
          trait_type: "Trust Score",
          value: trustScore,
          max_value: 100,
          display_type: "number",
        },
        {
          trait_type: "Reputation Tier",
          value: tier,
        },
        {
          trait_type: "Trust Level",
          value: trustLevel,
        },
        {
          trait_type: "Status",
          value: agent.status || "offline",
        },
        {
          trait_type: "Registered",
          value: registeredAt,
        },
        {
          trait_type: "Tasks Completed",
          value: agent.tasksCompleted ?? 0,
          display_type: "number",
        },
        {
          trait_type: "Agent Type",
          value: agent.type || "Unknown",
        },
      ],
      properties: {
        // OpenSea custom properties
        credit_score: creditScore,
        trust_score: trustScore,
        tier,
        asn,
        wallet: address,
      },
    });
  } catch (error) {
    console.error("NFT metadata API error:", error);
    return NextResponse.json(
      { error: "Failed to fetch agent metadata" },
      { status: 500 }
    );
  }
}
