import { describe, it, expect } from "vitest";
import { buildContextPack } from "./context-pack";
import { estimateTokens } from "./token-estimate";

const EMPTY = { working: null, longTerm: null, daily: null, rankedMemories: [], messages: [] };

describe("buildContextPack", () => {
  it("includes everything when it all fits within budget", () => {
    const result = buildContextPack({
      ...EMPTY,
      working: "current focus",
      longTerm: "long term facts",
      daily: "today's notes",
      tokenBudget: 10_000,
    });

    expect(result.working).toBe("current focus");
    expect(result.longTerm).toBe("long term facts");
    expect(result.daily).toBe("today's notes");
    expect(result.truncated).toBe(false);
    expect(result.omitted).toEqual([]);
  });

  it("reports zero tokens and no truncation for an all-empty input", () => {
    const result = buildContextPack({ ...EMPTY, tokenBudget: 8000 });
    expect(result.tokenCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.omitted).toEqual([]);
  });

  it("omits a whole document that doesn't fit, whole — no mid-doc clipping", () => {
    const huge = "x".repeat(10_000); // ~2500 tokens
    const result = buildContextPack({ ...EMPTY, working: huge, longTerm: "small", tokenBudget: 100 });

    expect(result.working).toBeNull();
    expect(result.omitted).toContain("working");
    expect(result.truncated).toBe(true);
    // longTerm still gets a chance at the un-consumed budget, since the
    // oversized doc that didn't fit never subtracted from `remaining`.
    expect(result.longTerm).toBe("small");
  });

  it("respects document priority order: working, then longTerm, then daily", () => {
    // Budget fits exactly one of the three ~equal-size docs.
    const doc = "y".repeat(40); // 10 tokens each
    const result = buildContextPack({ ...EMPTY, working: doc, longTerm: doc, daily: doc, tokenBudget: 10 });

    expect(result.working).toBe(doc);
    expect(result.longTerm).toBeNull();
    expect(result.daily).toBeNull();
    expect(result.omitted).toEqual(["longTerm", "daily"]);
  });

  it("takes a prefix of rankedMemories in given (score) order until the budget runs out", () => {
    const memories = [
      { id: "a", content: "z".repeat(40), score: 0.9 }, // 10 tokens
      { id: "b", content: "z".repeat(40), score: 0.8 }, // 10 tokens
      { id: "c", content: "z".repeat(40), score: 0.7 }, // 10 tokens
    ];
    const result = buildContextPack({ ...EMPTY, rankedMemories: memories, tokenBudget: 20 });

    expect(result.rankedMemories.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(true);
    expect(result.omitted).toContain("rankedMemories");
  });

  it("takes a prefix of messages until the budget runs out", () => {
    const messages = [
      { from: "a", channelName: "c1", content: "z".repeat(40), timestamp: 1 },
      { from: "b", channelName: "c1", content: "z".repeat(40), timestamp: 2 },
    ];
    const result = buildContextPack({ ...EMPTY, messages, tokenBudget: 10 });

    expect(result.messages).toHaveLength(1);
    expect(result.omitted).toContain("messages");
  });

  it("computes tokenCount as the actual sum of included content, not the budget", () => {
    const text = "hello world";
    const result = buildContextPack({ ...EMPTY, working: text, tokenBudget: 10_000 });
    expect(result.tokenCount).toBe(estimateTokens(text));
  });

  it("treats a zero token budget as omit-everything, not a crash", () => {
    const result = buildContextPack({ ...EMPTY, working: "anything", tokenBudget: 0 });
    expect(result.working).toBeNull();
    expect(result.truncated).toBe(true);
    expect(result.tokenCount).toBe(0);
  });

  it("does not mutate the input arrays", () => {
    const rankedMemories = [{ id: "a", content: "x", score: 1 }];
    const messages = [{ from: "a", channelName: "c", content: "x", timestamp: 1 }];
    buildContextPack({ ...EMPTY, rankedMemories, messages, tokenBudget: 8000 });
    expect(rankedMemories).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });
});
