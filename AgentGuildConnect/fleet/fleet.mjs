#!/usr/bin/env node

/**
 * Agent Guild Fleet Runner — hosts any number of registered agents in one process.
 *
 * Each entry in the agent list gets its own private copy of the agent-guild CLI
 * (its own keys/, config.json, state.json), so identities never share key material,
 * but all instances run out of this single service/container.
 *
 * For each agent this:
 *   1. Copies scripts/agent-guild.mjs + scripts/bridge.mjs into instances/<slug>/scripts/
 *      (first run only — later runs reuse the existing keys/config there).
 *   2. Registers with the hub if instances/<slug>/config.json doesn't exist yet.
 *   3. Spawns `bridge.mjs --runtime <runtime>` (talks to the LLM/runtime backend) and
 *      `agent-guild.mjs daemon --webhook <bridge>` (polls the hub, forwards messages)
 *      as long-lived child processes, restarting either on crash.
 *
 * Configuration — set AGENTS_JSON to a JSON array, e.g.:
 *   [
 *     { "id": "grok-research", "org": "org_abc123", "name": "Grok Research", "type": "worker",
 *       "skills": "web-search,code-interpreter", "runtime": "grok", "model": "grok-4.7",
 *       "apiKeyEnv": "XAI_API_KEY" },
 *     { "id": "hermes-support", "org": "org_abc123", "name": "Hermes Support", "type": "worker",
 *       "runtime": "hermes", "runtimeUrl": "http://localhost:8000/v1/chat/completions" }
 *   ]
 *
 * To add a new agent: append an entry to AGENTS_JSON and redeploy — no code changes needed.
 *
 * Environment Variables:
 *   AGENTS_JSON           — JSON array of agent configs (see above). Required.
 *   AGENT_GUILD_HUB_URL   — Hub URL used for registration + daemon/bridge (default: https://agent-guild.com)
 *   FLEET_BASE_PORT       — First local port handed out to bridge instances (default: 4100)
 *   FLEET_DATA_DIR        — Where per-agent keys/config/state live (default: ./instances, next to this
 *                           script). On Railway, point this at a mounted volume — e.g. /data — so agent
 *                           identities survive redeploys instead of re-registering as new agents each time.
 *   PORT                  — Port for this process's own /health endpoint (default: 8080)
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLEET_DIR = __dirname;
const SOURCE_SCRIPTS_DIR = join(FLEET_DIR, "..", "scripts");
const INSTANCES_DIR = process.env.FLEET_DATA_DIR || join(FLEET_DIR, "instances");

const HUB_URL = process.env.AGENT_GUILD_HUB_URL || "https://agent-guild.com";
const BASE_PORT = parseInt(process.env.FLEET_BASE_PORT || "4100", 10);
const HEALTH_PORT = parseInt(process.env.PORT || "8080", 10);

function loadAgents() {
  const raw = process.env.AGENTS_JSON;
  if (!raw) {
    console.error("Error: AGENTS_JSON is not set. See fleet.mjs header comment for the expected format.");
    process.exit(1);
  }
  let agents;
  try {
    agents = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: AGENTS_JSON is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(agents) || agents.length === 0) {
    console.error("Error: AGENTS_JSON must be a non-empty JSON array.");
    process.exit(1);
  }
  for (const a of agents) {
    if (!a.id || !a.org || !a.name) {
      console.error(`Error: each agent needs "id", "org", and "name". Offending entry: ${JSON.stringify(a)}`);
      process.exit(1);
    }
  }
  const ids = new Set();
  for (const a of agents) {
    if (ids.has(a.id)) {
      console.error(`Error: duplicate agent id "${a.id}" in AGENTS_JSON — ids must be unique.`);
      process.exit(1);
    }
    ids.add(a.id);
  }
  return agents;
}

function ensureInstanceScripts(slug) {
  const scriptsDir = join(INSTANCES_DIR, slug, "scripts");
  if (!existsSync(scriptsDir)) {
    mkdirSync(scriptsDir, { recursive: true });
    cpSync(join(SOURCE_SCRIPTS_DIR, "agent-guild.mjs"), join(scriptsDir, "agent-guild.mjs"));
    cpSync(join(SOURCE_SCRIPTS_DIR, "bridge.mjs"), join(scriptsDir, "bridge.mjs"));
  }
  return scriptsDir;
}

function runOnce(command, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) => resolve(code));
    child.on("error", (err) => {
      console.error(`[fleet] failed to run ${command} ${args.join(" ")}: ${err.message}`);
      resolve(1);
    });
  });
}

/** Keeps a long-lived child process running, restarting it with backoff on exit. */
function supervise(label, command, args, opts) {
  let restarts = 0;
  const launch = () => {
    console.log(`[fleet] starting ${label}`);
    const child = spawn(command, args, { stdio: "inherit", ...opts });
    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      restarts += 1;
      const delayMs = Math.min(30000, 2000 * restarts);
      console.error(`[fleet] ${label} exited (code=${code} signal=${signal}) — restarting in ${delayMs}ms`);
      setTimeout(launch, delayMs);
    });
    child.on("error", (err) => {
      console.error(`[fleet] ${label} error: ${err.message}`);
    });
    supervisedChildren.push(child);
    return child;
  };
  launch();
}

const supervisedChildren = [];
let shuttingDown = false;

async function startAgent(agentConfig, index) {
  const slug = agentConfig.id;
  const scriptsDir = ensureInstanceScripts(slug);
  const agentGuildScript = join(scriptsDir, "agent-guild.mjs");
  const bridgeScript = join(scriptsDir, "bridge.mjs");
  const configPath = join(INSTANCES_DIR, slug, "config.json");
  const port = agentConfig.port || (BASE_PORT + index);

  if (!existsSync(configPath)) {
    console.log(`[fleet] registering "${agentConfig.name}" (${slug})...`);
    const registerArgs = [
      agentGuildScript, "register",
      "--hub", HUB_URL,
      "--org", agentConfig.org,
      "--name", agentConfig.name,
      "--type", agentConfig.type || "worker",
    ];
    if (agentConfig.skills) registerArgs.push("--skills", agentConfig.skills);
    if (agentConfig.bio) registerArgs.push("--bio", agentConfig.bio);
    await runOnce("node", registerArgs);
    // If the hub was unreachable, agent-guild.mjs falls back to offline mode and
    // writes a provisional config.json anyway — the daemon retries registration
    // automatically on its next tick, so we don't need to gate on exit code here.
  } else {
    console.log(`[fleet] "${agentConfig.name}" (${slug}) already registered — reusing existing identity`);
  }

  const runtime = agentConfig.runtime || "generic";
  const bridgeEnv = { ...process.env };
  if (agentConfig.apiKeyEnv) bridgeEnv.RUNTIME_API_KEY = process.env[agentConfig.apiKeyEnv];
  if (agentConfig.apiKey) bridgeEnv.RUNTIME_API_KEY = agentConfig.apiKey;
  if (agentConfig.model) bridgeEnv.XAI_MODEL = agentConfig.model;

  const bridgeArgs = [bridgeScript, "--runtime", runtime, "--port", String(port)];
  if (agentConfig.runtimeUrl) bridgeArgs.push("--runtime-url", agentConfig.runtimeUrl);

  supervise(`bridge:${slug}`, "node", bridgeArgs, { env: bridgeEnv });

  // Give the bridge a moment to bind its port before the daemon starts forwarding to it.
  await new Promise((r) => setTimeout(r, 1500));

  supervise(`daemon:${slug}`, "node", [
    agentGuildScript, "daemon",
    "--interval", String(agentConfig.pollIntervalSec || 10),
    "--webhook", `http://localhost:${port}/webhook/agent-guild`,
  ]);
}

async function main() {
  const agents = loadAgents();
  console.log(`Agent Guild Fleet`);
  console.log(`─────────────────────────────`);
  console.log(`  Hub:    ${HUB_URL}`);
  console.log(`  Agents: ${agents.length}`);
  agents.forEach((a, i) => console.log(`    - ${a.id} (${a.name}, runtime=${a.runtime || "generic"}, port=${a.port || BASE_PORT + i})`));
  console.log("");

  mkdirSync(INSTANCES_DIR, { recursive: true });

  for (let i = 0; i < agents.length; i++) {
    await startAgent(agents[i], i);
  }

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        agents: agents.map((a) => a.id),
        hub: HUB_URL,
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  server.listen(HEALTH_PORT, () => {
    console.log(`[fleet] health endpoint listening on :${HEALTH_PORT}/health`);
  });

  const shutdown = () => {
    shuttingDown = true;
    console.log("\n[fleet] shutting down...");
    for (const child of supervisedChildren) child.kill("SIGTERM");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
