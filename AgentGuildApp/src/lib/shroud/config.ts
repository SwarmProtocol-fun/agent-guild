/**
 * Per-org Shroud (LLM proxy) settings — shroudConfigs/{orgId}. Off until an
 * org owner turns it on. Provider keys are vault secret ids, never values.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import type { Provider } from "./inspect";

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
  };
}

export async function saveShroudConfig(orgId: string, config: ShroudConfig, by: string): Promise<void> {
  await adminDb().collection("shroudConfigs").doc(orgId).set({ ...config, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
}

// ─── usage + events ────────────────────────────────────────────

const dayKey = (agentId: string) => `${agentId}_${new Date().toISOString().slice(0, 10)}`;

export async function tokensUsedToday(agentId: string): Promise<number> {
  const snap = await adminDb().collection("shroudUsage").doc(dayKey(agentId)).get();
  return snap.exists ? Number(snap.data()!.tokens || 0) : 0;
}

export async function addTokensUsed(orgId: string, agentId: string, tokens: number): Promise<void> {
  if (!tokens) return;
  await adminDb().collection("shroudUsage").doc(dayKey(agentId)).set(
    { orgId, agentId, tokens: FieldValue.increment(tokens), expiresAt: Timestamp.fromMillis(Date.now() + 3 * 86_400_000) },
    { merge: true },
  );
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
}

export function recordShroudEvent(event: ShroudEvent): void {
  adminDb().collection("shroudEvents").add({ ...event, at: Date.now() })
    .catch((err) => console.error("[shroud] event log failed:", err));
}

export async function listShroudEvents(orgId: string, limit = 100) {
  const snap = await adminDb().collection("shroudEvents").where("orgId", "==", orgId).orderBy("at", "desc").limit(Math.min(limit, 500)).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as ShroudEvent & { at: number }) }));
}
