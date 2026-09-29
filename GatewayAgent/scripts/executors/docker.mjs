/**
 * Docker Executor — Runs Docker containers with resource limits and output capture.
 *
 * Requires Docker CLI installed and accessible.
 *
 * Common Executor Interface:
 *   execute(task, logCallback) → { data, artifacts, executionTimeMs, exitCode }
 *   cancel() → void
 *   getStatus() → { running, pid?, progress? }
 *
 * `createExecutor()` returns a fresh instance (with its own inner shell
 * executor instance) — use this for concurrent execution. The module-level
 * exports below are a single shared instance for callers not yet updated to
 * per-task instances.
 */

import { createExecutor as createShellExecutor } from "./shell.mjs";

export function createExecutor() {
  const shell = createShellExecutor();
  let activeContainerId = null;
  let running = false;

  /**
   * Execute a Docker container.
   *
   * Payload fields:
   *   image: string (required) — Docker image name
   *   command: string[] — Command to run inside container
   *   volumes: string[] — Volume mounts (host:container format)
   *   envVars: Record<string, string> — Environment variables
   *   networkMode: string — Docker network mode (default: "none" for isolation)
   *   memoryLimit: string — Memory limit (default: "512m")
   *   cpuLimit: string — CPU limit (default: "2")
   *   workdir: string — Working directory inside container
   *
   * @param {Object} task
   * @param {Function} logCallback
   */
  async function execute(task, logCallback) {
    const { payload, timeoutMs = 120000 } = task;
    const {
      image,
      command = [],
      volumes = [],
      envVars = {},
      networkMode = "none",
      memoryLimit = "512m",
      cpuLimit = "2",
      workdir,
    } = payload;

    if (!image) throw new Error("Docker task missing 'image' in payload");

    running = true;

    // Generate unique container name for cancellation
    const containerName = `swarm-gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeContainerId = containerName;

    // Build docker run args
    const args = ["run", "--rm", `--name=${containerName}`, `--network=${networkMode}`];

    // Resource limits
    args.push(`--memory=${memoryLimit}`, `--cpus=${cpuLimit}`);

    // Timeout at Docker level
    args.push(`--stop-timeout=${Math.ceil(timeoutMs / 1000)}`);

    // Working directory
    if (workdir) {
      args.push("-w", workdir);
    }

    // Volume mounts
    for (const v of volumes) {
      args.push("-v", v);
    }

    // Environment variables
    for (const [k, v] of Object.entries(envVars)) {
      args.push("-e", `${k}=${v}`);
    }

    args.push(image, ...command);

    try {
      const dockerTask = {
        payload: { command: "docker", args, cwd: undefined, env: undefined },
        timeoutMs: timeoutMs + 10000, // Extra buffer over Docker's own timeout
      };

      const result = await shell.execute(dockerTask, logCallback);
      return result;
    } finally {
      running = false;
      activeContainerId = null;
    }
  }

  async function cancel() {
    if (activeContainerId) {
      try {
        const killer = createShellExecutor();
        await killer.execute(
          { payload: { command: "docker", args: ["kill", activeContainerId] }, timeoutMs: 10000 },
          null,
        );
      } catch {
        // Container may already be stopped
      }
    }
    // Also cancel the underlying `docker run` shell invocation itself, in
    // case `docker kill` above didn't reach it in time.
    shell.cancel();
  }

  function getStatus() {
    return {
      running,
      containerId: activeContainerId,
    };
  }

  return { execute, cancel, getStatus };
}

// Back-compat single shared instance — see module doc comment above.
const defaultExecutor = createExecutor();
export const execute = defaultExecutor.execute;
export const cancel = defaultExecutor.cancel;
export const getStatus = defaultExecutor.getStatus;
