/**
 * Canvas Transform — Bidirectional conversion between React Flow's node/edge
 * model and the workflow engine's WorkflowNode/WorkflowEdge model.
 */

import type { Node, Edge } from "@xyflow/react";
import type {
  WorkflowNode,
  WorkflowEdge,
  WorkflowNodeType,
  AgentTaskConfig,
  TriggerConfig,
  OutputConfig,
} from "./types";

// ── React Flow → Engine ─────────────────────────────────────────────────────

/** Map React Flow node type string to engine WorkflowNodeType */
function rfTypeToEngineType(rfType: string): WorkflowNodeType {
  if (rfType === "agent") return "agent-task";
  return rfType as WorkflowNodeType;
}

/** Build engine-compatible config from React Flow node data */
function rfDataToConfig(
  rfType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  switch (rfType) {
    case "trigger":
      return {
        triggerType: "manual",
      } satisfies TriggerConfig;

    case "agent":
      return {
        agentId: data.agentId as string,
        descriptionTemplate: (data.descriptionTemplate as string) || "Execute task",
        priority: ((data.priority as string) || "normal") as AgentTaskConfig["priority"],
      } satisfies AgentTaskConfig;

    case "output":
      return {
        label: (data.label as string) || "Result",
        outputType: ((data.outputType as string) || "result") as OutputConfig["outputType"],
      } satisfies OutputConfig;

    default:
      return { ...data };
  }
}

/** Convert React Flow nodes + edges into engine WorkflowNode[] + WorkflowEdge[] */
export function canvasToWorkflow(
  rfNodes: Node[],
  rfEdges: Edge[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNode[] = rfNodes.map((n) => ({
    id: n.id,
    type: rfTypeToEngineType(n.type || "transform"),
    label:
      (n.data?.agentName as string) ||
      (n.data?.label as string) ||
      n.type ||
      "Node",
    config: rfDataToConfig(n.type || "transform", (n.data || {}) as Record<string, unknown>),
    position: n.position,
  }));

  const edges: WorkflowEdge[] = rfEdges.map((e) => ({
    from: e.source,
    to: e.target,
    label: e.label as string | undefined,
  }));

  return { nodes, edges };
}

// ── Engine → React Flow ─────────────────────────────────────────────────────

/** Map engine WorkflowNodeType to React Flow node type string */
function engineTypeToRfType(engineType: WorkflowNodeType): string {
  if (engineType === "agent-task") return "agent";
  return engineType;
}

/** Build React Flow data from engine node */
function engineConfigToRfData(
  node: WorkflowNode,
): Record<string, unknown> {
  switch (node.type) {
    case "trigger":
      return {
        label: node.label || "Start",
        description: "Workflow trigger",
      };

    case "agent-task": {
      const config = node.config as AgentTaskConfig;
      return {
        agentId: config.agentId,
        agentName: node.label,
        agentType: "general",
        agentStatus: "offline",
        estimatedCost: 0,
        descriptionTemplate: config.descriptionTemplate,
        priority: config.priority,
      };
    }

    case "output": {
      const config = node.config as OutputConfig;
      return {
        label: config.label || node.label || "Result",
        outputType: config.outputType || "result",
      };
    }

    default:
      return { label: node.label, ...node.config };
  }
}

/** Convert engine WorkflowNode[] + WorkflowEdge[] into React Flow nodes + edges */
export function workflowToCanvas(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): { rfNodes: Node[]; rfEdges: Edge[] } {
  const rfNodes: Node[] = nodes.map((n) => ({
    id: n.id,
    type: engineTypeToRfType(n.type),
    position: n.position || { x: 0, y: 0 },
    data: engineConfigToRfData(n),
  }));

  const rfEdges: Edge[] = edges.map((e, i) => ({
    id: `edge-${i}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    label: e.label,
    animated: true,
    style: { stroke: "#d97706", strokeWidth: 2 },
  }));

  return { rfNodes, rfEdges };
}
