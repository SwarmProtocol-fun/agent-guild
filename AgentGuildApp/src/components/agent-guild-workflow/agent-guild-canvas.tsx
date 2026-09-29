/** Swarm Canvas — React Flow visual workflow editor with integrated execution. */
'use client';

import { useCallback, useRef, useState, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { Agent } from '@/lib/firestore';
import { validateWorkflow } from '@/lib/swarm-workflow';
import { canvasToWorkflow, workflowToCanvas } from '@/lib/workflow/canvas-transform';
import type { WorkflowNode, WorkflowEdge } from '@/lib/workflow/types';
import { useWorkflowRun } from '@/hooks/useWorkflowRun';
import { nodeTypes } from './nodes';
import { NodePalette } from './node-palette';
import { PriceSummary } from './price-summary';
import { RunProgressOverlay } from './run-detail-panel';

interface SwarmCanvasProps {
  agents: Agent[];
  orgId?: string;
  /** Existing workflow ID (for edit mode) */
  workflowId?: string;
  /** Pre-loaded nodes + edges (for edit mode) */
  initialNodes?: WorkflowNode[];
  initialEdges?: WorkflowEdge[];
  /** Callback when workflow is saved */
  onSaved?: (workflowId: string) => void;
}

let nodeId = 0;
const getNodeId = () => `swarm_node_${nodeId++}`;

function SwarmCanvasInner({
  agents,
  orgId,
  workflowId: existingWorkflowId,
  initialNodes,
  initialEdges,
  onSaved,
}: SwarmCanvasProps) {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  // Convert initial engine data to RF format if provided
  const initialRf = useMemo(() => {
    if (initialNodes && initialEdges) {
      return workflowToCanvas(initialNodes, initialEdges);
    }
    return { rfNodes: [] as Node[], rfEdges: [] as Edge[] };
  }, [initialNodes, initialEdges]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initialRf.rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialRf.rfEdges);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReturnType<typeof Object> | null>(null);

  // Execution state
  const [executingRunId, setExecutingRunId] = useState<string | null>(null);
  const [workflowId, setWorkflowId] = useState<string | undefined>(existingWorkflowId);
  const [executing, setExecuting] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  const { run, isPolling, cancel } = useWorkflowRun(executingRunId, orgId || "");

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge({
        ...connection,
        animated: true,
        style: { stroke: '#d97706', strokeWidth: 2 },
      }, eds));
    },
    [setEdges]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData('application/reactflow-type');
      const dataString = event.dataTransfer.getData('application/reactflow-data');

      if (!type || !reactFlowInstance) return;

      const position = (reactFlowInstance as any).screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const data = JSON.parse(dataString);

      const newNode: Node = {
        id: getNodeId(),
        type,
        position,
        data,
      };

      setNodes((nds) => [...nds, newNode]);
    },
    [reactFlowInstance, setNodes]
  );

  const validation = useMemo(
    () => validateWorkflow(nodes, edges),
    [nodes, edges]
  );

  const agentNodeCount = nodes.filter(n => n.type === 'agent').length;

  const handleExecute = async () => {
    if (!validation.isValid || !orgId || executing) return;

    setExecuting(true);
    setExecError(null);

    try {
      const { nodes: engineNodes, edges: engineEdges } = canvasToWorkflow(nodes, edges);

      // Create or update workflow definition
      let wfId = workflowId;
      if (!wfId) {
        const createRes = await fetch("/api/workflows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orgId,
            name: `Workflow ${new Date().toLocaleString()}`,
            nodes: engineNodes,
            edges: engineEdges,
            enabled: true,
          }),
        });
        if (!createRes.ok) {
          const data = await createRes.json().catch(() => ({}));
          throw new Error(data.error || "Failed to save workflow");
        }
        const createData = await createRes.json();
        wfId = createData.id;
        setWorkflowId(wfId);
        onSaved?.(wfId!);
      } else {
        await fetch(`/api/workflows/${wfId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orgId, nodes: engineNodes, edges: engineEdges }),
        });
      }

      // Start a run
      const runRes = await fetch(`/api/workflows/${wfId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId }),
      });
      if (!runRes.ok) {
        const data = await runRes.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start run");
      }
      const runData = await runRes.json();
      setExecutingRunId(runData.runId);
    } catch (err) {
      setExecError(err instanceof Error ? err.message : "Execution failed");
    } finally {
      setExecuting(false);
    }
  };

  const handleCancel = async () => {
    await cancel();
    setExecutingRunId(null);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-16rem)] rounded-lg border border-border overflow-hidden bg-card">
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 relative" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={{
              animated: true,
              style: { stroke: '#d97706', strokeWidth: 2 },
            }}
            fitView
            className="bg-muted"
          >
            <Background color="#d4d4d4" gap={20} />
            <Controls />
            <MiniMap
              nodeColor={(node) => {
                if (node.type === 'trigger') return '#f59e0b';
                if (node.type === 'output') return '#10b981';
                return '#fbbf24';
              }}
            />
            {nodes.length === 0 && (
              <Panel position="top-center">
                <div className="bg-card/90 border border-border rounded-lg px-6 py-4 text-center shadow-sm mt-20">
                  <p className="text-muted-foreground font-medium">
                    Drag nodes from the palette to build your swarm workflow
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Start with a Trigger, add Agents, and end with an Output
                  </p>
                </div>
              </Panel>
            )}
          </ReactFlow>

          {/* Execution progress overlay */}
          {run && executingRunId && (
            <RunProgressOverlay
              run={run}
              isPolling={isPolling}
              onCancel={handleCancel}
              onClose={() => setExecutingRunId(null)}
            />
          )}
        </div>

        <NodePalette agents={agents} />
      </div>

      {execError && (
        <div className="bg-red-50 border-t border-red-200 px-4 py-2 text-sm text-red-800 text-center">
          {execError}
        </div>
      )}

      <PriceSummary
        validation={validation}
        agentCount={agentNodeCount}
        onExecute={handleExecute}
        executing={executing || isPolling}
        onCancel={isPolling ? handleCancel : undefined}
      />
    </div>
  );
}

export function SwarmCanvas(props: SwarmCanvasProps) {
  return (
    <ReactFlowProvider>
      <SwarmCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
