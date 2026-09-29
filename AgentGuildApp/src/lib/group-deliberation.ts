/**
 * Group Deliberation System — Structured multi-agent debate, voting, and synthesis.
 *
 * Implements three deliberation patterns on top of the existing message router:
 *
 * 1. **Debate** — Agents propose solutions, critique each other, then a synthesizer
 *    produces the final output. Best for complex decisions where diverse perspectives
 *    improve quality.
 *
 * 2. **Vote** — Agents each produce a response, then vote on the best one.
 *    Best for selection/ranking tasks (code review, content moderation).
 *
 * 3. **Red Team / Blue Team** — One team argues for, another argues against,
 *    a judge evaluates. Best for adversarial testing, risk assessment, compliance.
 *
 * All mutations use Firestore transactions for race-condition safety.
 * Uses the existing session routing from message-router.mjs for agent communication.
 */

import { adminDb } from "./firebase-admin";
import { FieldValue } from "firebase-admin/firestore";

// ── Types ────────────────────────────────────────────────────────────────────

export type DeliberationType = "debate" | "vote" | "red_blue";

export type DeliberationStatus =
  | "setup"        // Configuring participants
  | "proposing"    // Agents generating initial proposals
  | "critiquing"   // Agents reviewing/critiquing others' proposals
  | "voting"       // Agents casting votes
  | "synthesizing" // Synthesizer producing final output
  | "completed"    // Done
  | "failed";      // Error

export interface Proposal {
  agentId: string;
  agentName: string;
  content: string;
  confidence: number; // 0-1
  reasoning?: string;
  submittedAt: number;
}

export interface Critique {
  fromAgentId: string;
  targetAgentId: string;
  content: string;
  sentiment: "support" | "challenge" | "neutral";
  strengthScore: number; // 0-1 how strong the proposal is
  submittedAt: number;
}

export interface Vote {
  voterId: string;
  /** Agent ID being voted for */
  selectedProposalAgentId: string;
  reason: string;
  submittedAt: number;
}

export interface DeliberationConfig {
  /** Type of deliberation */
  type: DeliberationType;
  /** The question/task being deliberated */
  topic: string;
  /** Organization ID */
  orgId: string;
  /** Who initiated the deliberation */
  initiatedBy: string;
  /** Maximum rounds of debate */
  maxRounds?: number;
  /** Timeout per round in ms */
  roundTimeoutMs?: number;
  /** Minimum proposals before moving to critique */
  minProposals?: number;
}

export interface DebateParticipants {
  /** Agents that propose solutions */
  proposerIds: string[];
  /** Agents that critique (can overlap with proposers) */
  reviewerIds: string[];
  /** Agent that produces final synthesis */
  synthesizerId: string;
}

export interface VoteParticipants {
  /** Agents that propose/vote */
  voterIds: string[];
}

export interface RedBlueParticipants {
  /** Agents arguing in favor */
  blueTeamIds: string[];
  /** Agents arguing against / finding flaws */
  redTeamIds: string[];
  /** Judge agent */
  judgeId: string;
}

export type Participants = DebateParticipants | VoteParticipants | RedBlueParticipants;

export interface Deliberation {
  id: string;
  config: DeliberationConfig;
  participants: Participants;
  status: DeliberationStatus;
  currentRound: number;
  proposals: Proposal[];
  critiques: Critique[];
  votes: Vote[];
  /** Final synthesized result */
  result?: {
    content: string;
    confidence: number;
    contributingAgents: string[];
    consensusLevel: number; // 0-1
  };
  createdAt: unknown;
  updatedAt: unknown;
  completedAt?: unknown;
}

// ── Validation ───────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ── Deliberation Manager ─────────────────────────────────────────────────────

export class DeliberationManager {
  /**
   * Create a new debate deliberation.
   */
  async createDebate(
    config: DeliberationConfig,
    participants: DebateParticipants,
  ): Promise<string> {
    const id = crypto.randomUUID();
    const deliberation: Omit<Deliberation, "createdAt" | "updatedAt"> = {
      id,
      config: { ...config, type: "debate" },
      participants,
      status: "proposing",
      currentRound: 1,
      proposals: [],
      critiques: [],
      votes: [],
    };

    await adminDb().collection("deliberations").doc(id).set({
      ...deliberation,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return id;
  }

  /**
   * Create a voting deliberation.
   */
  async createVote(
    config: DeliberationConfig,
    participants: VoteParticipants,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await adminDb().collection("deliberations").doc(id).set({
      id,
      config: { ...config, type: "vote" },
      participants,
      status: "proposing",
      currentRound: 1,
      proposals: [],
      critiques: [],
      votes: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return id;
  }

  /**
   * Create a red team / blue team deliberation.
   */
  async createRedBlue(
    config: DeliberationConfig,
    participants: RedBlueParticipants,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await adminDb().collection("deliberations").doc(id).set({
      id,
      config: { ...config, type: "red_blue" },
      participants,
      status: "proposing",
      currentRound: 1,
      proposals: [],
      critiques: [],
      votes: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return id;
  }

  /**
   * Submit a proposal from an agent.
   * Uses a Firestore transaction to prevent concurrent-write data loss.
   */
  async submitProposal(
    deliberationId: string,
    proposal: Omit<Proposal, "submittedAt">,
  ): Promise<void> {
    const ref = adminDb().collection("deliberations").doc(deliberationId);

    await adminDb().runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new Error("Deliberation not found");
      const delib = snap.data() as Deliberation;

      if (delib.status !== "proposing") {
        throw new Error(`Cannot submit proposal in status: ${delib.status}`);
      }

      // Prevent duplicate proposals from same agent in same round
      const alreadyProposed = delib.proposals.some(
        p => p.agentId === proposal.agentId && delib.currentRound === delib.currentRound,
      );
      if (alreadyProposed && delib.currentRound === 1) {
        // Only block duplicates in round 1; in later rounds agents refine
        const roundProposals = delib.proposals.filter(p => p.agentId === proposal.agentId);
        if (roundProposals.length >= delib.currentRound) {
          throw new Error(`Agent ${proposal.agentId} has already proposed in round ${delib.currentRound}`);
        }
      }

      const newProposal: Proposal = {
        ...proposal,
        confidence: clamp01(proposal.confidence),
        submittedAt: Date.now(),
      };
      const proposals = [...delib.proposals, newProposal];

      const minProposals = delib.config.minProposals || this.getExpectedProposalCount(delib);
      const shouldAdvance = proposals.length >= minProposals;

      txn.update(ref, {
        proposals,
        status: shouldAdvance ? this.getNextPhase(delib) : "proposing",
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  /**
   * Submit a critique of another agent's proposal.
   * Uses a Firestore transaction to prevent concurrent-write data loss.
   */
  async submitCritique(
    deliberationId: string,
    critique: Omit<Critique, "submittedAt">,
  ): Promise<void> {
    const ref = adminDb().collection("deliberations").doc(deliberationId);

    await adminDb().runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new Error("Deliberation not found");
      const delib = snap.data() as Deliberation;

      if (delib.status !== "critiquing") {
        throw new Error(`Cannot submit critique in status: ${delib.status}`);
      }

      // Prevent duplicate critiques (same reviewer → same target)
      const alreadyCritiqued = delib.critiques.some(
        c => c.fromAgentId === critique.fromAgentId && c.targetAgentId === critique.targetAgentId,
      );
      if (alreadyCritiqued) {
        throw new Error(
          `Agent ${critique.fromAgentId} has already critiqued ${critique.targetAgentId}`,
        );
      }

      const critiques = [...delib.critiques, {
        ...critique,
        strengthScore: clamp01(critique.strengthScore),
        submittedAt: Date.now(),
      }];

      const expectedCritiques = this.getExpectedCritiqueCount(delib);
      const currentCritiques = critiques.length;
      const shouldAdvance = currentCritiques >= expectedCritiques;

      const maxRounds = delib.config.maxRounds || 2;
      let nextStatus: DeliberationStatus = "critiquing";

      if (shouldAdvance) {
        if (delib.currentRound < maxRounds) {
          nextStatus = "proposing";
        } else {
          nextStatus = delib.config.type === "vote" ? "voting" : "synthesizing";
        }
      }

      txn.update(ref, {
        critiques,
        status: nextStatus,
        currentRound: nextStatus === "proposing" ? delib.currentRound + 1 : delib.currentRound,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  /**
   * Submit a vote.
   * Uses a Firestore transaction to prevent duplicate votes.
   */
  async submitVote(
    deliberationId: string,
    vote: Omit<Vote, "submittedAt">,
  ): Promise<void> {
    const ref = adminDb().collection("deliberations").doc(deliberationId);

    await adminDb().runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new Error("Deliberation not found");
      const delib = snap.data() as Deliberation;

      if (delib.status !== "voting") {
        throw new Error(`Cannot vote in status: ${delib.status}`);
      }

      // Prevent duplicate votes from same agent
      if (delib.votes.some(v => v.voterId === vote.voterId)) {
        throw new Error(`Agent ${vote.voterId} has already voted`);
      }

      // Validate the voted-for proposal exists
      if (!delib.proposals.some(p => p.agentId === vote.selectedProposalAgentId)) {
        throw new Error(`No proposal from agent ${vote.selectedProposalAgentId} to vote for`);
      }

      const votes = [...delib.votes, { ...vote, submittedAt: Date.now() }];

      const expectedVotes = this.getExpectedVoteCount(delib);
      const shouldAdvance = votes.length >= expectedVotes;

      if (shouldAdvance) {
        const result = this.tallyVotes(delib.proposals, votes);
        txn.update(ref, {
          votes,
          status: "completed",
          result,
          completedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        txn.update(ref, {
          votes,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
    });
  }

  /**
   * Submit the final synthesis (for debate and red/blue patterns).
   */
  async submitSynthesis(
    deliberationId: string,
    synthesis: { content: string; confidence: number },
  ): Promise<void> {
    const ref = adminDb().collection("deliberations").doc(deliberationId);

    await adminDb().runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new Error("Deliberation not found");
      const delib = snap.data() as Deliberation;

      if (delib.status !== "synthesizing") {
        throw new Error(`Cannot synthesize in status: ${delib.status}`);
      }

      const consensusLevel = this.calculateConsensus(delib);

      txn.update(ref, {
        status: "completed",
        result: {
          content: synthesis.content,
          confidence: clamp01(synthesis.confidence),
          contributingAgents: [
            ...new Set([
              ...delib.proposals.map(p => p.agentId),
              ...delib.critiques.map(c => c.fromAgentId),
            ]),
          ],
          consensusLevel,
        },
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
  }

  /**
   * Get a deliberation by ID.
   */
  async get(id: string): Promise<Deliberation | null> {
    const snap = await adminDb().collection("deliberations").doc(id).get();
    if (!snap.exists) return null;
    return snap.data() as Deliberation;
  }

  // ── Prompt Generation ──────────────────────────────────────────────────

  /**
   * Generate the prompt to send to a proposing agent.
   * Includes context from previous rounds if available.
   */
  buildProposalPrompt(delib: Deliberation, agentId: string): string {
    const parts: string[] = [
      `You are participating in a ${delib.config.type} deliberation.`,
      `\nTopic: ${delib.config.topic}`,
      `\nRound: ${delib.currentRound}`,
    ];

    // Include previous proposals and critiques for context
    if (delib.currentRound > 1) {
      parts.push("\n\n--- Previous Proposals ---");
      for (const p of delib.proposals) {
        parts.push(`\n[${p.agentName}]: ${p.content}`);
      }
      if (delib.critiques.length > 0) {
        parts.push("\n\n--- Critiques ---");
        for (const c of delib.critiques) {
          parts.push(`\n[${c.fromAgentId} → ${c.targetAgentId}] (${c.sentiment}): ${c.content}`);
        }
      }
      parts.push("\n\nConsider the feedback above and provide an improved proposal.");
    }

    if (delib.config.type === "red_blue") {
      const rb = delib.participants as RedBlueParticipants;
      const team = rb.blueTeamIds.includes(agentId) ? "BLUE (advocate)" : "RED (adversary)";
      parts.push(`\n\nYou are on team: ${team}`);
      if (team.includes("RED")) {
        parts.push("Your job is to find flaws, risks, and weaknesses.");
      } else {
        parts.push("Your job is to argue in favor and present strengths.");
      }
    }

    parts.push("\n\nProvide your response as JSON: { \"content\": \"...\", \"confidence\": 0.0-1.0, \"reasoning\": \"...\" }");

    return parts.join("");
  }

  /**
   * Generate the prompt to send to a critiquing agent.
   */
  buildCritiquePrompt(delib: Deliberation, targetProposal: Proposal): string {
    return [
      `You are reviewing a proposal in a ${delib.config.type} deliberation.`,
      `\nTopic: ${delib.config.topic}`,
      `\n\nProposal by ${targetProposal.agentName}:`,
      `${targetProposal.content}`,
      `\nConfidence: ${targetProposal.confidence}`,
      targetProposal.reasoning ? `\nReasoning: ${targetProposal.reasoning}` : "",
      "\n\nProvide your critique as JSON: { \"content\": \"...\", \"sentiment\": \"support|challenge|neutral\", \"strengthScore\": 0.0-1.0 }",
    ].join("\n");
  }

  /**
   * Generate the prompt for the synthesizer.
   */
  buildSynthesisPrompt(delib: Deliberation): string {
    const parts: string[] = [
      `You are the synthesizer for a ${delib.config.type} deliberation.`,
      `\nTopic: ${delib.config.topic}`,
      "\n\n--- All Proposals ---",
    ];

    for (const p of delib.proposals) {
      parts.push(`\n[${p.agentName}] (confidence: ${p.confidence}):\n${p.content}`);
    }

    if (delib.critiques.length > 0) {
      parts.push("\n\n--- All Critiques ---");
      for (const c of delib.critiques) {
        parts.push(`\n[${c.fromAgentId} → ${c.targetAgentId}] (${c.sentiment}, strength: ${c.strengthScore}):\n${c.content}`);
      }
    }

    parts.push("\n\nSynthesize the best elements from all proposals, incorporating critique feedback.");
    parts.push("Provide your synthesis as JSON: { \"content\": \"...\", \"confidence\": 0.0-1.0 }");

    return parts.join("");
  }

  // ── Internal Helpers ───────────────────────────────────────────────────

  private getExpectedProposalCount(delib: Deliberation): number {
    switch (delib.config.type) {
      case "debate":
        return (delib.participants as DebateParticipants).proposerIds.length;
      case "vote":
        return (delib.participants as VoteParticipants).voterIds.length;
      case "red_blue": {
        const rb = delib.participants as RedBlueParticipants;
        return rb.blueTeamIds.length + rb.redTeamIds.length;
      }
    }
  }

  private getExpectedCritiqueCount(delib: Deliberation): number {
    switch (delib.config.type) {
      case "debate": {
        const dp = delib.participants as DebateParticipants;
        // Each reviewer critiques each proposer they are not
        // If reviewer is also a proposer, they skip themselves; otherwise they critique all
        let count = 0;
        for (const reviewerId of dp.reviewerIds) {
          const isProposer = dp.proposerIds.includes(reviewerId);
          count += isProposer ? dp.proposerIds.length - 1 : dp.proposerIds.length;
        }
        return count;
      }
      case "vote":
        return 0; // No critique phase in vote
      case "red_blue": {
        const rb = delib.participants as RedBlueParticipants;
        // Red critiques all blue, blue critiques all red
        return rb.redTeamIds.length * rb.blueTeamIds.length +
               rb.blueTeamIds.length * rb.redTeamIds.length;
      }
    }
  }

  private getExpectedVoteCount(delib: Deliberation): number {
    if (delib.config.type === "vote") {
      return (delib.participants as VoteParticipants).voterIds.length;
    }
    return 0;
  }

  private getNextPhase(delib: Deliberation): DeliberationStatus {
    switch (delib.config.type) {
      case "debate":
        return "critiquing";
      case "vote":
        return "voting";
      case "red_blue":
        return "critiquing";
    }
  }

  private tallyVotes(
    proposals: Proposal[],
    votes: Vote[],
  ): Deliberation["result"] {
    if (proposals.length === 0 || votes.length === 0) {
      return {
        content: "",
        confidence: 0,
        contributingAgents: [],
        consensusLevel: 0,
      };
    }

    // Count votes per proposal
    const voteCounts = new Map<string, number>();
    for (const v of votes) {
      voteCounts.set(
        v.selectedProposalAgentId,
        (voteCounts.get(v.selectedProposalAgentId) || 0) + 1,
      );
    }

    // Find winner — on tie, pick the one with higher confidence
    let winnerId = "";
    let maxVotes = 0;
    let winnerConfidence = -1;
    for (const [agentId, count] of voteCounts) {
      const proposal = proposals.find(p => p.agentId === agentId);
      const confidence = proposal?.confidence ?? 0;
      if (count > maxVotes || (count === maxVotes && confidence > winnerConfidence)) {
        maxVotes = count;
        winnerId = agentId;
        winnerConfidence = confidence;
      }
    }

    const winningProposal = proposals.find(p => p.agentId === winnerId);
    const consensusLevel = maxVotes / votes.length;

    return {
      content: winningProposal?.content || "",
      confidence: winningProposal?.confidence || 0,
      contributingAgents: [...new Set(proposals.map(p => p.agentId))],
      consensusLevel,
    };
  }

  private calculateConsensus(delib: Deliberation): number {
    if (delib.critiques.length === 0) return 0.5;

    // Average strength score from critiques (clamped)
    const avgStrength =
      delib.critiques.reduce((sum, c) => sum + clamp01(c.strengthScore), 0) /
      delib.critiques.length;

    // Ratio of supportive critiques
    const supportRatio =
      delib.critiques.filter(c => c.sentiment === "support").length /
      delib.critiques.length;

    return avgStrength * 0.6 + supportRatio * 0.4;
  }
}
