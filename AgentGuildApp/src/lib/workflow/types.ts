/**
 * Workflow Engine — Core type definitions.
 *
 * A workflow is a directed acyclic graph (DAG) of nodes. Each node represents
 * an executable unit: an API call, an agent task, a conditional branch, or a
 * data transform. Edges define dependencies — a node runs only when all
 * upstream nodes have completed.
 *
 * Execution is server-orchestrated and Firestore-durable. Each poll advances
 * at most one node, fitting within Netlify's 10s serverless timeout.
 */

// ── Node types ───────────────────────────────────────────────────────────────

/** What kind of work a node performs */
export type WorkflowNodeType =
  | "trigger"      // Start node — fires on event/schedule/manual
  | "api-call"     // Direct HTTP API call (no agent)
  | "agent-task"   // Delegate to an agent via task assignment
  | "conditional"  // Branch based on expression
  | "transform"    // Transform data (JS expression)
  | "parallel"     // Fan-out: immediately marks all children as ready
  | "join"         // Fan-in: waits for all parents to complete
  | "delay"        // Wait for a duration
  | "output";      // Terminal node — collects results

/** Configuration specific to each node type */
export interface TriggerConfig {
  triggerType: "manual" | "cron" | "event" | "webhook";
  /** Cron expression (only for triggerType=cron) */
  schedule?: string;
  /** Event name to listen for (only for triggerType=event) */
  eventName?: string;
}

export interface ApiCallConfig {
  /** HTTP method */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** URL — supports {{variable}} interpolation from upstream outputs */
  url: string;
  /** Headers */
  headers?: Record<string, string>;
  /** Body template (JSON string with {{variable}} placeholders) */
  bodyTemplate?: string;
  /** Timeout in ms (default 9000 for Netlify safety) */
  timeoutMs?: number;
}

export interface AgentTaskConfig {
  /** Agent ID to assign the task to */
  agentId: string;
  /** Task description template */
  descriptionTemplate: string;
  /** Priority */
  priority?: "low" | "normal" | "high" | "critical";
  /** Whether the agent must explicitly accept */
  requiresAcceptance?: boolean;
  /** Timeout for the entire agent task in ms */
  timeoutMs?: number;
}

export interface ConditionalConfig {
  /** JS expression evaluated against upstream outputs.
   *  Return value determines which branch to take.
   *  Example: "inputs.status === 'approved'" */
  expression: string;
  /** Map of expression result → child node ID */
  branches: Record<string, string>;
  /** Default branch if no match */
  defaultBranch?: string;
}

export interface TransformConfig {
  /** JS expression that transforms inputs into output.
   *  Has access to `inputs` (merged upstream outputs). */
  expression: string;
}

export interface DelayConfig {
  /** Delay in milliseconds */
  durationMs: number;
}

export interface OutputConfig {
  /** Label for this output */
  label?: string;
  /** What to include in the final output */
  outputType?: "result" | "report" | "action";
}

export type NodeConfig =
  | TriggerConfig
  | ApiCallConfig
  | AgentTaskConfig
  | ConditionalConfig
  | TransformConfig
  | DelayConfig
  | OutputConfig
  | Record<string, unknown>;

// ── Workflow Definition (stored, reusable) ──────────────────────────────────

export interface WorkflowNode {
  /** Unique node ID within the workflow */
  id: string;
  type: WorkflowNodeType;
  /** Human-readable label */
  label: string;
  /** Type-specific configuration */
  config: NodeConfig;
  /** Retry policy */
  retries?: number;
  /** Position for visual editor (React Flow) */
  position?: { x: number; y: number };
}

export interface WorkflowEdge {
  /** Source node ID */
  from: string;
  /** Target node ID */
  to: string;
  /** Optional label (used for conditional branches) */
  label?: string;
}

export interface WorkflowDefinition {
  id: string;
  /** Human-readable name */
  name: string;
  description?: string;
  orgId: string;
  /** The DAG */
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Who created this definition */
  createdBy: string;
  /** Version counter (incremented on edit) */
  version: number;
  enabled: boolean;
  /** QA gates — evaluated after specific nodes complete */
  qaGates?: QAGate[];
  createdAt: unknown;
  updatedAt: unknown;
}

// ── QA Gates ─────────────────────────────────────────────────────────────────

/** A quality assurance gate evaluated after a node completes */
export interface QAGateRule {
  /** Human-readable name */
  name: string;
  /** Field in node output to validate */
  field: string;
  /** Comparison operator */
  operator: "exists" | "not_empty" | "eq" | "gte" | "lte" | "min_length" | "max_length" | "contains" | "not_contains" | "matches" | "regex";
  /** Expected value (depends on operator) */
  value?: unknown;
  /** What to do if the rule fails */
  onFail: "block" | "warn" | "retry" | "route_to";
  /** Target node ID for route_to action */
  failTargetNodeId?: string;
  /** Max retries for retry action */
  maxRetries?: number;
}

export interface QAGate {
  /** Node ID this gate applies to (evaluated after node completes) */
  afterNodeId: string;
  /** "all" = every rule must pass, "any" = at least one must pass */
  mode: "all" | "any";
  rules: QAGateRule[];
}

// ── Workflow Run (execution instance) ────────────────────────────────────────

export type RunStatus =
  | "pending"     // Created, not yet started
  | "running"     // At least one node is executing
  | "paused"      // Manually paused
  | "completed"   // All nodes terminal
  | "failed"      // Unrecoverable failure
  | "cancelled";  // Manually cancelled

export type NodeRunStatus =
  | "pending"     // Waiting for dependencies
  | "ready"       // All deps met, waiting to execute
  | "running"     // Currently executing
  | "completed"   // Finished successfully
  | "failed"      // Finished with error
  | "skipped"     // Skipped (conditional branch not taken)
  | "cancelled";  // Parent run cancelled

export interface NodeRunState {
  nodeId: string;
  status: NodeRunStatus;
  /** Inputs collected from upstream nodes */
  inputs?: Record<string, unknown>;
  /** Output data from this node's execution */
  output?: unknown;
  /** Error message if failed */
  error?: string;
  /** Number of retries attempted */
  retriesUsed: number;
  /** External reference (e.g., task assignment ID, HTTP request ID) */
  externalRef?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkflowRun {
  id: string;
  /** Workflow definition this run is based on */
  workflowId: string;
  /** Snapshot of the definition version at creation time */
  workflowVersion: number;
  orgId: string;
  /** Overall run status */
  status: RunStatus;
  /** Per-node execution state */
  nodeStates: Record<string, NodeRunState>;
  /** Trigger input data (e.g., webhook payload, manual params) */
  triggerInput?: Record<string, unknown>;
  /** Collected outputs from output nodes */
  outputs?: Record<string, unknown>;
  /** Overall progress 0-100 */
  progress: number;
  /** Error if the run failed */
  error?: string;
  /** Who triggered this run */
  triggeredBy: string;
  createdAt: unknown;
  updatedAt: unknown;
  completedAt?: unknown;
}

// ── Executor types ───────────────────────────────────────────────────────────

/** Result of executing one node */
export interface NodeExecutionResult {
  status: NodeRunStatus;
  output?: unknown;
  error?: string;
  externalRef?: string;
}

/** Handler for a specific node type */
export interface NodeHandler {
  type: WorkflowNodeType;
  /**
   * Execute the node. Must complete within ~9s.
   * Returns the new status + output.
   */
  execute(
    node: WorkflowNode,
    inputs: Record<string, unknown>,
    run: WorkflowRun,
  ): Promise<NodeExecutionResult>;
}

// ── Step Logs ────────────────────────────────────────────────────────────────

/** Persistent log entry for a single node execution step */
export interface StepLog {
  id: string;
  runId: string;
  nodeId: string;
  /** Node label at execution time (for display even if definition changes) */
  nodeLabel: string;
  nodeType: WorkflowNodeType;
  /** Log level */
  level: "info" | "warn" | "error" | "debug";
  message: string;
  /** Structured metadata (inputs, outputs, HTTP status, etc.) */
  metadata?: Record<string, unknown>;
  /** Timestamp in ms */
  timestamp: number;
}
