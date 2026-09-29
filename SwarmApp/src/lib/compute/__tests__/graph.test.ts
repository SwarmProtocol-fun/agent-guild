/**
 * `../firestore` is mocked at the module boundary, same as memory.test.ts —
 * this tests linkEntities/getRelatedEntities' own validation logic, not
 * Firestore plumbing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphEdge } from "../types";

const createGraphEdge = vi.fn();
const getGraphEdgesForEntity = vi.fn();
vi.mock("../firestore", () => ({
  createGraphEdge: (...args: unknown[]) => createGraphEdge(...args),
  getGraphEdgesForEntity: (...args: unknown[]) => getGraphEdgesForEntity(...args),
}));

const { linkEntities, getRelatedEntities, InvalidGraphEntityError } = await import("../graph");

describe("linkEntities", () => {
  beforeEach(() => {
    createGraphEdge.mockReset();
    createGraphEdge.mockResolvedValue("edge_1");
  });

  it("creates an edge with valid entities and relation", async () => {
    const id = await linkEntities(
      "org_1",
      { type: "agent", id: "agent_1" },
      { type: "task", id: "task_1" },
      "works_on",
    );
    expect(id).toBe("edge_1");
    expect(createGraphEdge).toHaveBeenCalledWith({
      orgId: "org_1",
      from: { type: "agent", id: "agent_1" },
      to: { type: "task", id: "task_1" },
      relation: "works_on",
      createdBy: null,
    });
  });

  it("trims relation whitespace", async () => {
    await linkEntities("org_1", { type: "agent", id: "a" }, { type: "memory", id: "m" }, "  related_to  ");
    expect(createGraphEdge).toHaveBeenCalledWith(expect.objectContaining({ relation: "related_to" }));
  });

  it("passes through createdBy when given", async () => {
    await linkEntities(
      "org_1",
      { type: "agent", id: "a" },
      { type: "project", id: "p" },
      "uses",
      { type: "agent", id: "a" },
    );
    expect(createGraphEdge).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: { type: "agent", id: "a" } }),
    );
  });

  it("rejects an unknown entity type", async () => {
    await expect(
      linkEntities("org_1", { type: "workspace" as never, id: "w" }, { type: "task", id: "t" }, "works_on"),
    ).rejects.toThrow(InvalidGraphEntityError);
    expect(createGraphEdge).not.toHaveBeenCalled();
  });

  it("rejects an empty entity id", async () => {
    await expect(
      linkEntities("org_1", { type: "agent", id: "" }, { type: "task", id: "t" }, "works_on"),
    ).rejects.toThrow(InvalidGraphEntityError);
  });

  it("rejects an empty relation", async () => {
    await expect(
      linkEntities("org_1", { type: "agent", id: "a" }, { type: "task", id: "t" }, "   "),
    ).rejects.toThrow(InvalidGraphEntityError);
  });

  it("rejects a relation longer than 100 chars", async () => {
    await expect(
      linkEntities("org_1", { type: "agent", id: "a" }, { type: "task", id: "t" }, "x".repeat(101)),
    ).rejects.toThrow(InvalidGraphEntityError);
  });

  it("rejects an invalid createdBy entity", async () => {
    await expect(
      linkEntities(
        "org_1",
        { type: "agent", id: "a" },
        { type: "task", id: "t" },
        "works_on",
        { type: "bogus" as never, id: "x" },
      ),
    ).rejects.toThrow(InvalidGraphEntityError);
  });
});

describe("getRelatedEntities", () => {
  beforeEach(() => {
    getGraphEdgesForEntity.mockReset();
  });

  it("delegates to getGraphEdgesForEntity for a valid entity", async () => {
    const edges: GraphEdge[] = [
      {
        id: "e1",
        orgId: "org_1",
        from: { type: "agent", id: "a" },
        to: { type: "task", id: "t" },
        relation: "works_on",
        createdBy: null,
        createdAt: new Date(),
      },
    ];
    getGraphEdgesForEntity.mockResolvedValue(edges);

    const result = await getRelatedEntities("org_1", { type: "agent", id: "a" }, { limit: 10 });
    expect(result).toBe(edges);
    expect(getGraphEdgesForEntity).toHaveBeenCalledWith("org_1", { type: "agent", id: "a" }, { limit: 10 });
  });

  it("rejects an invalid entity type before hitting firestore", async () => {
    await expect(getRelatedEntities("org_1", { type: "bogus" as never, id: "a" })).rejects.toThrow(
      InvalidGraphEntityError,
    );
    expect(getGraphEdgesForEntity).not.toHaveBeenCalled();
  });
});
