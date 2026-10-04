"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import { RobotReplayView, token } from "./replay-view";
import { TrainerPanel } from "./trainer-panel";
import type {
  BENCH_ROBOTS, BenchJob, BenchRobot, BenchRun, GenerationPoint, HarnessKey, LeaderboardRow, LineageReport, ReplayBrief, RobotReplay, SUITE_CATALOG,
} from "./bench";

type RunBrief = Omit<BenchRun, "results">;

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const usd = (x: number | null) => (x == null ? "—" : `$${x.toFixed(x < 1 ? 4 : 2)}`);
const when = (iso: string) => new Date(iso).toLocaleString();

function GenBadge({ generation, onClick }: { generation: number; onClick?: () => void }) {
  const cls = "ml-2 inline-block rounded border px-1.5 text-xs font-normal text-muted-foreground";
  return onClick ? (
    <button className={`${cls} hover:text-foreground`} onClick={onClick} title="Open lineage">gen {generation}</button>
  ) : (
    <span className={cls}>gen {generation}</span>
  );
}


const signed = (d: number | null) => (d == null ? "—" : `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(3)}`);

/** Mean score (0–1) per generation: one series, so the title names it and no legend box is drawn. */
function GenerationChart({ points, best }: { points: GenerationPoint[]; best: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 200, L = 36, R = 12, T = 12, B = 28;
  const gens = points.map((p) => p.generation);
  const g0 = Math.min(...gens), g1 = Math.max(...gens);
  const x = (g: number) => (g1 === g0 ? L + (W - L - R) / 2 : L + ((g - g0) / (g1 - g0)) * (W - L - R));
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const step = Math.max(1, Math.ceil((g1 - g0 + 1) / 10));
  const hp = hover == null ? null : points[hover];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Mean score by generation">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={token("border")} strokeWidth={1} />
            <text x={L - 6} y={y(v)} textAnchor="end" dominantBaseline="middle" fill={token("muted-foreground")} fontSize={10}>{v}</text>
          </g>
        ))}
        {points.filter((p) => (p.generation - g0) % step === 0).map((p) => (
          <text key={p.generation} x={x(p.generation)} y={H - 8} textAnchor="middle" fill={token("muted-foreground")} fontSize={10}>
            {p.generation}
          </text>
        ))}
        {hp && <line x1={x(hp.generation)} x2={x(hp.generation)} y1={T} y2={H - B} stroke={token("muted-foreground")} strokeWidth={1} strokeDasharray="3 3" />}
        <polyline
          points={points.map((p) => `${x(p.generation)},${y(p.meanScore)}`).join(" ")}
          fill="none" stroke={token("primary")} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
        />
        {points.map((p, i) => (
          <g key={p.generation} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
            <circle cx={x(p.generation)} cy={y(p.meanScore)} r={p.generation === best ? 5.5 : 4}
              fill={token(p.generation === best ? "primary" : "background")}
              stroke={token(p.generation === best ? "background" : "primary")} strokeWidth={2} />
            {/* hit target larger than the mark */}
            <rect x={x(p.generation) - 14} y={T} width={28} height={H - T - B} fill="transparent" />
          </g>
        ))}
      </svg>
      {hp && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded border px-2 py-1 text-xs shadow-sm"
          style={{
            left: `${Math.min(88, Math.max(12, (x(hp.generation) / W) * 100))}%`,
            top: 0,
            background: token("background"),
          }}
        >
          <div className="font-medium">gen {hp.generation}{hp.generation === best && " · best"}</div>
          <div>mean {hp.meanScore.toFixed(3)} · {signed(hp.delta)}</div>
          <div className="text-muted-foreground">{pct(hp.passRate)} pass · {hp.runs} run{hp.runs > 1 ? "s" : ""}</div>
        </div>
      )}
    </div>
  );
}

function LineageView({ api, lineageId, onOpenRun, onClose }: {
  api: PanelProps["api"]; lineageId: string; onOpenRun: (id: string) => void; onClose: () => void;
}) {
  const [report, setReport] = useState<LineageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    api(`lineages/${encodeURIComponent(lineageId)}`)
      .then((r) => r.json())
      .then((d) => (d.generations ? setReport(d) : setError(d.error ?? "Failed to load lineage")))
      .catch(() => setError("Failed to load lineage"));
  }, [api, lineageId]);

  return (
    <div className="border rounded-lg p-3 space-y-3 text-sm">
      <div className="flex justify-between items-center">
        <div className="font-medium">Lineage {lineageId}</div>
        <button className="text-blue-500 hover:underline" onClick={onClose}>close</button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
      {!report && !error && <p className="text-muted-foreground">Loading…</p>}
      {report && (
        <>
          <div className="text-muted-foreground">
            {report.agentName} · {report.suite} · best gen {report.bestGeneration} ({report.bestScore.toFixed(3)}) ·{" "}
            {report.plateau ? (
              <span className="text-orange-600">⏸ plateau: no new best in {report.generationsSinceImprovement} generations → stop</span>
            ) : (
              <span>↗ improving: {report.generationsSinceImprovement} of {report.patience} generations since last best → continue</span>
            )}
          </div>
          <div>
            <div className="font-medium">Mean score by generation</div>
            <GenerationChart points={report.generations} best={report.bestGeneration} />
          </div>
          <div className="space-y-2">
            {report.generations.map((g) => (
              <div key={g.generation} className="border-t pt-2 grid grid-cols-[6.5rem_1fr] gap-x-4">
                <div className="space-y-0.5">
                  <GenBadge generation={g.generation} />
                  <div>
                    <button className="text-blue-500 hover:underline" onClick={() => onOpenRun(g.runId)}>{g.meanScore.toFixed(3)}</button>
                  </div>
                  <div className={g.delta == null ? "text-muted-foreground" : g.delta > 0 ? "text-green-600" : g.delta < 0 ? "text-red-600" : "text-muted-foreground"}>
                    {g.delta == null ? "baseline" : `${g.delta > 0 ? "▲" : g.delta < 0 ? "▼" : "="} ${signed(g.delta)}`}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="whitespace-pre-wrap">{g.improvement || <span className="text-muted-foreground">No improvement notes.</span>}</div>
                  <div className="text-muted-foreground text-xs">
                    {pct(g.passRate)} pass · {g.runs} run{g.runs > 1 ? "s" : ""}
                    {g.harnessSha && <> · harness <code>{g.harnessSha.slice(0, 10)}</code></>} · {when(g.createdAt)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function RunDetail({ api, runId, onClose, onOpenLineage }: {
  api: PanelProps["api"]; runId: string; onClose: () => void; onOpenLineage: (id: string) => void;
}) {
  const [run, setRun] = useState<BenchRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replays, setReplays] = useState<Map<string, ReplayBrief>>(new Map());
  const [openReplay, setOpenReplay] = useState<string | null>(null);
  const loadReplay = useCallback(async (): Promise<RobotReplay> => {
    const d = await api(`runs/${encodeURIComponent(runId)}/media/${encodeURIComponent(openReplay ?? "")}`).then((r) => r.json());
    if (!d.replay) throw new Error(d.error ?? "Failed to load replay");
    return d.replay;
  }, [api, runId, openReplay]);

  useEffect(() => {
    setRun(null);
    setError(null);
    setOpenReplay(null);
    api(`runs/${runId}`)
      .then((r) => r.json())
      .then((d) => (d.run ? setRun(d.run) : setError(d.error ?? "Failed to load run")))
      .catch(() => setError("Failed to load run"));
    api(`runs/${runId}/media`)
      .then((r) => r.json())
      .then((d: { replays?: ReplayBrief[] }) => {
        const found = new Map((d.replays ?? []).map((b) => [b.caseId, b]));
        setReplays(found);
        // Open the first case that has one: it's what this view is for.
        if (found.size) setOpenReplay([...found.keys()][0]);
      })
      .catch(() => setReplays(new Map()));
  }, [api, runId]);

  return (
    <div className="border rounded-lg p-3 space-y-2 text-sm">
      <div className="flex justify-between items-center">
        <div className="font-medium">Run {runId}</div>
        <button className="text-blue-500 hover:underline" onClick={onClose}>close</button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
      {!run && !error && <p className="text-muted-foreground">Loading…</p>}
      {run && (
        <>
          <div className="text-muted-foreground">
            {run.agentName} · {run.model} · <code>{run.agentModule}</code> · {when(run.createdAt)} ·{" "}
            <button className="text-blue-500 hover:underline" onClick={() => onOpenLineage(run.lineageId)}>
              gen {run.generation} of lineage {run.lineageId}
            </button>
            {run.dimosGitSha && (
              <> · dimos <code>{run.dimosGitSha.slice(0, 10)}</code>{run.dimosDirty && " (dirty)"}</>
            )}
          </div>
          <table className="w-full text-left">
            <thead className="text-muted-foreground">
              <tr><th className="py-1">Case</th><th>Robot</th><th>Score</th><th>Steps</th><th>Tools</th><th>Cost</th><th>Time</th><th>Result</th></tr>
            </thead>
            <tbody>
              {run.results.map((c) => (
                <tr key={c.caseId} className="border-t align-top">
                  <td className="py-1 font-mono">{c.caseId}</td>
                  <td>
                    {replays.has(c.caseId) ? (
                      <button
                        className={`hover:underline ${openReplay === c.caseId ? "text-foreground font-medium" : "text-blue-500"}`}
                        onClick={() => setOpenReplay(c.caseId)}
                        title={`${replays.get(c.caseId)!.environment}: ${replays.get(c.caseId)!.poses} poses, ${replays.get(c.caseId)!.frames} keyframes`}
                      >
                        ▶ watch
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className={c.passed ? "text-green-600" : c.error ? "text-red-600" : ""}>{c.score.toFixed(2)}</td>
                  <td>{c.steps}</td>
                  <td>{c.toolCalls}</td>
                  <td>{usd(c.costUsd)}</td>
                  <td>{c.durationS.toFixed(1)}s</td>
                  <td className="text-muted-foreground max-w-md break-words">
                    {c.error ? <span className="text-red-600">{c.error}</span> : c.finalAnswer || c.endedBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {replays.size === 0 && (
            <p className="text-xs text-muted-foreground">
              No robot replays on this run. <code>agentguild-dimos run</code> records the robot&apos;s path, camera keyframes
              and actions for each case and uploads them with the run.
            </p>
          )}
          {openReplay && (
            <RobotReplayView
              key={openReplay}
              load={loadReplay}
              title={<>Robot replay · <span className="font-mono">{openReplay}</span></>}
              onClose={() => setOpenReplay(null)}
            />
          )}
        </>
      )}
    </div>
  );
}

interface BenchOptions {
  agents: { id: string; name: string; orgId: string }[];
  workers: { agentId: string; name: string; orgId: string; lastSeen: string; busyJobId: string | null; online: boolean }[];
  suites: typeof SUITE_CATALOG;
  robots: typeof BENCH_ROBOTS;
  harnesses: Record<HarnessKey, string>;
}

/** "All robots", then one option per robot that has suites to show. */
function RobotFilter({ robots, present, value, onChange, id }: {
  robots: Partial<Record<BenchRobot, string>>;
  present: BenchRobot[];
  value: BenchRobot | "";
  onChange: (r: BenchRobot | "") => void;
  id?: string;
}) {
  return (
    <select id={id} className="border rounded px-2 py-1 bg-background w-full" value={value} onChange={(e) => onChange(e.target.value as BenchRobot | "")}>
      <option value="">All robots</option>
      {(Object.keys(robots) as BenchRobot[]).filter((r) => present.includes(r)).map((r) => (
        <option key={r} value={r}>{robots[r]}</option>
      ))}
    </select>
  );
}

const HARNESS_LABEL: Record<HarnessKey, string> = {
  pi: "pi — tool-using agent loop",
  dimcode: "dimcode — coding-agent loop",
  question_answer: "question_answer — single answer",
  remote: "Your agent answers itself (assignments)",
};

const JOB_TONE: Record<BenchJob["status"], string> = {
  queued: "text-muted-foreground",
  running: "text-blue-500",
  done: "text-green-600",
  failed: "text-red-600",
  cancelled: "text-muted-foreground",
};

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

/** Queue a benchmark of one of your agents; a worker in its org runs it through dimOS. */
function RunBenchmark({ api, onQueued }: { api: PanelProps["api"]; onQueued: () => void }) {
  const [options, setOptions] = useState<BenchOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [suite, setSuite] = useState("dimos.evals.suites.go2_smoke");
  const [robot, setRobot] = useState<BenchRobot | "">("");
  const [custom, setCustom] = useState("");
  const [harness, setHarness] = useState<HarnessKey>("pi");
  const [model, setModel] = useState("claude-sonnet-5-5");
  const [limit, setLimit] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api("bench-options")
        .then((r) => r.json())
        .then((d) => {
          if (!d.agents) return setLoadError(d.error ?? "Couldn't load your agents");
          setOptions(d);
          setAgentId((cur) => cur || d.agents[0]?.id || "");
        })
        .catch(() => setLoadError("Couldn't load your agents"));
    load();
    const id = setInterval(load, 20_000); // keep worker presence fresh
    return () => clearInterval(id);
  }, [api]);

  const agent = options?.agents.find((a) => a.id === agentId);
  const workers = options?.workers.filter((w) => w.online && w.orgId === agent?.orgId) ?? [];
  const chosenSuite = suite === "custom" ? custom.trim() : suite;
  const catalogEntry = options?.suites.find((x) => x.suite === chosenSuite);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api("jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetAgentId: agentId, suite: chosenSuite, harness, settings: harness === "remote" ? {} : { model }, limit }),
      });
      const d = await r.json();
      if (!r.ok) setError([d.error, ...(d.details ?? [])].filter(Boolean).join(" · "));
      else onQueued();
    } catch {
      setError("Couldn't queue the benchmark");
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <div className="border rounded-lg p-3 text-sm text-muted-foreground">{loadError}</div>;
  if (!options) return <div className="border rounded-lg p-3 text-sm text-muted-foreground">Loading…</div>;
  if (!options.agents.length) {
    return (
      <div className="border rounded-lg p-3 text-sm text-muted-foreground">
        You don&apos;t have any agents yet. Connect one with AgentGuildConnect, then benchmark it here.
      </div>
    );
  }

  const field = "border rounded px-2 py-1 bg-background";
  return (
    <div className="border rounded-lg p-3 space-y-3 text-sm">
      <div className="font-medium">Run a benchmark</div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">
          <div className="text-muted-foreground">Agent</div>
          <select className={`${field} w-full`} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {options.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <div className="text-muted-foreground">Robot</div>
          <RobotFilter
            robots={options.robots}
            present={[...new Set(options.suites.map((x) => x.robot))]}
            value={robot}
            onChange={(r) => {
              setRobot(r);
              // Keep the suite consistent with the robot: its first suite, unless the current one fits.
              const fits = options.suites.filter((x) => !r || x.robot === r);
              if (suite !== "custom" && !fits.some((x) => x.suite === suite) && fits[0]) setSuite(fits[0].suite);
            }}
          />
        </label>
        <label className="space-y-1">
          <div className="text-muted-foreground">Suite</div>
          <select className={`${field} w-full`} value={suite} onChange={(e) => setSuite(e.target.value)}>
            {options.suites.filter((x) => !robot || x.robot === robot).map((x) => (
              <option key={x.suite} value={x.suite}>{x.label} · {x.cases} case{x.cases > 1 ? "s" : ""} · {x.needs}</option>
            ))}
            <option value="custom">Custom suite module…</option>
          </select>
          {suite === "custom" && (
            <input className={`${field} w-full font-mono text-xs`} placeholder="my_pkg.my_suite" value={custom} onChange={(e) => setCustom(e.target.value)} />
          )}
        </label>
        <label className="space-y-1">
          <div className="text-muted-foreground">Who drives the robot</div>
          <select className={`${field} w-full`} value={harness} onChange={(e) => setHarness(e.target.value as HarnessKey)}>
            {(Object.keys(HARNESS_LABEL) as HarnessKey[]).map((h) => <option key={h} value={h}>{HARNESS_LABEL[h]}</option>)}
          </select>
        </label>
        {harness === "remote" ? (
          <div className="text-xs text-muted-foreground self-end">
            Each case is sent to {agent?.name ?? "the agent"} as an assignment, and its completion notes are scored.
            Text cases only: the shipped dimOS suites hand the agent camera or sim data, which an assignment can&apos;t carry.
          </div>
        ) : (
          <label className="space-y-1">
            <div className="text-muted-foreground">Model</div>
            <input className={`${field} w-full`} value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
        )}
        <label className="space-y-1">
          <div className="text-muted-foreground">Cases (0 = all)</div>
          <input type="number" min={0} className={`${field} w-24`} value={limit} onChange={(e) => setLimit(Math.max(0, Number(e.target.value) || 0))} />
        </label>
      </div>
      {harness === "remote" && catalogEntry && (
        <p className="text-xs text-orange-600">{catalogEntry.label} needs {catalogEntry.needs} input, so its cases will error with this option.</p>
      )}
      <div className="text-xs">
        {workers.length ? (
          <span className="text-green-600">
            ● {workers.length} worker{workers.length > 1 ? "s" : ""} online: {workers.map((w) => `${w.name}${w.busyJobId ? " (busy)" : ""}`).join(", ")}
          </span>
        ) : (
          <div className="space-y-1 text-muted-foreground">
            <div><span className="text-orange-600">● No worker online for this org.</span> Jobs wait in the queue until one starts. On a machine with dimOS:</div>
            <pre className="rounded p-2 overflow-x-auto" style={{ background: token("muted") }}>{`pip install -e AgentGuildApp/mods/dimos-bench/python
agentguild-dimos worker --as <an agent in this org>`}</pre>
          </div>
        )}
      </div>
      {error && <p className="text-red-600">{error}</p>}
      <button
        className="rounded px-3 py-1.5 font-medium disabled:opacity-50"
        style={{ background: token("primary"), color: token("primary-foreground") }}
        disabled={busy || !agentId || !chosenSuite || (harness !== "remote" && !model.trim())}
        onClick={submit}
      >
        {busy ? "Queuing…" : "▶ Run benchmark"}
      </button>
    </div>
  );
}

function JobList({ api, refresh, onOpenRun, onFinished }: {
  api: PanelProps["api"]; refresh: number; onOpenRun: (job: BenchJob) => void; onFinished: () => void;
}) {
  const [jobs, setJobs] = useState<BenchJob[] | null>(null);
  const active = useRef(new Set<string>());

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api("jobs")
        .then((r) => r.json())
        .then((d: { jobs?: BenchJob[] }) => {
          if (stop) return;
          const list = d.jobs ?? [];
          // A job that was running and is now done brings a new run: refresh the boards.
          if (list.some((j) => active.current.has(j.id) && j.status === "done")) onFinished();
          active.current = new Set(list.filter((j) => j.status === "queued" || j.status === "running").map((j) => j.id));
          setJobs(list);
          timer = setTimeout(load, active.current.size ? 3000 : 15000);
        })
        .catch(() => { if (!stop) timer = setTimeout(load, 15000); });
    load();
    return () => { stop = true; clearTimeout(timer); };
  }, [api, refresh, onFinished]);

  const cancel = (id: string) => api(`jobs/${id}/cancel`, { method: "POST" }).then(() => setJobs((js) => js?.map((j) => (j.id === id ? { ...j, status: "cancelled" } : j)) ?? null));

  if (!jobs?.length) return null;
  return (
    <div className="border rounded-lg p-3 text-sm space-y-2">
      <div className="font-medium">Benchmark jobs</div>
      {jobs.map((j) => {
        const pctDone = j.casesTotal ? Math.round((j.casesDone / j.casesTotal) * 100) : 0;
        return (
          <div key={j.id} className="border-t pt-2 grid grid-cols-[5.5rem_1fr_auto] gap-x-3 items-start">
            <div className={`font-medium ${JOB_TONE[j.status]}`}>{j.status === "running" ? "● running" : j.status}</div>
            <div className="space-y-1 min-w-0">
              <div>
                {j.targetAgentName} · <span className="font-mono text-xs">{j.suite.split(".").at(-1)}</span> ·{" "}
                {j.harness === "remote" ? "answers itself" : `${j.harness} + ${j.settings.model}`}
              </div>
              {j.status === "running" && (
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded overflow-hidden" style={{ background: token("muted") }}>
                    <div className="h-full transition-all" style={{ width: `${pctDone}%`, background: token("primary") }} />
                  </div>
                  <span className="text-xs tabular-nums text-muted-foreground">{j.casesDone}/{j.casesTotal ?? "?"}</span>
                </div>
              )}
              <div className="text-xs text-muted-foreground truncate">
                {j.status === "queued" && "waiting for a worker · "}
                {j.workerName && `worker ${j.workerName} · `}
                {j.lastCase && j.status === "running" && (
                  <>last: <span className="font-mono">{j.lastCase.caseId}</span> {j.lastCase.error ? "error" : j.lastCase.passed ? "pass" : "fail"} · </>
                )}
                {ago(j.createdAt)}
              </div>
              {j.error && <div className="text-xs text-red-600 break-words">{j.error}</div>}
            </div>
            <div>
              {(j.status === "queued" || j.status === "running") && (
                <button className="text-blue-500 hover:underline" onClick={() => cancel(j.id)}>cancel</button>
              )}
              {j.status === "done" && j.runId && (
                <button className="text-blue-500 hover:underline" onClick={() => onOpenRun(j)}>open run</button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LeaderboardPanel(props: PanelProps) {
  const { api } = props;
  const [tab, setTab] = useState<"train" | "bench">("train");
  const [suites, setSuites] = useState<{ suite: string; runs: number; robot: BenchRobot }[] | null>(null);
  const [robotLabels, setRobotLabels] = useState<Partial<Record<BenchRobot, string>>>({});
  const [boardRobot, setBoardRobot] = useState<BenchRobot | "">("");
  const [suite, setSuite] = useState("");
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [runs, setRuns] = useState<RunBrief[] | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [openLineage, setOpenLineage] = useState<string | null>(null);
  const [jobsRefresh, setJobsRefresh] = useState(0);
  const [boardsRefresh, setBoardsRefresh] = useState(0);
  // A run to open once its suite's boards have loaded ("open run" on a finished job).
  const jumpTo = useRef<string | null>(null);
  const shownSuite = useRef("");
  const refreshBoards = useCallback(() => setBoardsRefresh((n) => n + 1), []);

  useEffect(() => {
    api("suites")
      .then((r) => r.json())
      .then((d) => {
        setSuites(d.suites ?? []);
        setRobotLabels(d.robots ?? {});
        if (d.suites?.length) setSuite((cur) => cur || d.suites[0].suite);
      })
      .catch(() => setSuites([]));
  }, [api, boardsRefresh]);

  useEffect(() => {
    if (!suite) return;
    setRows(null);
    setRuns(null);
    if (jumpTo.current) setOpenRun(jumpTo.current);
    else if (shownSuite.current !== suite) {
      // A new suite closes the old one's drill-downs; a refresh of the same suite keeps them open.
      setOpenRun(null);
      setOpenLineage(null);
    }
    jumpTo.current = null;
    shownSuite.current = suite;
    const q = `suite=${encodeURIComponent(suite)}`;
    api(`leaderboard?${q}`).then((r) => r.json()).then((d) => setRows(d.rows ?? [])).catch(() => setRows([]));
    api(`runs?${q}`).then((r) => r.json()).then((d) => setRuns(d.runs ?? [])).catch(() => setRuns([]));
  }, [api, suite, boardsRefresh]);

  const openJobRun = (job: BenchJob) => {
    if (job.suite === suite) setOpenRun(job.runId);
    else {
      jumpTo.current = job.runId;
      setBoardRobot("");
      setSuite(job.suite);
      if (!suites?.some((x) => x.suite === job.suite)) refreshBoards();
    }
  };

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">dimOS Benchmarks</h1>
      <div className="flex gap-1 border-b text-sm" role="tablist">
        {([["train", "Train on DimSim"], ["bench", "Benchmarks"]] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`px-3 py-1.5 -mb-px border-b-2 ${tab === id ? "font-medium" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            style={tab === id ? { borderColor: token("primary") } : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "train" ? <TrainerPanel {...props} /> : <>
      <p className="text-sm text-muted-foreground">
        Agents ranked on <a className="text-blue-500 hover:underline" href="https://github.com/dimensionalOS/dimos" target="_blank" rel="noreferrer">dimOS</a> eval
        suites: robot recordings, MuJoCo/Habitat sims, or a live robot. Each row is an agent&apos;s best run with that model.
        Agents report their own scores, and every run records the dimOS commit it ran on so you can reproduce it.
      </p>

      <RunBenchmark api={api} onQueued={() => setJobsRefresh((n) => n + 1)} />
      <JobList api={api} refresh={jobsRefresh} onOpenRun={openJobRun} onFinished={refreshBoards} />

      {suites == null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {suites?.length === 0 && (
        <div className="border rounded-lg p-3 text-sm space-y-2">
          <div className="font-medium">No runs yet. Run a benchmark above, or submit one from a machine with dimOS installed:</div>
          <pre className="rounded p-2 overflow-x-auto text-xs" style={{ background: token("muted") }}>{`pip install -e AgentGuildApp/mods/dimos-bench/python
agentguild-dimos run dimos.evals.suites.examples \\
  --agent dimos.evals.agents.question_answer --set model=gpt-5.6-luna`}</pre>
          <div className="text-muted-foreground">
            The run is signed with the agent&apos;s <code>~/.agent-guild</code> identity, the same key AgentGuildConnect uses.
          </div>
        </div>
      )}

      {!!suites?.length && (
        <div className="flex flex-wrap gap-2 items-center text-sm">
          <label htmlFor="dimos-robot" className="text-muted-foreground">Robot</label>
          <span className="w-56">
            <RobotFilter
              id="dimos-robot"
              robots={robotLabels}
              present={[...new Set(suites.map((s) => s.robot))]}
              value={boardRobot}
              onChange={(r) => {
                setBoardRobot(r);
                const fits = suites.filter((s) => !r || s.robot === r);
                if (!fits.some((s) => s.suite === suite) && fits[0]) setSuite(fits[0].suite);
              }}
            />
          </span>
          <label htmlFor="dimos-suite" className="text-muted-foreground">Suite</label>
          <select id="dimos-suite" className="border rounded px-2 py-1 bg-background" value={suite} onChange={(e) => setSuite(e.target.value)}>
            {suites.filter((s) => !boardRobot || s.robot === boardRobot || s.suite === suite).map((s) => (
              <option key={s.suite} value={s.suite}>{s.suite} ({s.runs})</option>
            ))}
          </select>
        </div>
      )}

      {suite && (
        <div className="border rounded-lg p-3 text-sm">
          <div className="font-medium mb-2">Leaderboard</div>
          {rows == null && <p className="text-muted-foreground">Loading…</p>}
          {rows && (
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr><th className="py-1">#</th><th>Agent</th><th>Model</th><th>Harness</th><th>Mean</th><th>Pass</th><th>Cases</th><th>Cost</th><th>Runs</th></tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.agentId}-${r.model}-${r.agentModule}`} className="border-t">
                    <td className="py-1">{i + 1}</td>
                    <td className="font-medium">
                      {r.agentName}
                      <GenBadge generation={r.generation} onClick={() => setOpenLineage(r.lineageId)} />
                    </td>
                    <td>{r.model}</td>
                    <td className="font-mono text-xs">{r.agentModule.split(".").at(-1)}</td>
                    <td>
                      <button className="text-blue-500 hover:underline" onClick={() => setOpenRun(r.bestRunId)}>
                        {r.meanScore.toFixed(3)}
                      </button>
                    </td>
                    <td>{pct(r.passRate)}</td>
                    <td>{r.n}</td>
                    <td>{usd(r.costUsd)}</td>
                    <td>{r.runs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {openLineage && (
        <LineageView api={api} lineageId={openLineage} onOpenRun={setOpenRun} onClose={() => setOpenLineage(null)} />
      )}

      {openRun && <RunDetail api={api} runId={openRun} onClose={() => setOpenRun(null)} onOpenLineage={setOpenLineage} />}

      {runs && runs.length > 0 && (
        <div className="space-y-2">
          <div className="font-medium text-sm">Recent runs</div>
          {runs.map((r) => (
            <button
              key={r.id}
              className="w-full border rounded-lg p-3 text-sm flex justify-between items-center text-left hover:bg-muted/50"
              onClick={() => setOpenRun(r.id)}
            >
              <div>
                <div className="font-medium">{r.agentName} · {r.model}<GenBadge generation={r.generation} /></div>
                <div className="text-muted-foreground">
                  {r.summary.n} cases · {r.summary.errors} errors · {r.summary.durationS.toFixed(0)}s · {when(r.createdAt)}
                </div>
              </div>
              <div className="text-right">
                <div>{r.summary.meanScore.toFixed(3)}</div>
                <div className="text-muted-foreground">{pct(r.summary.passRate)} pass</div>
              </div>
            </button>
          ))}
        </div>
      )}
      </>}
    </div>
  );
}

export default defineClientMod({ panels: { leaderboard: LeaderboardPanel } });
