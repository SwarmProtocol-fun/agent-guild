/**
 * Solana Anchor Executor — builds, tests or deploys an Anchor workspace an
 * agent wrote, inside the official solanafoundation/anchor image.
 *
 * Unlike the hyperliquid executor (a fixed command), the input here is
 * agent-written code — Cargo build scripts and test files run arbitrary
 * code — so it always runs in a throwaway container with memory/CPU limits,
 * never as a plain subprocess. That means this task type needs a worker
 * with a Docker daemon; register it with `--runtimes docker,solana-anchor`.
 * Network is bridged because cargo/yarn must download crates and packages.
 *
 * For `deploy`, `payload.privateKey` is the agent's own devnet key (JSON
 * byte array), decrypted by the Solana mod for this one task — the same
 * one-time-secret pattern as the hyperliquid executor. It's written to a
 * separate directory mounted read-only and removed with everything else
 * when the task ends; the hub deletes it from the task record on completion.
 *
 * Payload:
 *   action: "build" | "test" | "deploy"
 *   files: { [projectRelativePath]: contents }
 *   anchorVersion?: "0.31.1" | "1.0.2"
 *   deploy?: { cluster: "devnet" | "testnet", rpcUrl: string }
 *   privateKey?: string — deploy only
 *
 * Common Executor Interface:
 *   execute(task, logCallback) → { data, artifacts, executionTimeMs, exitCode }
 *   cancel() → void
 *   getStatus() → { running, pid?, progress? }
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execute as shellExecute } from "./shell.mjs";

export const ANCHOR_VERSIONS = ["0.31.1", "1.0.2"];
const IMAGE = (version) => `${process.env.SOLANA_ANCHOR_IMAGE || "solanafoundation/anchor"}:v${version}`;
const MEMORY = process.env.SOLANA_ANCHOR_MEMORY || "6g";
const CPUS = process.env.SOLANA_ANCHOR_CPUS || "4";
const LOG_TAIL_LINES = 150;

let activeContainer = null;

/** Project-relative path only: no absolute paths, `..`, or build output. Mirrors the mod's validateAnchorProject. */
export function validProjectPath(p) {
  return /^[A-Za-z0-9_.\-/]+$/.test(p) && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "") && !p.startsWith("target/");
}

/**
 * The in-container script. Builds twice around `anchor keys sync` so the
 * program's declare_id! matches the keypair the first build generated —
 * otherwise a freshly written program fails at runtime with
 * DeclaredProgramIdMismatch. The trap hands ownership of everything back to
 * the worker's user so it can delete the workspace afterwards.
 */
export function buildScript(action) {
  const lines = [
    "set -eo pipefail",
    'trap \'chown -R "$HOST_UID:$HOST_GID" /workspace 2>/dev/null || true\' EXIT',
    "mkdir -p ~/.config/solana",
    "[ -f ~/.config/solana/id.json ] || solana-keygen new --no-bip39-passphrase --silent --force -o ~/.config/solana/id.json >/dev/null",
    "echo '== anchor build'",
    "anchor build",
    "echo '== anchor keys sync'",
    "anchor keys sync",
    "anchor build",
  ];
  if (action === "test") {
    lines.push(
      "if [ -f package.json ]; then echo '== installing JS deps'; (yarn install --non-interactive || npm install --no-audit --no-fund); fi",
      "echo '== anchor test'",
      "anchor test --skip-build --provider.cluster localnet --provider.wallet ~/.config/solana/id.json",
    );
  }
  if (action === "deploy") {
    lines.push(
      "echo '== anchor deploy'",
      'anchor deploy --provider.cluster "$DEPLOY_RPC_URL" --provider.wallet /secrets/deployer.json',
    );
  }
  return lines.join("\n");
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
  return out;
}

/** Program ids (from target/deploy/*-keypair.json — public half only), .so sizes and IDLs. */
async function collectOutputs(project) {
  const programs = [];
  const idls = {};
  const deployDir = join(project, "target", "deploy");
  for (const f of await readdir(deployDir).catch(() => [])) {
    if (!f.endsWith("-keypair.json")) continue;
    const name = f.slice(0, -"-keypair.json".length);
    try {
      const secret = JSON.parse(await readFile(join(deployDir, f), "utf8"));
      const so = await stat(join(deployDir, `${name}.so`)).catch(() => null);
      programs.push({ name, programId: base58(secret.slice(32, 64)), soBytes: so ? so.size : null });
    } catch { /* malformed keypair — skip */ }
  }
  const idlDir = join(project, "target", "idl");
  for (const f of await readdir(idlDir).catch(() => [])) {
    if (!f.endsWith(".json")) continue;
    try { idls[f.slice(0, -5)] = JSON.parse(await readFile(join(idlDir, f), "utf8")); } catch { /* skip */ }
  }
  return { programs, idls };
}

/** `solana program deploy` (which anchor deploy wraps) prints these. */
export function parseDeploy(output) {
  const programIds = [...output.matchAll(/Program Id:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/g)].map((m) => m[1]);
  const signatures = [...output.matchAll(/Signature:\s*([1-9A-HJ-NP-Za-km-z]{80,90})/g)].map((m) => m[1]);
  return { programIds, signatures };
}

export async function execute(task, logCallback) {
  const { payload, timeoutMs = 15 * 60_000 } = task;
  const { action, files, anchorVersion = ANCHOR_VERSIONS[0], deploy, privateKey } = payload ?? {};

  if (!["build", "test", "deploy"].includes(action)) throw new Error("solana-anchor: action must be build, test or deploy");
  if (!ANCHOR_VERSIONS.includes(anchorVersion)) throw new Error(`solana-anchor: anchorVersion must be one of ${ANCHOR_VERSIONS.join(", ")}`);
  if (!files || typeof files !== "object" || !("Anchor.toml" in files)) throw new Error("solana-anchor: files must include Anchor.toml");
  for (const p of Object.keys(files)) {
    if (!validProjectPath(p) || typeof files[p] !== "string") throw new Error(`solana-anchor: invalid file ${p}`);
  }
  if (action === "deploy" && (!privateKey || !deploy?.rpcUrl)) throw new Error("solana-anchor: deploy needs privateKey and deploy.rpcUrl");

  const work = await mkdtemp(join(tmpdir(), "solana-anchor-"));
  const project = join(work, "project");
  const secrets = join(work, "secrets");
  const container = `agent-guild-anchor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeContainer = container;
  const startTime = Date.now();

  try {
    for (const [p, contents] of Object.entries(files)) {
      await mkdir(dirname(join(project, p)), { recursive: true });
      await writeFile(join(project, p), contents);
    }

    const args = [
      "run", "--rm", `--name=${container}`, "--network=bridge",
      `--memory=${MEMORY}`, `--cpus=${CPUS}`, "--pids-limit=1024",
      "-v", `${project}:/workspace`, "-w", "/workspace",
      "-e", `HOST_UID=${process.getuid?.() ?? 1000}`, "-e", `HOST_GID=${process.getgid?.() ?? 1000}`,
    ];
    if (action === "deploy") {
      await mkdir(secrets, { mode: 0o700 });
      await writeFile(join(secrets, "deployer.json"), privateKey, { mode: 0o600 });
      args.push("-v", `${secrets}:/secrets:ro`, "-e", `DEPLOY_RPC_URL=${deploy.rpcUrl}`);
    }
    args.push(IMAGE(anchorVersion), "bash", "-c", buildScript(action));

    // shell: false — args include agent-influenced values; never route them through /bin/sh.
    let result;
    try {
      result = await shellExecute({ payload: { command: "docker", args, shell: false }, timeoutMs }, logCallback);
    } catch (err) {
      // Timed out or failed to spawn — make sure the container doesn't outlive the task.
      await cancel();
      throw err;
    }

    const output = `${result.data.stdout}\n${result.data.stderr}`;
    const { programs, idls } = await collectOutputs(project);
    return {
      data: {
        action,
        anchorVersion,
        success: result.exitCode === 0,
        programs,
        idls,
        ...(action === "deploy" ? { deploy: { cluster: deploy.cluster, ...parseDeploy(output) } } : {}),
        logTail: output.split("\n").filter(Boolean).slice(-LOG_TAIL_LINES).join("\n"),
      },
      artifacts: [],
      executionTimeMs: Date.now() - startTime,
      exitCode: result.exitCode,
    };
  } finally {
    activeContainer = null;
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export async function cancel() {
  if (!activeContainer) return;
  try {
    await shellExecute({ payload: { command: "docker", args: ["kill", activeContainer], shell: false }, timeoutMs: 10_000 }, null);
  } catch {
    // Already stopped.
  }
}

export function getStatus() {
  return { running: activeContainer !== null, containerId: activeContainer };
}
