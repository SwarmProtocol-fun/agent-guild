/**
 * Dynamic NFT Card Image API — Agent Identity NFT
 *
 * Generates a card-shaped SVG with dynamic agent status for SwarmAgentIdentityNFT.
 * Card displays credit score, trust score, tier badge, status indicator,
 * skills, and Swarm branding with animated glow effects.
 *
 * Endpoint: GET /api/nft/badge/{agentAddress}
 * Returns: SVG image (card aspect ratio)
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";

// Tier configuration
const TIERS = {
  Platinum: { color: "#06b6d4", glow: "#22d3ee", bg1: "#0e2a35", bg2: "#0a1929", icon: "P", ring: "#67e8f9" },
  Gold:     { color: "#eab308", glow: "#facc15", bg1: "#2a2510", bg2: "#1a1708", icon: "G", ring: "#fde047" },
  Silver:   { color: "#94a3b8", glow: "#cbd5e1", bg1: "#1e2530", bg2: "#131a24", icon: "S", ring: "#e2e8f0" },
  Bronze:   { color: "#f97316", glow: "#fb923c", bg1: "#2a1a10", bg2: "#1a1008", icon: "B", ring: "#fdba74" },
} as const;

type TierName = keyof typeof TIERS;

function getTier(creditScore: number): TierName {
  if (creditScore >= 850) return "Platinum";
  if (creditScore >= 700) return "Gold";
  if (creditScore >= 550) return "Silver";
  return "Bronze";
}

function getStatusColor(status: string): string {
  switch (status) {
    case "online": return "#22c55e";
    case "busy": return "#f59e0b";
    case "offline": return "#6b7280";
    default: return "#6b7280";
  }
}

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    const { address } = await params;

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return new NextResponse("Invalid address", { status: 400 });
    }

    const normalizedAddress = address.toLowerCase();

    // Query Firestore for agent by walletAddress or agentAddress
    const agentsRef = adminDb().collection("agents");
    let querySnapshot = await agentsRef.where("walletAddress", "==", normalizedAddress).get();
    if (querySnapshot.empty) {
      querySnapshot = await agentsRef.where("agentAddress", "==", normalizedAddress).get();
    }

    let name = "Unknown Agent";
    let asn = "ASN-PENDING";
    let creditScore = 680;
    let trustScore = 50;
    let status = "offline";
    let agentType = "agent";
    let skillsList: string[] = [];
    let tasksCompleted = 0;

    if (!querySnapshot.empty) {
      const agent = querySnapshot.docs[0].data();
      name = agent.name || "Unknown Agent";
      asn = agent.asn || "ASN-PENDING";
      creditScore = agent.creditScore ?? 680;
      trustScore = agent.trustScore ?? 50;
      status = agent.status || "offline";
      agentType = agent.type || "agent";
      tasksCompleted = agent.tasksCompleted ?? 0;
      if (Array.isArray(agent.reportedSkills)) {
        skillsList = agent.reportedSkills.slice(0, 4).map((s: { name?: string }) => s.name || "skill");
      }
    }

    const tier = getTier(creditScore);
    const t = TIERS[tier];
    const statusColor = getStatusColor(status);
    const displayName = escapeXml(name.length > 22 ? name.substring(0, 22) + "..." : name);
    const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;
    const creditPct = Math.round(((creditScore - 300) / 600) * 100);
    const trustPct = trustScore;

    const svg = `<svg width="400" height="560" viewBox="0 0 400 560" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Card background gradient -->
    <linearGradient id="cardBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${t.bg1}"/>
      <stop offset="50%" stop-color="${t.bg2}"/>
      <stop offset="100%" stop-color="#080c14"/>
    </linearGradient>
    <!-- Tier accent gradient -->
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${t.color}" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="${t.glow}" stop-opacity="0.4"/>
    </linearGradient>
    <!-- Score bar gradient -->
    <linearGradient id="scoreBar" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="${t.color}"/>
      <stop offset="100%" stop-color="${t.glow}"/>
    </linearGradient>
    <!-- Glow filter -->
    <filter id="glow">
      <feGaussianBlur stdDeviation="4" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <!-- Soft shadow -->
    <filter id="shadow">
      <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="#000" flood-opacity="0.5"/>
    </filter>
    <!-- Card clip -->
    <clipPath id="cardClip"><rect width="400" height="560" rx="20"/></clipPath>
  </defs>

  <!-- Card body -->
  <g clip-path="url(#cardClip)">
    <rect width="400" height="560" fill="url(#cardBg)"/>

    <!-- Subtle grid pattern -->
    <g opacity="0.03" stroke="white" stroke-width="0.5">
      ${Array.from({ length: 20 }, (_, i) => `<line x1="0" y1="${i * 28}" x2="400" y2="${i * 28}"/>`).join("")}
      ${Array.from({ length: 15 }, (_, i) => `<line x1="${i * 28}" y1="0" x2="${i * 28}" y2="560"/>`).join("")}
    </g>

    <!-- Top accent bar -->
    <rect x="0" y="0" width="400" height="4" fill="url(#accent)"/>

    <!-- Tier glow orb (top right) -->
    <circle cx="340" cy="60" r="50" fill="${t.color}" opacity="0.06"/>
    <circle cx="340" cy="60" r="25" fill="${t.color}" opacity="0.08"/>

    <!-- SWARM PROTOCOL header -->
    <text x="24" y="38" font-family="monospace" font-size="10" fill="white" opacity="0.35" letter-spacing="3">SWARM PROTOCOL</text>

    <!-- Tier badge (top right) -->
    <g transform="translate(340, 34)" filter="url(#glow)">
      <rect x="-32" y="-12" width="64" height="24" rx="12" fill="${t.color}" opacity="0.15" stroke="${t.color}" stroke-width="1"/>
      <text x="0" y="5" font-family="monospace" font-size="11" font-weight="bold" text-anchor="middle" fill="${t.color}">${tier.toUpperCase()}</text>
    </g>

    <!-- Agent avatar circle -->
    <g transform="translate(200, 110)">
      <!-- Outer ring -->
      <circle cx="0" cy="0" r="46" fill="none" stroke="${t.ring}" stroke-width="2" opacity="0.3"/>
      <!-- Inner circle -->
      <circle cx="0" cy="0" r="40" fill="${t.bg1}" stroke="${t.color}" stroke-width="1.5" opacity="0.8"/>
      <!-- Agent type icon -->
      <text x="0" y="8" font-size="28" text-anchor="middle" fill="${t.color}" font-weight="bold">${agentType === "swarm" ? "S" : agentType === "coordinator" ? "C" : "A"}</text>
      <!-- Status indicator dot -->
      <circle cx="30" cy="30" r="8" fill="${statusColor}" stroke="${t.bg2}" stroke-width="3"/>
    </g>

    <!-- Agent name -->
    <text x="200" y="180" font-family="sans-serif" font-size="20" font-weight="bold" text-anchor="middle" fill="white">${displayName}</text>

    <!-- ASN -->
    <text x="200" y="202" font-family="monospace" font-size="11" text-anchor="middle" fill="${t.color}" opacity="0.8">${escapeXml(asn)}</text>

    <!-- Wallet address -->
    <text x="200" y="222" font-family="monospace" font-size="10" text-anchor="middle" fill="white" opacity="0.3">${shortAddr}</text>

    <!-- Divider -->
    <line x1="30" y1="240" x2="370" y2="240" stroke="${t.color}" stroke-width="0.5" opacity="0.2"/>

    <!-- Credit Score section -->
    <g transform="translate(30, 260)">
      <text x="0" y="0" font-family="monospace" font-size="9" fill="white" opacity="0.4" letter-spacing="2">CREDIT SCORE</text>
      <text x="340" y="0" font-family="monospace" font-size="9" fill="${t.color}" text-anchor="end">${creditScore} / 900</text>
      <!-- Score bar background -->
      <rect x="0" y="10" width="340" height="8" rx="4" fill="white" opacity="0.05"/>
      <!-- Score bar fill -->
      <rect x="0" y="10" width="${Math.round(340 * creditPct / 100)}" height="8" rx="4" fill="url(#scoreBar)"/>
    </g>

    <!-- Trust Score section -->
    <g transform="translate(30, 300)">
      <text x="0" y="0" font-family="monospace" font-size="9" fill="white" opacity="0.4" letter-spacing="2">TRUST SCORE</text>
      <text x="340" y="0" font-family="monospace" font-size="9" fill="${t.color}" text-anchor="end">${trustScore} / 100</text>
      <!-- Score bar background -->
      <rect x="0" y="10" width="340" height="8" rx="4" fill="white" opacity="0.05"/>
      <!-- Score bar fill -->
      <rect x="0" y="10" width="${Math.round(340 * trustPct / 100)}" height="8" rx="4" fill="url(#scoreBar)"/>
    </g>

    <!-- Divider -->
    <line x1="30" y1="335" x2="370" y2="335" stroke="${t.color}" stroke-width="0.5" opacity="0.2"/>

    <!-- Stats row -->
    <g transform="translate(0, 355)">
      <!-- Status -->
      <g transform="translate(70, 0)">
        <text x="0" y="0" font-family="monospace" font-size="9" text-anchor="middle" fill="white" opacity="0.4" letter-spacing="1">STATUS</text>
        <circle cx="-18" cy="17" r="4" fill="${statusColor}"/>
        <text x="2" y="22" font-family="sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="${statusColor}">${status.toUpperCase()}</text>
      </g>
      <!-- Tasks -->
      <g transform="translate(200, 0)">
        <text x="0" y="0" font-family="monospace" font-size="9" text-anchor="middle" fill="white" opacity="0.4" letter-spacing="1">TASKS</text>
        <text x="0" y="22" font-family="sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="white">${tasksCompleted}</text>
      </g>
      <!-- Type -->
      <g transform="translate(330, 0)">
        <text x="0" y="0" font-family="monospace" font-size="9" text-anchor="middle" fill="white" opacity="0.4" letter-spacing="1">TYPE</text>
        <text x="0" y="22" font-family="sans-serif" font-size="13" font-weight="bold" text-anchor="middle" fill="${t.color}">${escapeXml(agentType.toUpperCase())}</text>
      </g>
    </g>

    <!-- Skills tags -->
    ${skillsList.length > 0 ? `
    <g transform="translate(30, 410)">
      <text x="0" y="0" font-family="monospace" font-size="9" fill="white" opacity="0.4" letter-spacing="2">SKILLS</text>
      ${skillsList.map((skill, i) => {
        const x = i * 85;
        const displaySkill = escapeXml(skill.length > 10 ? skill.substring(0, 10) : skill);
        return `<g transform="translate(${x}, 10)">
          <rect x="0" y="0" width="80" height="22" rx="11" fill="${t.color}" opacity="0.1" stroke="${t.color}" stroke-width="0.5" opacity="0.3"/>
          <text x="40" y="15" font-family="monospace" font-size="9" text-anchor="middle" fill="${t.color}">${displaySkill}</text>
        </g>`;
      }).join("")}
    </g>` : ""}

    <!-- Bottom section -->
    <g transform="translate(0, 480)">
      <!-- Divider -->
      <line x1="30" y1="0" x2="370" y2="0" stroke="${t.color}" stroke-width="0.5" opacity="0.2"/>

      <!-- Hedera badge -->
      <g transform="translate(30, 20)">
        <rect x="0" y="0" width="90" height="24" rx="12" fill="#10b981" opacity="0.12" stroke="#10b981" stroke-width="0.5" opacity="0.3"/>
        <text x="45" y="16" font-family="monospace" font-size="9" font-weight="bold" text-anchor="middle" fill="#10b981">HEDERA</text>
      </g>

      <!-- Soulbound badge -->
      <g transform="translate(130, 20)">
        <rect x="0" y="0" width="100" height="24" rx="12" fill="${t.color}" opacity="0.12" stroke="${t.color}" stroke-width="0.5" opacity="0.3"/>
        <text x="50" y="16" font-family="monospace" font-size="9" font-weight="bold" text-anchor="middle" fill="${t.color}">SOULBOUND</text>
      </g>

      <!-- Chain ID -->
      <text x="370" y="36" font-family="monospace" font-size="9" text-anchor="end" fill="white" opacity="0.2">Chain 296</text>
    </g>

    <!-- Bottom branding -->
    <text x="200" y="542" font-family="monospace" font-size="9" text-anchor="middle" fill="white" opacity="0.15" letter-spacing="4">SWARM AGENT IDENTITY</text>

    <!-- Card border -->
    <rect x="1" y="1" width="398" height="558" rx="20" fill="none" stroke="${t.color}" stroke-width="1" opacity="0.15"/>
  </g>
</svg>`;

    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (error) {
    console.error("NFT badge API error:", error);
    const fallbackSvg = `<svg width="400" height="560" viewBox="0 0 400 560" xmlns="http://www.w3.org/2000/svg">
  <rect width="400" height="560" rx="20" fill="#0f172a" stroke="#334155" stroke-width="1"/>
  <text x="200" y="270" font-size="18" text-anchor="middle" fill="white" opacity="0.5">Swarm Agent Card</text>
  <text x="200" y="295" font-size="12" text-anchor="middle" fill="white" opacity="0.3">Loading...</text>
</svg>`;
    return new NextResponse(fallbackSvg, {
      headers: { "Content-Type": "image/svg+xml" },
    });
  }
}
