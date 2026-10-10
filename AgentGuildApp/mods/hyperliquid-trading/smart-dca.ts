/**
 * Smart DCA ("accumulation acceleration"): a DCA bot that buys more the
 * further price sits below its average cost, and can bank the whole stack
 * once price recovers past a take-profit. Each step of `stepPct` against the
 * average entry multiplies the next order by `multiplier`, up to `maxSteps`
 * steps — so a $20 bot with ×1.5 per 5% buys $20 at cost, $30 5% under,
 * $45 10% under, and so on. A short-direction bot mirrors it (adds as price
 * rises above its average short).
 *
 * Pure and browser-safe: the live tick and the backtester share it.
 */

export interface SmartDcaParams {
  /** Adverse move from average entry, in percent, per acceleration step. */
  stepPct: number;
  /** Size multiplier per step (≥ 1). */
  multiplier: number;
  maxSteps: number;
  /** Close the whole stack once price is this far in profit from average entry. Optional. */
  takeProfitPct?: number;
}

export const SMART_DCA_DEFAULTS: SmartDcaParams = { stepPct: 5, multiplier: 1.5, maxSteps: 4, takeProfitPct: 8 };

/** How far price has moved against an average entry, in percent (0 when it's in profit). */
export function adverseMovePct(price: number, avgEntry: number, isLong: boolean): number {
  if (!(avgEntry > 0) || !(price > 0)) return 0;
  const move = isLong ? (avgEntry - price) / avgEntry : (price - avgEntry) / avgEntry;
  return Math.max(0, move * 100);
}

/** The next order's size and which step it is on. Flat (no avgEntry) is step 0 — the base size. */
export function smartDcaSize(baseUsd: number, p: SmartDcaParams, price: number, avgEntry: number | null, isLong = true): { sizeUsd: number; step: number } {
  if (avgEntry == null) return { sizeUsd: baseUsd, step: 0 };
  const step = Math.min(p.maxSteps, Math.floor(adverseMovePct(price, avgEntry, isLong) / p.stepPct + 1e-9));
  return { sizeUsd: baseUsd * p.multiplier ** step, step };
}

/** Whether the stack has reached its take-profit. */
export function smartDcaTakeProfit(p: SmartDcaParams, price: number, avgEntry: number | null, isLong = true): boolean {
  if (!p.takeProfitPct || avgEntry == null || !(avgEntry > 0)) return false;
  const gain = isLong ? (price - avgEntry) / avgEntry : (avgEntry - price) / avgEntry;
  return gain * 100 >= p.takeProfitPct;
}

/** Validates the `smart` block of a DCA bot's params. Absent → null (a plain DCA). */
export function buildSmartDca(raw: unknown): SmartDcaParams | null | { error: string } {
  if (raw == null || raw === false) return null;
  const r = (raw === true ? {} : raw) as Record<string, unknown>;
  const num = (k: keyof SmartDcaParams) => (r[k] == null || r[k] === "" ? SMART_DCA_DEFAULTS[k] : Number(r[k]));
  const p: SmartDcaParams = {
    stepPct: num("stepPct")!,
    multiplier: num("multiplier")!,
    maxSteps: Math.round(num("maxSteps")!),
    takeProfitPct: r.takeProfitPct === 0 || r.takeProfitPct === "0" ? undefined : num("takeProfitPct"),
  };
  if (!(p.stepPct > 0 && p.stepPct <= 50)) return { error: "smart.stepPct must be between 0 and 50" };
  if (!(p.multiplier >= 1 && p.multiplier <= 5)) return { error: "smart.multiplier must be between 1 and 5" };
  if (!(p.maxSteps >= 0 && p.maxSteps <= 10)) return { error: "smart.maxSteps must be between 0 and 10" };
  if (p.takeProfitPct != null && !(p.takeProfitPct > 0 && p.takeProfitPct <= 500)) return { error: "smart.takeProfitPct must be above 0" };
  return p;
}
