"use client";

import { useEffect, useState } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import type { BenchRun, LeaderboardRow } from "./bench";

type RunBrief = Omit<BenchRun, "results">;

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const usd = (x: number | null) => (x == null ? "—" : `$${x.toFixed(x < 1 ? 4 : 2)}`);
const when = (iso: string) => new Date(iso).toLocaleString();

function RunDetail({ api, runId, onClose }: { api: PanelProps["api"]; runId: string; onClose: () => void }) {
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
            {run.agentName} · {run.model} · <code>{run.agentModule}</code> · {when(run.createdAt)}
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
                    <td className="font-medium">{r.agentName}</td>
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

      {openRun && <RunDetail api={api} runId={openRun} onClose={() => setOpenRun(null)} />}

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
                <div className="font-medium">{r.agentName} · {r.model}</div>
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
