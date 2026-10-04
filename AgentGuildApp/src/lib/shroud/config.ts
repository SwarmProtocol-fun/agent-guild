/**
 * Per-org Shroud (LLM proxy) settings — shroudConfigs/{orgId}. Off until an
 * org owner turns it on. Provider keys are vault secret ids, never values.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { PII_KINDS, type PiiKind, type Provider } from "./inspect";
import type { ModelPrice } from "./pricing";

export interface ShroudConfig {
  enabled: boolean;
  /** Vault secret holding each provider's API key. */
  providerSecrets: Partial<Record<Provider, string>>;
  /** Empty = any model. */
  allowedModels: string[];
  /** 0 = no cap; otherwise max_tokens is clamped to this. */
  maxTokensPerRequest: number;
  /** 0 = unlimited; input + output tokens per agent per UTC day. */
  dailyTokenBudgetPerAgent: number;
  blockedDomains: string[];
  injectionAction: "block" | "flag";
  /** 0–100; requests scoring at or above this are blocked (or flagged). */
  injectionThreshold: number;
  /** PII swapped for placeholders before the provider sees it; restored in non-streaming responses. */
  piiRedaction: PiiKind[];
  /** 0 = no cap; estimated USD per agent per UTC day. */
  dailySpendCapUsdPerAgent: number;
  /** 0 = no cap; estimated USD for the whole org per UTC day. */
  dailySpendCapUsdOrg: number;
  /** 0 = off; more requests than this from one agent in a minute halts the agent. */
  loopGuardPerMinute: number;
  /** 0 = off; this many identical requests in a row from one agent halts it. */
  loopGuardRepeats: number;
  /** Per-model USD per 1M tokens, overriding the built-in table (pricing.ts). */
  modelPrices: Record<string, ModelPrice>;
}

export const DEFAULT_SHROUD_CONFIG: ShroudConfig = {
  enabled: false,
  providerSecrets: {},
  allowedModels: [],
  maxTokensPerRequest: 0,
  dailyTokenBudgetPerAgent: 0,
  blockedDomains: [],
  injectionAction: "block",
  injectionThreshold: 40,
  piiRedaction: [],
  dailySpendCapUsdPerAgent: 0,
  dailySpendCapUsdOrg: 0,
  loopGuardPerMinute: 120,
  loopGuardRepeats: 8,
  modelPrices: {},
};

export async function getShroudConfig(orgId: string): Promise<ShroudConfig> {
  const snap = await adminDb().collection("shroudConfigs").doc(orgId).get();
  return { ...DEFAULT_SHROUD_CONFIG, ...(snap.data() as Partial<ShroudConfig> | undefined) };
}

const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);

export function validateShroudConfig(raw: Record<string, unknown>): ShroudConfig | string {
  const num = (v: unknown, min: number, max: number, name: string) => {
    const n = Number(v ?? 0);
    return Number.isInteger(n) && n >= min && n <= max ? n : `${name} must be a whole number from ${min} to ${max}`;
  };
  const maxTokens = num(raw.maxTokensPerRequest, 0, 1_000_000, "maxTokensPerRequest");
  if (typeof maxTokens === "string") return maxTokens;
  const budget = num(raw.dailyTokenBudgetPerAgent, 0, 1_000_000_000, "dailyTokenBudgetPerAgent");
  if (typeof budget === "string") return budget;
  const threshold = num(raw.injectionThreshold ?? 40, 1, 100, "injectionThreshold");
  if (typeof threshold === "string") return threshold;

  const perMinute = num(raw.loopGuardPerMinute ?? DEFAULT_SHROUD_CONFIG.loopGuardPerMinute, 0, 10_000, "loopGuardPerMinute");
  if (typeof perMinute === "string") return perMinute;
  const repeats = num(raw.loopGuardRepeats ?? DEFAULT_SHROUD_CONFIG.loopGuardRepeats, 0, 1000, "loopGuardRepeats");
  if (typeof repeats === "string") return repeats;
  const usd = (v: unknown, name: string) => {
    const n = Number(v ?? 0);
    return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? Math.round(n * 100) / 100 : `${name} must be a dollar amount from 0 to 1000000`;
  };
  const agentCap = usd(raw.dailySpendCapUsdPerAgent, "dailySpendCapUsdPerAgent");
  if (typeof agentCap === "string") return agentCap;
  const orgCap = usd(raw.dailySpendCapUsdOrg, "dailySpendCapUsdOrg");
  if (typeof orgCap === "string") return orgCap;

  const pii = list(raw.piiRedaction).map((k) => k.toLowerCase());
  const badPii = pii.filter((k) => !(PII_KINDS as readonly string[]).includes(k));
  if (badPii.length) return `piiRedaction: unknown kind(s) ${badPii.join(", ")}. Allowed: ${PII_KINDS.join(", ")}`;

  const modelPrices: Record<string, ModelPrice> = {};
  for (const [model, p] of Object.entries((raw.modelPrices || {}) as Record<string, Partial<ModelPrice>>)) {
    const input = Number(p?.input), output = Number(p?.output);
    if (!model.trim() || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || input > 10_000 || output > 10_000) {
      return `modelPrices.${model}: input and output must be USD per 1M tokens (0–10000)`;
    }
    modelPrices[model.trim().toLowerCase()] = { input, output };
  }

  const ps = (raw.providerSecrets || {}) as Record<string, unknown>;
  const providerSecrets: ShroudConfig["providerSecrets"] = {};
  for (const p of ["anthropic", "openai"] as Provider[]) if (ps[p]) providerSecrets[p] = String(ps[p]);

  const blockedDomains = list(raw.blockedDomains).map((d) => d.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  if (blockedDomains.some((d) => !/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) return "blockedDomains must be domain names like evil.com or *.evil.com";

  return {
    enabled: Boolean(raw.enabled),
    providerSecrets,
    allowedModels: list(raw.allowedModels),
    maxTokensPerRequest: maxTokens,
    dailyTokenBudgetPerAgent: budget,
    blockedDomains: [...new Set(blockedDomains)],
    injectionAction: raw.injectionAction === "flag" ? "flag" : "block",
    injectionThreshold: threshold,
    piiRedaction: [...new Set(pii)] as PiiKind[],
    dailySpendCapUsdPerAgent: agentCap,
    dailySpendCapUsdOrg: orgCap,
    loopGuardPerMinute: perMinute,
    loopGuardRepeats: repeats,
    modelPrices,
  };
}

export async function saveShroudConfig(orgId: string, config: ShroudConfig, by: string): Promise<void> {
  await adminDb().collection("shroudConfigs").doc(orgId).set({ ...config, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
}

// ─── usage + events ────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
const dayKey = (agentId: string) => `${agentId}_${today()}`;
const orgDayKey = (orgId: string) => `org_${orgId}_${today()}`;
const usageTtl = () => Timestamp.fromMillis(Date.now() + 3 * 86_400_000);

export async function tokensUsedToday(agentId: string): Promise<number> {
  const snap = await adminDb().collection("shroudUsage").doc(dayKey(agentId)).get();
  return snap.exists ? Number(snap.data()!.tokens || 0) : 0;
}

/** Estimated spend today in micro-dollars, for the agent and for its whole org. */
export async function spendToday(orgId: string, agentId: string): Promise<{ agentMicroUsd: number; orgMicroUsd: number }> {
  const db = adminDb();
  const [agent, org] = await db.getAll(db.collection("shroudUsage").doc(dayKey(agentId)), db.collection("shroudUsage").doc(orgDayKey(orgId)));
  return { agentMicroUsd: Number(agent.data()?.microUsd || 0), orgMicroUsd: Number(org.data()?.microUsd || 0) };
}

export async function addTokensUsed(orgId: string, agentId: string, tokens: number, microUsd = 0): Promise<void> {
  if (!tokens && !microUsd) return;
  const db = adminDb();
  const batch = db.batch();
  batch.set(
    db.collection("shroudUsage").doc(dayKey(agentId)),
    { orgId, agentId, tokens: FieldValue.increment(tokens), microUsd: FieldValue.increment(microUsd), expiresAt: usageTtl() },
    { merge: true },
  );
  if (microUsd) {
    batch.set(db.collection("shroudUsage").doc(orgDayKey(orgId)), { orgId, microUsd: FieldValue.increment(microUsd), expiresAt: usageTtl() }, { merge: true });
  }
  await batch.commit();
}

// ─── kill switch ───────────────────────────────────────────────

/**
 * shroudHalts/{agentId}: a halted agent's LLM calls are refused until an org
 * admin resumes it. Set by an admin, or by the loop guard when an agent
 * floods the proxy or repeats the same request over and over.
 */
export interface ShroudHalt {
  orgId: string;
  agentId: string;
  reason: string;
  by: string;
  at: number;
}

export async function getHalt(agentId: string): Promise<ShroudHalt | null> {
  const snap = await adminDb().collection("shroudHalts").doc(agentId).get();
  return snap.exists ? (snap.data() as ShroudHalt) : null;
}

export async function haltAgent(orgId: string, agentId: string, reason: string, by: string): Promise<ShroudHalt> {
  const halt: ShroudHalt = { orgId, agentId, reason: reason.slice(0, 300), by, at: Date.now() };
  await adminDb().collection("shroudHalts").doc(agentId).set(halt);
  return halt;
}

/** Returns false when the halt belongs to another org (or doesn't exist). */
export async function resumeAgent(orgId: string, agentId: string): Promise<boolean> {
  const ref = adminDb().collection("shroudHalts").doc(agentId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) return false;
  await ref.delete();
  await adminDb().collection("shroudRate").doc(agentId).delete().catch(() => {});
  return true;
}

export async function listHalts(orgId: string): Promise<ShroudHalt[]> {
  const snap = await adminDb().collection("shroudHalts").where("orgId", "==", orgId).limit(200).get();
  return snap.docs.map((d) => d.data() as ShroudHalt).sort((a, b) => b.at - a.at);
}

/**
 * Loop guard: count this request against the agent's current minute and its
 * run of identical requests. Returns why the agent should be halted, or null.
 * shroudRate/{agentId} holds { minute, count, lastHash, repeats }.
 */
export async function checkLoop(agentId: string, fingerprint: string, limits: { perMinute: number; repeats: number }): Promise<string | null> {
  if (!limits.perMinute && !limits.repeats) return null;
  const minute = Math.floor(Date.now() / 60_000);
  const ref = adminDb().collection("shroudRate").doc(agentId);
  return adminDb().runTransaction(async (tx) => {
    const prev = (await tx.get(ref)).data() || {};
    const count = prev.minute === minute ? Number(prev.count || 0) + 1 : 1;
    const repeats = prev.lastHash === fingerprint ? Number(prev.repeats || 1) + 1 : 1;
    tx.set(ref, { minute, count, lastHash: fingerprint, repeats, expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000) });
    if (limits.perMinute && count > limits.perMinute) return `loop guard: ${count} requests in one minute (limit ${limits.perMinute})`;
    if (limits.repeats && repeats >= limits.repeats) return `loop guard: the same request ${repeats} times in a row`;
    return null;
  });
}

export interface ShroudEvent {
  orgId: string;
  agentId: string;
  provider: Provider;
  model: string;
  stream: boolean;
  score: number;
  signals: string[];
  redactions: string[];
  responseSignals: string[];
  blocked: boolean;
  status: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** Estimated cost in micro-dollars (pricing.ts). */
  microUsd?: number;
  /** PII kinds masked in the request. */
  pii?: string[];
  /** Set when the request was refused by a spend cap, a halt or the loop guard. */
  killSwitch?: string;
}

export function recordShroudEvent(event: ShroudEvent): void {
  adminDb().collection("shroudEvents").add({ ...event, at: Date.now() })
    .catch((err) => console.error("[shroud] event log failed:", err));
}

export async function listShroudEvents(orgId: string, limit = 100) {
  const snap = await adminDb().collection("shroudEvents").where("orgId", "==", orgId).orderBy("at", "desc").limit(Math.min(limit, 500)).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShroudEvent & { at: number }) }));
}
