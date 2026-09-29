/**
 * Executor Registry — Maps task types to their executor modules.
 *
 * Each executor implements the common interface:
 *   execute(task, logCallback) → Promise<{ data, artifacts, executionTimeMs, exitCode }>
 *   cancel() → Promise<void>
 *   getStatus() → { running, pid?, progress? }
 */

import * as shellExecutor from "./shell.mjs";
import * as dockerExecutor from "./docker.mjs";
import * as comfyuiExecutor from "./comfyui.mjs";
import * as workflowExecutor from "./workflow.mjs";
import * as hyperliquidExecutor from "./hyperliquid.mjs";

/** Built-in executor registry (module-level singleton behavior — see createTaskExecutor for the concurrency-safe per-task path) */
const executors = new Map([
  ["shell", shellExecutor],
  ["docker", dockerExecutor],
  ["node", {
    // Node executor is a thin wrapper around shell
    execute: async (task, logCallback) => {
      const { payload, timeoutMs = 60000 } = task;
      const { script } = payload;
      if (!script) throw new Error("Node task missing 'script' in payload");
      return shellExecutor.execute(
        { payload: { command: "node", args: ["-e", script], shell: false }, timeoutMs },
        logCallback,
      );
    },
    cancel: () => shellExecutor.cancel(),
    getStatus: () => shellExecutor.getStatus(),
  }],
  ["comfyui", comfyuiExecutor],
  ["workflow", workflowExecutor],
  ["hyperliquid", hyperliquidExecutor],
]);

/**
 * Factories for task types whose executor module supports isolated,
 * concurrency-safe per-task instances (see shell.mjs/docker.mjs's
 * createExecutor()). Task types not listed here (comfyui, workflow) still
 * use the shared module-level singleton via `executors` above — a second
 * concurrent task of one of those types can still stomp the first's state,
 * same as shell/docker did before this factory existed.
 */
const executorFactories = new Map([
  ["shell", () => shellExecutor.createExecutor()],
  ["docker", () => dockerExecutor.createExecutor()],
  ["hyperliquid", () => hyperliquidExecutor.createExecutor()],
  ["node", () => {
    const shell = shellExecutor.createExecutor();
    return {
      execute: async (task, logCallback) => {
        const { payload, timeoutMs = 60000 } = task;
        const { script } = payload;
        if (!script) throw new Error("Node task missing 'script' in payload");
        return shell.execute(
          { payload: { command: "node", args: ["-e", script], shell: false }, timeoutMs },
          logCallback,
        );
      },
      cancel: () => shell.cancel(),
      getStatus: () => shell.getStatus(),
    };
  }],
]);

/**
 * Create an isolated executor instance for a task type, when the type
 * supports it (shell, docker, node); otherwise returns the shared
 * module-level singleton for that type (comfyui, workflow), matching prior
 * behavior for those.
 *
 * @param {string} taskType
 * @returns {{ execute: Function, cancel: Function, getStatus: Function }|null}
 */
export function createTaskExecutor(taskType) {
  const factory = executorFactories.get(taskType);
  if (factory) return factory();
  return getExecutor(taskType);
}

/**
 * Get an executor by task type.
 * @param {string} taskType
 * @returns {Object|null} The executor module or null
 */
export function getExecutor(taskType) {
  return executors.get(taskType) || null;
}

/**
 * Register a custom executor for a task type.
 * @param {string} taskType
 * @param {Object} executor — Must implement { execute, cancel, getStatus }
 */
export function registerExecutor(taskType, executor) {
  if (!executor.execute || typeof executor.execute !== "function") {
    throw new Error(`Executor for "${taskType}" must have an execute() method`);
  }
  executors.set(taskType, executor);
}

/**
 * List all registered task types.
 * @returns {string[]}
 */
export function listTaskTypes() {
  return [...executors.keys()];
}

/**
 * Execute a task by looking up the appropriate executor.
 *
 * @param {Object} task — Must include taskType
 * @param {Function} logCallback — Called with batches of log lines
 * @returns {Promise<{ data, artifacts, executionTimeMs, exitCode }>}
 */
export async function executeTask(task, logCallback) {
  const executor = getExecutor(task.taskType);
  if (!executor) {
    throw new Error(`Unknown task type: ${task.taskType}. Available: ${listTaskTypes().join(", ")}`);
  }
  return executor.execute(task, logCallback);
}

/**
 * Cancel the active executor for a given task type.
 * @param {string} taskType
 */
export async function cancelTask(taskType) {
  const executor = getExecutor(taskType);
  if (executor?.cancel) {
    await executor.cancel();
  }
}
