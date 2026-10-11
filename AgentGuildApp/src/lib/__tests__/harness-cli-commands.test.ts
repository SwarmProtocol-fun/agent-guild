/**
 * The harness tells agents to run `agent-guild <command>`. Every command it
 * names must exist in the CLI — both the Connect source and the copy served
 * at https://agent-guild.com/agent-guild.mjs, which is what a fresh agent
 * downloads. Each CLI copy runs from a scratch directory with an empty HOME,
 * so no identity is found and nothing reaches a hub.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..", "..", "..");
const CONNECT_SCRIPTS = join(APP, "..", "AgentGuildConnect", "scripts");

/** Files whose text reaches an agent: the harness, agent docs, and mod prompts. */
const HARNESS_SOURCES = [
  "src/lib/harness-benefits.ts",
  "src/lib/harness.ts",
  "src/lib/agent-registration-grants.ts",
  "public/skill.md",
  "public/llms.txt",
  "mods/hyperliquid-trading/server.ts",
  "mods/polymarket-trading/server.ts",
  "mods/polymarket-trading/agent-prompt.ts",
  "mods/dimos-bench/server.ts",
];

function advertised(): { file: string; command: string; sub?: string }[] {
  const out: { file: string; command: string; sub?: string }[] = [];
  for (const file of HARNESS_SOURCES) {
    const text = readFileSync(join(APP, file), "utf8");
    for (const m of text.matchAll(/\bagent-guild ([a-z][a-z0-9-]*)(?: ([a-z][a-z0-9-]*))?/g)) {
      out.push({ file, command: m[1], sub: m[2] });
    }
  }
  return out;
}

const COPIES = {
  source: [CONNECT_SCRIPTS, ["agent-guild.mjs", "mod-tools.mjs", "hl-mode.mjs", "identity-vault-crypto.mjs", "solana-escrow.mjs", "agent-guild-idl.json"]],
  published: [join(APP, "public"), ["agent-guild.mjs"]],
} as const;

// No AGENT_GUILD_TOKEN/HUB: `call` and `bindings` would otherwise go keyless to a real hub.
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENT_GUILD_"))),
  HOME: join(root, "home"),
});

let root: string;
const cli: Record<string, string> = {};

beforeAll(() => {
  // Inside AgentGuildConnect/node_modules so the source copy still resolves its npm imports.
  const base = join(CONNECT_SCRIPTS, "..", "node_modules", ".tmp");
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "harness-cli-"));
  for (const [name, [from, files]] of Object.entries(COPIES)) {
    const dir = join(root, name, "scripts");
    mkdirSync(dir, { recursive: true });
    for (const f of files) copyFileSync(join(from, f), join(dir, f));
    cli[name] = join(dir, "agent-guild.mjs");
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(file: string, args: string[]) {
  const r = spawnSync(process.execPath, [file, ...args], {
    env: cleanEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
    encoding: "utf8",
  });
  return `${r.stdout}\n${r.stderr}`;
}

describe("harness ⊆ CLI", () => {
  it("finds the commands the harness advertises", () => {
    const names = new Set(advertised().map((a) => a.command));
    for (const c of ["capabilities", "mod", "claim", "evolve"]) expect(names).toContain(c);
  });

  for (const copy of Object.keys(COPIES)) {
    it(`${copy} CLI runs every advertised command`, () => {
      const missing: string[] = [];
      for (const command of new Set(advertised().map((a) => a.command))) {
        const out = run(cli[copy], [command]);
        // A missing command is "Unknown command: x" — or, in old builds, the whole help text.
        if (out.includes(`Unknown command: ${command}`) || out.includes("\nCommands:\n")) missing.push(command);
      }
      expect(missing, `${copy} CLI lacks commands the harness advertises`).toEqual([]);
    });
  }

  it("source CLI has every advertised subcommand", () => {
    const { subcommands } = JSON.parse(execFileSync(process.execPath, [cli.source, "commands", "--json"], {
      env: cleanEnv(),
      encoding: "utf8",
    })) as { subcommands: Record<string, string[]> };
    const missing = advertised()
      .filter((a) => a.sub && subcommands[a.command] && !subcommands[a.command].includes(a.sub))
      .map((a) => `${a.command} ${a.sub} (${a.file})`);
    expect(missing).toEqual([]);
  });
});
