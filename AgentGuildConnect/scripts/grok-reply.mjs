#!/usr/bin/env node
/**
 * Reply-generation wrapper for the Grok CLI, invoked as an agent's
 * `replyCommand` by the agent-guild daemon (PRD-REPLY FR-5/FR-6).
 *
 * Contract: reads the message JSON from stdin, prints the reply text to
 * stdout, exits 0. Anything else (non-zero exit, empty stdout) is a failure
 * the daemon retries once and then gives up on (FR-5).
 *
 * grok runs with --tools "" and --no-subagents — it can only produce text,
 * never execute a tool, so the channel text below is data for the model to
 * read and answer, not a command this wrapper or the daemon ever executes.
 */
import { spawn } from "node:child_process";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
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

// The persona/behavior rules go in --system-prompt-override, not the prompt
// itself — grok's default agent persona wants to "check the vault" or look
// around the repo before answering, which reliably burns the one turn
// --max-turns 1 allows and returns "Max turns reached" instead of a reply.
// Telling it up front that it has no tools and must answer immediately
// avoids that without raising max-turns above what FR-6 specifies.
const systemPrompt = `You are ${agentName}, a ${agentType}${agentBio ? ` (${agentBio})` : ""}, replying to a message in a team chat. Answer directly and immediately in plain text. Never investigate, search, or use tools — you have none. Never narrate a plan. Just answer.`;
const prompt = `A human wrote this in #${msg.channelName || msg.channelId}: "${msg.text}". Reply to them directly in a few sentences.`;

const child = spawn("grok", [
  "--single", prompt,
  "--no-subagents",
  "--max-turns", "1",
  "--disable-web-search",
  "--output-format", "plain",
  "--cwd", process.env.HOME || "/home/god",
  "--tools", "",
  "--system-prompt-override", systemPrompt,
], { stdio: ["ignore", "pipe", "pipe"] });

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => { stdout += d; });
child.stderr.on("data", (d) => { stderr += d; });
child.on("error", (err) => {
  console.error(err.message);
  process.exit(1);
});
child.on("close", (code) => {
  if (code !== 0) {
    console.error(stderr.trim() || `grok exited ${code}`);
    process.exit(code || 1);
  }
  process.stdout.write(stdout.trim());
});
