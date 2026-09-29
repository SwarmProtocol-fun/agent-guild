/**
 * Cheap token-count estimate — ~4 characters per token, the same rough
 * heuristic commonly used for English text when no tokenizer for the
 * target model is available. This is an estimate, not a real tokenizer
 * (no tiktoken or model-specific vocab in this codebase) — good enough
 * for greedy context-budget truncation, not for exact billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
