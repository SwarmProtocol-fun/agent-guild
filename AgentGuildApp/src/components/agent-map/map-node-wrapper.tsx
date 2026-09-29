/** Map Node Wrapper — HOC that adds n8n-style hover toolbar + execution state borders to any node. */
"use client";

import { memo, useCallback } from "react";
import { NodeToolbar, Position, useReactFlow } from "@xyflow/react";
import { Play, Copy, Trash2, Ban } from "lucide-react";

type ExecutionState = "idle" | "running" | "waiting" | "success" | "error";

const EXECUTION_CLASSES: Record<ExecutionState, string> = {
  idle: "",
  running: "node-execution-running",
  waiting: "node-execution-running node-execution-waiting",
  success: "node-execution-success",
  error: "node-execution-error",
};

interface WrapperOptions {
  /** If true, node cannot be deleted or duplicated (data-driven nodes) */
  protected?: boolean;
}

/**
 * withNodeWrapper — wraps a React Flow node component with:
 * 1. Execution state CSS classes (running/success/error/waiting)
 * 2. Hover toolbar with Delete/Duplicate/Run buttons
 * 3. Disabled state overlay
 */
export function withNodeWrapper<P extends { data: Record<string, unknown>; id?: string }>(
  WrappedComponent: React.ComponentType<P>,
  options: WrapperOptions = {}
) {
  const Wrapper = memo(function NodeWrapper(props: P) {
    const { data, id } = props;
    const reactFlow = useReactFlow();

    const executionState = (data.executionState as ExecutionState) || "idle";
    const isDisabled = !!data.disabled;
    const isProtected = options.protected ?? false;

    const stateClass = EXECUTION_CLASSES[executionState] || "";
    const disabledClass = isDisabled ? "node-execution-disabled" : "";

    const handleDelete = useCallback(() => {
      if (isProtected || !id) return;
      reactFlow.deleteElements({ nodes: [{ id }] });
    }, [id, isProtected, reactFlow]);

    const handleDuplicate = useCallback(() => {
      if (isProtected || !id) return;
      const node = reactFlow.getNode(id);
      if (!node) return;
      const newId = `map_wf_${Date.now()}`;
      reactFlow.addNodes({
        id: newId,
        type: node.type,
        position: { x: node.position.x + 40, y: node.position.y + 40 },
        data: { ...node.data },
      });
    }, [id, isProtected, reactFlow]);

    const handleToggleDisable = useCallback(() => {
      if (!id) return;
      reactFlow.updateNodeData(id, { disabled: !isDisabled });
    }, [id, isDisabled, reactFlow]);

    const handleRun = useCallback(() => {
      if (!id) return;
      // Set running state briefly to demo the animation
      reactFlow.updateNodeData(id, { executionState: "running" });
      setTimeout(() => {
        reactFlow.updateNodeData(id, { executionState: "success" });
        setTimeout(() => {
          reactFlow.updateNodeData(id, { executionState: "idle" });
        }, 2000);
      }, 2000);
    }, [id, reactFlow]);

    return (
      <div className={`relative ${stateClass} ${disabledClass}`}>
        {/* Hover toolbar */}
        {!isProtected && (
          <NodeToolbar position={Position.Top} offset={8} align="center">
            <div className="flex items-center gap-0.5 bg-card border border-border rounded-md shadow-lg p-0.5 map-node-toolbar">
              <button
                onClick={handleRun}
                className="p-1.5 rounded hover:bg-emerald-500/10 transition-colors"
                title="Run node"
              >
                <Play className="w-3 h-3 text-emerald-500" />
              </button>
              <button
                onClick={handleDuplicate}
                className="p-1.5 rounded hover:bg-accent transition-colors"
                title="Duplicate"
              >
                <Copy className="w-3 h-3 text-muted-foreground" />
              </button>
              <button
                onClick={handleToggleDisable}
                className={`p-1.5 rounded transition-colors ${
                  isDisabled ? "bg-amber-500/10 hover:bg-amber-500/20" : "hover:bg-accent"
                }`}
                title={isDisabled ? "Enable" : "Disable"}
              >
                <Ban className={`w-3 h-3 ${isDisabled ? "text-amber-500" : "text-muted-foreground"}`} />
              </button>
              <div className="w-px h-4 bg-border mx-0.5" />
              <button
                onClick={handleDelete}
                className="p-1.5 rounded hover:bg-destructive/10 transition-colors"
                title="Delete"
              >
                <Trash2 className="w-3 h-3 text-destructive" />
              </button>
            </div>
          </NodeToolbar>
        )}

        <WrappedComponent {...props} />
      </div>
    );
  });

  Wrapper.displayName = `WithNodeWrapper(${WrappedComponent.displayName || WrappedComponent.name || "Component"})`;
  return Wrapper;
}
