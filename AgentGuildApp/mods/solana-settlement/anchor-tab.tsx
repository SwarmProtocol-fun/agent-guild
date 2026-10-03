"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, CopyButton, ErrorNote, Row, Section, buttonClass, inputClass, mono, muted, type Env, type Seed } from "./ui";

// Anchor sandbox: send a workspace to a GatewayAgent worker to build, test
// or deploy (POST /dev/anchor — the same route the agent's
// solana_anchor_job tool calls), then follow the job.

type Files = Record<string, string>;

interface JobResult {
  action: string;
  anchorVersion: string;
  success: boolean;
  programs: { name: string; programId: string; soBytes: number | null }[];
  idls: Record<string, unknown>;
  deploy?: { cluster: string; programIds: string[]; signatures: string[] };
  logTail: string;
}

interface Job {
  taskId: string;
  status: string;
  action?: string;
  result: { data?: JobResult; exitCode?: number } | JobResult | null;
  error: string | null;
}

const TERMINAL = new Set(["completed", "failed", "timeout", "cancelled"]);
const SKIP_DIRS = /(^|\/)(target|node_modules|\.git|\.anchor|test-ledger)(\/|$)/;
const MAX_BYTES = 512 * 1024;

/** A minimal Anchor 0.31 workspace: a PDA counter with a test. keys sync rewrites the placeholder ids. */
export function starterProject(): Files {
  const placeholder = "11111111111111111111111111111111";
  return {
    "Anchor.toml": `[toolchain]

[features]
resolution = true
skip-lint = false

[programs.localnet]
counter = "${placeholder}"

[programs.devnet]
counter = "${placeholder}"

[provider]
cluster = "localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
`,
    "Cargo.toml": `[workspace]
members = ["programs/*"]
resolver = "2"

[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1

[profile.release.build-override]
opt-level = 3
incremental = false
codegen-units = 1
`,
    "programs/counter/Cargo.toml": `[package]
name = "counter"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "lib"]
name = "counter"

[features]
default = []
cpi = ["no-entrypoint"]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
idl-build = ["anchor-lang/idl-build"]

[dependencies]
anchor-lang = "0.31.1"
`,
    "programs/counter/src/lib.rs": `use anchor_lang::prelude::*;

declare_id!("${placeholder}");

#[program]
pub mod counter {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.authority = ctx.accounts.authority.key();
        counter.count = 0;
        Ok(())
    }

    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        let counter = &mut ctx.accounts.counter;
        counter.count = counter.count.checked_add(1).ok_or(CounterError::Overflow)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Counter::INIT_SPACE, seeds = [b"counter", authority.key().as_ref()], bump)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Increment<'info> {
    #[account(mut, seeds = [b"counter", authority.key().as_ref()], bump, has_one = authority)]
    pub counter: Account<'info, Counter>,
    pub authority: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub authority: Pubkey,
    pub count: u64,
}

#[error_code]
pub enum CounterError {
    #[msg("Counter overflowed")]
    Overflow,
}
`,
    "package.json": JSON.stringify({
      license: "ISC",
      dependencies: { "@coral-xyz/anchor": "^0.31.1" },
      devDependencies: {
        chai: "^4.3.4", mocha: "^9.0.3", "ts-mocha": "^10.0.0", typescript: "^5.7.3",
        "@types/bn.js": "^5.1.0", "@types/chai": "^4.3.0", "@types/mocha": "^9.0.0",
      },
    }, null, 2),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { types: ["mocha", "chai"], typeRoots: ["./node_modules/@types"], lib: ["es2015"], module: "commonjs", target: "es6", esModuleInterop: true },
    }, null, 2),
    "tests/counter.ts": `import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Counter } from "../target/types/counter";
import { assert } from "chai";

describe("counter", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Counter as Program<Counter>;
  const authority = provider.wallet.publicKey;
  const [counter] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), authority.toBuffer()],
    program.programId,
  );

  it("initializes and increments", async () => {
    await program.methods.initialize().accountsPartial({ authority }).rpc();
    await program.methods.increment().accountsPartial({ authority }).rpc();
    const account = await program.account.counter.fetch(counter);
    assert.equal(account.count.toNumber(), 1);
  });
});
`,
  };
}

/** Folder upload → project map, rooted at the folder that holds Anchor.toml. */
async function readFolder(list: FileList): Promise<Files> {
  const all = Array.from(list);
  const anchorToml = all.find((f) => f.webkitRelativePath.endsWith("Anchor.toml") && f.webkitRelativePath.split("/").length <= 2);
  if (!anchorToml) throw new Error("Pick the workspace folder — the one containing Anchor.toml");
  const root = anchorToml.webkitRelativePath.slice(0, -"Anchor.toml".length);
  const files: Files = {};
  let total = 0;
  for (const f of all) {
    const rel = f.webkitRelativePath.slice(root.length);
    if (!f.webkitRelativePath.startsWith(root) || SKIP_DIRS.test(rel) || f.size > 200_000) continue;
    if (!/\.(rs|toml|ts|js|json|lock|md)$/.test(rel) && !rel.endsWith("Xargo.toml")) continue;
    total += f.size;
    if (total > MAX_BYTES) throw new Error(`Project source is over ${MAX_BYTES / 1024} KB — trim it (target/ and node_modules/ are already skipped)`);
    files[rel] = await f.text();
  }
  return files;
}

function jobData(job: Job): JobResult | null {
  const r = job.result as { data?: JobResult } | JobResult | null;
  if (!r) return null;
  return "data" in r && r.data ? r.data : (r as JobResult);
}

export function AnchorTab({ env, seed }: { env: Env; seed?: Seed }) {
  const [files, setFiles] = useState<Files | null>(null);
  const [version, setVersion] = useState("0.31.1");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);

  const caps = env.agent?.capabilities ?? {};
  const canBuild = !!caps["solana-dev-anchor"];
  const canDeploy = canBuild && !!caps["solana-dev-devnet"] && !!env.agent?.devWallet;

  // Jobs opened from elsewhere (an activity entry) arrive as a seed.
  useEffect(() => {
    const taskId = seed?.value;
    if (!taskId) return;
    setJobs((js) => (js.some((j) => j.taskId === taskId) ? js : [{ taskId, status: "loading", result: null, error: null }, ...js]));
  }, [seed?.nonce, seed?.value]);

  // Poll unfinished jobs.
  const { agentApi } = env;
  const pending = jobs.filter((j) => !TERMINAL.has(j.status)).map((j) => j.taskId).join(",");
  useEffect(() => {
    if (!pending) return;
    const poll = async () => {
      for (const taskId of pending.split(",")) {
        try {
          const res = await agentApi(`dev/anchor/${taskId}`);
          const data = await res.json();
          setJobs((js) => js.map((j) => (j.taskId === taskId ? (res.ok ? data : { ...j, status: "failed", error: data.error }) : j)));
        } catch { /* transient — next tick */ }
      }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [pending, agentApi]);

  async function submit(action: "build" | "test" | "deploy") {
    if (!files) return;
    setBusy(true);
    setSubmitError(null);
    setWarning(null);
    try {
      const res = await env.agentApi("dev/anchor", {
        method: "POST",
        body: JSON.stringify({ action, files, anchorVersion: version, ...(action === "deploy" ? { cluster: env.cluster === "testnet" ? "testnet" : "devnet" } : {}) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.warning) setWarning(data.warning);
      setJobs((js) => [{ taskId: data.taskId, status: "queued", action, result: null, error: null }, ...js]);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!env.agent) return <ErrorNote message="Pick an agent in the header — Anchor jobs run as that agent." />;

  return (
    <div className="space-y-3">
      <Section title="Anchor workspace" description="Runs in a throwaway solanafoundation/anchor container on a GatewayAgent worker. declare_id! is synced to the generated program keypair automatically.">
        {!canBuild && <ErrorNote message={`${env.agent.name} doesn't have the "Write Anchor programs" upgrade — enable it on the Agent tab.`} />}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass()} onClick={() => { setFiles(starterProject()); setVersion("0.31.1"); setLoadError(null); }}>Load starter (counter)</button>
          <button type="button" className={buttonClass()} onClick={() => folderInput.current?.click()}>Upload workspace folder…</button>
          <input ref={folderInput} type="file" className="hidden" multiple
            {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
            onChange={async (e) => {
              setLoadError(null);
              try { if (e.target.files) setFiles(await readFolder(e.target.files)); } catch (err) { setLoadError((err as Error).message); }
              e.target.value = "";
            }} />
          <select className={inputClass} value={version} onChange={(e) => setVersion(e.target.value)} aria-label="Anchor version">
            {["0.31.1", "1.0.2"].map((v) => <option key={v} value={v}>anchor {v}</option>)}
          </select>
        </div>
        {loadError && <ErrorNote message={loadError} />}
        {files && (
          <>
            <div className={`text-xs ${muted}`}>
              {Object.keys(files).length} files · {(Object.values(files).reduce((n, c) => n + c.length, 0) / 1024).toFixed(1)} KB
              <details className="mt-1">
                <summary className="cursor-pointer">files</summary>
                <ul className="font-mono mt-1">{Object.keys(files).sort().map((p) => <li key={p}>{p}</li>)}</ul>
              </details>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass(true)} disabled={!canBuild || busy} onClick={() => submit("build")}>Build</button>
              <button type="button" className={buttonClass()} disabled={!canBuild || busy} onClick={() => submit("test")}>Test</button>
              <button type="button" className={buttonClass()} disabled={!canDeploy || busy} onClick={() => submit("deploy")}
                title={canDeploy ? undefined : "Needs the devnet upgrade and a funded dev wallet"}>
                Deploy to {env.cluster === "testnet" ? "testnet" : "devnet"}
              </button>
            </div>
          </>
        )}
        {submitError && <ErrorNote message={submitError} />}
        {warning && <div className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">{warning}</div>}
      </Section>

      {jobs.map((job) => {
        const data = jobData(job);
        const done = TERMINAL.has(job.status);
        const ok = done && job.status === "completed" && data?.success;
        return (
          <Section key={job.taskId} title={`${job.action ?? data?.action ?? "anchor"} job`}
            right={<Badge tone={!done ? "warning" : ok ? "success" : "danger"}>{done && data ? (data.success ? job.status : "failed") : job.status}</Badge>}>
            <Row label="Task">{<span className={mono}>{job.taskId}</span>}</Row>
            {job.error && <ErrorNote message={job.error} />}
            {data?.programs?.map((p) => (
              <Row key={p.name} label={p.name}>
                <span className={mono}>{p.programId}</span> <CopyButton text={p.programId} />
                {p.soBytes != null && <span className={`text-xs ${muted}`}> · {(p.soBytes / 1024).toFixed(1)} KB .so</span>}
                {data.deploy?.programIds.includes(p.programId) && (
                  <button type="button" className="ml-2 text-xs text-blue-600 dark:text-blue-400 hover:underline" onClick={() => env.go("account", p.programId)}>open deployed program</button>
                )}
              </Row>
            ))}
            {data?.deploy?.signatures.map((s) => (
              <Row key={s} label="Deploy tx"><button type="button" className={`${mono} text-blue-600 dark:text-blue-400 hover:underline text-left`} onClick={() => env.go("tx", s)}>{s.slice(0, 24)}…</button></Row>
            ))}
            {data && Object.entries(data.idls ?? {}).map(([name, idl]) => (
              <Row key={name} label={`IDL · ${name}`}>
                <CopyButton text={JSON.stringify(idl, null, 2)} label="copy JSON" />
              </Row>
            ))}
            {data?.logTail && (
              <pre className="max-h-72 overflow-auto rounded-md bg-[hsl(var(--muted))] p-2 text-xs leading-relaxed">
                {data.logTail.split("\n").map((l, i) => <div key={i} className={/^error|error\[|FAILED|failing/.test(l) ? "text-red-600 dark:text-red-400" : ""}>{l}</div>)}
              </pre>
            )}
          </Section>
        );
      })}
    </div>
  );
}
