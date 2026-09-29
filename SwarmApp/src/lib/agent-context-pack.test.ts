/**
 * All four data sources (agent-memory-server, agent-context,
 * compute/memory) are mocked — this tests assembleAgentContext's own
 * composition logic (q-narrowing, task→rankedMemories wiring, budget
 * pass-through), not Firestore plumbing (covered by each source module's
 * own tests) or truncation math (covered by context-pack.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getExistingMemory = vi.fn();
const getDailyNoteIfExists = vi.fn();
vi.mock("./agent-memory-server", () => ({
  getExistingMemory: (...args: unknown[]) => getExistingMemory(...args),
  getDailyNoteIfExists: (...args: unknown[]) => getDailyNoteIfExists(...args),
}));

const getRecentMessagesForAgent = vi.fn();
vi.mock("./agent-context", () => ({
  getRecentMessagesForAgent: (...args: unknown[]) => getRecentMessagesForAgent(...args),
}));

const hybridSearchMemory = vi.fn();
vi.mock("./compute/memory", () => ({
  hybridSearchMemory: (...args: unknown[]) => hybridSearchMemory(...args),
}));

const { assembleAgentContext } = await import("./agent-context-pack");

const agent = { agentId: "agent_1", orgId: "org_1", agentName: "Agent One" };

describe("assembleAgentContext", () => {
  beforeEach(() => {
    getExistingMemory.mockReset();
    getDailyNoteIfExists.mockReset();
    getRecentMessagesForAgent.mockReset();
    hybridSearchMemory.mockReset();

    getExistingMemory.mockResolvedValue({ working: null, longTerm: null });
    getDailyNoteIfExists.mockResolvedValue(null);
    getRecentMessagesForAgent.mockResolvedValue({ messages: [], channels: [] });
  });

  it("does not call hybridSearchMemory when no task is given", async () => {
    await assembleAgentContext(agent, {});
    expect(hybridSearchMemory).not.toHaveBeenCalled();
  });

  it("runs hybridSearchMemory scoped to the agent when a task is given", async () => {
    hybridSearchMemory.mockResolvedValue([{ id: "m1", content: "deploy via Railway", score: 0.8 }]);
    const result = await assembleAgentContext(agent, { task: "deploy" });
    expect(hybridSearchMemory).toHaveBeenCalledWith("agent", "agent_1", "deploy", { limit: 20 });
    expect(result.rankedMemories).toEqual([{ id: "m1", content: "deploy via Railway", score: 0.8 }]);
  });

  it("narrows working/longTerm/daily sections and messages by q", async () => {
    getExistingMemory.mockResolvedValue({
      working: { id: "w1", subtype: "working_md", content: "## Current Focus\nRailway deploy\n## Blockers\nnone", createdAt: 1, updatedAt: 1 },
      longTerm: null,
    });
    getRecentMessagesForAgent.mockResolvedValue({
      messages: [
        { from: "a", channelName: "general", content: "railway is down", timestamp: 1 },
        { from: "b", channelName: "general", content: "unrelated chatter", timestamp: 2 },
      ],
      channels: [],
    });

    const result = await assembleAgentContext(agent, { q: "railway" });
    expect(result.working).toContain("Railway deploy");
    expect(result.working).not.toContain("Blockers");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content).toBe("railway is down");
  });

  it("omits a doc with no matching section under q rather than including it whole", async () => {
    getExistingMemory.mockResolvedValue({
      working: { id: "w1", subtype: "working_md", content: "## Current Focus\nnothing relevant here", createdAt: 1, updatedAt: 1 },
      longTerm: null,
    });
    const result = await assembleAgentContext(agent, { q: "railway" });
    expect(result.working).toBeNull();
  });

  it("passes messageLimit/sinceMs through to getRecentMessagesForAgent", async () => {
    await assembleAgentContext(agent, { messageLimit: 10, sinceMs: 12345 });
    expect(getRecentMessagesForAgent).toHaveBeenCalledWith("agent_1", { limit: 10, sinceMs: 12345 });
  });

  it("clamps tokenBudget via the shared clampTokenBudget", async () => {
    const result = await assembleAgentContext(agent, { tokenBudget: 1 });
    expect(result.tokenBudget).toBe(500); // MIN_TOKEN_BUDGET
  });

  it("defaults tokenBudget to 8000 when omitted", async () => {
    const result = await assembleAgentContext(agent, {});
    expect(result.tokenBudget).toBe(8000);
  });

  it("returns channels from getRecentMessagesForAgent", async () => {
    getRecentMessagesForAgent.mockResolvedValue({
      messages: [],
      channels: [{ id: "c1", name: "general" }],
    });
    const result = await assembleAgentContext(agent, {});
    expect(result.channels).toEqual([{ id: "c1", name: "general" }]);
  });
});
