import { describe, it, expect } from "vitest";
import { topologicalSort } from "../executor";
import type { WorkflowNode, WorkflowEdge } from "../types";

function makeNode(id: string, type: "trigger" | "output" | "transform" = "transform"): WorkflowNode {
  return { id, type, label: id, config: {} };
}

describe("topologicalSort", () => {
  it("sorts a simple linear DAG", () => {
    const nodes = [makeNode("a", "trigger"), makeNode("b"), makeNode("c", "output")];
    const edges: WorkflowEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ];
    const sorted = topologicalSort(nodes, edges);
    expect(sorted).toEqual(["a", "b", "c"]);
  });

  it("sorts a diamond DAG", () => {
    const nodes = [makeNode("a", "trigger"), makeNode("b"), makeNode("c"), makeNode("d", "output")];
    const edges: WorkflowEdge[] = [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ];
    const sorted = topologicalSort(nodes, edges);
    // a must come first, d must come last, b and c in middle
    expect(sorted[0]).toBe("a");
    expect(sorted[sorted.length - 1]).toBe("d");
    expect(sorted).toHaveLength(4);
  });

  it("handles a single node", () => {
    const nodes = [makeNode("only", "trigger")];
    const sorted = topologicalSort(nodes, []);
    expect(sorted).toEqual(["only"]);
  });

  it("handles disconnected nodes", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const sorted = topologicalSort(nodes, []);
    expect(sorted).toHaveLength(3);
    expect(new Set(sorted)).toEqual(new Set(["a", "b", "c"]));
  });

  it("throws on cycles", () => {
    const nodes = [makeNode("a"), makeNode("b"), makeNode("c")];
    const edges: WorkflowEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" }, // cycle
    ];
    expect(() => topologicalSort(nodes, edges)).toThrow("cycle");
  });

  it("throws on self-loop", () => {
    const nodes = [makeNode("a")];
    const edges: WorkflowEdge[] = [{ from: "a", to: "a" }];
    expect(() => topologicalSort(nodes, edges)).toThrow("cycle");
  });

  it("sorts a complex multi-path DAG", () => {
    //   a → b → d → f
    //   a → c → e → f
    //   b → e
    const nodes = [
      makeNode("a", "trigger"),
      makeNode("b"), makeNode("c"),
      makeNode("d"), makeNode("e"),
      makeNode("f", "output"),
    ];
    const edges: WorkflowEdge[] = [
      { from: "a", to: "b" }, { from: "a", to: "c" },
      { from: "b", to: "d" }, { from: "b", to: "e" },
      { from: "c", to: "e" },
      { from: "d", to: "f" }, { from: "e", to: "f" },
    ];
    const sorted = topologicalSort(nodes, edges);
    expect(sorted[0]).toBe("a");
    expect(sorted[sorted.length - 1]).toBe("f");

    // Verify ordering constraints
    const indexOf = (id: string) => sorted.indexOf(id);
    expect(indexOf("a")).toBeLessThan(indexOf("b"));
    expect(indexOf("a")).toBeLessThan(indexOf("c"));
    expect(indexOf("b")).toBeLessThan(indexOf("d"));
    expect(indexOf("b")).toBeLessThan(indexOf("e"));
    expect(indexOf("c")).toBeLessThan(indexOf("e"));
    expect(indexOf("d")).toBeLessThan(indexOf("f"));
    expect(indexOf("e")).toBeLessThan(indexOf("f"));
  });
});
