#!/usr/bin/env node
/**
 * hl-agent — plug your own agent into the hyperliquid-trading mod.
 *
 * Zero dependencies (Node 18+). Use it two ways:
 *
 *   1. As a library inside your agent's tool loop:
 *        import { connect } from "./hl-agent.mjs";
 *        const hl = await connect();            // reads env, checks GET /me
 *        const tools = hl.tools;                // hand these to your LLM
 *        const out = await hl.call(name, input) // run whichever tool it picks
 *
 *   2. From the shell:
 *        node hl-agent.mjs me                    # is the agent plugged in?
 *        node hl-agent.mjs tools                 # tool manifest (JSON)
 *        node hl-agent.mjs call hyperliquid_trade '{"coin":"ETH","isBuy":true,"sizeUsd":10}'
 *        node hl-agent.mjs daemon                # execute DCA/grid/sniper signals as they fire
 *
 * Environment:
 *   AGENT_GUILD_URL        hub origin, default https://agent-guild.com
 *   AGENT_GUILD_TOKEN      agt_… bearer token with the mods:call scope, or
 *   AGENT_GUILD_AGENT_ID + AGENT_GUILD_API_KEY
 *   HL_MASTER_SECRET       the passphrase that decrypts this agent's Hyperliquid
 *                          wallet. Sent only in request bodies, never shown to the model.
 *                          Not needed when instant trading is on for the agent.
 *   HL_POLL_MS             daemon poll interval, default 30000
 */

const BASE = "/api/mods/hyperliquid-trading";

function config(env = process.env) {
  const url = (env.AGENT_GUILD_URL || "https://agent-guild.com").replace(/\/$/, "");
  const token = env.AGENT_GUILD_TOKEN;
  const agentId = env.AGENT_GUILD_AGENT_ID;
  const apiKey = env.AGENT_GUILD_API_KEY;
  if (!token && !(agentId && apiKey)) {
    throw new Error("Set AGENT_GUILD_TOKEN (agt_…, mods:call scope) or AGENT_GUILD_AGENT_ID + AGENT_GUILD_API_KEY");
  }
  return { url, token, agentId, apiKey, masterSecret: env.HL_MASTER_SECRET };
}

function makeRequest(cfg) {
  return async function request(method, path, body) {
    const u = new URL(`${cfg.url}${BASE}/${path}`);
    const headers = { "Content-Type": "application/json" };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    else {
      u.searchParams.set("agentId", cfg.agentId);
      u.searchParams.set("apiKey", cfg.apiKey);
    }
    const resp = await fetch(u, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`${method} ${path} → ${resp.status}: ${data.error || resp.statusText}`);
    return data;
  };
}

export async function connect(env = process.env) {
  const cfg = config(env);
  const request = makeRequest(cfg);
  const me = await request("GET", "me");
  const { tools } = await request("GET", "agent/tools");
  const byName = new Map(tools.map((t) => [t.name, t]));

  /** Run one tool from the manifest. Fills {path} segments, injects masterSecret into POST bodies. */
  async function call(name, input = {}) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const rest = { ...input };
    const path = tool.path.replace(/\{(\w+)\}/g, (_, key) => {
      const value = key === "agentId" ? me.agentId : rest[key];
      delete rest[key];
      if (value == null) throw new Error(`${name} needs ${key}`);
      return encodeURIComponent(String(value));
    });
    if (tool.method === "GET") return request("GET", path);
    if (!cfg.masterSecret && !me.wallet?.instant) {
      throw new Error("HL_MASTER_SECRET is required to place or close trades (or turn on instant trading for this agent)");
    }
    return request("POST", path, cfg.masterSecret ? { ...rest, masterSecret: cfg.masterSecret } : rest);
  }

  /** Strategy signals the hub's tick has flagged; each needs the passphrase to fire. */
  async function executePending() {
    const { strategies } = await request("GET", `strategy/${encodeURIComponent(me.agentId)}/pending`);
    const results = [];
    for (const s of strategies) {
      try {
        const r = await request("POST", `strategy/${encodeURIComponent(s.id)}/execute-pending`, { masterSecret: cfg.masterSecret });
        results.push({ strategyId: s.id, type: s.type, coin: s.coin, taskId: r.taskId });
      } catch (err) {
        results.push({ strategyId: s.id, type: s.type, coin: s.coin, error: err.message });
      }
    }
    return results;
  }

  return { me, tools, call, executePending, request };
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log("usage: hl-agent.mjs me | tools | call <tool> [json] | daemon");
    return;
  }
  const hl = await connect();
  if (cmd === "me") return console.log(JSON.stringify(hl.me, null, 2));
  if (cmd === "tools") return console.log(JSON.stringify(hl.tools, null, 2));
  if (cmd === "call") {
    const [name, json] = args;
    return console.log(JSON.stringify(await hl.call(name, json ? JSON.parse(json) : {}), null, 2));
  }
  if (cmd === "daemon") {
    if (hl.me.wallet?.instant) {
      console.log("Instant trading is on for this agent — the hub fires its strategies itself; no daemon needed.");
      return;
    }
    if (!process.env.HL_MASTER_SECRET) throw new Error("HL_MASTER_SECRET is required for the daemon");
    if (!hl.me.readyToTrade) console.warn("warning: agent is not ready to trade yet:", JSON.stringify(hl.me));
    const pollMs = Number(process.env.HL_POLL_MS) || 30000;
    console.log(`hl-agent daemon: agent ${hl.me.agentId}, polling every ${pollMs / 1000}s`);
    for (;;) {
      try {
        for (const r of await hl.executePending()) console.log(new Date().toISOString(), JSON.stringify(r));
      } catch (err) {
        console.error(new Date().toISOString(), err.message);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  throw new Error(`Unknown command ${cmd}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
