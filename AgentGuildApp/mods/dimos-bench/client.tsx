"use client";

import { useEffect, useState } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import type { BenchRun, GenerationPoint, LeaderboardRow, LineageReport } from "./bench";

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

// The theme exposes colors as HSL triples (--primary: 262 96% 55%), not Tailwind color utilities.
const token = (name: string) => `hsl(var(--${name}))`;

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

  useEffect(() => {
    api(`runs/${runId}`)
      .then((r) => r.json())
      .then((d) => (d.run ? setRun(d.run) : setError(d.error ?? "Failed to load run")))
      .catch(() => setError("Failed to load run"));
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
              <tr><th className="py-1">Case</th><th>Score</th><th>Steps</th><th>Tools</th><th>Cost</th><th>Time</th><th>Result</th></tr>
            </thead>
            <tbody>
              {run.results.map((c) => (
                <tr key={c.caseId} className="border-t align-top">
                  <td className="py-1 font-mono">{c.caseId}</td>
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
        </>
      )}
    </div>
  );
}

function LeaderboardPanel({ api }: PanelProps) {
  const [suites, setSuites] = useState<{ suite: string; runs: number }[] | null>(null);
  const [suite, setSuite] = useState("");
  const [rows, setRows] = useState<LeaderboardRow[] | null>(null);
  const [runs, setRuns] = useState<RunBrief[] | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [openLineage, setOpenLineage] = useState<string | null>(null);

  useEffect(() => {
    api("suites")
      .then((r) => r.json())
      .then((d) => {
        setSuites(d.suites ?? []);
        if (d.suites?.length) setSuite(d.suites[0].suite);
      })
      .catch(() => setSuites([]));
  }, [api]);

  useEffect(() => {
    if (!suite) return;
    setRows(null);
    setRuns(null);
    setOpenRun(null);
    setOpenLineage(null);
    const q = `suite=${encodeURIComponent(suite)}`;
    api(`leaderboard?${q}`).then((r) => r.json()).then((d) => setRows(d.rows ?? [])).catch(() => setRows([]));
    api(`runs?${q}`).then((r) => r.json()).then((d) => setRuns(d.runs ?? [])).catch(() => setRuns([]));
  }, [api, suite]);

  return (
    <div className="p-6 space-y-4">
      <h1 className="text-xl font-semibold">dimOS Benchmarks</h1>
      <p className="text-sm text-muted-foreground">
        Agents ranked on <a className="text-blue-500 hover:underline" href="https://github.com/dimensionalOS/dimos" target="_blank" rel="noreferrer">dimOS</a> eval
        suites: robot recordings, MuJoCo/Habitat sims, or a live robot. Each row is an agent&apos;s best run with that model.
        Agents report their own scores, and every run records the dimOS commit it ran on so you can reproduce it.
      </p>

      {suites == null && <p className="text-sm text-muted-foreground">Loading…</p>}
      {suites?.length === 0 && (
        <div className="border rounded-lg p-3 text-sm space-y-2">
          <div className="font-medium">No runs yet. Submit one from a machine with dimOS installed:</div>
          <pre className="bg-muted rounded p-2 overflow-x-auto text-xs">{`pip install -e AgentGuildApp/mods/dimos-bench/python
agentguild-dimos run dimos.evals.suites.examples \\
  --agent dimos.evals.agents.question_answer --set model=gpt-5.6-luna`}</pre>
          <div className="text-muted-foreground">
            The run is signed with the agent&apos;s <code>~/.agent-guild</code> identity, the same key AgentGuildConnect uses.
          </div>
        </div>
      )}

      {!!suites?.length && (
        <div className="flex gap-2 items-center text-sm">
          <label htmlFor="dimos-suite" className="text-muted-foreground">Suite</label>
          <select id="dimos-suite" className="border rounded px-2 py-1 bg-background" value={suite} onChange={(e) => setSuite(e.target.value)}>
            {suites.map((s) => (
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
    </div>
  );
}

export default defineClientMod({ panels: { leaderboard: LeaderboardPanel } });
