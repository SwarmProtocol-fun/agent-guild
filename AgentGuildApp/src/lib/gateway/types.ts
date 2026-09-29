/**
 * Pull-Based Gateway Runtime — Type definitions.
 *
 * Workers register with the gateway, periodically pull tasks from the queue,
 * execute them within resource limits, and push results back.
 *
 * Architecture:
 *   Gateway Queue (Firestore) ← workers pull
 *   Workers register + heartbeat → Gateway tracks liveness
 *   Results pushed → Gateway delivers to caller (workflow, API, etc.)
 */

// ── Worker types ─────────────────────────────────────────────────────────────

export type WorkerStatus = "idle" | "busy" | "draining" | "offline";

/** Resource limits for a worker */
export interface WorkerResources {
  /** Max CPU cores available */
  maxCpuCores: number;
  /** Max memory in MB */
  maxMemoryMb: number;
  /** Max concurrent tasks */
  maxConcurrent: number;
  /** Current CPU usage (0-100) */
  cpuUsagePercent?: number;
  /** Current memory usage in MB */
  memoryUsageMb?: number;
  /** Currently running task count */
  activeTasks: number;
}

/** Capabilities a worker advertises */
export interface WorkerCapabilities {
  /** Supported task types */
  taskTypes: string[];
  /** Supported runtimes (e.g., "node", "python", "docker") */
  runtimes: string[];
  /** Custom capability tags */
  tags: string[];
}

/** A registered gateway worker */
export interface GatewayWorker {
  id: string;
  orgId: string;
  /** Human-readable name */
  name: string;
  /** Worker status */
  status: WorkerStatus;
  /** Resource limits and current usage */
  resources: WorkerResources;
  /** Advertised capabilities */
  capabilities: WorkerCapabilities;
  /** Region for affinity routing */
  region?: string;
  /** IP address (for logging, not routing) */
  ipAddress?: string;
  /** Ed25519 public key in PEM SPKI format (for WS auth) */
  publicKey?: string;
  /** Last heartbeat timestamp */
  lastHeartbeat: unknown;
  /** Registration timestamp */
  registeredAt: unknown;
  updatedAt: unknown;
}

// ── Task Queue types ─────────────────────────────────────────────────────────

export type QueuedTaskStatus =
  | "queued"       // Waiting to be claimed
  | "claimed"      // Worker has claimed it
  | "running"      // Worker is executing
  | "completed"    // Finished successfully
  | "failed"       // Finished with error
  | "timeout"      // Execution timed out
  | "cancelled";   // Manually cancelled

export type TaskPriority = "low" | "normal" | "high" | "critical";

/** Resource requirements for a task */
export interface TaskResourceRequirements {
  /** Minimum CPU cores needed */
  minCpuCores?: number;
  /** Minimum memory in MB */
  minMemoryMb?: number;
  /** Required runtime */
  runtime?: string;
  /** Required capability tags (worker must have ALL) */
  requiredTags?: string[];
}

/** A task in the gateway queue */
export interface QueuedTask {
  id: string;
  orgId: string;
  /** Task type (must match worker capabilities) */
  taskType: string;
  /** Unique idempotency key (prevents duplicate queueing) */
  idempotencyKey?: string;
  /** Priority (higher = pulled first) */
  priority: TaskPriority;
  /** Task payload */
  payload: Record<string, unknown>;
  /** Resource requirements */
  resources: TaskResourceRequirements;
  /** Current status */
  status: QueuedTaskStatus;
  /** Worker that claimed this task */
  claimedBy?: string;
  /** Claimed at timestamp */
  claimedAt?: unknown;
  /** Execution timeout in ms (default 60s) */
  timeoutMs: number;
  /** Result data (set on completion) */
  result?: unknown;
  /** Error message (set on failure) */
  error?: string;
  /** Retry count */
  retriesUsed: number;
  /** Max retries */
  maxRetries: number;
  /** Source reference (e.g., workflow run ID + node ID) */
  sourceRef?: string;
  /** Callback URL to POST result to (optional) */
  callbackUrl?: string;
  createdAt: unknown;
  updatedAt: unknown;
  completedAt?: unknown;
}

// ── Priority weights ─────────────────────────────────────────────────────────

export const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  critical: 100,
  high: 75,
  normal: 50,
  low: 25,
};

// ── Job Log types ───────────────────────────────────────────────────────────

/** Persisted batch of log lines from a gateway job execution */
export interface JobLogEntry {
  id: string;
  taskId: string;
  workerId: string;
  orgId: string;
  /** Batch of log lines (stdout/stderr prefixed) */
  lines: string[];
  /** Firestore Timestamp */
  timestamp: unknown;
}

// ── Gateway WebSocket message types ─────────────────────────────────────────

export type GatewayWSMessageType =
  | "job:dispatch"
  | "job:status"
  | "job:status:ack"
  | "job:log"
  | "job:log:ack"
  | "job:cancel"
  | "heartbeat"
  | "drain"
  | "connected"
  | "error";

/** Hub → Gateway: dispatch a job */
export interface JobDispatchMessage {
  type: "job:dispatch";
  taskId: string;
  taskType: string;
  payload: Record<string, unknown>;
  priority: TaskPriority;
  timeoutMs: number;
  resources: TaskResourceRequirements;
  ts: number;
}

/** Gateway → Hub: report job status */
export interface JobStatusMessage {
  type: "job:status";
  taskId: string;
  status: "running" | "completed" | "failed";
  result?: unknown;
  error?: string;
}

/** Gateway → Hub: stream log lines */
export interface JobLogMessage {
  type: "job:log";
  taskId: string;
  lines: string[];
  ts: number;
}

/** Gateway → Hub: heartbeat with system metrics */
export interface GatewayHeartbeatMessage {
  type: "heartbeat";
  resources: WorkerResources;
}

// ── Task result types ───────────────────────────────────────────────────────

/** Artifact produced by a task execution */
export interface TaskArtifact {
  name: string;
  url: string;
  /** MIME type */
  type: string;
  /** Size in bytes */
  size: number;
  /** SHA-256 hash */
  hash?: string;
}

/** Structured task result */
export interface TaskResult {
  data?: unknown;
  artifacts?: TaskArtifact[];
  executionTimeMs: number;
  exitCode?: number;
}
