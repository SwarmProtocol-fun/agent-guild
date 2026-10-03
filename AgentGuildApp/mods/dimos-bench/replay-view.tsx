"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Pose, RobotReplay } from "./bench";

// The theme exposes colors as HSL triples (--primary: 262 96% 55%), not Tailwind color utilities.
export const token = (name: string) => `hsl(var(--${name}))`;

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
export function PathMap({ path, now, actionTimes }: { path: Pose[]; now: number; actionTimes: number[] }) {
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

/** Replay of what a robot did: camera keyframes, top-down path, and the actions it was given. */
export function RobotReplayView({ load, title, onClose }: {
  /** Fetches the replay; a new function (identity) reloads it. */
  load: () => Promise<RobotReplay>;
  title: React.ReactNode;
  onClose: () => void;
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
    load()
      .then(setReplay)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load replay"));
  }, [load]);

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
        <div className="font-medium">{title}</div>
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
                      className={`h-10 w-auto rounded cursor-pointer border-2 ${i === frameIdx ? "" : "border-transparent opacity-70 hover:opacity-100"}`}
                      style={i === frameIdx ? { borderColor: token("primary") } : undefined}
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
                className="border rounded px-2 py-0.5 hover:opacity-80 min-w-16"
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
                      <span style={done ? { color: token("primary") } : undefined}>{a.name}</span>
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
