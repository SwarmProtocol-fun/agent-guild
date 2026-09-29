/** Map Custom Edge — Bezier edge with hover toolbar and status coloring (n8n-style). */
"use client";

import { memo, useState, useCallback } from "react";
import {
  getBezierPath,
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
} from "@xyflow/react";
import { Trash2, Plus } from "lucide-react";

export const MapCustomEdge = memo(function MapCustomEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  label,
  data,
  selected,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  // Status-based coloring
  const status = (data as Record<string, unknown>)?.status as string | undefined;
  const animated = (data as Record<string, unknown>)?.animated as boolean | undefined;
  let strokeColor = "#d97706"; // default amber
  if (status === "success") strokeColor = "#10b981";
  else if (status === "error") strokeColor = "#ef4444";
  else if (status === "active") strokeColor = "#fbbf24";

  const handleDelete = useCallback(() => {
    // Dispatch a custom event that agent-map.tsx listens for
    window.dispatchEvent(new CustomEvent("map-edge-delete", { detail: { edgeId: id } }));
  }, [id]);

  const handleAddNode = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("map-edge-add-node", {
        detail: { edgeId: id, x: labelX, y: labelY },
      })
    );
  }, [id, labelX, labelY]);

  return (
    <>
      {/* Invisible wider hit area for easier hover/selection */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="react-flow__edge-interaction"
      />

      {/* Visible edge */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth: hovered || selected ? 3 : 2,
          filter: hovered || selected ? `drop-shadow(0 0 4px ${strokeColor}80)` : undefined,
          transition: "stroke-width 0.2s, filter 0.2s",
          strokeDasharray: animated ? "5 5" : undefined,
        }}
      />

      {/* Edge label */}
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
            }}
            className="text-[10px] font-medium bg-card px-1.5 py-0.5 rounded border border-border shadow-sm"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}

      {/* Edge toolbar on hover */}
      {(hovered || selected) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY - 20}px)`,
              pointerEvents: "all",
            }}
            className="flex items-center gap-0.5 bg-card border border-border rounded-md shadow-lg p-0.5"
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            <button
              onClick={handleAddNode}
              className="p-1 rounded hover:bg-accent transition-colors"
              title="Add node here"
            >
              <Plus className="w-3 h-3 text-muted-foreground" />
            </button>
            <button
              onClick={handleDelete}
              className="p-1 rounded hover:bg-destructive/10 transition-colors"
              title="Delete edge"
            >
              <Trash2 className="w-3 h-3 text-destructive" />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});
