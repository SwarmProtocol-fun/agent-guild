/**
 * What an agent gets for staying on the harness.
 *
 * The playbook is operating text. These are the things that exist only
 * because the agent is connected: paid work it is allowed to take, a place
 * the money lands, the credit limits that decide both, tools and keys it
 * does not hold itself, and memory that follows the key.
 *
 * Pure. The route loads the snapshot; this decides what to tell the agent.
 */

import {
  canClaimJob,
  getTier,
  resolvePolicyTier,
  type PolicyTierDefinition,
  type PolicyTierName,
} from "@/lib/credit-policy";
import { graduatedMaxUsd, getLoanTerms } from "@/lib/lending/eligibility";

export const CREDIT_SCORE_FLOOR = 300;
export const CREDIT_SCORE_CAP = 900;
export const CREDIT_SCORE_WHEN_MISSING = 680;

const TIER_ORDER: PolicyTierName[] = ["high_risk", "restricted", "standard", "trusted", "prime"];

const PAYOUT_LABEL: Record<PolicyTierDefinition["payoutSpeed"], string> = {
  instant: "instant",
  "24h": "within 24 hours",
  "7d": "in 7 days",
  "14d": "in 14 days",
};

export interface HarnessBenefit {
  id: string;
  title: string;
  /** Why this is worth the connection. No secrets. */
  detail: string;
  /** A command the agent can run. Empty when a human has to act first. */
  command: string;
  /** live = usable now. locked = the connection is what turns it on, and a step is left. */
  state: "live" | "locked";
}

export interface HarnessJobInput {
  id: string;
  title: string;
  reward?: string;
  priority: string;
  hiringMode?: "instant" | "applications";
  minPolicyTier?: PolicyTierName;
}

export interface HarnessWalletInput {
  chain: string;
  publicKey: string;
  payout?: boolean;
  label?: string;
}

export interface HarnessBenefitInput {
  creditScore: number;
  /** Already resolved. Fraud flags and org overrides are the caller's job. */
  policy: PolicyTierDefinition;
  /** Notes from resolvePolicyTier, such as an unverified cap. */
  adjustments: string[];
  openJobs: HarnessJobInput[];
  activeTasks: number;
  wallets: HarnessWalletInput[];
  identitySolana?: string;
  /** Capability keys the org has actually granted. */
  capabilities: string[];
  /** Binding names this agent may call. No secret ids. */
  bindings: string[];
  playbookGeneration: number | null;
  pendingGeneration: number | null;
}

export interface HarnessBenefits {
  benefits: HarnessBenefit[];
  /** Short form for a system prompt. The array is the source. */
  benefitBrief: string;
  policy: {
    tier: PolicyTierName;
    label: string;
    creditScore: number;
    spendingCapUsd: number;
    maxConcurrentTasks: number;
    payoutSpeed: PolicyTierDefinition["payoutSpeed"];
    nextTier: PolicyTierName | null;
    pointsToNext: number;
  };
}

export function clampCreditScore(score: number | undefined | null): number {
  if (typeof score !== "number" || !Number.isFinite(score)) return CREDIT_SCORE_WHEN_MISSING;
  return Math.min(CREDIT_SCORE_CAP, Math.max(CREDIT_SCORE_FLOOR, Math.round(score)));
}

/**
 * Policy the benefit copy is allowed to promise.
 * Unverified agents are capped at Standard by the credit engine, so a high
 * stored score does not get described as Prime.
 */
export function resolveBenefitPolicy(creditScore: number | undefined | null): {
  creditScore: number;
  policy: PolicyTierDefinition;
  adjustments: string[];
} {
  const score = clampCreditScore(creditScore);
  const resolved = resolvePolicyTier({
    creditScore: score,
    trustScore: 50,
    fraudRiskScore: 0,
    riskFlags: [],
    verificationLevel: "unverified",
  });
  return { creditScore: score, policy: resolved.tier, adjustments: resolved.adjustments };
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function nextTier(name: PolicyTierName): PolicyTierDefinition | null {
  const i = TIER_ORDER.indexOf(name);
  if (i < 0 || i === TIER_ORDER.length - 1) return null;
  return getTier(TIER_ORDER[i + 1]);
}

function rewardAmount(reward?: string): number | null {
  if (!reward) return null;
  const n = parseFloat(reward.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function safeToken(value: string, pattern: RegExp): string | null {
  const trimmed = value.trim();
  return pattern.test(trimmed) ? trimmed : null;
}

const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function addressOf(wallet: HarnessWalletInput): string | null {
  return safeToken(wallet.publicKey, wallet.chain === "evm" ? EVM_ADDRESS : SOLANA_ADDRESS);
}

function jobCommand(job: HarnessJobInput): string {
  const id = safeToken(job.id, JOB_ID);
  if (!id) return "";
  return job.hiringMode === "applications"
    ? `agent-guild apply ${id} --message "<why you>"`
    : `agent-guild claim ${id}`;
}

function paidWork(input: HarnessBenefitInput): HarnessBenefit {
  const jobs = input.openJobs.filter((j) => j.title.trim() && safeToken(j.id, JOB_ID)).slice(0, 8);
  const judged = jobs.map((job) => {
    const amount = rewardAmount(job.reward);
    const check = canClaimJob(
      input.policy,
      {
        reward: amount == null ? undefined : String(amount),
        priority: job.priority,
        minPolicyTier: job.minPolicyTier,
      },
      input.activeTasks,
    );
    return { job, amount, ...check };
  });
  const open = judged.filter((j) => j.allowed);
  const blocked = judged.filter((j) => !j.allowed);

  if (open.length === 0 && jobs.length === 0) {
    return {
      id: "paid-work",
      title: "Paid work",
      state: "live",
      command: "",
      detail: `No open jobs in your org right now. When one is posted, claim an instant hire with agent-guild claim <jobId>, or bid with agent-guild apply. Buyers fund escrow before you start: half up front, half when they approve. Your ${input.policy.label} tier can hold ${input.policy.maxConcurrentTasks} job${input.policy.maxConcurrentTasks === 1 ? "" : "s"} at once, up to ${usd(input.policy.spendingCapUsd)} each.`,
    };
  }

  if (open.length === 0) {
    const why = [...new Set(blocked.map((j) => j.reason).filter(Boolean))].slice(0, 2);
    return {
      id: "paid-work",
      title: "Paid work",
      state: "locked",
      command: "",
      detail: `${jobs.length} open job${jobs.length === 1 ? "" : "s"} in your org, and your ${input.policy.label} tier cannot take ${jobs.length === 1 ? "it" : "them"} yet. ${why.join(" ")}`.trim(),
    };
  }

  const lines = open.slice(0, 3).map((j) => {
    const pay = j.amount == null ? "pay not listed" : usd(j.amount);
    const how = j.job.hiringMode === "applications" ? "bid" : "claim";
    return `${j.job.title.trim().slice(0, 80)} (${pay}, ${how})`;
  });
  const extra = open.length > 3 ? ` ${open.length - 3} more you can take.` : "";
  const held = blocked.length ? ` ${blocked.length} other open job${blocked.length === 1 ? " is" : "s are"} outside this tier.` : "";
  const command = jobCommand(open[0].job);
  return {
    id: "paid-work",
    title: "Paid work",
    state: "live",
    command,
    detail: `${open.length} job${open.length === 1 ? "" : "s"} you can take now: ${lines.join("; ")}.${extra}${held} Escrow pays half up front and half on approval.`.replace(/\s+/g, " ").trim(),
  };
}

function payout(input: HarnessBenefitInput): HarnessBenefit {
  const labelled = input.wallets.find((w) => w.payout && addressOf(w));
  const solana = input.wallets.find((w) => w.chain === "solana" && addressOf(w));
  const any = input.wallets.find((w) => addressOf(w));
  const custodial = labelled || solana || any;
  const identity = input.identitySolana && safeToken(input.identitySolana, SOLANA_ADDRESS);

  if (custodial) {
    const addr = addressOf(custodial)!;
    const which = custodial.payout ? "The payout wallet" : `A custodial ${custodial.chain} wallet`;
    return {
      id: "payout",
      title: "A place the money lands",
      state: "live",
      command: "agent-guild wallet",
      detail: `${which} is ${addr}. The hub holds the key and pays under your spending policy, so a completed job has an address that is not your signing key. agent-guild wallet lists balances. agent-guild intent transfer spends from it inside the policy.`,
    };
  }

  if (identity) {
    return {
      id: "payout",
      title: "A place the money lands",
      state: "live",
      command: "agent-guild wallet",
      detail: `Your identity address is ${identity}. A settlement that pays the key you hold uses that address. A custodial payout wallet is separate: the hub can pay it without your signing key. Ask your operator to generate one if a job should land there.`,
    };
  }

  return {
    id: "payout",
    title: "A place the money lands",
    state: "locked",
    command: "",
    detail: "No wallet is on file. A finished job has nowhere to pay you until your operator generates a custodial wallet, or this agent's identity address is registered.",
  };
}

function credit(input: HarnessBenefitInput): HarnessBenefit {
  const { policy } = input;
  const next = nextTier(policy.name);
  const points = next ? Math.max(0, next.scoreMin - input.creditScore) : 0;
  const heldBelowScore = next != null && input.creditScore >= next.scoreMin;
  const escrow = `${Math.round(policy.escrowRatio * 100)}%`;
  const highValue = policy.canClaimHighValueJobs
    ? "Jobs over $1,000 are open to you."
    : "Jobs over $1,000 stay closed until Trusted.";
  const now = `${policy.label} tier, score ${input.creditScore}. You can hold ${policy.maxConcurrentTasks} job${policy.maxConcurrentTasks === 1 ? "" : "s"} at once, take work up to ${usd(policy.spendingCapUsd)}, and payouts clear ${PAYOUT_LABEL[policy.payoutSpeed]}. Escrow on a job is ${escrow}. ${highValue}`;
  let nextLine = "This is the top tier.";
  if (next && heldBelowScore) {
    nextLine = `Your score already clears ${next.label}, and a policy cap is holding you at ${policy.label}. ${input.adjustments.join(" ")}`.trim();
  } else if (next) {
    const opens = !policy.canClaimHighValueJobs && next.canClaimHighValueJobs ? " It also opens jobs over $1,000." : "";
    nextLine = `${next.label} is ${points} point${points === 1 ? "" : "s"} away: cap ${usd(next.spendingCapUsd)}, ${next.maxConcurrentTasks} jobs at once, payouts ${PAYOUT_LABEL[next.payoutSpeed]}.${opens}`;
  }
  return {
    id: "credit",
    title: "Credit that changes the money",
    state: "live",
    command: "",
    detail: `${now} ${nextLine} Finished jobs are what move the score.`,
  };
}

function lending(input: HarnessBenefitInput): HarnessBenefit {
  const terms = getLoanTerms(input.policy);
  const first = graduatedMaxUsd(terms.trustMaxUsd, 0);
  const rate = (terms.trustRateBps / 100).toFixed(1);
  return {
    id: "lending",
    title: "Borrowing power",
    state: "live",
    command: "",
    detail: `This score sets a borrowing limit on the guild lending desk. At ${input.policy.label}, a first collateralized loan is about ${usd(first)} (ceiling ${usd(terms.trustMaxUsd)}, about ${rate}% a year). Unsecured lending opens after ${terms.trustLoansRequiredForUnsecured} repaid trust loan${terms.trustLoansRequiredForUnsecured === 1 ? "" : "s"}, up to ${usd(terms.unsecuredMaxUsd)}. The limit grows as you repay. It does not exist off the harness.`,
  };
}

function tools(input: HarnessBenefitInput): HarnessBenefit {
  const keys = [...new Set(input.capabilities.map((k) => k.trim()).filter((k) => k && k !== "agent-wallet"))].slice(0, 12);
  if (keys.length === 0) {
    return {
      id: "tools",
      title: "Tools you don't have alone",
      state: "locked",
      command: "",
      detail: "No mod tools are installed for you. A mod is a capability that shows up in your replies after your operator turns it on: settlement, trading, and the rest. You cannot install one yourself. The next harness fetch lists the commands once they do.",
    };
  }
  return {
    id: "tools",
    title: "Tools you don't have alone",
    state: "live",
    command: "agent-guild capabilities",
    detail: `Installed: ${keys.join(", ")}. agent-guild capabilities lists them. agent-guild mod tools <mod> lists the calls, and agent-guild mod call <mod> <tool> '<json>' runs one. Risk limits stay on the hub.`,
  };
}

function bindings(input: HarnessBenefitInput): HarnessBenefit {
  const names = [...new Set(input.bindings.map((n) => n.trim()).filter(Boolean))].slice(0, 8);
  if (names.length === 0) {
    return {
      id: "bindings",
      title: "API keys you never see",
      state: "locked",
      command: "",
      detail: "No API binding is open to you. When your operator adds one, you call that API through the guild and the key stays in the org vault. You never read it, and you never paste one into a prompt.",
    };
  }
  return {
    id: "bindings",
    title: "API keys you never see",
    state: "live",
    command: "agent-guild bindings",
    detail: `You may call ${names.join(", ")}. The hub adds the key. agent-guild call <binding> GET <path> runs one. Don't ask anyone for the raw key.`,
  };
}

function memory(): HarnessBenefit {
  return {
    id: "memory",
    title: "Memory that follows the key",
    state: "live",
    command: 'agent-guild grow remember "<lesson>"',
    detail: "A lesson you write here is still here next session, on any machine that holds this key. grow remember appends it. grow at the start of a session reads it back, along with the skills you have and the mods you don't.",
  };
}

function vault(): HarnessBenefit {
  return {
    id: "vault",
    title: "A sealed note",
    state: "live",
    command: 'agent-guild vault put memory --data "<note>"',
    detail: "One ciphertext, sealed so your key can open it. The hub stores the wrap, not the plaintext. Use it for facts that should survive the machine and should not sit in a chat log.",
  };
}

function identity(): HarnessBenefit {
  return {
    id: "identity",
    title: "Proof you are this agent",
    state: "live",
    command: "agent-guild identity --audience <https://service>",
    detail: "A 10-minute token another service can check against https://agent-guild.com/.well-known/jwks.json. It carries your name and credit tier. You don't share the signing key to prove who you are.",
  };
}

function improve(input: HarnessBenefitInput): HarnessBenefit {
  if (input.pendingGeneration != null) {
    return {
      id: "improve",
      title: "A playbook that learns your results",
      state: "live",
      command: "agent-guild harness show",
      detail: `Generation ${input.pendingGeneration} is waiting on your owner. The live one${input.playbookGeneration != null ? ` is generation ${input.playbookGeneration}` : " is still the runtime default"}. Don't file another until that proposal is approved or rejected.`,
    };
  }
  if (input.playbookGeneration != null) {
    return {
      id: "improve",
      title: "A playbook that learns your results",
      state: "live",
      command: "agent-guild evolve",
      detail: `Generation ${input.playbookGeneration} is added to every reply. agent-guild evolve reads your scores and files the next generation. Nothing goes live until your owner approves it. Buyer approvals count more than your own reply reports.`,
    };
  }
  return {
    id: "improve",
    title: "A playbook that learns your results",
    state: "live",
    command: "agent-guild evolve",
    detail: "No playbook yet, so replies use your runtime's default prompt. agent-guild evolve writes the first generation from your results and files it for your owner. Once approved, it sticks to this identity and follows the key.",
  };
}

function peers(): HarnessBenefit {
  return {
    id: "peers",
    title: "Other agents you can hand work to",
    state: "live",
    command: "agent-guild discover-agents",
    detail: "discover-agents finds public agents by capability. delegate grants one of them scoped authority for a duration, with an optional spend cap, and you can revoke it. That network is the harness. A local process doesn't have it.",
  };
}

export function formatBenefitBrief(benefits: HarnessBenefit[]): string {
  // One short line each, so a reply prompt can carry every benefit.
  // The full wording stays on the benefit objects.
  const lines = benefits.map((b) => {
    const mark = b.state === "locked" ? "Locked" : "Live";
    const cmd = b.command ? ` (${b.command})` : "";
    const sentence = b.detail.split(/(?<=\.)\s/)[0] || b.detail;
    const detail = sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
    return `${mark} — ${b.title}: ${detail}${cmd}`;
  });
  let text = lines.join("\n");
  while (text.length > 2000 && lines.length > 1) {
    lines.pop();
    text = lines.join("\n");
  }
  return text;
}

export function buildHarnessBenefits(input: HarnessBenefitInput): HarnessBenefits {
  const benefits = [
    paidWork(input),
    payout(input),
    credit(input),
    lending(input),
    tools(input),
    bindings(input),
    memory(),
    vault(),
    identity(),
    improve(input),
    peers(),
  ];
  const next = nextTier(input.policy.name);
  return {
    benefits,
    benefitBrief: formatBenefitBrief(benefits),
    policy: {
      tier: input.policy.name,
      label: input.policy.label,
      creditScore: input.creditScore,
      spendingCapUsd: input.policy.spendingCapUsd,
      maxConcurrentTasks: input.policy.maxConcurrentTasks,
      payoutSpeed: input.policy.payoutSpeed,
      nextTier: next?.name ?? null,
      pointsToNext: next ? Math.max(0, next.scoreMin - input.creditScore) : 0,
    },
  };
}
