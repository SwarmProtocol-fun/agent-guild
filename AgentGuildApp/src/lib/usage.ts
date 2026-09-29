/**
 * Token Usage / Cost Tracker
 *
 * Track token consumption across agents and models with cost estimates.
 * Inspired by robsannaa/openclaw-mission-control usage-view.
 */

import {
    collection,
    doc,
    addDoc,
    getDocs,
    query,
    where,
    orderBy,
    serverTimestamp,
    Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface UsageRecord {
    id: string;
    orgId: string;
    agentId: string;
    agentName?: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    sessionId?: string;
    timestamp: Date | null;
}

export interface UsageAlarm {
    id: string;
    model: string;
    tokenLimit: number;
    timeline: "24h" | "7d" | "30d";
    enabled: boolean;
}

export interface ModelUsageSummary {
    model: string;
    requests: number;
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
    costUsd: number;
    pctOfTotal: number;
}

export interface AgentUsageSummary {
    agentId: string;
    agentName: string;
    totalTokens: number;
    costUsd: number;
    models: string[];
    requests: number;
}

export interface DailyCost {
    date: string; // YYYY-MM-DD
    costUsd: number;
    tokens: number;
}

// ═══════════════════════════════════════════════════════════════
// Model Pricing (per 1M tokens)
// ═══════════════════════════════════════════════════════════════

export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 2.50, output: 10.00 },
    "gpt-4o-mini": { input: 0.15, output: 0.60 },
    "gpt-4-turbo": { input: 10.00, output: 30.00 },
    "gpt-3.5-turbo": { input: 0.50, output: 1.50 },
    "claude-3.5-sonnet": { input: 3.00, output: 15.00 },
    "claude-3-haiku": { input: 0.25, output: 1.25 },
    "claude-3-opus": { input: 15.00, output: 75.00 },
    "gemini-pro": { input: 0.50, output: 1.50 },
    "gemini-1.5-pro": { input: 3.50, output: 10.50 },
    "llama-3-70b": { input: 0.59, output: 0.79 },
    "mistral-large": { input: 4.00, output: 12.00 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
    const pricing = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o-mini"];
    return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

export function shortModel(model: string): string {
    return model.split("/").pop() || model;
}

export function fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

export function fmtCost(usd: number): string {
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD
// ═══════════════════════════════════════════════════════════════

const USAGE_COLLECTION = "usageRecords";

export async function logUsage(record: Omit<UsageRecord, "id" | "timestamp">): Promise<string> {
    const ref = await addDoc(collection(db, USAGE_COLLECTION), {
        ...record,
        costUsd: record.costUsd || estimateCost(record.model, record.tokensIn, record.tokensOut),
        timestamp: serverTimestamp(),
    });
    return ref.id;
}

export async function getUsageRecords(orgId: string, daysBack = 30): Promise<UsageRecord[]> {
    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    const q = query(
        collection(db, USAGE_COLLECTION),
        where("orgId", "==", orgId),
        where("timestamp", ">=", Timestamp.fromDate(since)),
        orderBy("timestamp", "desc"),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            orgId: data.orgId,
            agentId: data.agentId,
            agentName: data.agentName,
            model: data.model,
            tokensIn: data.tokensIn,
            tokensOut: data.tokensOut,
            costUsd: data.costUsd,
            sessionId: data.sessionId,
            timestamp: data.timestamp instanceof Timestamp ? data.timestamp.toDate() : null,
        } as UsageRecord;
    });
}

// ═══════════════════════════════════════════════════════════════
// Aggregation helpers
// ═══════════════════════════════════════════════════════════════

export function aggregateByModel(records: UsageRecord[]): ModelUsageSummary[] {
    const map: Record<string, ModelUsageSummary> = {};
    let grandTotal = 0;

    for (const r of records) {
        const total = r.tokensIn + r.tokensOut;
        grandTotal += total;
        if (!map[r.model]) {
            map[r.model] = { model: r.model, requests: 0, tokensIn: 0, tokensOut: 0, totalTokens: 0, costUsd: 0, pctOfTotal: 0 };
        }
        map[r.model].requests++;
        map[r.model].tokensIn += r.tokensIn;
        map[r.model].tokensOut += r.tokensOut;
        map[r.model].totalTokens += total;
        map[r.model].costUsd += r.costUsd;
    }

    const result = Object.values(map).sort((a, b) => b.costUsd - a.costUsd);
    for (const m of result) m.pctOfTotal = grandTotal > 0 ? Math.round((m.totalTokens / grandTotal) * 100) : 0;
    return result;
}

export function aggregateByAgent(records: UsageRecord[]): AgentUsageSummary[] {
    const map: Record<string, AgentUsageSummary> = {};

    for (const r of records) {
        if (!map[r.agentId]) {
            map[r.agentId] = { agentId: r.agentId, agentName: r.agentName || r.agentId, totalTokens: 0, costUsd: 0, models: [], requests: 0 };
        }
        map[r.agentId].totalTokens += r.tokensIn + r.tokensOut;
        map[r.agentId].costUsd += r.costUsd;
        map[r.agentId].requests++;
        if (!map[r.agentId].models.includes(r.model)) map[r.agentId].models.push(r.model);
    }

    return Object.values(map).sort((a, b) => b.costUsd - a.costUsd);
}

export function aggregateDaily(records: UsageRecord[]): DailyCost[] {
    const map: Record<string, DailyCost> = {};

    for (const r of records) {
        if (!r.timestamp) continue;
        const date = r.timestamp.toISOString().slice(0, 10);
        if (!map[date]) map[date] = { date, costUsd: 0, tokens: 0 };
        map[date].costUsd += r.costUsd;
        map[date].tokens += r.tokensIn + r.tokensOut;
    }

    return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}
