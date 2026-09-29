/** Agent Map Canvas — React Flow graph visualization of agents, hub, and job nodes with connections. */
"use client";

// Restore native Map/Set if MetaMask SES lockdown corrupted them
if (typeof window !== "undefined") {
  const g = globalThis as Record<string, unknown>;
  if (typeof Map !== "function" && typeof g.__nativeMap === "function") {
    (globalThis as Record<string, unknown>).Map = g.__nativeMap;
  }
  if (typeof Set !== "function" && typeof g.__nativeSet === "function") {
    (globalThis as Record<string, unknown>).Set = g.__nativeSet;
  }
}

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { MapAgentNode } from "./map-agent-node";
import { MapHubNode } from "./map-hub-node";
import { MapJobNode } from "./map-job-node";
import { createWorkflowNodeType } from "./map-workflow-node";
import { MapConditionNode, MapSwitchNode, MapMergeNode } from "./map-logic-node";
import { MapStickyNode } from "./map-sticky-node";
import { MapPromptNode } from "./map-prompt-node";
import { MapCustomEdge } from "./map-custom-edge";
import { MapContextMenu, buildCanvasMenuActions, buildNodeMenuActions } from "./map-context-menu";
import { withNodeWrapper } from "./map-node-wrapper";
import { AgentMapPalette, type DockPosition } from "./agent-map-palette";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PanelLeftClose, PanelLeftOpen, Maximize, Trash2, Play, Plus, Minus, LocateFixed, MapPinned, Undo2, Redo2, Save, FolderOpen, AlertCircle } from "lucide-react";

interface Agent {
  id: string;
  name: string;
  type: string;
  status: string;
  costPerRun?: number;
  activeJobName?: string;
  assignedCost?: number;
}

interface Task {
  id: string;
  status: string;
  assigneeAgentId?: string;
}

interface Job {
  id: string;
  title: string;
  reward?: string;
  priority: string;
  requiredSkills: string[];
  status: string;
}

export interface DispatchPayload {
  prompt: string;
  priority: "low" | "medium" | "high";
  reward: string;
  agentIds: string[];
}

interface AgentMapProps {
  projectName: string;
  agents: Agent[];
  tasks: Task[];
  jobs?: Job[];
  onAssign?: (assignments: { jobId: string; agentId: string; jobTitle: string; agentName: string }[]) => Promise<void>;
  onDispatch?: (payload: DispatchPayload) => Promise<void>;
  executing?: boolean;
  currencySymbol?: string;
}

// ─── Undo/Redo History ──────────────────────────────────────────────────────

interface HistoryEntry {
  nodes: Node[];
  edges: Edge[];
}

const MAX_HISTORY = 50;

function useHistory() {
  const [past, setPast] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    setPast(prev => [...prev.slice(-MAX_HISTORY + 1), entry]);
    setFuture([]);
  }, []);

  const undo = useCallback((current: HistoryEntry): HistoryEntry | null => {
    if (past.length === 0) return null;
    const prev = past[past.length - 1];
    setPast(p => p.slice(0, -1));
    setFuture(f => [...f, current]);
    return prev;
  }, [past]);

  const redo = useCallback((current: HistoryEntry): HistoryEntry | null => {
    if (future.length === 0) return null;
    const next = future[future.length - 1];
    setFuture(f => f.slice(0, -1));
    setPast(p => [...p, current]);
    return next;
  }, [future]);

  return { pushHistory, undo, redo, canUndo: past.length > 0, canRedo: future.length > 0 };
}

// ─── Workflow Persistence ────────────────────────────────────────────────────

const WORKFLOW_STORAGE_KEY = "swarm-agent-map-workflow";

function saveWorkflow(nodes: Node[], edges: Edge[]) {
  try {
    const data = JSON.stringify({ nodes, edges, savedAt: Date.now() });
    localStorage.setItem(WORKFLOW_STORAGE_KEY, data);
  } catch {
    // localStorage may be full or unavailable
  }
}

function loadWorkflow(): { nodes: Node[]; edges: Edge[] } | null {
  try {
    const raw = localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.nodes && data.edges) return data;
  } catch {
    // Corrupted data
  }
  return null;
}

// ─── Edge Validation ─────────────────────────────────────────────────────────

/** Data-driven node types that should not receive workflow connections */
const DATA_NODE_TYPES: Record<string, true> = { agentNode: true, hubNode: true, jobNode: true };

function isValidConnection(connection: Connection, nodes: Node[]): boolean {
  if (!connection.source || !connection.target) return false;
  // Prevent self-loops
  if (connection.source === connection.target) return false;

  const sourceNode = nodes.find(n => n.id === connection.source);
  const targetNode = nodes.find(n => n.id === connection.target);
  if (!sourceNode || !targetNode) return false;

  // Allow agent → job connections (assignment)
  if (sourceNode.type === "agentNode" && targetNode.type === "jobNode") return true;
  // Allow agent → prompt connections
  if (sourceNode.type === "agentNode" && targetNode.type === "mapPrompt") return true;

  // Allow workflow → workflow connections
  const sourceIsData = !!(sourceNode.type && DATA_NODE_TYPES[sourceNode.type]);
  const targetIsData = !!(targetNode.type && DATA_NODE_TYPES[targetNode.type]);

  // Block data node → data node connections (except agent→job above)
  if (sourceIsData && targetIsData) return false;

  return true;
}

// ─── Node Types ──────────────────────────────────────────────────────────────

// Wrap workflow nodes with hover toolbar + execution states
const wrappedWorkflow = (key: string) => withNodeWrapper(createWorkflowNodeType(key));

const nodeTypes = {
  // Data-driven nodes (protected — no delete/duplicate)
  agentNode: MapAgentNode,
  hubNode: MapHubNode,
  jobNode: MapJobNode,
  // Prompt input
  mapPrompt: withNodeWrapper(MapPromptNode),
  // Triggers
  mapTriggerManual: wrappedWorkflow("mapTriggerManual"),
  mapTriggerWebhook: wrappedWorkflow("mapTriggerWebhook"),
  mapTriggerSchedule: wrappedWorkflow("mapTriggerSchedule"),
  mapTriggerJobComplete: wrappedWorkflow("mapTriggerJobComplete"),
  // Logic
  mapCondition: withNodeWrapper(MapConditionNode),
  mapSwitch: withNodeWrapper(MapSwitchNode),
  mapMerge: withNodeWrapper(MapMergeNode),
  // Actions
  mapHttpRequest: wrappedWorkflow("mapHttpRequest"),
  mapCodeScript: wrappedWorkflow("mapCodeScript"),
  mapDispatchJob: wrappedWorkflow("mapDispatchJob"),
  mapSendMessage: wrappedWorkflow("mapSendMessage"),
  // Flow control
  mapDelay: wrappedWorkflow("mapDelay"),
  mapLoop: wrappedWorkflow("mapLoop"),
  mapErrorHandler: wrappedWorkflow("mapErrorHandler"),
  // AI
  mapLlmCall: wrappedWorkflow("mapLlmCall"),
  mapSummarizer: wrappedWorkflow("mapSummarizer"),
  mapClassifier: wrappedWorkflow("mapClassifier"),
  // Annotations
  mapSticky: MapStickyNode,
};

const edgeTypes = {
  mapCustomEdge: MapCustomEdge,
};

let mapNodeId = 0;
const getMapNodeId = () => `map_wf_${mapNodeId++}`;

function AgentMapInner({ agents, tasks, jobs = [], onAssign, onDispatch, executing = false, currencySymbol = "$" }: AgentMapProps) {
  const [assignmentEdges, setAssignmentEdges] = useState<Edge[]>([]);
   
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  const [showPalette, setShowPalette] = useState(true);
  const [dockPosition, setDockPosition] = useState<DockPosition>("left");
  const [userWorkflowNodes, setUserWorkflowNodes] = useState<Node[]>([]);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [miniMapColor, setMiniMapColor] = useState<"default" | "mono" | "warm">("default");

  // Error feedback state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showError = useCallback((msg: string) => {
    setErrorMessage(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setErrorMessage(null), 5000);
  }, []);

  // Undo/redo
  const { pushHistory, undo, redo, canUndo, canRedo } = useHistory();

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId?: string;
  } | null>(null);

  const rfInstance = useReactFlow();

  // Quick dispatch state
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchPrompt, setDispatchPrompt] = useState("");
  const [dispatchPriority, setDispatchPriority] = useState<"low" | "medium" | "high">("medium");
  const [dispatchReward, setDispatchReward] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
  const [dispatching, setDispatching] = useState(false);

  const openJobs = useMemo(() => jobs.filter((j) => j.status === "open"), [jobs]);

  const { initialNodes, initialEdges } = useMemo(() => {
    // Agent nodes — left side, stacked vertically
    const agentStartX = 80;
    const agentStartY = 80;
    const agentSpacing = 100;

    const agentNodes: Node[] = agents.map((agent, i) => {
      const agentTasks = tasks.filter((t) => t.assigneeAgentId === agent.id);
      const agentActive = agentTasks.filter((t) => t.status === "in_progress");
      const a = agent as unknown as Record<string, unknown>;

      return {
        id: agent.id,
        type: "agentNode",
        position: { x: agentStartX, y: agentStartY + i * agentSpacing },
        data: {
          label: agent.name,
          agentName: agent.name,
          type: agent.type,
          status: agent.status,
          taskCount: agentTasks.length,
          activeCount: agentActive.length,
          costEstimate: `$${(agent.costPerRun ?? 1.5).toFixed(2)}`,
          activeJobName: agent.activeJobName,
          assignedCost: agent.assignedCost ?? 0,
          currencySymbol,
          // ChatDev-style extended data
          asn: a.asn as string | undefined,
          creditScore: (a.creditScore as number) || 0,
          trustScore: (a.trustScore as number) || 0,
          skills: Array.isArray(a.reportedSkills)
            ? (a.reportedSkills as { name: string }[]).map(s => s.name)
            : [],
        },
      };
    });

    // Inter-agent communication edges (ChatDev-style chain)
    // Connect agents that share the same active job (collaborative chain)
    const commEdges: Edge[] = [];
    const busyAgents = agents.filter(a => a.status === "busy" && a.activeJobName);
    const jobGroups: Record<string, string[]> = {};
    for (const a of busyAgents) {
      const jobName = a.activeJobName!;
      if (!jobGroups[jobName]) jobGroups[jobName] = [];
      jobGroups[jobName].push(a.id);
    }
    for (const agentIds of Object.values(jobGroups)) {
      for (let j = 0; j < agentIds.length - 1; j++) {
        commEdges.push({
          id: `comm-${agentIds[j]}-${agentIds[j + 1]}`,
          source: agentIds[j],
          sourceHandle: "job-source",
          target: agentIds[j + 1],
          animated: true,
          style: { stroke: "#a855f7", strokeWidth: 2, strokeDasharray: "3 3" },
          label: "collab",
          labelStyle: { fontSize: 9, fill: "#a855f7" },
          type: "mapCustomEdge",
        });
      }
    }

    // Prompt node — right side, vertically centered
    const agentBlockHeight = Math.max(0, (agents.length - 1) * agentSpacing);
    const startX = 500;
    const startY = agentStartY + agentBlockHeight / 2;

    const promptNode: Node = {
      id: "prompt-start",
      type: "mapPrompt",
      position: { x: startX, y: startY },
      data: { label: "Prompt", prompt: "" },
    };

    // Edges from each agent → prompt node
    const startEdges: Edge[] = agents.map((agent) => ({
      id: `start-${agent.id}`,
      source: agent.id,
      target: "prompt-start",
      animated: false,
      style: {
        stroke: "#d97706",
        strokeWidth: 2,
        strokeDasharray: "5 5",
      },
    }));

    return {
      initialNodes: [...agentNodes, promptNode],
      initialEdges: [...startEdges, ...commEdges],
    };
  }, [agents, tasks, currencySymbol]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState([...initialEdges, ...assignmentEdges]);

  // Load saved workflow on mount
  useEffect(() => {
    const saved = loadWorkflow();
    if (saved && saved.nodes.length > 0) {
      const workflowNodes = saved.nodes.filter(n => n.id.startsWith("map_wf_"));
      if (workflowNodes.length > 0) {
        setUserWorkflowNodes(workflowNodes);
      }
    }
  }, []);

  // Sync nodes/edges when data changes — preserve user-dropped workflow nodes
  useEffect(() => {
    setNodes([...initialNodes, ...userWorkflowNodes]);
  }, [initialNodes, userWorkflowNodes, setNodes]);

  useEffect(() => {
    setEdges([...initialEdges, ...assignmentEdges]);
  }, [initialEdges, setEdges, assignmentEdges]);

  // Handle new connections — with validation
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;

      // Validate connection
      if (!isValidConnection(connection, nodes)) {
        showError("Invalid connection — cannot connect these node types");
        return;
      }

      // Prevent duplicate edges
      const exists = edges.some(
        (e) => e.source === connection.source && e.target === connection.target
      );
      if (exists) return;

      // Save history before change
      pushHistory({ nodes: [...nodes], edges: [...edges] });

      setEdges((eds) => addEdge({
        ...connection,
        animated: true,
        style: { stroke: "#d97706", strokeWidth: 2 },
      }, eds));
    },
    [edges, setEdges, nodes, showError, pushHistory]
  );

  // Compute assignments from edges
  const assignments = useMemo(() => {
    return assignmentEdges
      .map((edge) => {
        const agentId = edge.source;
        const jobId = edge.target?.replace("job-", "") || "";
        const agent = agents.find((a) => a.id === agentId);
        const job = openJobs.find((j) => j.id === jobId);
        if (!agent || !job) return null;
        return { jobId: job.id, agentId: agent.id, jobTitle: job.title, agentName: agent.name };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);
  }, [assignmentEdges, agents, openJobs]);

  const totalCost = useMemo(() => {
    return assignments.reduce((sum, a) => {
      const job = openJobs.find((j) => j.id === a.jobId);
      const reward = parseFloat((job?.reward || "0").replace(/[^0-9.]/g, ""));
      return sum + (isNaN(reward) ? 0 : reward);
    }, 0);
  }, [assignments, openJobs]);

  const handleClearAssignments = useCallback(() => {
    setAssignmentEdges([]);
    setEdges(initialEdges);
  }, [initialEdges, setEdges]);

  const handleExecute = useCallback(async () => {
    if (onAssign && assignments.length > 0) {
      try {
        await onAssign(assignments);
        setAssignmentEdges([]);
      } catch (err) {
        showError(`Assignment failed: ${err instanceof Error ? err.message : "Unknown error"}`);
      }
    }
  }, [onAssign, assignments, showError]);

  // ─── Undo / Redo handlers ───
  const handleUndo = useCallback(() => {
    const entry = undo({ nodes: [...nodes], edges: [...edges] });
    if (entry) {
      const workflowNodes = entry.nodes.filter(n => n.id.startsWith("map_wf_"));
      setUserWorkflowNodes(workflowNodes);
      setEdges(entry.edges);
    }
  }, [undo, nodes, edges, setEdges]);

  const handleRedo = useCallback(() => {
    const entry = redo({ nodes: [...nodes], edges: [...edges] });
    if (entry) {
      const workflowNodes = entry.nodes.filter(n => n.id.startsWith("map_wf_"));
      setUserWorkflowNodes(workflowNodes);
      setEdges(entry.edges);
    }
  }, [redo, nodes, edges, setEdges]);

  // ─── Workflow save/load ───
  const handleSaveWorkflow = useCallback(() => {
    saveWorkflow(userWorkflowNodes, edges.filter(e => !e.id.startsWith("start-")));
  }, [userWorkflowNodes, edges]);

  // ─── Drag-and-drop from palette ───
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/reactflow-type");
      const rawData = event.dataTransfer.getData("application/reactflow-data");
      if (!type || !reactFlowInstance) return;

      // FIX #1: Prevent duplicate agent nodes from palette
      if (type === "agentNode") {
        try {
          const parsed = JSON.parse(rawData);
          const agentName = parsed.agentName || parsed.label;
          const alreadyExists = nodes.some(
            n => n.type === "agentNode" && (n.data.agentName === agentName || n.data.label === agentName)
          );
          if (alreadyExists) {
            showError(`Agent "${agentName}" is already on the canvas`);
            return;
          }
        } catch {
          // Continue with drop if parsing fails
        }
      }

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(rawData);
      } catch {
        data = { label: type };
      }

      const newNode: Node = {
        id: getMapNodeId(),
        type,
        position,
        data,
      };

      // Save history before adding
      pushHistory({ nodes: [...nodes], edges: [...edges] });
      setUserWorkflowNodes((prev) => [...prev, newNode]);
    },
    [reactFlowInstance, nodes, edges, showError, pushHistory]
  );

  // ─── Context menu handlers ───
  const isUserNode = useCallback((nodeId: string) => nodeId.startsWith("map_wf_"), []);

  const onPaneContextMenu = useCallback((event: MouseEvent | React.MouseEvent) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault();
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
  }, []);

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleAddSticky = useCallback((screenX: number, screenY: number) => {
    if (!reactFlowInstance) return;
    const position = reactFlowInstance.screenToFlowPosition({ x: screenX, y: screenY });
    const newNode: Node = {
      id: getMapNodeId(),
      type: "mapSticky",
      position,
      data: { label: "Note", content: "", color: "yellow", width: 200, height: 120 },
      style: { width: 200, height: 120 },
    };
    pushHistory({ nodes: [...nodes], edges: [...edges] });
    setUserWorkflowNodes((prev) => [...prev, newNode]);
  }, [reactFlowInstance, nodes, edges, pushHistory]);

  const handleDeleteNode = useCallback((nodeId: string) => {
    if (!isUserNode(nodeId)) return;
    pushHistory({ nodes: [...nodes], edges: [...edges] });
    setUserWorkflowNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
  }, [isUserNode, setNodes, nodes, edges, pushHistory]);

  const handleDuplicateNode = useCallback((nodeId: string) => {
    if (!isUserNode(nodeId)) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    pushHistory({ nodes: [...nodes], edges: [...edges] });
    const newNode: Node = {
      id: getMapNodeId(),
      type: node.type,
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      data: { ...node.data },
    };
    setUserWorkflowNodes((prev) => [...prev, newNode]);
  }, [isUserNode, nodes, edges, pushHistory]);

  const handleToggleDisable = useCallback((nodeId: string) => {
    setNodes((nds) => nds.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, disabled: !n.data.disabled } } : n
    ));
  }, [setNodes]);

  // ─── Keyboard shortcuts ───
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      // Ctrl+Z — undo
      if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Ctrl+Shift+Z or Ctrl+Y — redo
      if ((e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey) || (e.key === "y" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        handleRedo();
        return;
      }

      // Ctrl+S — save workflow
      if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSaveWorkflow();
        return;
      }

      // Delete selected user nodes + selected edges
      if (e.key === "Delete" || e.key === "Backspace") {
        const selectedNodes = nodes.filter((n) => n.selected && isUserNode(n.id));
        const selectedEdgeIds = edges.filter((e) => e.selected).map((e) => e.id);

        if (selectedNodes.length > 0 || selectedEdgeIds.length > 0) {
          e.preventDefault();
          pushHistory({ nodes: [...nodes], edges: [...edges] });
          selectedNodes.forEach((n) => handleDeleteNode(n.id));
          if (selectedEdgeIds.length > 0) {
            setEdges((eds) => eds.filter((edge) => !selectedEdgeIds.includes(edge.id)));
            // FIX #2: Sync assignment edges when edges are deleted via keyboard
            setAssignmentEdges((prev) => prev.filter((edge) => !selectedEdgeIds.includes(edge.id)));
          }
        }
      }

      // Ctrl+A — select all
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setNodes((nds) => nds.map((n) => ({ ...n, selected: true })));
        setEdges((eds) => eds.map((e) => ({ ...e, selected: true })));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [nodes, edges, isUserNode, handleDeleteNode, setNodes, setEdges, handleUndo, handleRedo, handleSaveWorkflow, pushHistory]);

  // ─── Edge delete event listener ───
  useEffect(() => {
    const handleEdgeDelete = (e: Event) => {
      const { edgeId } = (e as CustomEvent).detail;
      pushHistory({ nodes: [...nodes], edges: [...edges] });
      setEdges((eds) => eds.filter((edge) => edge.id !== edgeId));
      // FIX #2: Always sync assignment edges on edge delete
      setAssignmentEdges((prev) => prev.filter((edge) => edge.id !== edgeId));
    };
    window.addEventListener("map-edge-delete", handleEdgeDelete);
    return () => window.removeEventListener("map-edge-delete", handleEdgeDelete);
  }, [setEdges, nodes, edges, pushHistory]);

  // Build context menu actions
  const contextMenuActions = useMemo(() => {
    if (!contextMenu) return [];
    if (contextMenu.nodeId) {
      return buildNodeMenuActions({
        onDuplicate: () => handleDuplicateNode(contextMenu.nodeId!),
        onDelete: () => handleDeleteNode(contextMenu.nodeId!),
        onToggleDisable: () => handleToggleDisable(contextMenu.nodeId!),
        onCopy: () => { /* future: clipboard */ },
        isDisabled: !!nodes.find((n) => n.id === contextMenu.nodeId)?.data?.disabled,
        isProtected: !isUserNode(contextMenu.nodeId!),
      });
    }
    return buildCanvasMenuActions({
      onAddSticky: handleAddSticky,
      onSelectAll: () => setNodes((nds) => nds.map((n) => ({ ...n, selected: true }))),
      onFitView: () => rfInstance.fitView({ duration: 300 }),
      menuX: contextMenu.x,
      menuY: contextMenu.y,
    });
  }, [contextMenu, nodes, isUserNode, handleDuplicateNode, handleDeleteNode, handleToggleDisable, handleAddSticky, setNodes, rfInstance]);

  const toggleAgent = useCallback((id: string) => {
    setSelectedAgentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllAgents = useCallback(() => {
    if (selectedAgentIds.size === agents.length) {
      setSelectedAgentIds(new Set());
    } else {
      setSelectedAgentIds(new Set(agents.map((a) => a.id)));
    }
  }, [selectedAgentIds.size, agents]);

  // FIX #3: Dispatch with user-visible error feedback
  const handleDispatch = useCallback(async () => {
    if (!onDispatch || !dispatchPrompt.trim() || selectedAgentIds.size === 0) return;
    try {
      setDispatching(true);
      await onDispatch({
        prompt: dispatchPrompt.trim(),
        priority: dispatchPriority,
        reward: dispatchReward.trim(),
        agentIds: [...selectedAgentIds],
      });
      // Reset form
      setDispatchPrompt("");
      setDispatchPriority("medium");
      setDispatchReward("");
      setSelectedAgentIds(new Set());
      setDispatchOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      showError(`Dispatch failed: ${message}`);
    } finally {
      setDispatching(false);
    }
  }, [onDispatch, dispatchPrompt, dispatchPriority, dispatchReward, selectedAgentIds, showError]);

  const maxNodes = Math.max(agents.length, openJobs.length);
  const canvasHeight = Math.max(500, Math.min(900, 300 + maxNodes * 80));

  const isHorizontalDock = dockPosition === "top" || dockPosition === "bottom";

  // Handle dock drop zones — detect where palette was dragged
  const handleDockDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/palette-dock")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }, []);

  const handleDockDrop = useCallback((position: DockPosition) => (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/palette-dock")) {
      e.preventDefault();
      setDockPosition(position);
    }
  }, []);

  // Palette element
  const paletteEl = showPalette ? (
    <AgentMapPalette agents={agents} dockPosition={dockPosition} onDockChange={setDockPosition} />
  ) : null;

  // Canvas element
  const canvasEl = (
    <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden" style={{ width: 0 }}>
      {/* Dock drop zones — visible during palette drag */}
      {showPalette && (
        <>
          <div
            className="absolute inset-y-0 left-0 w-8 z-10 opacity-0 hover:opacity-100 transition-opacity"
            onDragOver={handleDockDragOver}
            onDrop={handleDockDrop("left")}
          >
            <div className="h-full w-1 bg-amber-500/30 rounded-r" />
          </div>
          <div
            className="absolute inset-y-0 right-0 w-8 z-10 opacity-0 hover:opacity-100 transition-opacity"
            onDragOver={handleDockDragOver}
            onDrop={handleDockDrop("right")}
          >
            <div className="h-full w-1 bg-amber-500/30 rounded-l ml-auto" />
          </div>
          <div
            className="absolute inset-x-0 top-0 h-8 z-10 opacity-0 hover:opacity-100 transition-opacity"
            onDragOver={handleDockDragOver}
            onDrop={handleDockDrop("top")}
          >
            <div className="w-full h-1 bg-amber-500/30 rounded-b" />
          </div>
          <div
            className="absolute inset-x-0 bottom-0 h-8 z-10 opacity-0 hover:opacity-100 transition-opacity"
            onDragOver={handleDockDragOver}
            onDrop={handleDockDrop("bottom")}
          >
            <div className="w-full h-1 bg-amber-500/30 rounded-t mt-auto" />
          </div>
        </>
      )}

      {/* Error toast */}
      {errorMessage && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-destructive/90 text-destructive-foreground px-4 py-2 rounded-lg shadow-lg animate-in fade-in slide-in-from-top-2 duration-200" role="alert">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="text-sm font-medium">{errorMessage}</span>
          <button onClick={() => setErrorMessage(null)} className="ml-2 hover:opacity-80" aria-label="Dismiss error">×</button>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={(connection) => isValidConnection(connection as Connection, nodes)}
        onInit={setReactFlowInstance}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onPaneClick={closeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{
          type: "mapCustomEdge",
          animated: true,
          style: { stroke: "#d97706", strokeWidth: 2 },
        }}
        edgesFocusable
        edgesReconnectable
        snapToGrid
        snapGrid={[20, 20]}
        fitView
        fitViewOptions={{ maxZoom: 1.5, minZoom: 0.3 }}
        proOptions={{ hideAttribution: true }}
        className="bg-muted"
        aria-label="Agent workflow canvas"
      >
        <Background variant={BackgroundVariant.Dots} color="#d4d4d4" gap={20} size={1.5} />

        {/* Custom zoom controls — styled to match theme */}
        <Panel position="bottom-left">
          <div className="flex flex-col gap-0.5 bg-card/90 backdrop-blur border border-border rounded-lg shadow-sm overflow-hidden" role="toolbar" aria-label="Zoom controls">
            <button
              onClick={() => rfInstance.zoomIn({ duration: 200 })}
              className="p-2 hover:bg-accent transition-colors border-b border-border/50"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <Plus className="w-4 h-4 text-muted-foreground" />
            </button>
            <button
              onClick={() => rfInstance.zoomOut({ duration: 200 })}
              className="p-2 hover:bg-accent transition-colors border-b border-border/50"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <Minus className="w-4 h-4 text-muted-foreground" />
            </button>
            <button
              onClick={() => rfInstance.fitView({ duration: 300 })}
              className="p-2 hover:bg-accent transition-colors"
              title="Fit view"
              aria-label="Fit view"
            >
              <LocateFixed className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </Panel>

        {/* MiniMap — hideable with color modes */}
        {showMiniMap && (
          <MiniMap
            nodeColor={(node) => {
              if (miniMapColor === "mono") return "#a0a0a0";
              if (miniMapColor === "warm") {
                if (node.type === "agentNode") return "#f59e0b";
                if (node.type === "mapSticky") return "#eab308";
                return "#fb923c";
              }
              if (node.type === "agentNode") return "#fbbf24";
              if (node.type === "mapSticky") return "#eab308";
              if (node.type === "mapPrompt" || node.type === "mapTriggerManual") return "#f59e0b";
              return "#60a5fa";
            }}
            style={{
              background: miniMapColor === "default" ? "#1e293b" : miniMapColor === "mono" ? "#18181b" : "#1c1917",
            }}
            maskColor={
              miniMapColor === "default" ? "rgba(30, 41, 59, 0.7)"
                : miniMapColor === "mono" ? "rgba(24, 24, 27, 0.7)"
                : "rgba(28, 25, 23, 0.7)"
            }
            className="!border !border-border !rounded-lg !shadow-sm"
            aria-label="Canvas minimap"
          />
        )}

        {/* Canvas toolbar panel — top right */}
        <Panel position="top-right">
          <div className="flex items-center gap-1.5 bg-card/90 backdrop-blur border border-border rounded-lg px-2 py-1.5 shadow-sm" role="toolbar" aria-label="Canvas actions">
            <Badge variant="outline" className="text-[10px] font-medium">
              {userWorkflowNodes.length} node{userWorkflowNodes.length !== 1 ? "s" : ""}
            </Badge>
            <div className="w-px h-4 bg-border" />

            {/* Undo/Redo */}
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              className="p-1.5 rounded hover:bg-accent transition-colors disabled:opacity-30"
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
            >
              <Undo2 className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button
              onClick={handleRedo}
              disabled={!canRedo}
              className="p-1.5 rounded hover:bg-accent transition-colors disabled:opacity-30"
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo"
            >
              <Redo2 className="w-3.5 h-3.5 text-muted-foreground" />
            </button>

            <div className="w-px h-4 bg-border" />

            {/* Save/Load Workflow */}
            <button
              onClick={handleSaveWorkflow}
              className="p-1.5 rounded hover:bg-accent transition-colors"
              title="Save workflow (Ctrl+S)"
              aria-label="Save workflow"
            >
              <Save className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button
              onClick={() => {
                const saved = loadWorkflow();
                if (saved && saved.nodes.length > 0) {
                  pushHistory({ nodes: [...nodes], edges: [...edges] });
                  const workflowNodes = saved.nodes.filter(n => n.id.startsWith("map_wf_"));
                  setUserWorkflowNodes(workflowNodes);
                } else {
                  showError("No saved workflow found");
                }
              }}
              className="p-1.5 rounded hover:bg-accent transition-colors"
              title="Load workflow"
              aria-label="Load saved workflow"
            >
              <FolderOpen className="w-3.5 h-3.5 text-muted-foreground" />
            </button>

            <div className="w-px h-4 bg-border" />

            <button
              onClick={() => rfInstance.fitView({ duration: 300 })}
              className="p-1.5 rounded hover:bg-accent transition-colors"
              title="Fit View"
              aria-label="Fit view"
            >
              <Maximize className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            {userWorkflowNodes.length > 0 && (
              <button
                onClick={() => {
                  pushHistory({ nodes: [...nodes], edges: [...edges] });
                  setUserWorkflowNodes([]);
                  setNodes(initialNodes);
                }}
                className="p-1.5 rounded hover:bg-destructive/10 transition-colors"
                title="Clear workflow nodes"
                aria-label="Clear all workflow nodes"
              >
                <Trash2 className="w-3.5 h-3.5 text-destructive" />
              </button>
            )}
            <button
              onClick={() => {
                userWorkflowNodes.forEach((n) => {
                  rfInstance.updateNodeData(n.id, { executionState: "running" });
                });
                setTimeout(() => {
                  userWorkflowNodes.forEach((n) => {
                    rfInstance.updateNodeData(n.id, { executionState: "success" });
                  });
                  setTimeout(() => {
                    userWorkflowNodes.forEach((n) => {
                      rfInstance.updateNodeData(n.id, { executionState: "idle" });
                    });
                  }, 2000);
                }, 2000);
              }}
              className="p-1.5 rounded hover:bg-emerald-500/10 transition-colors"
              title="Run workflow (demo)"
              aria-label="Run workflow demo"
              disabled={userWorkflowNodes.length === 0}
            >
              <Play className="w-3.5 h-3.5 text-emerald-500" />
            </button>
            <div className="w-px h-4 bg-border" />
            {/* MiniMap toggle + color */}
            <button
              onClick={() => setShowMiniMap(!showMiniMap)}
              className={`p-1.5 rounded transition-colors ${
                showMiniMap ? "bg-amber-500/10 text-amber-500" : "hover:bg-accent text-muted-foreground"
              }`}
              title={showMiniMap ? "Hide minimap" : "Show minimap"}
              aria-label={showMiniMap ? "Hide minimap" : "Show minimap"}
              aria-pressed={showMiniMap}
            >
              <MapPinned className="w-3.5 h-3.5" />
            </button>
            {showMiniMap && (["default", "mono", "warm"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setMiniMapColor(c)}
                className={`w-3.5 h-3.5 rounded-full border-2 transition-all ${
                  miniMapColor === c ? "scale-110 border-amber-500" : "border-border hover:border-muted-foreground"
                }`}
                style={{
                  background: c === "default" ? "#60a5fa" : c === "mono" ? "#888" : "#f59e0b",
                }}
                title={`${c.charAt(0).toUpperCase() + c.slice(1)} colors`}
                aria-label={`Minimap ${c} color theme`}
                aria-pressed={miniMapColor === c}
              />
            ))}
          </div>
        </Panel>
      </ReactFlow>

      {/* Context menu */}
      {contextMenu && (
        <MapContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          actions={contextMenuActions}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );

  return (
    <div className="flex flex-col rounded-lg border border-border overflow-hidden bg-card" role="region" aria-label="Agent Map">
      {/* Main canvas area — flex direction changes based on dock position */}
      <div
        className={`flex min-h-0 overflow-hidden ${
          isHorizontalDock ? "flex-col" : "flex-row"
        }`}
        style={{ height: `${canvasHeight}px` }}
      >
        {(dockPosition === "left" || dockPosition === "top") && paletteEl}
        {canvasEl}
        {(dockPosition === "right" || dockPosition === "bottom") && paletteEl}
      </div>

      {/* Assignment Summary Bar */}
      <div className="border-t border-border bg-card px-4 py-3 flex items-center justify-between gap-4" role="status" aria-label="Assignment summary">
        <div className="flex items-center gap-4">
          <div className="text-sm">
            <span className="text-muted-foreground">Assignments: </span>
            <span className="font-semibold">{assignments.length}</span>
          </div>
          {totalCost > 0 && (
            <div className="text-sm">
              <span className="text-muted-foreground">Total Cost: </span>
              <span className="font-bold text-amber-600 dark:text-amber-400">
                {totalCost.toLocaleString()} {currencySymbol}
              </span>
            </div>
          )}
          {assignments.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {assignments.map((a) => (
                <Badge key={a.jobId} variant="outline" className="text-[10px] bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                  {a.agentName} → {a.jobTitle}
                </Badge>
              ))}
            </div>
          )}
          {assignments.length === 0 && openJobs.length > 0 && (
            <Badge className="bg-muted text-muted-foreground text-xs">
              Draw connections from agents to jobs to assign
            </Badge>
          )}
          {openJobs.length === 0 && !dispatchOpen && (
            <Badge className="bg-muted text-muted-foreground text-xs">
              No open jobs — use Quick Dispatch below to create one
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {assignments.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearAssignments}
              disabled={executing}
            >
              Clear
            </Button>
          )}
          <Button
            onClick={handleExecute}
            disabled={assignments.length === 0 || executing || !onAssign}
            className="bg-amber-600 hover:bg-amber-700 text-black disabled:opacity-50"
          >
            {executing
              ? "Executing..."
              : `Execute${assignments.length > 0 ? ` (${assignments.length} jobs)` : ""}`}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowPalette(!showPalette)}
            title={showPalette ? "Hide Node Palette" : "Show Node Palette"}
            aria-label={showPalette ? "Hide node palette" : "Show node palette"}
            aria-pressed={showPalette}
          >
            {showPalette ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {/* Quick Dispatch Panel */}
      <div className="border-t border-border">
        <button
          onClick={() => setDispatchOpen(!dispatchOpen)}
          className="w-full px-4 py-2.5 flex items-center justify-between text-sm font-semibold text-foreground hover:bg-muted/50 transition-colors"
          aria-expanded={dispatchOpen}
          aria-controls="dispatch-panel"
        >
          <span className="flex items-center gap-2">
            <span className="text-base">🚀</span>
            Quick Dispatch — Create Job & Assign Agents
          </span>
          <span className={`transition-transform ${dispatchOpen ? "rotate-180" : ""}`}>▼</span>
        </button>

        {dispatchOpen && (
          <div id="dispatch-panel" className="px-4 pb-4 space-y-4 bg-muted/30" role="form" aria-label="Quick dispatch form">
            <div>
              <label htmlFor="dispatch-prompt" className="text-xs font-medium text-muted-foreground mb-1 block">
                Job Prompt — What should the agents do?
              </label>
              <textarea
                id="dispatch-prompt"
                value={dispatchPrompt}
                onChange={(e) => setDispatchPrompt(e.target.value)}
                placeholder="e.g. Research the top 10 DeFi protocols by TVL and create a comparison report with risk analysis..."
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm min-h-[80px] resize-y focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/50 placeholder:text-muted-foreground/50"
                disabled={dispatching}
              />
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Priority</label>
                <div className="flex gap-1.5" role="radiogroup" aria-label="Job priority">
                  {(["low", "medium", "high"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setDispatchPriority(p)}
                      disabled={dispatching}
                      role="radio"
                      aria-checked={dispatchPriority === p}
                      className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium border transition-all ${dispatchPriority === p
                          ? p === "high"
                            ? "bg-orange-500/15 border-orange-500/40 text-orange-500"
                            : p === "medium"
                              ? "bg-amber-500/15 border-amber-500/40 text-amber-500"
                              : "bg-muted border-border text-foreground"
                          : "border-border/50 text-muted-foreground hover:border-border"
                        }`}
                    >
                      {p === "high" ? "🔥 " : p === "medium" ? "⚡ " : ""}
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="w-40">
                <label htmlFor="dispatch-reward" className="text-xs font-medium text-muted-foreground mb-1 block">Reward ({currencySymbol})</label>
                <input
                  id="dispatch-reward"
                  type="text"
                  value={dispatchReward}
                  onChange={(e) => setDispatchReward(e.target.value)}
                  placeholder="Optional"
                  disabled={dispatching}
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-500/50"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-medium text-muted-foreground">
                  Select Agents ({selectedAgentIds.size}/{agents.length})
                </label>
                <button
                  onClick={selectAllAgents}
                  disabled={dispatching}
                  className="text-[11px] text-amber-500 hover:text-amber-400 transition-colors"
                >
                  {selectedAgentIds.size === agents.length ? "Deselect All" : "Select All"}
                </button>
              </div>

              {agents.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2">No agents assigned to this project yet.</p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2" role="group" aria-label="Agent selection">
                  {agents.map((agent) => {
                    const selected = selectedAgentIds.has(agent.id);
                    const isOnline = agent.status === "online";
                    return (
                      <button
                        key={agent.id}
                        onClick={() => toggleAgent(agent.id)}
                        disabled={dispatching}
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={`${agent.name} (${agent.status})`}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left text-xs transition-all ${selected
                            ? "border-amber-500 bg-amber-500/10 text-foreground ring-1 ring-amber-500/30"
                            : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                          }`}
                      >
                        <span className={`w-2 h-2 rounded-full shrink-0 ${isOnline ? "bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.5)]" : "bg-red-400"
                          }`} />
                        <span className="truncate font-medium">{agent.name}</span>
                        {selected && <span className="ml-auto text-amber-500">✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border/50">
              <div className="text-xs text-muted-foreground">
                {selectedAgentIds.size > 0 && dispatchPrompt.trim() && (
                  <span>
                    Will create 1 job and assign {selectedAgentIds.size} agent{selectedAgentIds.size > 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDispatchOpen(false)}
                  disabled={dispatching}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleDispatch}
                  disabled={dispatching || !dispatchPrompt.trim() || selectedAgentIds.size === 0 || !onDispatch}
                  className="bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-black font-semibold px-6"
                >
                  {dispatching ? (
                    <span className="flex items-center gap-2">
                      <span className="animate-spin">⚙️</span> Dispatching...
                    </span>
                  ) : (
                    <span>🚀 Dispatch</span>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AgentMap(props: AgentMapProps) {
  return (
    <ReactFlowProvider>
      <AgentMapInner {...props} />
    </ReactFlowProvider>
  );
}
