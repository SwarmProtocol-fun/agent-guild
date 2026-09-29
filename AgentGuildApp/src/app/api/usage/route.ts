import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Config paths - mapping from OpenClaw's server.js logic
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.env.OPENCLAW_WORKSPACE || process.cwd();
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const AGENT_ID = process.env.OPENCLAW_AGENT || 'main';

// Paths to data
const sessDir = path.join(OPENCLAW_DIR, 'agents', AGENT_ID, 'sessions');
const pricingFile = path.join(WORKSPACE_DIR, 'data', 'model_pricing_usd_per_million.json');

const DEFAULT_MODEL_PRICING = {
    'anthropic/claude-opus-4-6': { input: 15.00, output: 75.00, cacheRead: 1.875, cacheWrite: 18.75 },
    'anthropic/claude-opus-4-5': { input: 15.00, output: 75.00, cacheRead: 1.875, cacheWrite: 18.75 },
    'anthropic/claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'anthropic/claude-sonnet-4-5': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    'anthropic/claude-3-5-haiku-latest': { input: 0.80, output: 4.00, cacheRead: 0.08, cacheWrite: 1.00 },
    'openai/gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0.075, cacheWrite: 0.30 },
    'google/gemini-3-pro-preview': { input: 1.25, output: 10.00, cacheRead: 0.31, cacheWrite: 4.50 },
    'google/gemini-3-flash-preview': { input: 0.15, output: 0.60, cacheRead: 0.04, cacheWrite: 0.15 },
};

function toNum(v: any) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function normalizeProvider(provider: string) {
    return String(provider || 'unknown').trim().toLowerCase();
}

function normalizeModel(provider: string, model: string) {
    const p = normalizeProvider(provider);
    let m = String(model || 'unknown').trim();
    const pref = p + '/';
    if (m.toLowerCase().startsWith(pref)) m = m.slice(pref.length);
    const ml = m.toLowerCase();

    if (p === 'anthropic') {
        if (ml.startsWith('claude-opus-4-6')) return 'claude-opus-4-6';
        if (ml.startsWith('claude-opus-4-5')) return 'claude-opus-4-5';
        if (ml.startsWith('claude-sonnet-4-6')) return 'claude-sonnet-4-6';
        if (ml.startsWith('claude-sonnet-4-5')) return 'claude-sonnet-4-5';
        if (ml.startsWith('claude-3-5-haiku')) return 'claude-3-5-haiku-latest';
    }
    if (p === 'openai') {
        if (ml.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
    }
    if (p === 'google' && ml.startsWith('gemini-3-flash-preview')) return 'gemini-3-flash-preview';
    return m;
}

function loadModelPricing() {
    try {
        if (!fs.existsSync(pricingFile)) return { ...DEFAULT_MODEL_PRICING };
        const parsed = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
        const rates = parsed && parsed.rates_usd_per_million;
        if (!rates || typeof rates !== 'object') return { ...DEFAULT_MODEL_PRICING };

        const out: any = {};
        for (const [k, v] of Object.entries(rates)) {
            if (!k.includes('/') || !v || typeof v !== 'object') continue;
            const val = v as any;
            out[String(k)] = {
                input: toNum(val.input),
                output: toNum(val.output),
                cacheRead: toNum(val.cacheRead),
                cacheWrite: toNum(val.cacheWrite)
            };
        }
        return Object.keys(out).length ? out : { ...DEFAULT_MODEL_PRICING };
    } catch {
        return { ...DEFAULT_MODEL_PRICING };
    }
}

const MODEL_PRICING = loadModelPricing();

function estimateMsgCost(msg: any) {
    const usage = msg && msg.usage ? msg.usage : {};
    const explicit = toNum(usage.cost && usage.cost.total);
    if (explicit > 0) return explicit;

    const provider = normalizeProvider(msg && msg.provider);
    const modelNorm = normalizeModel(provider, msg && msg.model);
    const rates = (MODEL_PRICING as any)[`${provider}/${modelNorm}`];

    if (!rates) return 0;

    const input = Math.max(0, toNum(usage.input)) / 1_000_000;
    const output = Math.max(0, toNum(usage.output)) / 1_000_000;
    const cacheRead = Math.max(0, toNum(usage.cacheRead)) / 1_000_000;
    const cacheWrite = Math.max(0, toNum(usage.cacheWrite)) / 1_000_000;

    return (
        input * toNum(rates.input) +
        output * toNum(rates.output) +
        cacheRead * toNum(rates.cacheRead) +
        cacheWrite * toNum(rates.cacheWrite)
    );
}

export async function GET(req: NextRequest) {
    // Require authenticated session (injected by middleware)
    const sessionAddress = req.headers.get('x-session-address');
    if (!sessionAddress) {
        return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    try {
        const now = Date.now();
        const fiveHoursMs = 5 * 3600000;
        const oneWeekMs = 7 * 86400000;

        // Safety check if directories don't exist
        if (!fs.existsSync(sessDir)) {
            return NextResponse.json({
                fiveHour: { perModel: {}, perModelCost: {}, recentCalls: [] },
                weekly: { perModel: {} },
                current: { opusOutput: 0, sonnetOutput: 0, totalCost: 0, totalCalls: 0 },
                estimatedLimits: { opus: 88000, sonnet: 220000 },
                burnRate: { tokensPerMinute: 0, costPerMinute: 0 },
                error: "Session directory not found"
            });
        }

        const files = fs.readdirSync(sessDir).filter(f => {
            if (!f.endsWith('.jsonl')) return false;
            try { return fs.statSync(path.join(sessDir, f)).mtimeMs > now - oneWeekMs; } catch { return false; }
        });

        const perModel5h: any = {};
        const perModelWeek: any = {};
        const recentMessages: any[] = [];

        for (const file of files) {
            try {
                const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const d = JSON.parse(line);
                        if (d.type !== 'message') continue;
                        const msg = d.message;
                        if (!msg || !msg.usage) continue;

                        const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
                        if (!ts) continue;

                        const provider = normalizeProvider(msg.provider);
                        const model = normalizeModel(provider, msg.model);
                        const modelKey = `${provider}/${model}`;

                        const inTok = Math.max(0, toNum(msg.usage.input));
                        const outTok = Math.max(0, toNum(msg.usage.output));
                        const cacheReadTok = Math.max(0, toNum(msg.usage.cacheRead));
                        const cacheWriteTok = Math.max(0, toNum(msg.usage.cacheWrite));
                        const cost = estimateMsgCost(msg);

                        if (now - ts < fiveHoursMs) {
                            if (!perModel5h[modelKey]) perModel5h[modelKey] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
                            perModel5h[modelKey].input += inTok;
                            perModel5h[modelKey].output += outTok;
                            perModel5h[modelKey].cacheRead += cacheReadTok;
                            perModel5h[modelKey].cacheWrite += cacheWriteTok;
                            perModel5h[modelKey].cost += cost;
                            perModel5h[modelKey].calls++;
                        }
                        if (now - ts < oneWeekMs) {
                            if (!perModelWeek[modelKey]) perModelWeek[modelKey] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
                            perModelWeek[modelKey].input += inTok;
                            perModelWeek[modelKey].output += outTok;
                            perModelWeek[modelKey].cacheRead += cacheReadTok;
                            perModelWeek[modelKey].cacheWrite += cacheWriteTok;
                            perModelWeek[modelKey].cost += cost;
                            perModelWeek[modelKey].calls++;
                        }
                        if (now - ts < fiveHoursMs) {
                            recentMessages.push({ ts, model: modelKey, input: inTok, output: outTok, cost });
                        }
                    } catch { }
                }
            } catch { }
        }

        recentMessages.sort((a, b) => b.ts - a.ts);

        const estimatedLimits = { opus: 88000, sonnet: 220000 };

        let burnTokensPerMin = 0;
        let burnCostPerMin = 0;
        const thirtyMinAgo = now - 30 * 60000;
        const recent30 = recentMessages.filter(m => m.ts >= thirtyMinAgo);

        if (recent30.length > 0) {
            const totalOut30 = recent30.reduce((s, m) => s + m.output, 0);
            const totalCost30 = recent30.reduce((s, m) => s + m.cost, 0);
            const spanMs = Math.max(now - Math.min(...recent30.map(m => m.ts)), 60000);
            burnTokensPerMin = totalOut30 / (spanMs / 60000);
            burnCostPerMin = totalCost30 / (spanMs / 60000);
        }

        const opusKey = Object.keys(perModel5h).find(k => k.includes('opus')) || '';
        const opusOut = opusKey ? perModel5h[opusKey].output : 0;
        const sonnetKey = Object.keys(perModel5h).find(k => k.includes('sonnet')) || '';
        const sonnetOut = sonnetKey ? perModel5h[sonnetKey].output : 0;

        const perModelCost5h: any = {};
        for (const [model, data] of Object.entries(perModel5h) as any) {
            const slash = model.indexOf('/');
            const provider = slash >= 0 ? model.slice(0, slash) : 'unknown';
            const modelName = slash >= 0 ? model.slice(slash + 1) : model;
            const rates = (MODEL_PRICING as any)[`${provider}/${modelName}`] || {};

            const inputCost = (data.input || 0) / 1000000 * toNum(rates.input);
            const outputCost = (data.output || 0) / 1000000 * toNum(rates.output);
            const cacheReadCost = (data.cacheRead || 0) / 1000000 * toNum(rates.cacheRead);
            const cacheWriteCost = (data.cacheWrite || 0) / 1000000 * toNum(rates.cacheWrite);

            perModelCost5h[model] = {
                inputCost,
                outputCost,
                cacheReadCost,
                cacheWriteCost,
                totalCost: data.cost || (inputCost + outputCost + cacheReadCost + cacheWriteCost)
            };
        }

        const totalCost5h = Object.values(perModel5h).reduce((s: number, m: any) => s + (m.cost || 0), 0);
        const totalCalls5h = Object.values(perModel5h).reduce((s: number, m: any) => s + (m.calls || 0), 0);

        return NextResponse.json({
            fiveHour: {
                perModel: perModel5h,
                perModelCost: perModelCost5h,
                recentCalls: recentMessages.slice(0, 20)
            },
            weekly: {
                perModel: perModelWeek
            },
            burnRate: {
                tokensPerMinute: Math.round(burnTokensPerMin * 100) / 100,
                costPerMinute: Math.round(burnCostPerMin * 10000) / 10000
            },
            estimatedLimits,
            current: {
                opusOutput: opusOut,
                sonnetOutput: sonnetOut,
                totalCost: Math.round(totalCost5h * 100) / 100,
                totalCalls: totalCalls5h,
            }
        });
    } catch (error) {
        console.error('Error fetching usage:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
