/**
 * Shroud spend estimates — USD per 1M tokens, used by the spend caps.
 *
 * Anthropic rates are first-party list prices (checked 2026-09-25). OpenAI
 * rates are list prices as last known and drift more often, so orgs can
 * override any model in their Shroud config (`modelPrices`). A model nobody
 * priced is charged at the most expensive rate in the table, so a cap errs
 * toward stopping too early rather than letting spend run past it.
 *
 * Prompt-cache reads and writes are billed differently by the providers; the
 * proxy counts them as ordinary input tokens, which over-estimates — the safe
 * direction for a cap.
 */

export interface ModelPrice {
  input: number;
  output: number;
}

export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-mythos-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // OpenAI
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3": { input: 2, output: 8 },
};

const MOST_EXPENSIVE: ModelPrice = Object.values(DEFAULT_MODEL_PRICES).reduce(
  (max, p) => (p.input + p.output > max.input + max.output ? p : max),
);

/**
 * Price for a model id. Exact match first, then the longest table key the id
 * starts with ("claude-sonnet-4-20250514" → "claude-sonnet-4",
 * "gpt-4o-2024-08-06" → "gpt-4o"), org overrides before defaults.
 */
export function priceFor(model: string, overrides: Record<string, ModelPrice> = {}): { price: ModelPrice; known: boolean } {
  const id = model.trim().toLowerCase();
  for (const table of [overrides, DEFAULT_MODEL_PRICES]) {
    if (table[id]) return { price: table[id], known: true };
    const prefix = Object.keys(table)
      .filter((k) => id.startsWith(`${k}-`) || id.startsWith(`${k}@`))
      .sort((a, b) => b.length - a.length)[0];
    if (prefix) return { price: table[prefix], known: true };
  }
  return { price: MOST_EXPENSIVE, known: false };
}

/** Estimated cost in micro-dollars (integers keep Firestore increments exact). */
export function costMicroUsd(model: string, inputTokens: number, outputTokens: number, overrides?: Record<string, ModelPrice>): number {
  const { price } = priceFor(model, overrides);
  return Math.ceil(inputTokens * price.input + outputTokens * price.output);
}
