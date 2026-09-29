/**
 * Each dependency mocked at the module boundary — this tests mcp-tools.ts's
 * own input validation, defaulting, and wiring, not the underlying
 * compute/memory, compute/graph, or agent-context-pack logic (each has its
 * own tests).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rememberMemory = vi.fn();
const hybridSearchMemory = vi.fn();
vi.mock("./compute/memory", () => ({
  rememberMemory: (...args: unknown[]) => rememberMemory(...args),
  hybridSearchMemory: (...args: unknown[]) => hybridSearchMemory(...args),
}));

const linkEntities = vi.fn();
const getRelatedEntities = vi.fn();
vi.mock("./compute/graph", async () => {
  const actual = await vi.importActual<typeof import("./compute/graph")>("./compute/graph");
  return {
    linkEntities: (...args: unknown[]) => linkEntities(...args),
    getRelatedEntities: (...args: unknown[]) => getRelatedEntities(...args),
    InvalidGraphEntityError: actual.InvalidGraphEntityError,
  };
});

const assembleAgentContext = vi.fn();
vi.mock("./agent-context-pack", () => ({
  assembleAgentContext: (...args: unknown[]) => assembleAgentContext(...args),
}));

const { mcpRemember, mcpRecall, mcpContextPack, mcpLink, mcpGraph, McpToolInputError } = await import(
  "./mcp-tools"
);
const { InvalidGraphEntityError } = await import("./compute/graph");

const agent = { agentId: "agent_1", orgId: "org_1", agentName: "Agent One" };

describe("mcpRemember", () => {
  beforeEach(() => {
    rememberMemory.mockReset();
    rememberMemory.mockResolvedValue("mem_1");
  });

  it("defaults scope to the calling agent", async () => {
    const result = await mcpRemember(agent, { content: "the deploy target is Railway" });
    expect(result).toEqual({ id: "mem_1" });
    expect(rememberMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: "agent", scopeId: "agent_1", agentId: "agent_1", content: "the deploy target is Railway" }),
    );
  });

  it("honors an explicit scope", async () => {
    await mcpRemember(agent, { content: "shared note", scopeType: "workspace", scopeId: "ws_1" });
    expect(rememberMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: "workspace", scopeId: "ws_1" }),
    );
  });

  it("redacts a secret before persisting", async () => {
    await mcpRemember(agent, { content: "key is sk-ant-" + "a".repeat(95) });
    const written = rememberMemory.mock.calls[0][0].content;
    expect(written).not.toContain("sk-ant-" + "a".repeat(95));
  });

  it("rejects empty content", async () => {
    await expect(mcpRemember(agent, { content: "" })).rejects.toThrow(McpToolInputError);
    expect(rememberMemory).not.toHaveBeenCalled();
  });

  it("rejects content over the length cap", async () => {
    await expect(mcpRemember(agent, { content: "x".repeat(50_001) })).rejects.toThrow(McpToolInputError);
  });

  it("rejects too many tags", async () => {
    await expect(
      mcpRemember(agent, { content: "hi", tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
    ).rejects.toThrow(McpToolInputError);
  });
});

describe("mcpRecall", () => {
  beforeEach(() => {
    hybridSearchMemory.mockReset();
    hybridSearchMemory.mockResolvedValue([
      { id: "m1", content: "railway deploy", score: 0.9, matchType: "both", tags: ["deploy"], pinned: false },
    ]);
  });

  it("defaults scope to the calling agent and clamps limit", async () => {
    const result = await mcpRecall(agent, { query: "railway", limit: 500 });
    expect(hybridSearchMemory).toHaveBeenCalledWith("agent", "agent_1", "railway", { limit: 100 });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].content).toBe("railway deploy");
  });

  it("rejects an empty query", async () => {
    await expect(mcpRecall(agent, { query: "" })).rejects.toThrow(McpToolInputError);
  });
});

describe("mcpContextPack", () => {
  it("delegates to assembleAgentContext with task/tokenBudget", async () => {
    assembleAgentContext.mockReset();
    assembleAgentContext.mockResolvedValue({ working: null });
    await mcpContextPack(agent, { task: "deploy", tokenBudget: 2000 });
    expect(assembleAgentContext).toHaveBeenCalledWith(agent, { task: "deploy", tokenBudget: 2000 });
  });
});

describe("mcpLink", () => {
  beforeEach(() => {
    linkEntities.mockReset();
    linkEntities.mockResolvedValue("edge_1");
  });

  it("defaults from-entity to the calling agent", async () => {
    const result = await mcpLink(agent, { toType: "task", toId: "task_1", relation: "works_on" });
    expect(result).toEqual({ id: "edge_1" });
    expect(linkEntities).toHaveBeenCalledWith(
      "org_1",
      { type: "agent", id: "agent_1" },
      { type: "task", id: "task_1" },
      "works_on",
      { type: "agent", id: "agent_1" },
    );
  });

  it("rejects missing required fields", async () => {
    await expect(mcpLink(agent, { toType: "task", toId: "", relation: "works_on" })).rejects.toThrow(
      McpToolInputError,
    );
  });

  it("wraps InvalidGraphEntityError as McpToolInputError", async () => {
    linkEntities.mockRejectedValue(new InvalidGraphEntityError("bad entity"));
    await expect(mcpLink(agent, { toType: "task", toId: "t1", relation: "works_on" })).rejects.toThrow(
      McpToolInputError,
    );
  });
});

describe("mcpGraph", () => {
  beforeEach(() => {
    getRelatedEntities.mockReset();
    getRelatedEntities.mockResolvedValue([]);
  });

  it("queries edges for the given entity", async () => {
    await mcpGraph(agent, { type: "agent", id: "agent_1", relation: "works_on" });
    expect(getRelatedEntities).toHaveBeenCalledWith(
      "org_1",
      { type: "agent", id: "agent_1" },
      { relation: "works_on", limit: undefined },
    );
  });

  it("rejects missing id", async () => {
    await expect(mcpGraph(agent, { type: "agent", id: "" })).rejects.toThrow(McpToolInputError);
  });
});
