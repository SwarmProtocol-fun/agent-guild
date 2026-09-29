/** Map Workflow Node — Generic configurable React Flow node for triggers, actions, and flow control. */
"use client";

import { useState, memo } from "react";
import { Handle, Position } from "@xyflow/react";
import { NODE_CATALOG_MAP } from "./agent-map-node-catalog";

/* ── Color mappings ── */

const BORDER_COLORS: Record<string, string> = {
  amber: "border-amber-400",
  purple: "border-purple-400",
  blue: "border-blue-400",
  orange: "border-orange-400",
  red: "border-red-400",
  yellow: "border-yellow-400",
};

const BG_COLORS: Record<string, string> = {
  amber: "bg-amber-500/10",
  purple: "bg-purple-500/10",
  blue: "bg-blue-500/10",
  orange: "bg-orange-500/10",
  red: "bg-red-500/10",
  yellow: "bg-yellow-500/10",
};

const TAG_COLORS: Record<string, string> = {
  amber: "text-amber-600 dark:text-amber-400",
  purple: "text-purple-600 dark:text-purple-400",
  blue: "text-blue-600 dark:text-blue-400",
  orange: "text-orange-600 dark:text-orange-400",
  red: "text-red-600 dark:text-red-400",
  yellow: "text-yellow-600 dark:text-yellow-400",
};

const HANDLE_COLORS: Record<string, string> = {
  amber: "!bg-amber-500",
  purple: "!bg-purple-500",
  blue: "!bg-blue-500",
  orange: "!bg-orange-500",
  red: "!bg-red-500",
  yellow: "!bg-yellow-500",
};

/* ── Category labels ── */

const CATEGORY_LABELS: Record<string, string> = {
  amber: "Trigger",
  purple: "Logic",
  blue: "Action",
  orange: "Flow",
  red: "Flow",
  yellow: "Note",
};

/* ── Detail field definitions per node type ── */

const NODE_DETAIL_FIELDS: Record<string, Array<{ key: string; label: string }>> = {
  mapPrompt: [{ key: "prompt", label: "Prompt" }],
  mapTriggerManual: [],
  mapTriggerWebhook: [{ key: "url", label: "Endpoint URL" }],
  mapTriggerSchedule: [{ key: "cron", label: "Cron Expression" }],
  mapTriggerJobComplete: [],
  mapHttpRequest: [
    { key: "method", label: "Method" },
    { key: "url", label: "URL" },
  ],
  mapCodeScript: [
    { key: "language", label: "Language" },
    { key: "code", label: "Code" },
  ],
  mapDispatchJob: [
    { key: "prompt", label: "Prompt" },
    { key: "priority", label: "Priority" },
  ],
  mapSendMessage: [
    { key: "target", label: "Target" },
    { key: "message", label: "Message" },
  ],
  mapDelay: [{ key: "durationMs", label: "Duration (ms)" }],
  mapLoop: [
    { key: "mode", label: "Mode" },
    { key: "count", label: "Count" },
  ],
  mapErrorHandler: [
    { key: "action", label: "Action" },
    { key: "retries", label: "Retries" },
  ],
  mapLlmCall: [
    { key: "model", label: "Model" },
    { key: "prompt", label: "Prompt" },
  ],
  mapSummarizer: [
    { key: "inputField", label: "Input Field" },
    { key: "maxLength", label: "Max Length" },
  ],
  mapClassifier: [
    { key: "categories", label: "Categories" },
  ],
};

/* ── Component ── */

interface MapWorkflowNodeData {
  label: string;
  [key: string]: unknown;
}

function MapWorkflowNodeInner({
  data,
  nodeType,
}: {
  data: MapWorkflowNodeData;
  nodeType: string;
}) {
  const [expanded, setExpanded] = useState(false);

  const catalogItem = NODE_CATALOG_MAP[nodeType];
  const color = catalogItem?.color || "blue";
  const icon = catalogItem?.icon || "⚙️";
  const fields = NODE_DETAIL_FIELDS[nodeType] || [];

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        setExpanded(!expanded);
      }}
      className={`rounded-lg border-2 bg-card px-3 py-2.5 shadow-md cursor-pointer transition-all duration-200 ${
        expanded ? "min-w-[220px] max-w-[280px]" : "min-w-[160px] max-w-[220px]"
      } ${BORDER_COLORS[color] || "border-border"}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className={`!w-3 !h-3 ${HANDLE_COLORS[color] || "!bg-blue-500"}`}
      />

      {/* Header */}
      <div className="flex items-center gap-2 mb-1">
        <span className="text-base">{icon}</span>
        <span className="text-xs font-semibold truncate flex-1">{data.label}</span>
        <span
          className={`text-[9px] font-bold uppercase tracking-wider ${
            TAG_COLORS[color] || ""
          }`}
        >
          {CATEGORY_LABELS[color] || "Node"}
        </span>
      </div>

      {/* Collapsed */}
      {!expanded && (
        <p className="text-[10px] text-muted-foreground/60 mt-0.5">
          Click to expand
        </p>
      )}

      {/* Expanded details */}
      {expanded && fields.length > 0 && (
        <div className="mt-2 space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
          {fields.map((field) => {
            const val = data[field.key];
            return (
              <div
                key={field.key}
                className={`px-2 py-1.5 rounded text-[11px] ${
                  BG_COLORS[color] || "bg-muted/50"
                }`}
              >
                <span className="text-[10px] text-muted-foreground">
                  {field.label}
                </span>
                <p className="font-medium text-foreground truncate">
                  {val != null && val !== "" ? String(val) : "—"}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {expanded && fields.length === 0 && (
        <div className="mt-2 animate-in fade-in slide-in-from-top-1 duration-200">
          <p className="text-[10px] text-muted-foreground">
            No configuration required
          </p>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className={`!w-3 !h-3 ${HANDLE_COLORS[color] || "!bg-blue-500"}`}
      />
    </div>
  );
}

/**
 * Factory — creates a named React Flow node component for a given node type key.
 * This avoids creating 11 near-identical component files.
 */
export function createWorkflowNodeType(typeKey: string) {
  const Component = memo(function WorkflowNode({
    data,
  }: {
    data: MapWorkflowNodeData;
  }) {
    return <MapWorkflowNodeInner data={data} nodeType={typeKey} />;
  });
  Component.displayName = `MapWorkflow_${typeKey}`;
  return Component;
}
