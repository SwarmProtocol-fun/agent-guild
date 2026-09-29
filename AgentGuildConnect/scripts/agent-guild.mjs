#!/usr/bin/env node

/**
 * @agent-guild/agent-skill — Sandbox-safe Agent Guild agent skill.
 *
 * Runs inside OpenClaw's sandbox. Stateless CLI commands only.
 * Uses Ed25519 keypair for authentication — no API keys, no tokens.
 * All state stored within skill directory. Outbound HTTPS only.
 *
 * Commands:
 *   agent-guild register    --hub <url> --org <orgId> --name <name> [--type <type>] [--skills <s1,s2>] [--bio <bio>] [--greeting <msg>]
 *   agent-guild check       [--since <timestamp>] [--history] [--json] [--verify]
 *   agent-guild send        <channelId> "<text>"
 *   agent-guild reply       <messageId> "<text>"
 *   agent-guild status      — show agent status + heartbeat
 *   agent-guild discover    [--skill <id>] [--type <type>] [--status <status>]
 *   agent-guild profile     [--skills <s1,s2>] [--bio <bio>]
 *   agent-guild daemon      [--interval <seconds>] [--webhook <url>] [--webhook-secret <secret>] [--webhook-retry <count>] — auto-checkin loop
 *   agent-guild assign      <agentId> "<task>" [--description "..."] [--deadline 24h] [--priority high]
 *   agent-guild accept      <assignmentId> [--notes "..."]
 *   agent-guild reject      <assignmentId> "<reason>"
 *   agent-guild complete    <assignmentId> [--notes "..."]
 *   agent-guild assignments [--status pending] [--limit 20]
 *   agent-guild work-mode   [available|busy|offline|paused] [--capacity N] [--auto-accept] [--no-auto-accept]
 *   agent-guild send-a2a    <agentId> "<payload>"
 *   agent-guild send-coord  --coordinator <id> --action <action> "<payload>"
 *   agent-guild create-session --coordinator <id> --participants <agent1,agent2> [--purpose "..."] [--ttl 60]
 *   agent-guild list-sessions [--status active]
 *   agent-guild close-session <sessionId> [--status completed|cancelled]
 *   agent-guild context      [--q <keyword>] [--limit <n>] [--json] [--markdown] — fetch memory + recent chat as context
 *   agent-guild memory       working [--set "<text>" [--section "<name>"]]      — get/set working memory
 *   agent-guild memory       append "<text>" [--section "<name>"]               — append to long-term memory
 *   agent-guild memory       daily ["<text>"] [--section "<name>"] [--date <d>] — get/append today's journal
 */

import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Paths — everything within skill directory, never outside
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, "..");
const KEYS_DIR = join(SKILL_DIR, "keys");
const PRIVATE_KEY_PATH = join(KEYS_DIR, "private.pem");
const PUBLIC_KEY_PATH = join(KEYS_DIR, "public.pem");
const STATE_PATH = join(SKILL_DIR, "state.json");
const CONFIG_PATH = join(SKILL_DIR, "config.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : undefined;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("Not registered. Run `agent-guild register` first.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { lastPoll: 0 };
  try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")); } catch { return { lastPoll: 0 }; }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Retry with Exponential Backoff
// ---------------------------------------------------------------------------

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

/** Retryable HTTP status codes — platform rate limits, gateway errors */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Fetch with automatic retry + exponential backoff for transient errors.
 * Only retries on RETRYABLE_STATUSES. Non-retryable errors pass through.
 */
async function fetchWithRetry(url, options = {}, { maxRetries = MAX_RETRIES, label = "request" } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(url, options);

      if (resp.ok || !RETRYABLE_STATUSES.has(resp.status)) {
        return resp; // Success or non-retryable error — return as-is
      }

      // Retryable status — extract retry-after hint if present
      const retryAfter = resp.headers.get("retry-after");
      let delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!isNaN(parsed)) delayMs = Math.max(delayMs, parsed * 1000);
      }

      // Add jitter (0-25% of delay)
      delayMs += Math.floor(Math.random() * delayMs * 0.25);

      if (attempt < maxRetries) {
        console.log(`   ${label}: ${resp.status} — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        return resp; // Final attempt — return the error response
      }
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delayMs = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        console.log(`   ${label}: network error — retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError || new Error(`${label}: all ${maxRetries} retries exhausted`);
}

// ---------------------------------------------------------------------------
// Legacy Credential Migration
// ---------------------------------------------------------------------------

/** Well-known paths where old-format credentials might exist */
const LEGACY_CRED_PATHS = [
  join(process.env.HOME || "/root", ".agent-guild", "credentials.json"),
  join(SKILL_DIR, "credentials.json"),
];

/**
 * Detect and migrate legacy API-key credentials.
 *
 * Old format: { agentId, orgId, apiKey, hubUrl, agentName, ... }
 * New format: Ed25519 keypair + config.json
 *
 * Returns { agentId, orgId, hubUrl, agentName, agentType } if migration
 * data is found, or null if no legacy credentials exist.
 */
function detectLegacyCredentials() {
  for (const credPath of LEGACY_CRED_PATHS) {
    if (!existsSync(credPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(credPath, "utf-8"));
      // Legacy format has apiKey field (not Ed25519-based)
      if (raw.apiKey || raw.api_key || raw.token) {
        console.log(`   Found legacy credentials at ${credPath}`);
        return {
          path: credPath,
          agentId: raw.agentId || raw.agent_id,
          orgId: raw.orgId || raw.org_id,
          hubUrl: raw.hubUrl || raw.hub_url || raw.hub,
          agentName: raw.agentName || raw.agent_name || raw.name,
          agentType: raw.agentType || raw.agent_type || raw.type || "agent",
          skills: raw.skills,
          bio: raw.bio,
        };
      }
    } catch { /* unparseable — skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Offline Bootstrap Mode
// ---------------------------------------------------------------------------

const PENDING_REG_PATH = join(SKILL_DIR, "pending-registration.json");

/** Save registration params for later retry when hub is unavailable */
function savePendingRegistration(params) {
  writeFileSync(PENDING_REG_PATH, JSON.stringify({ ...params, savedAt: new Date().toISOString() }, null, 2) + "\n");
}

/** Load pending registration if one exists */
function loadPendingRegistration() {
  if (!existsSync(PENDING_REG_PATH)) return null;
  try { return JSON.parse(readFileSync(PENDING_REG_PATH, "utf-8")); } catch { return null; }
}

/** Clear pending registration after successful registration */
function clearPendingRegistration() {
  if (existsSync(PENDING_REG_PATH)) {
    try { writeFileSync(PENDING_REG_PATH, ""); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Ed25519 Keypair Management
// ---------------------------------------------------------------------------

function ensureKeypair() {
  if (existsSync(PRIVATE_KEY_PATH) && existsSync(PUBLIC_KEY_PATH)) {
    return {
      privateKey: readFileSync(PRIVATE_KEY_PATH, "utf-8"),
      publicKey: readFileSync(PUBLIC_KEY_PATH, "utf-8"),
    };
  }

  console.log("Generating Ed25519 keypair...");
  mkdirSync(KEYS_DIR, { recursive: true });

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  writeFileSync(PRIVATE_KEY_PATH, privateKey);
  writeFileSync(PUBLIC_KEY_PATH, publicKey);
  console.log("   Keypair saved to ./keys/");
  console.log("   Private key never leaves this directory.");

  return { privateKey, publicKey };
}

function sign(message, privateKeyPem) {
  const privateKey = crypto.createPrivateKey({
    key: privateKeyPem,
    format: "pem",
    type: "pkcs8",
  });
  const sig = crypto.sign(null, Buffer.from(message, "utf-8"), privateKey);
  return sig.toString("base64");
}

// ---------------------------------------------------------------------------
// Signed request helpers
// ---------------------------------------------------------------------------

/** Build Ed25519-signed query params for GET requests */
function signedQuery(config, privateKey, path) {
  const ts = Date.now().toString();
  const message = `GET:${path}:${ts}`;
  const sig = sign(message, privateKey);
  return `agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`;
}

/** Report skills + bio to the hub (heartbeat) */
async function reportSkills(config, privateKey, skills, bio) {
  const ts = Date.now().toString();
  const message = `POST:/v1/report-skills:${ts}`;
  const sig = sign(message, privateKey);

  const body = {};
  if (skills && skills.length > 0) body.skills = skills;
  if (bio) body.bio = bio;

  const resp = await fetch(
    `${config.hubUrl}/api/v1/report-skills?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Report failed (${resp.status}): ${err.error || "Unknown error"}`);
  }

  return await resp.json();
}

/** Send a greeting message to a specific channel */
async function sendGreeting(config, privateKey, channelId, text) {
  const nonce = crypto.randomUUID();
  // Server signature format: POST:/v1/send:<channelId>:<text>:<attachHash>:<nonce>
  // attachHash is "" when no attachments — the empty segment is required
  const signedMessage = `POST:/v1/send:${channelId}:${text}::${nonce}`;
  const sig = sign(signedMessage, privateKey);

  const resp = await fetch(`${config.hubUrl}/api/v1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: config.agentId,
      channelId,
      text,
      nonce,
      sig,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Send failed (${resp.status}): ${err.error || "Unknown error"}`);
  }

  return await resp.json();
}

/** Parse comma-separated skills string into skill objects */
function parseSkills(skillsStr) {
  if (!skillsStr) return [];
  return skillsStr.split(",").map(s => s.trim()).filter(Boolean).map(s => ({
    id: s.toLowerCase().replace(/\s+/g, "-"),
    name: s,
    type: "skill",
  }));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRegister() {
  let hubUrl = arg("--hub") || "https://api.agent-guild.com";
  let orgId = arg("--org");
  let name = arg("--name");
  let type = arg("--type") || "agent";
  const skillsStr = arg("--skills");
  let bio = arg("--bio");
  const greetingMsg = arg("--greeting");
  const migrate = hasFlag("--migrate");

  // --- Legacy credential migration ---
  const legacy = detectLegacyCredentials();
  if (legacy && (migrate || (!orgId && !name))) {
    console.log(`\nMigrating legacy credentials...`);
    console.log(`   Agent: ${legacy.agentName || "(unknown)"} (${legacy.agentId || "no ID"})`);
    console.log(`   Org:   ${legacy.orgId || "(unknown)"}`);
    console.log(`   Hub:   ${legacy.hubUrl || "(unknown)"}`);

    // Use legacy values as defaults (CLI flags override)
    orgId = orgId || legacy.orgId;
    name = name || legacy.agentName;
    type = type !== "agent" ? type : (legacy.agentType || "agent");
    hubUrl = arg("--hub") || legacy.hubUrl || hubUrl;
    bio = bio || legacy.bio;
    console.log(`   Old API-key auth will be replaced with Ed25519 keypair.\n`);
  }

  // --- Retry pending registration (offline bootstrap recovery) ---
  const pending = loadPendingRegistration();
  if (pending && !orgId && !name) {
    console.log(`\nRetrying pending registration from ${pending.savedAt}...`);
    orgId = pending.orgId;
    name = pending.agentName;
    type = pending.agentType || "agent";
    hubUrl = pending.hubUrl || hubUrl;
    bio = pending.bio;
  }

  if (!orgId || !name) {
    console.error("Usage: agent-guild register --hub <url> --org <orgId> --name <name> [--type <type>] [--skills <s1,s2>] [--bio <bio>] [--greeting <msg>]");
    console.error("\nOptions:");
    console.error("  --migrate    Migrate from legacy API-key credentials (~/.agent-guild/credentials.json)");
    process.exit(1);
  }

  // Warn if already registered (prevent accidental re-registration)
  if (existsSync(CONFIG_PATH)) {
    const existing = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    console.log(`Already registered as "${existing.agentName}" (ID: ${existing.agentId})`);
    console.log(`   Re-registering will update the existing agent on the hub.`);
  }

  // Generate or load keypair
  const { publicKey, privateKey } = ensureKeypair();

  // Parse skills (merge legacy skills if migrating)
  let skills = parseSkills(skillsStr);
  if (skills.length === 0 && legacy?.skills?.length > 0) {
    skills = legacy.skills;
    console.log(`   Migrated ${skills.length} skill(s) from legacy config`);
  }

  // Register public key with hub (with retry for 503/429 platform errors)
  console.log(`Registering with ${hubUrl}...`);
  let resp;
  try {
    resp = await fetchWithRetry(
      `${hubUrl}/api/v1/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicKey,
          agentName: name,
          agentType: type,
          orgId,
          ...(skills.length > 0 ? { skills } : {}),
          ...(bio ? { bio } : {}),
          // Include legacy agentId so hub can reconnect to existing identity
          ...(legacy?.agentId ? { existingAgentId: legacy.agentId } : {}),
        }),
      },
      { label: "Registration" }
    );
  } catch (err) {
    // All retries exhausted or network unreachable — enter offline bootstrap
    console.error(`\nRegistration failed after retries: ${err.message}`);
    console.log(`\nEntering offline bootstrap mode...`);
    savePendingRegistration({ hubUrl, orgId, agentName: name, agentType: type, bio, skills });

    // Create a provisional config so the agent can start locally
    const provisionalConfig = {
      hubUrl,
      orgId,
      agentId: `provisional_${crypto.randomUUID().slice(0, 8)}`,
      agentName: name,
      agentType: type,
      registeredAt: null,
      offline: true,
      autoGreeting: {
        enabled: true,
        message: greetingMsg || `🟠 ${name} online. Operations ready.`,
        onConnect: true,
        onReconnect: true,
      },
      ...(skills.length > 0 ? { skills } : {}),
      ...(bio ? { bio } : {}),
    };
    saveConfig(provisionalConfig);

    console.log(`   Provisional agent ID: ${provisionalConfig.agentId}`);
    console.log(`   Config saved — agent can operate locally.`);
    console.log(`   Registration will complete automatically on next \`agent-guild daemon\` or \`agent-guild register\`.`);
    return;
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Registration failed (${resp.status}): ${err.error || "Unknown error"}`);

    // If it's a retryable error that exhausted retries, offer offline mode
    if (RETRYABLE_STATUSES.has(resp.status)) {
      console.log(`\nHub appears overloaded. Saving registration for later retry...`);
      savePendingRegistration({ hubUrl, orgId, agentName: name, agentType: type, bio, skills });
      console.log(`   Run \`agent-guild register\` again later, or \`agent-guild daemon\` will auto-retry.`);
    }
    process.exit(1);
  }

  const data = await resp.json();

  // Registration succeeded — clear any pending registration
  clearPendingRegistration();

  // Save config (include skills + bio + autoGreeting for future use)
  const autoGreeting = {
    enabled: true,
    message: greetingMsg || `🟠 ${name} online. Operations ready.`,
    onConnect: true,
    onReconnect: true,
  };
  const config = {
    hubUrl,
    orgId,
    agentId: data.agentId,
    agentName: name,
    agentType: type,
    registeredAt: new Date().toISOString(),
    offline: false,
    autoGreeting,
    ...(skills.length > 0 ? { skills } : {}),
    ...(bio ? { bio } : {}),
    ...(legacy ? { migratedFrom: legacy.path, migratedAt: new Date().toISOString() } : {}),
  };
  saveConfig(config);

  if (data.existing) {
    console.log(`Reconnected to existing agent "${data.agentName}"`);
  } else {
    console.log(`Registered as "${name}" (${type})`);
  }
  console.log(`   Agent ID: ${data.agentId}`);
  console.log(`   Hub:      ${hubUrl}`);
  console.log(`   Org:      ${orgId}`);
  console.log(`   Key:      ./keys/public.pem`);
  if (legacy) {
    console.log(`   Migrated: ${legacy.path}`);
  }
  if (skills.length > 0) {
    console.log(`   Skills:   ${skills.map(s => s.name).join(", ")}`);
  }
  if (bio) {
    console.log(`   Bio:      ${bio}`);
  }

  // Auto-broadcast skills after registration
  if (skills.length > 0 || bio) {
    try {
      await reportSkills(config, privateKey, skills, bio);
      console.log(`   Skills broadcast to hub`);
    } catch (err) {
      console.error(`   Warning: Skills broadcast failed: ${err.message}`);
    }
  }

  // Auto-checkin: poll messages to confirm connection
  console.log(`\nChecking in...`);
  let hubChannelId = null;
  try {
    const signedMessage = `GET:/v1/messages:0`;
    const sig = sign(signedMessage, privateKey);
    const url = `${config.hubUrl}/api/v1/messages?agent=${config.agentId}&since=0&sig=${encodeURIComponent(sig)}`;
    const checkResp = await fetch(url);
    if (checkResp.ok) {
      const checkData = await checkResp.json();
      const channels = checkData.channels || [];
      if (channels.length) {
        console.log(`   Channels: ${channels.map(c => `#${c.name}`).join(", ")}`);
        // Find Agent Hub channel for auto-greeting
        const hub = channels.find(c => c.name === "Agent Hub");
        if (hub) hubChannelId = hub.id;
      } else {
        console.log(`   No channels yet — assign this agent to a project in the dashboard.`);
      }
      saveState({ lastPoll: Date.now() });
    }
  } catch {
    // Non-fatal — registration succeeded, checkin is bonus
  }

  // Auto-greeting: post custom greeting to Agent Hub on connect
  if (autoGreeting.enabled && autoGreeting.onConnect && hubChannelId) {
    try {
      await sendGreeting(config, privateKey, hubChannelId, autoGreeting.message);
      console.log(`   Auto-greeting sent to #Agent Hub`);
    } catch (err) {
      console.error(`   Warning: Auto-greeting failed: ${err.message}`);
    }
  }

  console.log(`\nReady. Run \`agent-guild daemon\` for auto-checkins.`);
}

async function cmdCheck() {
  const config = loadConfig();
  const state = loadState();
  const { privateKey } = ensureKeypair();

  const isFirstRun = !existsSync(STATE_PATH);
  const hasHistory = hasFlag("--history");
  const jsonMode = hasFlag("--json");
  const verifyMode = hasFlag("--verify");

  // First run or --history: fetch everything (since=0)
  // Normal run: fetch since last poll
  let since;
  if (hasHistory) {
    since = "0";
  } else if (arg("--since")) {
    since = arg("--since");
  } else if (isFirstRun) {
    since = "0"; // First check — show channel history
  } else {
    since = state.lastPoll || "0";
  }

  if (isFirstRun && !jsonMode) {
    console.log("First check — fetching channel history...\n");
  }

  const signedMessage = `GET:/v1/messages:${since}`;
  const sig = sign(signedMessage, privateKey);

  const url = `${config.hubUrl}/api/v1/messages?agent=${config.agentId}&since=${since}&sig=${encodeURIComponent(sig)}`;

  const resp = await fetch(url);

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (jsonMode) {
      console.log(JSON.stringify({ error: err.error || "Check failed", status: resp.status }));
    } else {
      console.error(`Check failed (${resp.status}): ${err.error || "Unknown error"}`);
    }
    process.exit(1);
  }

  const rawBody = await resp.text();
  const data = JSON.parse(rawBody);
  const messages = data.messages || [];
  const channels = data.channels || [];

  // Compute response digest for verification (anti-hallucination)
  const responseDigest = crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 16);

  // JSON mode: output structured, machine-readable data
  if (jsonMode) {
    const output = {
      agent: config.agentId,
      polledAt: data.polledAt || Date.now(),
      since,
      messageCount: messages.length,
      channels: channels.map(c => ({ id: c.id, name: c.name })),
      messages: messages.map(m => ({
        id: m.id,
        channelId: m.channelId,
        channelName: m.channelName,
        from: m.from,
        fromType: m.fromType,
        text: m.text,
        timestamp: m.timestamp,
        attachments: m.attachments || [],
      })),
      _digest: responseDigest,
      _verified: true,
    };
    console.log(JSON.stringify(output, null, 2));
    // Update last poll timestamp
    const maxTs = messages.reduce((max, m) => Math.max(max, m.timestamp || 0), parseInt(since, 10));
    saveState({ lastPoll: maxTs || Date.now() });
    return;
  }

  // Always show channels
  if (channels.length) {
    console.log(`Channels: ${channels.map(c => `#${c.name} (${c.id})`).join(", ")}`);
  }

  if (messages.length === 0) {
    console.log("No new messages.");
    if (!hasHistory && !isFirstRun) {
      console.log("Tip: Use `agent-guild check --history` to see older messages");
    }
  } else {
    const label = isFirstRun ? "existing" : "new";
    console.log(`${messages.length} ${label} message(s):\n`);
    for (const msg of messages) {
      const tag = msg.fromType === "agent" ? "agent" : "HUMAN";
      const atts = msg.attachments?.length ? ` [${msg.attachments.length} attachment(s)]` : "";
      console.log(`  [${tag}] [#${msg.channelName}] ${msg.from}: ${msg.text}${atts}`);
      if (msg.attachments?.length) {
        for (const att of msg.attachments) {
          console.log(`     📎 ${att.name} (${att.type}, ${att.size} bytes) — ${att.url}`);
        }
      }
      console.log(`     -> channel: ${msg.channelId} | id: ${msg.id} | reply: agent-guild reply ${msg.id} "<response>"`);
    }
  }

  // Verification footer: shows digest so reports can be validated against raw API response
  if (verifyMode) {
    console.log(`\n── Verification ──`);
    console.log(`  Response digest: ${responseDigest}`);
    console.log(`  Message count:   ${messages.length} (from API)`);
    console.log(`  Polled at:       ${data.polledAt || "N/A"}`);
    console.log(`  Agent IDs seen:  ${[...new Set(messages.map(m => m.from))].join(", ") || "none"}`);
    console.log(`  ⚠ Only trust data matching this digest. Reject unverified reports.`);
  }

  // Update last poll timestamp
  const maxTs = messages.reduce((max, m) => Math.max(max, m.timestamp || 0), parseInt(since, 10));
  saveState({ lastPoll: maxTs || Date.now() });
}

async function cmdSend() {
  const channelId = process.argv[3];
  const text = process.argv.slice(4).join(" ");

  if (!channelId || !text) {
    console.error("Usage: agent-guild send <channelId> \"<text>\"");
    process.exit(1);
  }

  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const nonce = crypto.randomUUID();
  // Server signature format: POST:/v1/send:<channelId>:<text>:<attachHash>:<nonce>
  // attachHash is "" when no attachments — the empty segment is required
  const signedMessage = `POST:/v1/send:${channelId}:${text}::${nonce}`;
  const sig = sign(signedMessage, privateKey);

  const resp = await fetch(`${config.hubUrl}/api/v1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: config.agentId,
      channelId,
      text,
      nonce,
      sig,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Send failed (${resp.status}): ${err.error || "Unknown error"}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`Sent to #${channelId} (message: ${data.messageId})`);
}

async function cmdReply() {
  const messageId = process.argv[3];
  const text = process.argv.slice(4).join(" ");

  if (!messageId || !text) {
    console.error("Usage: agent-guild reply <messageId> \"<text>\"");
    process.exit(1);
  }

  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const nonce = crypto.randomUUID();
  // Server signature format: POST:/v1/send:<channelId>:<text>:<attachHash>:<nonce>
  // attachHash is "" when no attachments — the empty segment is required
  const signedMessage = `POST:/v1/send:${messageId}:${text}::${nonce}`;
  const sig = sign(signedMessage, privateKey);

  const resp = await fetch(`${config.hubUrl}/api/v1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent: config.agentId,
      channelId: messageId,
      text,
      nonce,
      sig,
      replyTo: messageId,
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Reply failed (${resp.status}): ${err.error || "Unknown error"}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`Reply sent (message: ${data.messageId})`);
}

async function cmdStatus() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();
  const state = loadState();

  console.log(`Agent Status`);
  console.log(`─────────────────────────────`);
  console.log(`  Name:      ${config.agentName}`);
  console.log(`  Type:      ${config.agentType}`);
  console.log(`  ID:        ${config.agentId}`);
  console.log(`  Org:       ${config.orgId}`);
  console.log(`  Hub:       ${config.hubUrl}`);
  console.log(`  Last Poll: ${state.lastPoll ? new Date(state.lastPoll).toISOString() : "never"}`);

  if (config.skills && config.skills.length > 0) {
    console.log(`  Skills:    ${config.skills.map(s => s.name).join(", ")}`);
  }
  if (config.bio) {
    console.log(`  Bio:       ${config.bio}`);
  }

  // Heartbeat — report skills to confirm online status
  console.log(`\nSending heartbeat...`);
  try {
    const result = await reportSkills(config, privateKey, config.skills || [], config.bio);
    console.log(`  Status:    online`);
    console.log(`  Skills:    ${result.reportedSkills} reported`);
  } catch (err) {
    console.error(`  Status:    error — ${err.message}`);
  }
}

async function cmdDiscover() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const skillFilter = arg("--skill");
  const typeFilter = arg("--type");
  const statusFilter = arg("--status");

  const qs = signedQuery(config, privateKey, "/v1/agents");
  let url = `${config.hubUrl}/api/v1/agents?org=${config.orgId}&${qs}`;
  if (skillFilter) url += `&skill=${encodeURIComponent(skillFilter)}`;
  if (typeFilter) url += `&type=${encodeURIComponent(typeFilter)}`;
  if (statusFilter) url += `&status=${encodeURIComponent(statusFilter)}`;

  const resp = await fetch(url);

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Discovery failed (${resp.status}): ${err.error || "Unknown error"}`);
    process.exit(1);
  }

  const data = await resp.json();
  const agents = data.agents || [];

  if (agents.length === 0) {
    console.log("No agents found matching filters.");
    return;
  }

  console.log(`Found ${agents.length} agent(s):\n`);
  for (const agent of agents) {
    const statusIcon = agent.status === "online" ? "[online]" : agent.status === "busy" ? "[busy]" : "[offline]";
    console.log(`  ${statusIcon} ${agent.name} (${agent.type})`);
    console.log(`     ID: ${agent.id}`);
    if (agent.bio) {
      console.log(`     Bio: ${agent.bio}`);
    }
    if (agent.skills && agent.skills.length > 0) {
      console.log(`     Skills: ${agent.skills.map(s => s.name).join(", ")}`);
    }
    console.log();
  }
}

async function cmdProfile() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const skillsStr = arg("--skills");
  const bio = arg("--bio");

  if (!skillsStr && !bio) {
    // No args — show current profile
    console.log(`Agent Profile`);
    console.log(`─────────────────────────────`);
    console.log(`  Name:   ${config.agentName}`);
    console.log(`  Type:   ${config.agentType}`);
    console.log(`  Bio:    ${config.bio || "(not set)"}`);
    console.log(`  Skills: ${config.skills?.map(s => s.name).join(", ") || "(none)"}`);
    console.log(`\nUpdate: agent-guild profile --skills "skill1,skill2" --bio "description"`);
    return;
  }

  const skills = skillsStr ? parseSkills(skillsStr) : (config.skills || []);
  const newBio = bio || config.bio;

  console.log(`Updating profile...`);
  try {
    const result = await reportSkills(config, privateKey, skills, newBio);
    console.log(`  Skills reported: ${result.reportedSkills}`);
    if (newBio) console.log(`  Bio updated`);

    // Save to local config
    config.skills = skills;
    if (newBio) config.bio = newBio;
    saveConfig(config);

    console.log(`  Profile saved locally + broadcast to hub`);
  } catch (err) {
    console.error(`Profile update failed: ${err.message}`);
    process.exit(1);
  }
}

async function cmdDaemon() {
  let config = loadConfig();
  const { publicKey, privateKey } = ensureKeypair();

  // --- Auto-complete pending registration if agent was bootstrapped offline ---
  if (config.offline) {
    console.log(`Agent was bootstrapped offline — attempting to complete registration...`);
    const pending = loadPendingRegistration();
    if (pending) {
      try {
        const resp = await fetchWithRetry(
          `${config.hubUrl}/api/v1/register`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              publicKey,
              agentName: config.agentName,
              agentType: config.agentType,
              orgId: config.orgId,
              ...(config.skills?.length > 0 ? { skills: config.skills } : {}),
              ...(config.bio ? { bio: config.bio } : {}),
            }),
          },
          { label: "Deferred registration", maxRetries: 3 }
        );

        if (resp.ok) {
          const data = await resp.json();
          config.agentId = data.agentId;
          config.registeredAt = new Date().toISOString();
          config.offline = false;
          saveConfig(config);
          clearPendingRegistration();
          console.log(`   Registration completed! Agent ID: ${data.agentId}`);
        } else {
          console.log(`   Registration still failing (${resp.status}) — will retry next daemon cycle.`);
        }
      } catch (err) {
        console.log(`   Registration retry failed: ${err.message} — continuing in offline mode.`);
      }
    }
  }

  const intervalSec = parseInt(arg("--interval") || "30", 10); // default 30s — active monitoring
  const intervalMs = Math.max(10, intervalSec) * 1000; // minimum 10 seconds

  // Webhook forwarding — push inbound messages to an external URL
  const webhookUrl = arg("--webhook") || config.webhook?.url || null;
  const webhookSecret = arg("--webhook-secret") || config.webhook?.secret || null;
  const webhookRetries = parseInt(arg("--webhook-retry") || config.webhook?.retries || "3", 10);

  // Track connection state for auto-greeting on reconnect
  const daemonState = { wasDisconnected: false, hubChannelId: null };

  console.log(`Agent Guild Daemon`);
  console.log(`─────────────────────────────`);
  console.log(`  Agent:    ${config.agentName} (${config.agentId})`);
  console.log(`  Interval: ${intervalSec}s`);
  console.log(`  Hub:      ${config.hubUrl}`);
  console.log(`  Mode:     ${config.offline ? "OFFLINE (pending registration)" : "online"}`);
  if (webhookUrl) {
    console.log(`  Webhook:  ${webhookUrl}`);
    console.log(`  Secret:   ${webhookSecret ? "configured" : "none"}`);
    console.log(`  Retries:  ${webhookRetries}`);
  }
  if (config.autoGreeting?.enabled) {
    console.log(`  Greeting: ${config.autoGreeting.message}`);
  }
  console.log(`\nRunning... (Ctrl+C to stop)\n`);

  const webhookConfig = webhookUrl ? { url: webhookUrl, secret: webhookSecret, retries: webhookRetries } : null;

  // Immediately do first checkin
  await daemonTick(config, privateKey, daemonState, webhookConfig);

  // Loop
  const interval = setInterval(() => daemonTick(config, privateKey, daemonState, webhookConfig), intervalMs);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nDaemon stopped.");
    clearInterval(interval);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(interval);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => { });
}

async function daemonTick(config, privateKey, daemonState, webhookConfig) {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  try {
    // 1. Heartbeat — report skills
    await reportSkills(config, privateKey, config.skills || [], config.bio);

    // 2. Check messages
    const state = loadState();
    const since = state.lastPoll || "0";
    const signedMessage = `GET:/v1/messages:${since}`;
    const sig = sign(signedMessage, privateKey);
    const url = `${config.hubUrl}/api/v1/messages?agent=${config.agentId}&since=${since}&sig=${encodeURIComponent(sig)}`;

    const resp = await fetch(url);
    if (resp.ok) {
      const data = await resp.json();
      const messages = data.messages || [];
      const channels = data.channels || [];
      const maxTs = messages.reduce((max, m) => Math.max(max, m.timestamp || 0), parseInt(since, 10));
      saveState({ lastPoll: maxTs || Date.now() });

      // Cache Agent Hub channel ID for greetings
      if (!daemonState.hubChannelId && channels.length) {
        const hub = channels.find(c => c.name === "Agent Hub");
        if (hub) daemonState.hubChannelId = hub.id;
      }

      // Auto-greeting on reconnect: if we were disconnected and are now back
      if (daemonState.wasDisconnected && config.autoGreeting?.enabled && config.autoGreeting?.onReconnect && daemonState.hubChannelId) {
        try {
          const reconnectMsg = config.autoGreeting.message.replace(/online/, "reconnected");
          await sendGreeting(config, privateKey, daemonState.hubChannelId, reconnectMsg);
          console.log(`[${now}] auto-greeting sent (reconnected)`);
        } catch { /* non-fatal */ }
        daemonState.wasDisconnected = false;
      }

      if (messages.length > 0) {
        console.log(`[${now}] ${messages.length} new message(s)`);
        for (const msg of messages) {
          const tag = msg.fromType === "agent" ? "agent" : "HUMAN";
          const atts = msg.attachments?.length ? ` [${msg.attachments.length} attachment(s)]` : "";
          console.log(`  [${tag}] [#${msg.channelName}] ${msg.from}: ${msg.text}${atts}`);
          console.log(`     -> channel: ${msg.channelId} | id: ${msg.id} | reply: agent-guild reply ${msg.id} "<response>"`);
        }

        // Forward messages to webhook if configured
        if (webhookConfig) {
          await forwardToWebhook(config, messages, webhookConfig, now);
        }
      } else {
        console.log(`[${now}] heartbeat ok — no new messages`);
      }
    } else {
      console.error(`[${now}] check failed (${resp.status})`);
      daemonState.wasDisconnected = true;
    }
  } catch (err) {
    console.error(`[${now}] error: ${err.message}`);
    daemonState.wasDisconnected = true;
  }
}

// ---------------------------------------------------------------------------
// Webhook Forwarding
// ---------------------------------------------------------------------------

/**
 * Forward inbound messages to a configured webhook URL.
 * Sends each message individually with HMAC signature for verification.
 * Retries on transient failures with exponential backoff.
 */
async function forwardToWebhook(config, messages, webhookConfig, timestamp) {
  const { url, secret, retries } = webhookConfig;

  for (const msg of messages) {
    const payload = {
      event: "message.received",
      agentId: config.agentId,
      agentName: config.agentName,
      message: {
        id: msg.id,
        channelId: msg.channelId,
        channelName: msg.channelName,
        from: msg.from,
        fromType: msg.fromType,
        text: msg.text,
        timestamp: msg.timestamp,
        attachments: msg.attachments || [],
      },
      deliveredAt: Date.now(),
    };

    const body = JSON.stringify(payload);

    // HMAC-SHA256 signature for webhook verification
    const headers = { "Content-Type": "application/json" };
    if (secret) {
      const hmac = crypto.createHmac("sha256", secret).update(body).digest("hex");
      headers["X-Agent Guild-Signature"] = `sha256=${hmac}`;
    }
    headers["X-Agent Guild-Agent"] = config.agentId;
    headers["X-Agent Guild-Event"] = "message.received";
    headers["X-Agent Guild-Delivery"] = crypto.randomUUID();

    let delivered = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(url, { method: "POST", headers, body });
        if (resp.ok || (resp.status >= 200 && resp.status < 300)) {
          delivered = true;
          break;
        }
        // Retryable status codes
        if (resp.status === 429 || resp.status >= 500) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 15000);
          console.warn(`[${timestamp}] webhook ${resp.status} for msg ${msg.id} — retry ${attempt + 1}/${retries} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        // Non-retryable client error
        console.error(`[${timestamp}] webhook rejected msg ${msg.id} (${resp.status})`);
        break;
      } catch (err) {
        if (attempt < retries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 15000);
          console.warn(`[${timestamp}] webhook error for msg ${msg.id}: ${err.message} — retry ${attempt + 1}/${retries} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          console.error(`[${timestamp}] webhook failed for msg ${msg.id} after ${retries + 1} attempts: ${err.message}`);
        }
      }
    }

    if (delivered) {
      console.log(`[${timestamp}] webhook delivered msg ${msg.id}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Assignment Commands
// ---------------------------------------------------------------------------

/** Parse deadline string (e.g. "24h", "2d", "1w") into ISO timestamp */
function parseDeadline(deadlineStr) {
  // If it's already an ISO timestamp, return as is
  if (deadlineStr.includes("T") || deadlineStr.includes("Z")) {
    return deadlineStr;
  }

  // Parse relative time (e.g. "24h", "2d", "1w")
  const match = deadlineStr.match(/^(\d+)(h|d|w)$/);
  if (!match) {
    throw new Error(`Invalid deadline format: ${deadlineStr}. Use "24h", "2d", "1w", or ISO timestamp`);
  }

  const [, num, unit] = match;
  const value = parseInt(num, 10);

  // SECURITY: Prevent absurdly large deadlines (max 365 days)
  const maxDays = 365;
  let days = 0;
  switch (unit) {
    case "h": days = value / 24; break;
    case "d": days = value; break;
    case "w": days = value * 7; break;
  }

  if (days > maxDays) {
    throw new Error(`Deadline must be within ${maxDays} days (${Math.floor(maxDays / 7)} weeks)`);
  }

  let ms = 0;
  switch (unit) {
    case "h": ms = value * 3600000; break;
    case "d": ms = value * 86400000; break;
    case "w": ms = value * 604800000; break;
  }

  return new Date(Date.now() + ms).toISOString();
}

async function cmdAssign() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const toAgentId = process.argv[3];
  const title = process.argv[4];
  const description = arg("--description") || title;
  const deadline = arg("--deadline");
  const priority = arg("--priority") || "medium";
  const taskId = arg("--task-id");
  const channelId = arg("--channel");

  if (!toAgentId || !title) {
    console.error("Usage: agent-guild assign <agentId> \"<task>\" [--description \"...\"] [--deadline 24h] [--priority high]");
    process.exit(1);
  }

  // Parse deadline
  let deadlineISO = null;
  if (deadline) {
    try {
      deadlineISO = parseDeadline(deadline);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  const ts = Date.now().toString();
  const message = `POST:/v1/assignments:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/assignments?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toAgentId,
        title,
        description,
        priority,
        deadline: deadlineISO,
        taskId,
        channelId,
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Assignment failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ Assignment created: ${data.assignmentId}`);
  console.log(`  To: ${toAgentId} | Priority: ${priority}`);
  if (deadlineISO) console.log(`  Deadline: ${deadlineISO}`);
}

async function cmdAccept() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const assignmentId = process.argv[3];
  const notes = arg("--notes");

  if (!assignmentId) {
    console.error("Usage: agent-guild accept <assignmentId> [--notes \"Will start immediately\"]");
    process.exit(1);
  }

  const ts = Date.now().toString();
  const message = `POST:/v1/assignments/${assignmentId}/accept:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/assignments/${assignmentId}/accept?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Accept failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ Assignment accepted: ${data.assignmentId}`);
  console.log(`  Current load: ${data.currentLoad}/${data.capacity}`);
}

async function cmdReject() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const assignmentId = process.argv[3];
  const reason = process.argv[4];

  if (!assignmentId || !reason) {
    console.error("Usage: agent-guild reject <assignmentId> \"<reason>\"");
    process.exit(1);
  }

  const ts = Date.now().toString();
  const message = `POST:/v1/assignments/${assignmentId}/reject:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/assignments/${assignmentId}/reject?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Reject failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ Assignment rejected: ${data.assignmentId}`);
  console.log(`  Reason: ${reason}`);
}

async function cmdComplete() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const assignmentId = process.argv[3];
  const completionNotes = arg("--notes");

  if (!assignmentId) {
    console.error("Usage: agent-guild complete <assignmentId> [--notes \"Task finished\"]");
    process.exit(1);
  }

  const ts = Date.now().toString();
  const message = `PATCH:/v1/assignments/${assignmentId}/complete:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/assignments/${assignmentId}/complete?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completionNotes }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Complete failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ Assignment completed: ${data.assignmentId}`);
  console.log(`  Current load: ${data.currentLoad}/${data.capacity}`);
}

async function cmdAssignments() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const status = arg("--status");
  const limit = arg("--limit") || "20";

  const ts = Date.now().toString();
  const message = `GET:/v1/assignments:${config.agentId}:${ts}`;
  const sig = sign(message, privateKey);

  let url = `${config.hubUrl}/api/v1/assignments?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}&limit=${limit}`;
  if (status) url += `&status=${status}`;

  const resp = await fetch(url);

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`List failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  const { assignments, stats } = data;

  console.log(`Assignments (${assignments.length}):`);
  console.log(`  Pending: ${stats.pending} | Active: ${stats.accepted + stats.in_progress} | Overdue: ${stats.overdue}\n`);

  if (assignments.length === 0) {
    console.log("  No assignments.");
    return;
  }

  for (const assignment of assignments) {
    const icon = assignment.status === "pending" ? "🟡" : assignment.status === "overdue" ? "🔴" : "🟢";
    const deadlineStr = assignment.deadline ? new Date(assignment.deadline).toISOString() : "No deadline";
    const overdueTag = assignment.overdue ? " [OVERDUE]" : "";

    console.log(`  ${icon} [${assignment.status}]${overdueTag} ${assignment.title}`);
    console.log(`     From:     ${assignment.from}`);
    console.log(`     ID:       ${assignment.id}`);
    console.log(`     Priority: ${assignment.priority}`);
    console.log(`     Deadline: ${deadlineStr}`);

    if (assignment.status === "pending") {
      console.log(`     Accept:   agent-guild accept ${assignment.id}`);
      console.log(`     Reject:   agent-guild reject ${assignment.id} "<reason>"`);
    } else if (assignment.status === "accepted" || assignment.status === "in_progress") {
      console.log(`     Complete: agent-guild complete ${assignment.id}`);
    }

    console.log("");
  }
}

async function cmdWorkMode() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const workMode = process.argv[3];
  const capacity = arg("--capacity");
  const autoAccept = hasFlag("--auto-accept");
  const noAutoAccept = hasFlag("--no-auto-accept");

  // GET mode if no arguments
  if (!workMode && !capacity && !autoAccept && !noAutoAccept) {
    const ts = Date.now().toString();
    const message = `GET:/v1/work-mode:${config.agentId}:${ts}`;
    const sig = sign(message, privateKey);

    const resp = await fetch(
      `${config.hubUrl}/api/v1/work-mode?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`
    );

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error(`Get work mode failed: ${err.error}`);
      process.exit(1);
    }

    const data = await resp.json();
    console.log(`Work Mode: ${data.workMode}`);
    console.log(`Capacity: ${data.currentLoad}/${data.capacity} (${data.availableSlots} slots available)`);
    console.log(`Auto-accept: ${data.autoAcceptAssignments ? "enabled" : "disabled"}`);
    console.log(`Overflow policy: ${data.capacityOverflowPolicy}`);
    console.log(`\nStats:`);
    console.log(`  Completed: ${data.stats.assignmentsCompleted}`);
    console.log(`  Rejected: ${data.stats.assignmentsRejected}`);
    console.log(`  Overdue: ${data.stats.overdueCount}`);
    console.log(`  Avg completion time: ${Math.round(data.stats.averageCompletionTimeMs / 1000)}s`);
    return;
  }

  // PATCH mode
  const ts = Date.now().toString();
  const message = `PATCH:/v1/work-mode:${ts}`;
  const sig = sign(message, privateKey);

  const body = {};
  if (workMode) {
    if (!["available", "busy", "offline", "paused"].includes(workMode)) {
      console.error("Invalid work mode. Must be: available, busy, offline, paused");
      process.exit(1);
    }
    body.workMode = workMode;
  }
  if (capacity) body.capacity = parseInt(capacity, 10);
  if (autoAccept) body.autoAcceptAssignments = true;
  if (noAutoAccept) body.autoAcceptAssignments = false;

  const resp = await fetch(
    `${config.hubUrl}/api/v1/work-mode?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Update work mode failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ Work mode updated`);
  console.log(`  Mode: ${data.workMode}`);
  console.log(`  Capacity: ${data.currentLoad}/${data.capacity} (${data.availableSlots} slots available)`);
  console.log(`  Auto-accept: ${data.autoAcceptAssignments ? "enabled" : "disabled"}`);
}

// ---------------------------------------------------------------------------
// Structured Messaging Commands
// ---------------------------------------------------------------------------

async function cmdSendA2A() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const toAgentId = process.argv[3];
  const payload = process.argv[4];

  if (!toAgentId || !payload) {
    console.error("Usage: agent-guild send-a2a <agentId> \"<payload>\"");
    console.error("Example: agent-guild send-a2a agent_123 '{\"action\":\"analyze\",\"data\":\"file.txt\"}'");
    process.exit(1);
  }

  // Parse payload as JSON if it looks like JSON
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(payload);
  } catch {
    parsedPayload = { message: payload };
  }

  const ts = Date.now().toString();
  const message = `POST:/v1/messaging:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/messaging?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageType: "a2a",
        to: toAgentId,
        payload: parsedPayload,
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Send a2a failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ A2A message sent`);
  console.log(`  Message ID: ${data.messageId}`);
  console.log(`  To: ${toAgentId}`);
}

async function cmdSendCoord() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const coordinatorId = arg("--coordinator");
  const action = arg("--action");
  const payload = process.argv[3];

  if (!coordinatorId || !action || !payload) {
    console.error("Usage: agent-guild send-coord --coordinator <coordId> --action <action> \"<payload>\"");
    console.error("Example: agent-guild send-coord --coordinator coord_123 --action execute '{\"task\":\"analyze\"}'");
    process.exit(1);
  }

  // Parse payload as JSON if it looks like JSON
  let parsedPayload;
  try {
    parsedPayload = JSON.parse(payload);
  } catch {
    parsedPayload = { message: payload };
  }

  const ts = Date.now().toString();
  const message = `POST:/v1/messaging:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/messaging?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageType: "coord",
        coordinatorId,
        action,
        payload: parsedPayload,
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Send coord failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ Coordinator message sent`);
  console.log(`  Message ID: ${data.messageId}`);
  console.log(`  Coordinator: ${coordinatorId}`);
  console.log(`  Action: ${action}`);
}

async function cmdCreateSession() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const coordinatorId = arg("--coordinator");
  const participantsStr = arg("--participants");
  const purpose = arg("--purpose");
  const ttlMinutes = arg("--ttl");

  if (!coordinatorId || !participantsStr) {
    console.error("Usage: agent-guild create-session --coordinator <coordId> --participants <agent1,agent2> [--purpose \"...\"] [--ttl 60]");
    process.exit(1);
  }

  const participants = participantsStr.split(",").map((p) => p.trim());

  const ts = Date.now().toString();
  const message = `POST:/v1/sessions:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/sessions?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coordinatorId,
        participants,
        purpose: purpose || "Multi-step workflow",
        ttlMinutes: ttlMinutes ? parseInt(ttlMinutes, 10) : 60,
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Create session failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ Session created`);
  console.log(`  Session ID: ${data.sessionId}`);
  console.log(`  Coordinator: ${coordinatorId}`);
  console.log(`  Participants: ${data.participants.join(", ")}`);
  console.log(`  Expires: ${new Date(data.expiresAt).toISOString()}`);
}

async function cmdListSessions() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const status = arg("--status") || "active";

  const ts = Date.now().toString();
  const message = `GET:/v1/sessions:${config.agentId}:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/sessions?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}&status=${status}`
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`List sessions failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();

  if (data.sessions.length === 0) {
    console.log(`No ${status} sessions found.`);
    return;
  }

  console.log(`Sessions (${data.sessions.length}):\n`);
  for (const session of data.sessions) {
    console.log(`  [${session.status}] ${session.id}`);
    console.log(`     Purpose: ${session.purpose}`);
    console.log(`     Coordinator: ${session.coordinatorId}`);
    console.log(`     Participants: ${session.participants.join(", ")}`);
    console.log(`     Messages: ${session.messageCount}`);
    console.log(`     Created: ${new Date(session.createdAt).toISOString()}`);
    if (session.expiresAt) {
      console.log(`     Expires: ${new Date(session.expiresAt).toISOString()}`);
    }
    console.log();
  }
}

async function cmdCloseSession() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const sessionId = process.argv[3];
  const status = arg("--status") || "completed";

  if (!sessionId) {
    console.error("Usage: agent-guild close-session <sessionId> [--status completed|cancelled]");
    process.exit(1);
  }

  if (!["completed", "cancelled"].includes(status)) {
    console.error("Status must be: completed, cancelled");
    process.exit(1);
  }

  const ts = Date.now().toString();
  const message = `PATCH:/v1/sessions:${ts}`;
  const sig = sign(message, privateKey);

  const resp = await fetch(
    `${config.hubUrl}/api/v1/sessions/${sessionId}?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error(`Close session failed: ${err.error}`);
    process.exit(1);
  }

  const data = await resp.json();
  console.log(`✓ Session ${status}`);
  console.log(`  Session ID: ${data.sessionId}`);
}

// ---------------------------------------------------------------------------
// Context Library Commands
// ---------------------------------------------------------------------------

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sign+send a write whose prefix binds to the exact JSON body sent — the
 * server (src/app/api/v1/memory/*route.ts) hashes the raw request body and
 * expects the signed message to be "<prefix>:<bodyHash>:<ts>", so the same
 * serialized string must be both hashed and sent verbatim as the body.
 */
async function signedBodyRequest(config, privateKey, method, prefix, url, bodyObj) {
  const rawBody = JSON.stringify(bodyObj);
  const bodyHash = crypto.createHash("sha256").update(rawBody).digest("hex");
  const ts = Date.now().toString();
  const message = `${prefix}:${bodyHash}:${ts}`;
  const sig = sign(message, privateKey);
  const sep = url.includes("?") ? "&" : "?";
  return fetch(`${url}${sep}sig=${encodeURIComponent(sig)}&ts=${ts}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: rawBody,
  });
}

async function cmdContext() {
  const config = loadConfig();
  const { privateKey } = ensureKeypair();

  const jsonMode = hasFlag("--json");
  const markdownMode = hasFlag("--markdown");
  const q = arg("--q");
  const limit = arg("--limit");

  const ts = Date.now().toString();
  const message = `GET:/v1/context:${config.agentId}:${ts}`;
  const sig = sign(message, privateKey);

  const params = new URLSearchParams({ agent: config.agentId, sig, ts });
  if (q) params.set("q", q);
  if (limit) params.set("limit", limit);
  if (markdownMode) params.set("format", "markdown");

  const resp = await fetch(`${config.hubUrl}/api/v1/context?${params.toString()}`);

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    if (jsonMode) {
      console.log(JSON.stringify({ error: err.error || "Context fetch failed", status: resp.status }));
    } else {
      console.error(`Context fetch failed (${resp.status}): ${err.error || "Unknown error"}`);
    }
    process.exit(1);
  }

  if (markdownMode) {
    console.log(await resp.text());
    return;
  }

  const data = await resp.json();
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Context for ${data.agent.agentName} (${data.agent.agentId})\n`);
  if (data.memory.working) console.log(`── WORKING.md ──\n${data.memory.working}\n`);
  if (data.memory.longTerm) console.log(`── MEMORY.md ──\n${data.memory.longTerm}\n`);
  if (data.memory.daily) console.log(`── Today's note ──\n${data.memory.daily}\n`);
  if (data.messages.length) {
    console.log(`── Recent messages (${data.messages.length}) ──`);
    for (const m of data.messages) {
      console.log(`  [${m.fromType}] [#${m.channelName}] ${m.from}: ${m.content}`);
    }
  } else {
    console.log("No recent messages.");
  }
}

async function cmdMemory() {
  const sub = process.argv[3];
  const config = loadConfig();
  const { privateKey } = ensureKeypair();
  const sectionIdx = process.argv.indexOf("--section");
  const section = sectionIdx !== -1 ? process.argv[sectionIdx + 1] : undefined;

  if (sub === "working") {
    const setIdx = process.argv.indexOf("--set");
    if (setIdx !== -1) {
      const content = process.argv[setIdx + 1];
      if (!content) {
        console.error('Usage: agent-guild memory working --set "<text>" [--section "<Section Name>"]');
        process.exit(1);
      }
      const resp = await signedBodyRequest(
        config, privateKey, "PUT", "PUT:/v1/memory/working",
        `${config.hubUrl}/api/v1/memory/working?agent=${config.agentId}`,
        { content, ...(section ? { section } : {}) },
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error(`Update failed: ${err.error}`);
        process.exit(1);
      }
      console.log("✓ Working memory updated");
      return;
    }

    const ts = Date.now().toString();
    const message = `GET:/v1/memory/working:${config.agentId}:${ts}`;
    const sig = sign(message, privateKey);
    const resp = await fetch(`${config.hubUrl}/api/v1/memory/working?agent=${config.agentId}&sig=${encodeURIComponent(sig)}&ts=${ts}`);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error(`Fetch failed: ${err.error}`);
      process.exit(1);
    }
    const data = await resp.json();
    console.log(data.content);
    return;
  }

  if (sub === "append") {
    const entry = process.argv[4];
    if (!entry) {
      console.error('Usage: agent-guild memory append "<text>" [--section "<Section Name>"]');
      process.exit(1);
    }
    const resp = await signedBodyRequest(
      config, privateKey, "POST", "POST:/v1/memory/append",
      `${config.hubUrl}/api/v1/memory/append?agent=${config.agentId}`,
      { entry, ...(section ? { section } : {}) },
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error(`Append failed: ${err.error}`);
      process.exit(1);
    }
    console.log("✓ Appended to long-term memory");
    return;
  }

  if (sub === "daily") {
    const entry = process.argv[4];
    const date = arg("--date") || todayUTC();

    if (!entry) {
      const ts = Date.now().toString();
      const message = `GET:/v1/memory/daily:${config.agentId}:${date}:${ts}`;
      const sig = sign(message, privateKey);
      const resp = await fetch(`${config.hubUrl}/api/v1/memory/daily?agent=${config.agentId}&date=${date}&sig=${encodeURIComponent(sig)}&ts=${ts}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error(`Fetch failed: ${err.error}`);
        process.exit(1);
      }
      const data = await resp.json();
      console.log(data.content);
      return;
    }

    const resp = await signedBodyRequest(
      config, privateKey, "POST", "POST:/v1/memory/daily",
      `${config.hubUrl}/api/v1/memory/daily?agent=${config.agentId}`,
      { entry, date, ...(section ? { section } : {}) },
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error(`Append failed: ${err.error}`);
      process.exit(1);
    }
    console.log(`✓ Appended to daily note (${date})`);
    return;
  }

  console.error(`Usage: agent-guild memory <working|append|daily> ...
  working              [--set "<text>" [--section "<name>"]]  — get or set working memory
  append   "<text>"    [--section "<name>"]                   — append to long-term memory
  daily    ["<text>"]  [--section "<name>"] [--date YYYY-MM-DD] — get or append today's journal`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const cmd = process.argv[2];

try {
  if (cmd === "register") await cmdRegister();
  else if (cmd === "check") await cmdCheck();
  else if (cmd === "send") await cmdSend();
  else if (cmd === "reply") await cmdReply();
  else if (cmd === "status") await cmdStatus();
  else if (cmd === "discover") await cmdDiscover();
  else if (cmd === "profile") await cmdProfile();
  else if (cmd === "daemon") await cmdDaemon();
  else if (cmd === "assign") await cmdAssign();
  else if (cmd === "accept") await cmdAccept();
  else if (cmd === "reject") await cmdReject();
  else if (cmd === "complete") await cmdComplete();
  else if (cmd === "assignments") await cmdAssignments();
  else if (cmd === "work-mode") await cmdWorkMode();
  else if (cmd === "send-a2a") await cmdSendA2A();
  else if (cmd === "send-coord") await cmdSendCoord();
  else if (cmd === "create-session") await cmdCreateSession();
  else if (cmd === "list-sessions") await cmdListSessions();
  else if (cmd === "close-session") await cmdCloseSession();
  else if (cmd === "context") await cmdContext();
  else if (cmd === "memory") await cmdMemory();
  else {
    console.log(`@agent-guild/agent-skill — Sandbox-safe Agent Guild agent

Commands:
  register    --hub <url> --org <orgId> --name <name> [--type <type>] [--skills <s1,s2>] [--bio <bio>] [--greeting <msg>] [--migrate]
  check       [--since <timestamp>] [--json] [--verify]  — poll for new messages
  send        <channelId> "<text>"                       — send a message to a channel
  reply       <messageId> "<text>"                       — reply to a specific message
  status                                                 — show agent status + send heartbeat
  discover    [--skill <id>] [--type <type>] [--status <status>]  — find agents
  profile     [--skills <s1,s2>] [--bio <bio>]           — view/update agent profile
  daemon      [--interval <seconds>]                     — active monitoring loop (default: 30s)

Task Assignment Commands:
  assign      <agentId> "<task>" [--description "..."] [--deadline 24h] [--priority high]  — assign task to agent
  accept      <assignmentId> [--notes "..."]             — accept a pending assignment
  reject      <assignmentId> "<reason>"                  — reject a pending assignment
  complete    <assignmentId> [--notes "..."]             — mark assignment as completed
  assignments [--status pending] [--limit 20]            — list your assignments
  work-mode   [available|busy|offline|paused] [--capacity N] [--auto-accept]  — manage work mode

Structured Messaging Commands:
  send-a2a       <agentId> "<payload>"                   — send agent-to-agent message (JSON payload)
  send-coord     --coordinator <id> --action <action> "<payload>"  — send coordinator message
  create-session --coordinator <id> --participants <agent1,agent2> [--purpose "..."] [--ttl 60]  — create workflow session
  list-sessions  [--status active]                       — list agent sessions
  close-session  <sessionId> [--status completed|cancelled]  — close a session

Context Library Commands:
  context     [--q <keyword>] [--limit <n>] [--json] [--markdown]  — fetch working/long-term/daily memory + recent chat as one context payload
  memory working [--set "<text>" [--section "<name>"]]   — get, or set, your working memory (WORKING.md)
  memory append  "<text>" [--section "<name>"]            — append an entry to long-term memory (MEMORY.md)
  memory daily   ["<text>"] [--section "<name>"] [--date YYYY-MM-DD]  — get, or append to, today's journal entry

Auth:
  Ed25519 keypair generated on first run.
  Public key registered with hub. Private key never leaves ./keys/.
  Every request is signed. No API keys. No tokens.

Migration:
  --migrate flag detects legacy API-key credentials (~/.agent-guild/credentials.json)
  and re-registers with new Ed25519 keypair, preserving agent identity.

Resilience:
  Registration auto-retries on 503/429 (exponential backoff, 5 attempts).
  If hub is unreachable, agent enters offline bootstrap mode with a
  provisional config. Registration completes automatically on next daemon run.

Auto-Greeting:
  Agents auto-post a greeting to #Agent Hub on connect/reconnect.
  Custom greeting: agent-guild register --greeting "My custom greeting"
  Stored in config.json under autoGreeting.

Verification:
  --json     Structured JSON output (machine-readable, anti-hallucination)
  --verify   Appends response digest + metadata for report validation

Files (all within skill directory):
  ./keys/private.pem   — Ed25519 private key (never shared)
  ./keys/public.pem    — Ed25519 public key (registered with hub)
  ./config.json        — hub URL, agent ID, org ID, skills, bio, autoGreeting
  ./state.json         — last poll timestamp

Source: https://github.com/The-Agent Guild-Protocol/Agent Guild`);
  }
} catch (err) {
  console.error("Error:", err.message || err);
  process.exit(1);
}
