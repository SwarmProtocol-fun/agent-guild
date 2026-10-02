"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import type { BenchRun, GenerationPoint, LeaderboardRow, LineageReport, Pose, ReplayBrief, RobotReplay } from "./bench";

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

/** Index of the last item with t <= now (items sorted by t), or -1. */
function lastAt<T>(items: T[], t: (item: T) => number | null, now: number): number {
  let found = -1;
  items.forEach((item, i) => {
    const ti = t(item);
    if (ti != null && ti <= now) found = i;
  });
  return found;
}

/** Pose at time `now`, interpolated between recorded samples. */
function poseAt(path: Pose[], now: number): Pose | null {
  if (!path.length) return null;
  const i = lastAt(path, (p) => p[0], now);
  if (i < 0) return path[0];
  if (i >= path.length - 1) return path[path.length - 1];
  const [t0, x0, y0, a0] = path[i];
  const [t1, x1, y1, a1] = path[i + 1];
  const k = t1 > t0 ? (now - t0) / (t1 - t0) : 0;
  const da = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)); // shortest turn
  return [now, x0 + (x1 - x0) * k, y0 + (y1 - y0) * k, a0 + da * k];
}

/** Top-down map of the robot's odometry: x right, y up, equal scale, 1 m grid. */
function PathMap({ path, now, actionTimes }: { path: Pose[]; now: number; actionTimes: number[] }) {
  const W = 420, H = 320, PAD = 24;
  const xs = path.map((p) => p[1]), ys = path.map((p) => p[2]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1); // at least 1 m across, so a robot standing still isn't zoomed to a dot
  const s = Math.min((W - 2 * PAD) / Math.max(maxX - minX, 1), (H - 2 * PAD) / Math.max(maxY - minY, 1));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const X = (x: number) => W / 2 + (x - cx) * s;
  const Y = (y: number) => H / 2 - (y - cy) * s;
  const step = span > 40 ? 10 : span > 8 ? 2 : 1;
  const gridX: number[] = [], gridY: number[] = [];
  for (let g = Math.ceil((cx - W / 2 / s) / step) * step; g <= cx + W / 2 / s; g += step) gridX.push(g);
  for (let g = Math.ceil((cy - H / 2 / s) / step) * step; g <= cy + H / 2 / s; g += step) gridY.push(g);
  const here = poseAt(path, now);
  const travelled = path.filter((p) => p[0] <= now);
  const pts = (ps: Pose[]) => ps.map((p) => `${X(p[1]).toFixed(1)},${Y(p[2]).toFixed(1)}`).join(" ");
  const [, x0, y0] = path[0];
  const end = path[path.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto rounded border" style={{ background: token("muted") }} role="img" aria-label="Robot path, top-down">
      {gridX.map((g) => <line key={`x${g}`} x1={X(g)} x2={X(g)} y1={0} y2={H} stroke={token("border")} strokeWidth={1} />)}
      {gridY.map((g) => <line key={`y${g}`} x1={0} x2={W} y1={Y(g)} y2={Y(g)} stroke={token("border")} strokeWidth={1} />)}
      <polyline points={pts(path)} fill="none" stroke={token("muted-foreground")} strokeWidth={1.5} strokeDasharray="4 3" opacity={0.6} />
      {travelled.length > 1 && (
        <polyline points={pts(travelled)} fill="none" stroke={token("primary")} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
      )}
      {actionTimes.map((t, i) => {
        const p = poseAt(path, t);
        return p && <circle key={i} cx={X(p[1])} cy={Y(p[2])} r={3} fill={token(t <= now ? "primary" : "background")} stroke={token("primary")} strokeWidth={1.5} />;
      })}
      <circle cx={X(x0)} cy={Y(y0)} r={5} fill={token("background")} stroke={token("foreground")} strokeWidth={1.5} />
      <text x={X(x0) + 8} y={Y(y0) - 6} fontSize={10} fill={token("muted-foreground")}>start</text>
      <rect x={X(end[1]) - 4} y={Y(end[2]) - 4} width={8} height={8} fill={token("foreground")} />
      {here && (
        // The robot, top-down: a quadruped body facing +x with its camera's view cone,
        // rotated to its yaw (SVG y points down, so the angle is negated).
        <g transform={`translate(${X(here[1])},${Y(here[2])}) rotate(${(-here[3] * 180) / Math.PI})`}>
          <path d="M 0 0 L 46 -24 A 52 52 0 0 1 46 24 Z" fill={token("primary")} opacity={0.18} />
          {[[-8, -9], [8, -9], [-8, 9], [8, 9]].map(([lx, ly]) => (
            <rect key={`${lx}${ly}`} x={lx - 3} y={ly - 2.5} width={6} height={5} rx={1.5} fill={token("foreground")} />
          ))}
          <rect x={-13} y={-7} width={26} height={14} rx={4} fill={token("primary")} stroke={token("foreground")} strokeWidth={1.5} />
          <rect x={12} y={-4} width={6} height={8} rx={2} fill={token("foreground")} />
        </g>
      )}
      <g transform={`translate(${PAD},${H - 12})`}>
        <line x1={0} x2={step * s} y1={0} y2={0} stroke={token("foreground")} strokeWidth={2} />
        <text x={step * s + 6} y={0} dominantBaseline="middle" fontSize={10} fill={token("muted-foreground")}>{step} m</text>
      </g>
    </svg>
  );
}

function RobotReplayView({ api, runId, caseId, onClose }: {
  api: PanelProps["api"]; runId: string; caseId: string; onClose: () => void;
}) {
  const [replay, setReplay] = useState<RobotReplay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = useRef<number | null>(null);

  useEffect(() => {
    setReplay(null);
    setError(null);
    setNow(0);
    setPlaying(false);
    api(`runs/${encodeURIComponent(runId)}/media/${encodeURIComponent(caseId)}`)
      .then((r) => r.json())
      .then((d) => (d.replay ? setReplay(d.replay) : setError(d.error ?? "Failed to load replay")))
      .catch(() => setError("Failed to load replay"));
  }, [api, runId, caseId]);

  const duration = useMemo(() => {
    if (!replay) return 0;
    const ts = [...replay.path.map((p) => p[0]), ...replay.frames.map((f) => f.t), ...replay.actions.map((a) => a.t ?? 0)];
    return Math.max(0, ...ts);
  }, [replay]);

  // Play at real time, looping to the start when it reaches the end.
  useEffect(() => {
    if (!playing || duration <= 0) return;
    let raf = 0;
    const tick = (ms: number) => {
      const dt = last.current == null ? 0 : (ms - last.current) / 1000;
      last.current = ms;
      setNow((t) => (t + dt > duration ? 0 : t + dt));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [playing, duration]);

  const frameIdx = replay ? Math.max(0, lastAt(replay.frames, (f) => f.t, now)) : -1;
  const frame = replay?.frames[frameIdx];
  const timed = replay?.actions.filter((a) => a.t != null) ?? [];
  const here = replay ? poseAt(replay.path, now) : null;

  return (
    <div className="border rounded-lg p-3 space-y-3 text-sm">
      <div className="flex justify-between items-center">
        <div className="font-medium">
          Robot replay · <span className="font-mono">{caseId}</span>
        </div>
        <button className="text-blue-500 hover:underline" onClick={onClose}>close</button>
      </div>
      {error && <p className="text-red-600">{error}</p>}
      {!replay && !error && <p className="text-muted-foreground">Loading…</p>}
      {replay && (
        <>
          <div className="text-muted-foreground">
            {replay.environment}{replay.source && <> · {replay.source}</>} · {duration.toFixed(1)}s ·{" "}
            {replay.path.length} poses · {replay.frames.length} keyframes · {replay.actions.length} actions
          </div>
          <div className={`grid gap-3 ${replay.path.length && replay.frames.length ? "md:grid-cols-2" : ""}`}>
            {replay.frames.length > 0 && frame && (
              <figure className="space-y-1">
                <img
                  src={`data:image/jpeg;base64,${frame.jpeg}`}
                  alt={`Robot camera at ${frame.t.toFixed(1)}s`}
                  className="w-full h-auto rounded border bg-black"
                  width={frame.w || undefined}
                  height={frame.h || undefined}
                />
                <figcaption className="text-xs text-muted-foreground">
                  camera · frame {frameIdx + 1}/{replay.frames.length} · t={frame.t.toFixed(1)}s
                </figcaption>
                <div className="flex gap-1 overflow-x-auto">
                  {replay.frames.map((f, i) => (
                    <img
                      key={i}
                      src={`data:image/jpeg;base64,${f.jpeg}`}
                      alt={`keyframe ${i + 1}`}
                      onClick={() => { setPlaying(false); setNow(f.t); }}
                      className={`h-10 w-auto rounded cursor-pointer border-2 ${i === frameIdx ? "border-primary" : "border-transparent opacity-70 hover:opacity-100"}`}
                    />
                  ))}
                </div>
              </figure>
            )}
            {replay.path.length > 0 && (
              <figure className="space-y-1">
                <PathMap path={replay.path} now={now} actionTimes={timed.map((a) => a.t as number)} />
                <figcaption className="text-xs text-muted-foreground">
                  odometry, top-down
                  {here && <> · x {here[1].toFixed(2)} m, y {here[2].toFixed(2)} m, heading {((here[3] * 180) / Math.PI).toFixed(0)}°</>}
                </figcaption>
              </figure>
            )}
          </div>
          {duration > 0 && (
            <div className="flex items-center gap-2">
              <button
                className="border rounded px-2 py-0.5 hover:bg-muted min-w-16"
                onClick={() => { if (!playing && now >= duration) setNow(0); setPlaying(!playing); }}
              >
                {playing ? "❚❚ pause" : "▶ play"}
              </button>
              <input
                type="range" min={0} max={duration} step={duration / 500} value={now}
                onChange={(e) => { setPlaying(false); setNow(Number(e.target.value)); }}
                className="flex-1" aria-label="Replay time"
              />
              <span className="tabular-nums text-muted-foreground w-24 text-right">{now.toFixed(1)} / {duration.toFixed(1)}s</span>
            </div>
          )}
          {replay.actions.length > 0 && (
            <div>
              <div className="font-medium mb-1">What the agent told the robot</div>
              <ol className="space-y-0.5 max-h-48 overflow-y-auto font-mono text-xs">
                {replay.actions.map((a, i) => {
                  const done = a.t != null && a.t <= now;
                  return (
                    <li
                      key={i}
                      className={`flex gap-2 ${a.t != null ? "cursor-pointer hover:bg-muted/50" : ""} ${done ? "" : "text-muted-foreground"}`}
                      onClick={() => { if (a.t != null) { setPlaying(false); setNow(a.t); } }}
                    >
                      <span className="w-14 shrink-0 text-right tabular-nums">{a.t == null ? "—" : `${a.t.toFixed(1)}s`}</span>
                      <span className={done ? "text-primary" : ""}>{a.name}</span>
                      <span className="truncate">{a.args !== "{}" && a.args}</span>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
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
            <RobotReplayView api={api} runId={runId} caseId={openReplay} onClose={() => setOpenReplay(null)} />
          )}
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
