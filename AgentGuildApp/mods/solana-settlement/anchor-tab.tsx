"use client";

import { useEffect, useRef, useState } from "react";
import { CircleCheck, CircleX, FlaskConical, FolderOpen, FolderUp, Hammer, LoaderCircle, Rocket, Sparkles } from "lucide-react";
import {
  Addr, Badge, Button, Card, CodeBlock, CopyButton, EmptyState, ErrorNote, Notice, PageHeader, Row, Select,
  cx, linkClass, muted, shortAddr, type Env, type Seed,
} from "./ui";

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

  const header = (
    <PageHeader icon={Hammer} title="Anchor programs"
      description="Build, test and deploy an Anchor workspace in a throwaway container on a GatewayAgent worker — the same job the agent's solana_anchor_job tool runs." />
  );

  if (!env.agent) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={Hammer} title="Pick an agent to run Anchor jobs">Jobs run as the agent (and deploys sign with its dev wallet), so choose one in the sidebar.</EmptyState>
      </div>
    );
  }

  const fileCount = files ? Object.keys(files).length : 0;
  const kb = files ? Object.values(files).reduce((n, c) => n + c.length, 0) / 1024 : 0;
  const deployTarget = env.cluster === "testnet" ? "testnet" : "devnet";

  return (
    <div className="space-y-4">
      {header}
      {!canBuild && (
        <Notice tone="warning" title={`${env.agent.name} doesn't have the “Write Anchor programs” upgrade`}>Enable it on the Overview page, then come back.</Notice>
      )}

      <Card title="Workspace" description="declare_id! is rewritten to the generated program keypair automatically."
        actions={
          <Select value={version} onChange={(e) => setVersion(e.target.value)} aria-label="Anchor version">
            {["0.31.1", "1.0.2"].map((v) => <option key={v} value={v}>Anchor {v}</option>)}
          </Select>
        }>
        {!files ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <button type="button" onClick={() => { setFiles(starterProject()); setVersion("0.31.1"); setLoadError(null); }}
              className="flex flex-col items-start gap-1 rounded-lg border border-[hsl(var(--border))] p-4 text-left transition-colors hover:border-[hsl(var(--primary))]/50 hover:bg-[hsl(var(--primary))]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]">
              <Sparkles className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden />
              <span className="text-sm font-medium">Start from the counter example</span>
              <span className={cx("text-xs", muted)}>A PDA counter with initialize/increment and a passing test.</span>
            </button>
            <button type="button" onClick={() => folderInput.current?.click()}
              className="flex flex-col items-start gap-1 rounded-lg border border-dashed border-[hsl(var(--border))] p-4 text-left transition-colors hover:border-[hsl(var(--primary))]/50 hover:bg-[hsl(var(--primary))]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]">
              <FolderUp className="h-5 w-5 text-[hsl(var(--primary))]" aria-hidden />
              <span className="text-sm font-medium">Upload a workspace folder</span>
              <span className={cx("text-xs", muted)}>The folder with Anchor.toml. target/ and node_modules/ are skipped.</span>
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <FolderOpen className="h-4 w-4 text-[hsl(var(--primary))]" aria-hidden />
                <span className="font-medium">{fileCount} files</span>
                <span className={cx("text-xs", muted)}>{kb.toFixed(1)} KB</span>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" className="h-8" onClick={() => folderInput.current?.click()}>Replace</Button>
                <Button variant="ghost" className="h-8" onClick={() => setFiles(null)}>Clear</Button>
              </div>
            </div>
            <details className="group">
              <summary className={cx("cursor-pointer text-xs", muted)}>Show files</summary>
              <ul className="mt-2 columns-1 gap-4 font-mono text-xs sm:columns-2">{Object.keys(files).sort().map((p) => <li key={p} className="truncate">{p}</li>)}</ul>
            </details>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" icon={Hammer} disabled={!canBuild} loading={busy} onClick={() => submit("build")}>Build</Button>
              <Button icon={FlaskConical} disabled={!canBuild} loading={busy} onClick={() => submit("test")}>Test</Button>
              <Button icon={Rocket} disabled={!canDeploy} loading={busy} onClick={() => submit("deploy")}
                title={canDeploy ? undefined : "Needs the devnet upgrade and a funded dev wallet"}>Deploy to {deployTarget}</Button>
            </div>
            {!canDeploy && canBuild && <p className={cx("text-xs", muted)}>Deploying needs the “Act on devnet” upgrade and a dev wallet with ~2–5 SOL.</p>}
          </div>
        )}
        <input ref={folderInput} type="file" className="hidden" multiple aria-hidden tabIndex={-1}
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={async (e) => {
            setLoadError(null);
            try { if (e.target.files) setFiles(await readFolder(e.target.files)); } catch (err) { setLoadError((err as Error).message); }
            e.target.value = "";
          }} />
        {loadError && <div className="mt-3"><ErrorNote message={loadError} /></div>}
        {submitError && <div className="mt-3"><ErrorNote message={submitError} /></div>}
        {warning && <div className="mt-3"><Notice tone="warning" title="Queued, but no worker is online">{warning}</Notice></div>}
      </Card>

      {jobs.length > 0 && <h3 className={cx("pt-2 text-[11px] font-semibold uppercase tracking-wider", muted)}>Jobs</h3>}
      {jobs.map((job) => {
        const data = jobData(job);
        const done = TERMINAL.has(job.status);
        const ok = done && job.status === "completed" && !!data?.success;
        const label = !done ? (job.status === "queued" ? "Queued" : job.status === "loading" ? "Loading" : "Running") : ok ? "Succeeded" : "Failed";
        return (
          <Card key={job.taskId}
            title={<span className="flex items-center gap-2">
              {!done ? <LoaderCircle className="h-4 w-4 animate-spin text-[hsl(var(--primary))] motion-reduce:animate-none" aria-hidden />
                : ok ? <CircleCheck className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden /> : <CircleX className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden />}
              <span className="capitalize">{job.action ?? data?.action ?? "Anchor"}</span> · {label}
            </span>}
            description={<span className="font-mono">{job.taskId}</span>}
            actions={data?.anchorVersion && <Badge>Anchor {data.anchorVersion}</Badge>}>
            <div className="space-y-3">
              {job.error && <ErrorNote message={job.error} />}
              {!done && <p className={cx("text-xs", muted)}>{job.status === "queued" ? "Waiting for a GatewayAgent worker with the solana-anchor runtime…" : "Compiling — a first build downloads crates and can take several minutes."}</p>}
              {data?.programs?.map((p) => (
                <div key={p.name} className="flex flex-wrap items-center gap-2 rounded-lg border border-[hsl(var(--border))] px-3 py-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  <Addr value={p.programId} env={env} />
                  {p.soBytes != null && <Badge>{(p.soBytes / 1024).toFixed(1)} KB .so</Badge>}
                  {data.deploy?.programIds.includes(p.programId) && <Badge tone="success" dot>Deployed</Badge>}
                </div>
              ))}
              {data?.deploy?.signatures.map((sig) => (
                <Row key={sig} label="Deploy transaction"><button type="button" className={cx("font-mono text-xs", linkClass)} onClick={() => env.go("tx", sig)}>{shortAddr(sig, 10)}</button></Row>
              ))}
              {data && Object.keys(data.idls ?? {}).length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cx("text-xs", muted)}>IDL</span>
                  {Object.entries(data.idls).map(([name, idl]) => (
                    <span key={name} className="inline-flex items-center rounded-full border border-[hsl(var(--border))] pl-2.5 text-xs">{name}<CopyButton text={JSON.stringify(idl, null, 2)} label={`Copy ${name} IDL`} /></span>
                  ))}
                </div>
              )}
              {data?.logTail && <CodeBlock title="Build log (tail)" code={data.logTail} lineClass={(l) => (/^error|error\[|FAILED|failing/.test(l) ? "text-red-600 dark:text-red-400" : undefined)} maxHeight="max-h-72" />}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
