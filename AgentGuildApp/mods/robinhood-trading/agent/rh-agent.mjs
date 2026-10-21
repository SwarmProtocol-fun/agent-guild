#!/usr/bin/env node
/**
 * rh-agent — plug your own agent into the robinhood-trading mod.
 *
 * Robinhood only signs in to apps on localhost, so each agent connects
 * itself, once, from the machine it runs on:
 *
 *   node rh-agent.mjs login      # opens Robinhood's sign-in, catches the redirect on localhost
 *
 * The hub keeps the PKCE secret and the resulting tokens (encrypted); this
 * script only relays the one-time code, so no Robinhood token ever lands on
 * this machine or in the model's context. No browser here (Docker, a remote
 * box)? Open the printed link anywhere, sign in, and paste the localhost
 * address it ends on back into this terminal.
 *
 * Zero dependencies (Node 18+). Then use it two ways:
 *
 *   1. As a library inside your agent's tool loop:
 *        import { connect } from "./rh-agent.mjs";
 *        const rh = await connect();             // reads env, checks GET /me
 *        const tools = rh.tools;                 // hand these to your LLM
 *        const out = await rh.call(name, input)  // run whichever tool it picks
 *
 *   2. From the shell:
 *        node rh-agent.mjs me | tools | logout
 *        node rh-agent.mjs call rh_call '{"tool":"get_portfolio"}'
 *        node rh-agent.mjs call rh_order '{"arguments":{"symbol":"SPY","side":"buy","type":"market","dollar_amount":"10"},"reason":"…","idempotencyKey":"…"}'
 *
 * Environment:
 *   AGENT_GUILD_URL        hub origin, default https://agent-guild.com
 *   AGENT_GUILD_TOKEN      agt_… bearer token with the mods:call scope, or
 *   AGENT_GUILD_AGENT_ID + AGENT_GUILD_API_KEY
 *   RH_CALLBACK_PORT       localhost port for the sign-in redirect, default 53682
 *   RH_NO_BROWSER          set to skip opening a browser (just print the link)
 */
import http from "node:http";
import { spawn } from "node:child_process";
import readline from "node:readline";

const BASE = "/api/mods/robinhood-trading";
const LOGIN_TIMEOUT_MS = 15 * 60_000;

function config(env = process.env) {
  const url = (env.AGENT_GUILD_URL || "https://agent-guild.com").replace(/\/$/, "");
  const token = env.AGENT_GUILD_TOKEN;
  const agentId = env.AGENT_GUILD_AGENT_ID;
  const apiKey = env.AGENT_GUILD_API_KEY;
  if (!token && !(agentId && apiKey)) {
    throw new Error("Set AGENT_GUILD_TOKEN (agt_…, mods:call scope) or AGENT_GUILD_AGENT_ID + AGENT_GUILD_API_KEY");
  }
  return { url, token, agentId, apiKey, port: Number(env.RH_CALLBACK_PORT) || 53682, noBrowser: !!env.RH_NO_BROWSER };
}

function makeRequest(cfg) {
  return async function request(method, path, body, query = {}) {
    const u = new URL(`${cfg.url}${BASE}/${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
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

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch { /* no browser on this machine: the printed link still works */ }
}

const PAGE = (title, text) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body>`;

/**
 * The sign-in, end to end: ask the hub for Robinhood's link, then take the
 * code from whichever arrives first — the redirect on localhost, or an
 * address pasted into the terminal — and hand it to the hub.
 */
export async function login(env = process.env, log = console.log) {
  const cfg = config(env);
  const request = makeRequest(cfg);
  const redirectUri = `http://localhost:${cfg.port}/callback`;
  const { authorizeUrl } = await request("POST", "connection/start", { redirectUri });

  return new Promise((resolve, reject) => {
    let settled = false;
    let rl = null;
    const finish = async (callbackUrl, respond) => {
      if (settled) return;
      settled = true;
      try {
        const out = await request("POST", "connection/finish", { callbackUrl });
        respond?.(200, PAGE("Robinhood connected", "Your agent is connected. You can close this tab."));
        resolve(out);
      } catch (err) {
        respond?.(400, PAGE("Couldn't connect", String(err.message).replace(/</g, "&lt;")));
        reject(err);
      } finally {
        stop();
      }
    };

    // "localhost" may resolve to 127.0.0.1 or ::1 depending on the browser: listen on both, loopback only.
    const onRequest = (req, res) => {
      const url = new URL(req.url, redirectUri);
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      finish(url.toString(), (status, html) => res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(html));
    };
    const servers = ["127.0.0.1", "::1"].map((host) => {
      const s = http.createServer(onRequest);
      s.on("error", (err) => { if (host === "127.0.0.1") log(`(couldn't listen on ${redirectUri}: ${err.message} — paste the address instead)`); });
      s.listen(cfg.port, host);
      return s;
    });
    const stop = () => {
      clearTimeout(timer);
      for (const s of servers) s.close();
      rl?.close();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error("Sign-in timed out after 15 minutes — run login again"));
    }, LOGIN_TIMEOUT_MS);

    log("Sign in to Robinhood to connect this agent:\n");
    log(`  ${authorizeUrl}\n`);
    log(`Waiting on ${redirectUri} … (no browser here? sign in anywhere, then paste the localhost address it ends on)`);
    if (!cfg.noBrowser) openBrowser(authorizeUrl);

    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (line) => { if (line.includes("code=")) finish(line.trim()); });
    }
  });
}

export async function connect(env = process.env) {
  const cfg = config(env);
  const request = makeRequest(cfg);
  const me = await request("GET", "me");
  const { tools } = await request("GET", "agent/tools");
  const byName = new Map(tools.map((t) => [t.name, t]));

  /** Run one tool from the manifest. Fills {path} segments and sends GET inputs as the query. */
  async function call(name, input = {}) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    const rest = { ...input };
    const path = tool.path.replace(/\{(\w+)\}/g, (_, key) => {
      const value = rest[key];
      delete rest[key];
      if (value == null) throw new Error(`${name} needs ${key}`);
      return encodeURIComponent(String(value));
    });
    return tool.method === "GET" ? request("GET", path, undefined, rest) : request("POST", path, rest);
  }

  return { me, tools, call, request };
}

async function main(argv) {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log("usage: rh-agent.mjs login | logout | me | tools | call <tool> [json]");
    return;
  }
  if (cmd === "login") {
    const out = await login();
    return console.log(`Connected: agent ${out.agentId} reaches ${out.tools} Robinhood tools.`);
  }
  if (cmd === "logout") {
    await makeRequest(config())("POST", "connection/disconnect", {});
    return console.log("Disconnected from Robinhood.");
  }
  const rh = await connect();
  if (cmd === "me") return console.log(JSON.stringify(rh.me, null, 2));
  if (cmd === "tools") return console.log(JSON.stringify(rh.tools, null, 2));
  if (cmd === "call") {
    const [name, json] = args;
    return console.log(JSON.stringify(await rh.call(name, json ? JSON.parse(json) : {}), null, 2));
  }
  throw new Error(`Unknown command ${cmd}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
