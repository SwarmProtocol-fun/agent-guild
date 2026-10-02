#!/usr/bin/env node
/**
 * Reply-generation wrapper for the Grok CLI, invoked as an agent's
 * `replyCommand` by the agent-guild daemon.
 *
 * Contract: reads the message JSON from stdin, prints the reply text to
 * stdout, exits 0. Anything else (non-zero exit, empty stdout) is a failure
 * the daemon retries once and then gives up on.
 *
 * The daemon tells this wrapper which channel kind it's answering for via
 * AGENT_GUILD_CHANNEL_KIND (a trusted, locally-derived value — not something
 * a channel message could ever set). The two kinds run completely separately:
 *
 *   - Agent Hub ("hub"): sandboxed. --tools "", --no-subagents, single-turn,
 *     no session, no vault. The daemon only calls this wrapper for a Hub
 *     message when the text actually named the agent.
 *   - The agent's own DM ("dm"): the builder belt. A lasting session on its
 *     own --leader-socket, tools on, --always-approve, and this agent's
 *     context vault. A DM instruction can be carried out, not just described.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BELT_SOURCE = join(HERE, "..", "BELT.md");
const HOME = process.env.HOME || "/home/god";
const REX_VAULT = join(HOME, "context-vault");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function readClip(path, max) {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > max ? `${text.slice(0, max)}\n…` : text;
  } catch {
    return "";
  }
}

// The session log grows all day; the next turn needs the latest turns, not
// the first ones.
function readTail(path, max) {
  try {
    const text = readFileSync(path, "utf8").trim();
    return text.length > max ? `…\n${text.slice(-max)}` : text;
  } catch {
    return "";
  }
}

function ensureVault(dir, agentName, agentType, agentBio) {
  mkdirSync(join(dir, "projects"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  const belt = existsSync(BELT_SOURCE)
    ? readFileSync(BELT_SOURCE, "utf8")
    : "# Builder belt\n\nRead INDEX.md and GLOBAL.md in this folder. Rex's vault is /home/god/context-vault/.\n";
  writeFileSync(join(dir, "BELT.md"), belt);
  if (!existsSync(join(dir, "INDEX.md"))) {
    writeFileSync(join(dir, "INDEX.md"), [
      `# ${agentName} vault`,
      "",
      "1. `BELT.md` — builder belt",
      "2. `GLOBAL.md` — who you are",
      "3. `projects/` — one file per job",
      "4. `sessions/` — private DM log",
      "",
      `Rex continuity vault (read it and answer with the real data): ${REX_VAULT}`,
      "",
    ].join("\n"));
  }
  if (!existsSync(join(dir, "GLOBAL.md"))) {
    writeFileSync(join(dir, "GLOBAL.md"), [
      `# ${agentName}`,
      "",
      `${agentType}${agentBio ? `. ${agentBio}` : ""}.`,
      "",
      "Private DMs are the workbench (this belt). #Agent Hub is chat only.",
      "",
    ].join("\n"));
  }
}

function vaultBrief(dir) {
  const day = new Date().toISOString().slice(0, 10);
  const tail = readTail(join(dir, "sessions", `${day}.md`), 12000);
  return [
    `Your vault: ${dir}`,
    `Belt: ${join(dir, "BELT.md")}`,
    `Rex vault: ${REX_VAULT}`,
    "",
    readClip(join(REX_VAULT, "GLOBAL.md"), 4000),
    "",
    readClip(join(REX_VAULT, "INDEX.md"), 12000),
    "",
    readClip(join(dir, "GLOBAL.md"), 2000),
    tail ? `\nToday so far:\n${tail}` : "",
  ].filter(Boolean).join("\n");
}

function logTurn(dir, agentName, msg, reply) {
  const day = new Date().toISOString().slice(0, 10);
  const log = join(dir, "sessions", `${day}.md`);
  if (!existsSync(log)) writeFileSync(log, `# ${day}\n`);
  const stamp = new Date().toISOString();
  // Whole turn, whitespace intact — the next turn should see exactly what
  // changed (paths, commands, diffs), not a 600-character one-liner.
  const said = String(msg.text || "").trim();
  const answered = String(reply || "").trim();
  appendFileSync(log, `\n## ${stamp}\n**${msg.from}:**\n\n${said}\n\n**${agentName}:**\n\n${answered}\n`);
}

const raw = await readStdin();
let msg;
try {
  msg = JSON.parse(raw);
} catch {
  console.error("grok-reply: invalid JSON on stdin");
  process.exit(1);
}

const agentName = process.env.AGENT_GUILD_AGENT_NAME || "the agent";
const agentType = process.env.AGENT_GUILD_AGENT_TYPE || "assistant";
const agentBio = process.env.AGENT_GUILD_AGENT_BIO || "";
const agentId = process.env.AGENT_GUILD_AGENT_ID || "";
const isDm = process.env.AGENT_GUILD_CHANNEL_KIND === "dm";

const history = Array.isArray(msg.history) ? msg.history : [];
const transcript = history
  .map((h) => `${h.fromType === "agent" ? agentName : h.from}: ${h.text}`)
  .join("\n");
const prompt = transcript
  ? `Recent messages in #${msg.channelName || msg.channelId}:\n${transcript}\n\n${msg.from} just wrote: "${msg.text}"\nAnswer in full. If the facts are in the vault or on disk, open them and use the real data. Do not hold back.`
  : `A human wrote this in #${msg.channelName || msg.channelId}: "${msg.text}". Answer in full. If the facts are in the vault or on disk, open them and use the real data. Do not hold back.`;

let systemPrompt;
const grokArgs = ["--single", prompt, "--output-format", "plain"];

if (isDm) {
  const vaultDir = join(HOME, ".agent-guild", agentId || "unknown", "vault");
  ensureVault(vaultDir, agentName, agentType, agentBio);
  systemPrompt = [
    `You are ${agentName}, a ${agentType}${agentBio ? ` (${agentBio})` : ""}, in a private DM on Agent Guild. This channel is full power.`,
    "You have the builder belt: shell, files, web, and both vaults. The belt file is named in the brief below. Rex's map is in that brief.",
    "Answer with the actual facts, dates, numbers, names, and file contents. When the message touches a project, a person, a case, or a past decision, open the matching file and use it. Do not give a one-line brush-off. Do not say you cannot see something you can open. Do not leave out data you already have.",
    "Do the work he asks for, then say what you found or what changed.",
    "Never read or quote signing keys, private.pem, or credentials.json.",
    "",
    vaultBrief(vaultDir),
  ].join("\n");

  const agentSlug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const sessionDir = join(HOME, ".agent-guild", "grok-sessions", agentSlug);
  mkdirSync(sessionDir, { recursive: true });
  grokArgs.push(
    "--continue",
    "--cwd", sessionDir,
    "--leader-socket", join(HOME, ".grok", `leader-${agentSlug}.sock`),
    "--max-turns", "24",
    "--always-approve",
    "--permission-mode", "bypassPermissions",
    "--no-plan",
    "--deny", `Read(${HOME}/.agent-guild/**/keys/**)`,
    "--deny", `Read(${HOME}/.agent-guild/**/private.pem)`,
    "--deny", `Read(${HOME}/.agent-guild/**/credentials.json)`,
    "--system-prompt-override", systemPrompt,
  );
} else {
  systemPrompt = `You are ${agentName}, a ${agentType}${agentBio ? ` (${agentBio})` : ""}, replying to a message in a shared team channel. Answer directly and immediately in plain text. Never investigate, search, or use tools — you have none. Never narrate a plan. Just answer.`;
  grokArgs.push(
    "--system-prompt-override", systemPrompt,
    "--no-subagents",
    "--max-turns", "1",
    "--disable-web-search",
    "--cwd", HOME,
    "--tools", "",
  );
}

function runGrok(args) {
  return new Promise((resolve) => {
    const child = spawn("grok", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => resolve({ code: 1, stdout: "", stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

let result = await runGrok(grokArgs);

// --continue only resumes an existing session for that --cwd. The first DM
// has none yet, so start one. Later replies continue it.
if (isDm && result.code !== 0 && /no session found/i.test(result.stderr)) {
  result = await runGrok(grokArgs.filter((a) => a !== "--continue"));
}

if (result.code !== 0) {
  console.error(result.stderr.trim() || `grok exited ${result.code}`);
  process.exit(result.code || 1);
}

const reply = result.stdout.trim();
if (isDm && agentId) {
  try {
    logTurn(join(HOME, ".agent-guild", agentId, "vault"), agentName, msg, reply);
  } catch (err) {
    console.error(`vault log: ${err.message}`);
  }
}
process.stdout.write(reply);
