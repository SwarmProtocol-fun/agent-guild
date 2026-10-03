"use client";

/**
 * "Train on DimSim" — dimOS's browser robot simulator (vendored under
 * public/dimsim, embed mode) inside the panel. You can drive the Go2 to record
 * demonstrations, or let the agent drive: each step the server shows the
 * robot's camera frame to the model, which picks the next move. Every attempt
 * is scored with DimSim's own rubric, leaves a lesson in the agent's memory,
 * and exports as JSONL training data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelProps } from "@agent-guild/sdk";
import type { Pose, RobotReplay } from "./bench";
import { RobotReplayView, token } from "./replay-view";
import type { Episode, EpisodeStep, LearningPoint, SimAction, SimPose, SimTask } from "./training";

/** window.__agentGuild inside the sim iframe (mods/dimos-bench/dimsim/src/agentGuildEmbed.js). */
interface SimApi {
  ready: Promise<unknown>;
  observe(): { jpeg: string; width: number; height: number; pose: SimPose };
  act(a: Partial<SimAction>): { pose: SimPose; blocked: boolean; moved: number };
  reset(p: SimPose): SimPose;
  score(target: string, thresholdM: number): { passed: boolean; score: number; reason?: string };
}

interface SimOptions {
  tasks: SimTask[];
  agents: { id: string; name: string; orgId: string }[];
  canDrive: boolean;
  model: string;
}

type Mode = "idle" | "human" | "agent";

const SIM_URL = "/dimsim/index.html?dimos=1&embed=1&scene=apartment";
const HUMAN_MAX_STEPS = 60;
const KEYS: Record<string, Partial<SimAction>> = {
  w: { forward: 0.5 }, arrowup: { forward: 0.5 },
  s: { forward: -0.25 }, arrowdown: { forward: -0.25 },
  a: { turn: 30 }, arrowleft: { turn: 30 },
  d: { turn: -30 }, arrowright: { turn: -30 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error([d.error, ...(d.details ?? [])].filter(Boolean).join(" · ") || `HTTP ${r.status}`);
  return d as T;
}

/** Episode steps → the replay viewer's shape. DimSim's floor plan is x/z; the map draws z upward as -y. */
function episodeReplay(ep: Episode, steps: EpisodeStep[]): RobotReplay {
  const toMap = (p: SimPose): Pose => [0, p.x, -p.z, ((p.yaw - 90) * Math.PI) / 180];
  return {
    runId: ep.id,
    caseId: ep.taskId,
    environment: "DimSim",
    source: `${ep.scene} · ${ep.actor === "human" ? "demonstration" : `agent (${ep.model})`}`,
    path: steps.map((s, k) => {
      const [, x, y, a] = toMap(s.pose);
      return [k, x, y, a] as Pose;
    }),
    frames: steps.filter((s) => s.jpeg).map((s) => ({ t: s.i, w: 640, h: 288, jpeg: s.jpeg })),
    actions: steps.map((s) => ({
      t: s.i,
      name: `turn ${s.action.turn}°, forward ${s.action.forward} m${s.blocked ? " (blocked)" : ""}`,
      args: s.thought ? JSON.stringify(s.thought) : "{}",
    })),
    streams: [],
  };
}

/** Final distance to the target per attempt; filled = success, ring = failed, square = your demo. */
function LearningCurve({ points, threshold }: { points: LearningPoint[]; threshold: number }) {
  const W = 420, H = 150, L = 34, R = 10, T = 10, B = 24;
  const ds = points.map((p) => p.finalDistance ?? 0);
  const max = Math.max(threshold * 1.5, ...ds, 1);
  const x = (k: number) => (points.length < 2 ? L + (W - L - R) / 2 : L + (k / (points.length - 1)) * (W - L - R));
  const y = (d: number) => T + (d / max) * (H - T - B); // 0 m (arrived) at the top
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Distance to target by attempt">
      <rect x={L} y={T} width={W - L - R} height={y(threshold) - T} fill={token("primary")} opacity={0.08} />
      <line x1={L} x2={W - R} y1={y(threshold)} y2={y(threshold)} stroke={token("primary")} strokeDasharray="4 3" strokeWidth={1} />
      <text x={W - R} y={y(threshold) - 3} textAnchor="end" fontSize={9} fill={token("muted-foreground")}>goal {threshold} m</text>
      {[0, max / 2, max].map((v) => (
        <text key={v} x={L - 5} y={y(v)} textAnchor="end" dominantBaseline="middle" fontSize={9} fill={token("muted-foreground")}>{v.toFixed(1)}</text>
      ))}
      {points.length > 1 && (
        <polyline points={points.map((p, k) => `${x(k)},${y(p.finalDistance ?? max)}`).join(" ")} fill="none" stroke={token("muted-foreground")} strokeWidth={1} opacity={0.5} />
      )}
      {points.map((p, k) => {
        const cx = x(k), cy = y(p.finalDistance ?? max), ok = p.status === "success";
        return p.actor === "human" ? (
          <rect key={p.episodeId} x={cx - 4} y={cy - 4} width={8} height={8} fill={token(ok ? "primary" : "background")} stroke={token("primary")} strokeWidth={1.5}>
            <title>attempt {p.attempt} · your demo · {p.status} · {p.finalDistance?.toFixed(2)} m</title>
          </rect>
        ) : (
          <circle key={p.episodeId} cx={cx} cy={cy} r={4.5} fill={token(ok ? "primary" : "background")} stroke={token("primary")} strokeWidth={1.5}>
            <title>attempt {p.attempt} · agent · {p.status} · {p.finalDistance?.toFixed(2)} m · {p.steps} steps</title>
          </circle>
        );
      })}
      <text x={L} y={H - 6} fontSize={9} fill={token("muted-foreground")}>attempt →</text>
    </svg>
  );
}

export function TrainerPanel({ api }: PanelProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const sim = useRef<SimApi | null>(null);
  const [simState, setSimState] = useState<"loading" | "ready" | "error">("loading");
  const [options, setOptions] = useState<SimOptions | null>(null);
  const [agentId, setAgentId] = useState("");
  const [taskId, setTaskId] = useState("go-to-couch");
  const [mode, setMode] = useState<Mode>("idle");
  const [episode, setEpisode] = useState<Episode | null>(null);
  const [lessons, setLessons] = useState<string[]>([]);
  const [newLesson, setNewLesson] = useState<string | null>(null);
  const [camera, setCamera] = useState<string | null>(null);
  const [status, setStatus] = useState<{ step: number; distance: number | null; thought: string; blocked: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ episodes: Episode[]; curves: Record<string, LearningPoint[]> } | null>(null);
  const [openEpisode, setOpenEpisode] = useState<string | null>(null);
  const stopRef = useRef(false);
  const busy = useRef(false);

  const task = options?.tasks.find((t) => t.id === taskId) ?? null;
  const agent = options?.agents.find((a) => a.id === agentId) ?? null;

  useEffect(() => {
    api("sim/options")
      .then((r) => json<SimOptions>(r))
      .then((d) => {
        setOptions(d);
        setAgentId((cur) => cur || d.agents[0]?.id || "");
      })
      .catch((e: Error) => setError(e.message));
  }, [api]);

  // The sim is same-origin: wait for its embed API to come up.
  const onFrameLoad = useCallback(async () => {
    setSimState("loading");
    const win = frame.current?.contentWindow as (Window & { __agentGuild?: SimApi }) | null;
    for (let i = 0; i < 600 && !win?.__agentGuild; i++) await sleep(100);
    try {
      await win!.__agentGuild!.ready;
      sim.current = win!.__agentGuild!;
      setSimState("ready");
    } catch {
      setSimState("error");
    }
  }, []);

  const loadHistory = useCallback(() => {
    if (!agentId) return;
    api(`episodes?agentId=${encodeURIComponent(agentId)}`)
      .then((r) => json<{ episodes: Episode[]; curves: Record<string, LearningPoint[]> }>(r))
      .then(setHistory)
      .catch(() => setHistory(null));
  }, [api, agentId]);
  useEffect(loadHistory, [loadHistory]);

  const resetRobot = useCallback(() => {
    if (!sim.current || !task) return;
    sim.current.reset(task.startPose);
    const o = sim.current.observe();
    setCamera(o.jpeg);
    setStatus({ step: 0, distance: sim.current.score(task.target, task.thresholdM).score, thought: "", blocked: false });
  }, [task]);
  // Back to the start when the sim comes up or the task changes — not when an
  // attempt ends, so you can see where the robot finished.
  useEffect(() => {
    if (simState === "ready") resetRobot();
  }, [simState, resetRobot]);

  const start = async (actor: "human" | "agent") => {
    if (!sim.current || !task || !agentId) return;
    setError(null);
    setNewLesson(null);
    resetRobot();
    stopRef.current = false;
    try {
      const d = await json<{ episode: Episode; lessons: string[] }>(
        await api("episodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, taskId, actor, startDistance: sim.current.score(task.target, task.thresholdM).score }),
        }),
      );
      setEpisode(d.episode);
      setLessons(d.lessons);
      setMode(actor);
      if (actor === "agent") void agentLoop(d.episode);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Observe → act → score → record. Shared by your demo and the agent. */
  const step = async (ep: Episode, i: number, action: Partial<SimAction>, thought = "") => {
    const s = sim.current!;
    const before = s.observe();
    const result = s.act(action);
    const score = s.score(task!.target, task!.thresholdM);
    const after = s.observe();
    setCamera(after.jpeg);
    setStatus({ step: i + 1, distance: score.score, thought, blocked: result.blocked });
    await json(
      await api(`episodes/${ep.id}/steps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          steps: [{ jpeg: before.jpeg, pose: before.pose, action: { forward: action.forward ?? 0, turn: action.turn ?? 0 }, distance: score.score, blocked: result.blocked, thought }],
        }),
      }),
    );
    return score;
  };

  const finish = async (ep: Episode, outcome: "success" | "failed" | "stopped") => {
    const s = sim.current!;
    const finalDistance = s.score(task!.target, task!.thresholdM).score;
    setMode("idle");
    try {
      const d = await json<{ episode: Episode }>(
        await api(`episodes/${ep.id}/finish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: outcome, finalDistance: Number.isFinite(finalDistance) ? finalDistance : null }),
        }),
      );
      setEpisode(d.episode);
      if (d.episode.lesson) {
        setNewLesson(d.episode.lesson);
        setLessons((ls) => [d.episode.lesson, ...ls]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
    loadHistory();
  };

  const agentLoop = async (ep: Episode) => {
    const s = sim.current!;
    for (let i = 0; i < task!.maxSteps; i++) {
      if (stopRef.current) return finish(ep, "stopped");
      const o = s.observe();
      let decision: { thought: string; action: SimAction; done: boolean };
      try {
        decision = await json(
          await api(`episodes/${ep.id}/act`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jpeg: o.jpeg, pose: o.pose }),
          }),
        );
      } catch (e) {
        setError((e as Error).message);
        return finish(ep, "stopped");
      }
      if (stopRef.current) return finish(ep, "stopped");
      const score = await step(ep, i, decision.action, decision.thought);
      if (score.passed) return finish(ep, "success");
      if (decision.done) return finish(ep, "failed"); // it thought it had arrived; the rubric disagrees
    }
    return finish(ep, "failed");
  };

  const humanMove = useCallback(
    async (action: Partial<SimAction>) => {
      if (mode !== "human" || !episode || busy.current) return;
      busy.current = true;
      try {
        const i = status?.step ?? 0;
        const score = await step(episode, i, action);
        if (score.passed) await finish(episode, "success");
        else if (i + 1 >= HUMAN_MAX_STEPS) await finish(episode, "failed");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        busy.current = false;
      }
    },
    // step/finish close over the current episode and task
    [mode, episode, status, task],
  );

  useEffect(() => {
    if (mode !== "human") return;
    const onKey = (e: KeyboardEvent) => {
      const a = KEYS[e.key.toLowerCase()];
      if (!a || (e.target as HTMLElement)?.closest?.("input, select, textarea")) return;
      e.preventDefault();
      void humanMove(a);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, humanMove]);

  const download = async (images: boolean) => {
    const r = await api(`episodes/export?agentId=${encodeURIComponent(agentId)}${images ? "&images=1" : ""}`);
    if (!r.ok) return setError("Export failed");
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${agent?.name ?? "agent"}-dimsim${images ? "-images" : ""}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const loadEpisode = useMemo(
    () => async (): Promise<RobotReplay> => {
      const d = await json<{ episode: Episode; steps: EpisodeStep[] }>(await api(`episodes/${openEpisode}`));
      return episodeReplay(d.episode, d.steps);
    },
    [api, openEpisode],
  );

  const field = "border rounded px-2 py-1 bg-background";
  const curve = history?.curves[taskId] ?? [];
  const reached = status?.distance != null && task ? status.distance <= task.thresholdM : false;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        dimOS&apos;s DimSim robot simulator: a Unitree Go2 in a furnished apartment. Drive it yourself to record a
        demonstration, or let your agent drive from the robot&apos;s camera. Each attempt is scored by DimSim&apos;s rubric,
        teaches the agent a lesson it keeps in memory, and becomes training data.
      </p>

      {error && <p className="text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2 items-end">
        <label className="space-y-1">
          <div className="text-muted-foreground">Agent</div>
          <select className={field} value={agentId} disabled={mode !== "idle"} onChange={(e) => setAgentId(e.target.value)}>
            {options?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <div className="text-muted-foreground">Task</div>
          <select className={field} value={taskId} disabled={mode !== "idle"} onChange={(e) => setTaskId(e.target.value)}>
            {options?.tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        {mode === "idle" ? (
          <>
            <button
              className="rounded px-3 py-1.5 font-medium disabled:opacity-50"
              style={{ background: token("primary"), color: token("primary-foreground") }}
              disabled={simState !== "ready" || !agentId || !options?.canDrive}
              title={options && !options.canDrive ? "Set ANTHROPIC_API_KEY on the server to let agents drive" : undefined}
              onClick={() => start("agent")}
            >
              ▶ Agent drives
            </button>
            <button className="border rounded px-3 py-1.5 disabled:opacity-50" disabled={simState !== "ready" || !agentId} onClick={() => start("human")}>
              🎮 Record a demo
            </button>
          </>
        ) : (
          <button className="border rounded px-3 py-1.5" onClick={() => (mode === "agent" ? (stopRef.current = true) : episode && finish(episode, "stopped"))}>
            ■ Stop
          </button>
        )}
        {mode === "human" && episode && (
          <button className="border rounded px-3 py-1.5" onClick={() => finish(episode, "failed")}>Give up</button>
        )}
      </div>
      {options && !options.canDrive && (
        <p className="text-xs text-orange-600">
          Agent driving needs a model: set <code>ANTHROPIC_API_KEY</code> on the server. Demonstrations work without it.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-2">
          <div className="relative rounded border overflow-hidden bg-black aspect-video">
            {/* View only: keys go to the panel (demo controls), not the sim's own WASD. */}
            <iframe ref={frame} src={SIM_URL} title="DimSim robot simulator" className="absolute inset-0 w-full h-full pointer-events-none" onLoad={onFrameLoad} />
            {simState !== "ready" && (
              <div className="absolute inset-0 grid place-items-center text-white/80 text-sm bg-black/60">
                {simState === "loading" ? "Loading the apartment and the Go2 (about 200 MB the first time)…" : "The simulator failed to start."}
              </div>
            )}
            {status && task && (
              <div className="absolute left-2 top-2 rounded px-2 py-1 text-xs text-white bg-black/60 tabular-nums">
                step {status.step}
                {mode === "agent" ? `/${task.maxSteps}` : ""} · {status.distance?.toFixed(2)} m to the {task.target}
                {reached ? " ✓" : ""}
                {status.blocked ? " · blocked" : ""}
              </div>
            )}
          </div>
          {mode === "human" && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Drive with W/A/S/D or the arrow keys, or:</span>
              <button className="border rounded px-2 py-1" onClick={() => humanMove(KEYS.a)}>⟲ left 30°</button>
              <button className="border rounded px-2 py-1" onClick={() => humanMove(KEYS.w)}>↑ forward 0.5 m</button>
              <button className="border rounded px-2 py-1" onClick={() => humanMove(KEYS.s)}>↓ back 0.25 m</button>
              <button className="border rounded px-2 py-1" onClick={() => humanMove(KEYS.d)}>⟳ right 30°</button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <figure className="space-y-1">
            {camera ? (
              <img src={`data:image/jpeg;base64,${camera}`} alt="Robot camera" className="w-full h-auto rounded border bg-black" />
            ) : (
              <div className="aspect-[640/288] rounded border bg-black" />
            )}
            <figcaption className="text-xs text-muted-foreground">What the robot&apos;s camera sees (what the agent drives from)</figcaption>
          </figure>
          {mode === "agent" && status?.thought && (
            <div className="rounded border p-2 text-xs">
              <span className="font-medium">{agent?.name} thinks:</span> {status.thought}
            </div>
          )}
          <div className="rounded border p-2 space-y-1">
            <div className="font-medium">{agent?.name ?? "Agent"}&apos;s DimSim memory</div>
            {newLesson && (
              <div className="text-xs rounded px-2 py-1" style={{ background: token("muted") }}>
                <span className="font-medium">New lesson:</span> {newLesson}
              </div>
            )}
            {lessons.length ? (
              <ul className="text-xs text-muted-foreground space-y-1 max-h-36 overflow-y-auto list-disc pl-4">
                {lessons.map((l, k) => <li key={k}>{l}</li>)}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing yet. Each finished attempt adds a lesson the agent reads next time.</p>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded border p-3 space-y-2">
          <div className="font-medium">Learning curve · {task?.label}</div>
          {curve.length ? (
            task && <LearningCurve points={curve} threshold={task.thresholdM} />
          ) : (
            <p className="text-xs text-muted-foreground">No finished attempts at this task yet.</p>
          )}
          <p className="text-xs text-muted-foreground">Distance left to the target after each attempt; inside the shaded band is a pass. ● agent · ■ your demo · filled = passed.</p>
        </div>
        <div className="rounded border p-3 space-y-2">
          <div className="flex justify-between items-center">
            <div className="font-medium">Attempts</div>
            <div className="flex gap-2 text-xs">
              <button className="text-blue-500 hover:underline disabled:opacity-50" disabled={!history?.episodes.length} onClick={() => download(false)}>Export JSONL</button>
              <button className="text-blue-500 hover:underline disabled:opacity-50" disabled={!history?.episodes.length} onClick={() => download(true)}>with camera frames</button>
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto space-y-1">
            {history?.episodes.map((e) => (
              <button key={e.id} className="w-full text-left rounded px-2 py-1 hover:bg-black/5 flex justify-between gap-2" onClick={() => setOpenEpisode(e.id)}>
                <span>
                  <span className={e.status === "success" ? "text-green-600" : e.status === "failed" ? "text-red-600" : "text-muted-foreground"}>{e.status}</span>{" "}
                  · {e.task} · {e.actor === "human" ? "your demo" : "agent"} · {e.steps} steps
                </span>
                <span className="text-muted-foreground tabular-nums">{e.finalDistance != null ? `${e.finalDistance.toFixed(2)} m` : "—"}</span>
              </button>
            ))}
            {!history?.episodes.length && <p className="text-xs text-muted-foreground">Attempts you or the agent make show up here.</p>}
          </div>
        </div>
      </div>

      {openEpisode && (
        <RobotReplayView key={openEpisode} load={loadEpisode} title="Attempt replay" onClose={() => setOpenEpisode(null)} />
      )}
    </div>
  );
}
