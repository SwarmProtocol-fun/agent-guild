/**
 * Agent Passport — read-only aggregation of an agent's identity, wallets,
 * capabilities, and reputation into one object.
 *
 * This introduces no new storage. Every field is assembled from data that
 * already exists (the `agents` doc, custodial wallets, resolved mod
 * capabilities, on-chain registration flags, privacy settings) — it exists
 * so callers (the discovery endpoint, a future SDK) have one shape to read
 * instead of five. See api/v1/agents/[id]/passport and api/v1/agents/discover.
 *
 * Cross-org visibility follows the same privacy model reputation-chain.ts's
 * isAgentPublic() uses: nothing is exposed to an org that isn't the agent's
 * own unless privacyLevel is "public", and sub-sections are gated further by
 * allowPublicProfile / allowPublicScores. Server-only (Firebase Admin SDK).
 */
import { getAgent, getAgentCapabilities } from "./firestore-admin";
import type { ResolvedCapability } from "./skills";
import type { ReportedSkill } from "./firestore";
import { listPublicAgentWallets, type PublicAgentWallet } from "./agent-wallets";
import { getPrivacySettings } from "./privacy-settings";
import { getTierForScore, CREDIT_SCORE_DEFAULT, TRUST_SCORE_DEFAULT, type TierDefinition } from "./credit-tiers";
import { liveStatus } from "./presence";

/** Same shape as GET /api/v1/agents/:id/wallets — see listPublicAgentWallets. */
export type PassportWallet = PublicAgentWallet;

export interface PassportReputation {
  creditScore: number;
  trustScore: number;
  tier: TierDefinition;
  tasksCompleted: number;
  scoreBreakdown?: {
    execution: number;
    reliability: number;
    settlement: number;
    trustNetwork: number;
    risk: number;
    confidence: number;
  };
}

export interface PassportOnChain {
  asn?: string;
  solanaRegistered: boolean;
  solanaTxHash?: string;
  erc8004TokenId?: string;
  erc8004ValidationCount?: number;
}

export interface AgentPassport {
  agentId: string;
  /** Omitted on a cross-org view — an agent's org is not public information. */
  orgId?: string;
  name: string;
  type: string;
  bio?: string;
  avatarUrl?: string;
  status: "online" | "offline" | "busy" | "paused";
  capabilities: ResolvedCapability[];
  reportedSkills: ReportedSkill[];
  wallets: PassportWallet[];
  /** Present only when the viewer is the agent's own org, or the agent allows public scores. */
  reputation?: PassportReputation;
  onChain: PassportOnChain;
  generatedAt: string;
}

export interface BuildPassportOptions {
  /** Org the requester belongs to. Full detail is returned when this matches the agent's own org. */
  viewerOrgId?: string;
  /** Look up live wallet balances (default true). Discovery turns this off — it builds many passports per request. */
  walletBalances?: boolean;
}

/**
 * Builds the passport for one agent. Returns null when the agent doesn't
 * exist, or (for a cross-org viewer) when the agent hasn't opted into a
 * public profile — same "return nothing rather than a 403" shape as
 * isAgentPublic()'s fail-closed default, so a private agent's existence
 * isn't confirmed by a non-null response either way.
 */
export async function buildAgentPassport(
  agentId: string,
  options: BuildPassportOptions = {},
): Promise<AgentPassport | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;

  const isOwnOrg = options.viewerOrgId != null && options.viewerOrgId === agent.orgId;
  const privacy = await getPrivacySettings(agent.orgId, agentId);
  const isPublic = privacy.privacyLevel === "public";

  if (!isOwnOrg && !isPublic) return null;
  const showProfile = isOwnOrg || privacy.allowPublicProfile;
  if (!showProfile) return null;
  const showScores = isOwnOrg || privacy.allowPublicScores;

  const [capabilities, wallets] = await Promise.all([
    getAgentCapabilities(agentId, agent.orgId).catch(() => [] as ResolvedCapability[]),
    listPublicAgentWallets(agentId, agent, { balances: options.walletBalances !== false })
      .then((list) => list.wallets)
      .catch(() => [] as PassportWallet[]),
  ]);

  const creditScore = agent.creditScore ?? CREDIT_SCORE_DEFAULT;
  const trustScore = agent.trustScore ?? TRUST_SCORE_DEFAULT;

  const passport: AgentPassport = {
    agentId: agent.id,
    ...(isOwnOrg ? { orgId: agent.orgId } : {}),
    name: agent.name,
    type: agent.type,
    bio: agent.bio,
    avatarUrl: agent.avatarUrl,
    status: liveStatus({ status: agent.status, lastSeen: agent.lastSeen, offlineAt: agent.offlineAt }),
    capabilities,
    reportedSkills: agent.reportedSkills ?? [],
    wallets,
    onChain: {
      asn: agent.asn,
      solanaRegistered: agent.onChainRegistered ?? false,
      solanaTxHash: agent.onChainTxHash,
      erc8004TokenId: agent.erc8004TokenId,
      erc8004ValidationCount: agent.erc8004ValidationCount,
    },
    generatedAt: new Date().toISOString(),
  };

  if (showScores) {
    passport.reputation = {
      creditScore,
      trustScore,
      tier: getTierForScore(creditScore),
      tasksCompleted: agent.tasksCompleted ?? 0,
      scoreBreakdown: agent.scoreBreakdown
        ? {
            execution: agent.scoreBreakdown.execution,
            reliability: agent.scoreBreakdown.reliability,
            settlement: agent.scoreBreakdown.settlement,
            trustNetwork: agent.scoreBreakdown.trustNetwork,
            risk: agent.scoreBreakdown.risk,
            confidence: agent.scoreBreakdown.confidence,
          }
        : undefined,
    };
  }

  return passport;
}
