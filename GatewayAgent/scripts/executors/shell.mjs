/**
 * Shell Executor — Runs shell commands with timeout and output capture.
 *
 * Common Executor Interface:
 *   execute(task, logCallback) → { data, artifacts, executionTimeMs, exitCode }
 *   cancel() → void
 *   getStatus() → { running, pid?, progress? }
 *
 * `createExecutor()` returns a fresh instance with its own process state —
 * use this for concurrent execution (gateway.mjs creates one per task). The
 * module-level `execute`/`cancel`/`getStatus` below are a single shared
 * instance kept only for callers that haven't been updated to per-task
 * instances; two concurrent tasks routed through the module-level API would
 * still stomp each other's process reference, exactly as before.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(__dirname, "../..");

/**
 * Create an isolated shell executor instance. Each instance tracks its own
 * active process, so concurrent instances never see or cancel each other's
 * process.
 */
export function createExecutor() {
  let activeProc = null;

  /**
   * Execute a shell command with stdout/stderr streaming.
   *
   * @param {Object} task - The gateway task
   * @param {Function} logCallback - Called with log lines: logCallback(lines: string[])
   * @returns {{ data: Object, artifacts: Array, executionTimeMs: number, exitCode: number }}
   */
  async function execute(task, logCallback) {
    const { payload, timeoutMs = 60000 } = task;
    // `shell` defaults to true (existing behavior for generic shell tasks,
    // which may rely on shell features like pipes/redirects/globs). Callers
    // that just want to run a literal command with literal argv entries —
    // e.g. the "node" executor running `node -e <script>` — must pass
    // `shell: false`: with shell:true, Node concatenates command+args into
    // one shell command line with no escaping, so any shell metacharacter
    // in an arg (parens, asterisks, pipes, ...) gets reinterpreted by the
    // shell instead of reaching the target program literally.
    const { command, args = [], cwd, env, shell = true } = payload;

    if (!command) throw new Error("Shell task missing 'command' in payload");

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        shell,
        cwd: cwd || AGENT_DIR,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      activeProc = proc;

      let stdout = "";
      let stderr = "";
      let killed = false;
      const logBuffer = [];
      let flushTimer = null;

      // Batch log lines and flush every 200ms for efficiency
      function flushLogs() {
        if (logBuffer.length > 0 && logCallback) {
          logCallback([...logBuffer]);
          logBuffer.length = 0;
        }
      }

      flushTimer = setInterval(flushLogs, 200);

      const timer = setTimeout(() => {
        killed = true;
        proc.kill("SIGKILL");
      }, timeoutMs);

      proc.stdout.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        const lines = chunk.split("\n").filter(Boolean);
        logBuffer.push(...lines.map((l) => `[stdout] ${l}`));
      });

      proc.stderr.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        const lines = chunk.split("\n").filter(Boolean);
        logBuffer.push(...lines.map((l) => `[stderr] ${l}`));
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        clearInterval(flushTimer);
        flushLogs();
        activeProc = null;
        reject(new Error(`Spawn error: ${err.message}`));
      });

      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        clearInterval(flushTimer);
        flushLogs();
        activeProc = null;

        if (killed) {
          reject(new Error(`Process killed: execution timed out after ${timeoutMs}ms`));
          return;
        }

        // A non-null signal with our own timeout path not responsible (killed
        // is false here) means something else terminated the process — e.g.
        // OOM-killed by the OS. `code` is null in that case; previously this
        // fell through to `exitCode: code || 0`, silently reporting success
        // with truncated output instead of surfacing the real failure.
        if (signal) {
          reject(new Error(`Process terminated by signal ${signal}`));
          return;
        }

        resolve({
          data: {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
          },
          artifacts: [],
          executionTimeMs: Date.now() - startTime,
          exitCode: code || 0,
        });
      });
    });
  }

  function cancel() {
    if (activeProc) {
      activeProc.kill("SIGTERM");
      const proc = activeProc;
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5000);
    }
  }

  function getStatus() {
    return {
      running: !!activeProc,
      pid: activeProc?.pid,
    };
  }

  return { execute, cancel, getStatus };
}

// Back-compat single shared instance — see module doc comment above.
const defaultExecutor = createExecutor();
export const execute = defaultExecutor.execute;
export const cancel = defaultExecutor.cancel;
export const getStatus = defaultExecutor.getStatus;
