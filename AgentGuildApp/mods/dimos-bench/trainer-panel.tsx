"use client";

/**
 * "Train on DimSim" — dimOS's browser robot simulator (vendored under
 * public/dimsim, embed mode) inside the panel, with a choice of robot (Go2,
 * rover, humanoid: SIM_ROBOTS). You can drive it freely
 * with the keyboard, or let the agent drive with its own model: the panel
 * posts what the robot sees to the server's drive relay, the agent reads it
 * and answers with a move (agent-guild sim tools), and the panel runs it. A
 * Claude stand-in on the server can drive instead, for agents that can't.
 * Every attempt is scored with DimSim's own rubric, leaves a lesson in the
 * agent's memory, and exports as JSONL training data.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PanelProps } from "@agent-guild/sdk";
import type { Pose, RobotReplay } from "./bench";
import { RobotReplayView, token } from "./replay-view";
import { SimMap, type FloorPlan } from "./sim-map";
import {
  objectTask, recentPassRate,
  type DriveMove, type Episode, type EpisodeStatus, type EpisodeStep, type LearningPoint, type SimAction, type SimPose, type SimRobot, type SimTask,
} from "./training";

/** window.__agentGuild inside the sim iframe (mods/dimos-bench/dimsim/src/agentGuildEmbed.js). */
interface SimApi {
  ready: Promise<unknown>;
  observe(): { jpeg: string; width: number; height: number; pose: SimPose };
  act(a: Partial<SimAction>): { pose: SimPose; blocked: boolean; moved: number };
  drive(v: { forward?: number; turn?: number }): { pose: SimPose; blocked: boolean };
  reset(p: SimPose): SimPose;
  score(target: string, thresholdM: number): { passed: boolean; score: number; reason?: string };
  objects(): { id: string; title: string }[];
  panorama(): string[];
  floorPlan(): FloorPlan;
  randomStart(target: string, thresholdM: number): SimPose | null;
  setRobot(id: SimRobot): SimRobot;
}

interface SimOptions {
  tasks: SimTask[];
  robots: { id: SimRobot; label: string; about: string }[];
  agents: { id: string; name: string; orgId: string }[];
  canDrive: boolean;
  model: string;
}

type Mode = "idle" | "agent";
type Outcome = Exclude<EpisodeStatus, "running">;

const SIM_URL = "/dimsim/index.html?dimos=1&embed=1&scene=apartment";
/** Free driving (not recorded): held keys → velocity, forward m/s and turn deg/s. */
const DRIVE_KEYS: Record<string, "f" | "b" | "l" | "r"> = {
  w: "f", arrowup: "f", s: "b", arrowdown: "b", a: "l", arrowleft: "l", d: "r", arrowright: "r",
};
const DRIVE_SPEED = { f: 1, b: -0.5, l: 90, r: -90 };
const DRIVE_REFRESH_MS = 120; // camera + minimap refresh while driving
const MAX_TRAIL = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const poseOf = (s: Pick<EpisodeStep, "pose">) => s.pose;

/** The attempt worth beating: a pass in the fewest steps, else the closest finish. */
function bestEpisode(episodes: Episode[], taskId: string): Episode | null {
  const done = episodes.filter((e) => e.taskId === taskId && e.status !== "running" && e.status !== "stopped" && e.steps > 0);
  const wins = done.filter((e) => e.status === "success").sort((a, b) => a.steps - b.steps);
  if (wins.length) return wins[0];
  return done.filter((e) => e.finalDistance != null).sort((a, b) => a.finalDistance! - b.finalDistance!)[0] ?? null;
}

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
      name: s.look ? "looked around" : `turn ${s.action.turn}°, forward ${s.action.forward} m${s.blocked ? " (blocked)" : ""}`,
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
  const [robot, setRobot] = useState<SimRobot>("go2");
  const [mode, setMode] = useState<Mode>("idle");
  const [lessons, setLessons] = useState<string[]>([]);
  const [newLesson, setNewLesson] = useState<string | null>(null);
  const [camera, setCamera] = useState<string | null>(null);
  const [status, setStatus] = useState<{ step: number; distance: number | null; thought: string; blocked: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<{ episodes: Episode[]; curves: Record<string, LearningPoint[]> } | null>(null);
  const [openEpisode, setOpenEpisode] = useState<string | null>(null);
  const [objects, setObjects] = useState<{ id: string; title: string }[]>([]);
  const [plan, setPlan] = useState<FloorPlan | null>(null);
  const [randomStarts, setRandomStarts] = useState(false);
  const [trail, setTrail] = useState<SimPose[]>([]);
  const [ghost, setGhost] = useState<SimPose[]>([]);
  const [trainN, setTrainN] = useState(5);
  const [stopAfter, setStopAfter] = useState(3);
  const [training, setTraining] = useState<{ k: number; n: number; streak: number; passes: number } | null>(null);
  const stopRef = useRef(false);
  /** Cancels the own-driver loop's long-poll for the agent's next move. */
  const abortRef = useRef<AbortController | null>(null);
  const [standIn, setStandIn] = useState(false);
  const [waiting, setWaiting] = useState(false);

  /** Built-in tasks, then "go to <object>" for every object in the scene. */
  const objectTasks = useMemo(() => {
    const seen = new Map<string, number>();
    return objects
      .map((o) => {
        const t = objectTask(o.id, o.title);
        if (!t) return null;
        const n = (seen.get(t.label) ?? 0) + 1;
        seen.set(t.label, n);
        return n > 1 ? { ...t, label: `${t.label} (${n})` } : t;
      })
      .filter((t): t is SimTask => t !== null)
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [objects]);
  const task = options?.tasks.find((t) => t.id === taskId) ?? objectTasks.find((t) => t.id === taskId) ?? null;
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
      setObjects(sim.current.objects());
      try {
        const p = sim.current.floorPlan();
        setPlan(p.cells ? p : null);
      } catch {
        setPlan(null); // the minimap and random starts are extras; the sim still works
      }
      setSimState("ready");
    } catch {
      setSimState("error");
    }
  }, []);

  const loadHistory = useCallback(() => {
    if (!agentId) return;
    api(`episodes?agentId=${encodeURIComponent(agentId)}&robot=${robot}`)
      .then((r) => json<{ episodes: Episode[]; curves: Record<string, LearningPoint[]> }>(r))
      .then(setHistory)
      .catch(() => setHistory(null));
  }, [api, agentId, robot]);
  useEffect(loadHistory, [loadHistory]);

  /** Put the robot at `pose` (default: the task's start) and show what it sees. */
  const resetRobot = useCallback((pose?: SimPose) => {
    if (!sim.current || !task) return null;
    const at = sim.current.reset(pose ?? task.startPose);
    const o = sim.current.observe();
    setCamera(o.jpeg);
    setTrail([at]);
    setStatus({ step: 0, distance: sim.current.score(task.target, task.thresholdM).score, thought: "", blocked: false });
    return at;
  }, [task]);
  // Back to the start when the sim comes up or the task changes — not when an
  // attempt ends, so you can see where the robot finished.
  // Switching robots changes its look, camera and collisions in the sim, and
  // where it can go (the floor plan's reachable area), so reload the plan too.
  useEffect(() => {
    if (simState !== "ready" || !sim.current) return;
    sim.current.setRobot(robot);
    try {
      const p = sim.current.floorPlan();
      setPlan(p.cells ? p : null);
    } catch {
      setPlan(null);
    }
    resetRobot();
  }, [simState, robot, resetRobot]);

  // The best earlier attempt at this task, drawn on the minimap as a ghost trail.
  const best = useMemo(() => (history ? bestEpisode(history.episodes, taskId) : null), [history, taskId]);
  useEffect(() => {
    setGhost([]);
    if (!best) return;
    let live = true;
    api(`episodes/${best.id}?images=0`)
      .then((r) => json<{ episode: Episode; steps: EpisodeStep[] }>(r))
      .then((d) => live && setGhost([...d.steps.map(poseOf), ...(d.episode.finalPose ? [d.episode.finalPose] : [])]))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, best]);

  /** Run an agent attempt (from a random reachable pose when that's on); resolves when it ends. */
  const runAttempt = async (): Promise<Outcome | null> => {
    if (!sim.current || !task || !agentId) return null;
    setError(null);
    setNewLesson(null);
    const from = randomStarts ? sim.current.randomStart(task.target, task.thresholdM) : null;
    if (randomStarts && !from) setError("No reachable random start for this target; starting from the default pose.");
    const startPose = resetRobot(from ?? undefined);
    try {
      const d = await json<{ episode: Episode; lessons: string[] }>(
        await api("episodes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId, taskId, actor: "agent", driver: standIn ? "server" : "own", robot, startPose,
            title: task.id.startsWith("obj:") ? task.task : undefined,
            startDistance: sim.current.score(task.target, task.thresholdM).score,
          }),
        }),
      );
      setLessons(d.lessons);
      setMode("agent");
      return await (standIn ? agentLoop(d.episode) : ownLoop(d.episode));
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const start = () => {
    stopRef.current = false;
    void runAttempt();
  };

  /** Run up to n agent attempts back to back; stop early after `stopAfter` passes in a row. */
  const train = async () => {
    stopRef.current = false;
    let streak = 0, passes = 0;
    for (let k = 0; k < trainN && !stopRef.current; k++) {
      setTraining({ k: k + 1, n: trainN, streak, passes });
      const outcome = await runAttempt();
      if (outcome == null || outcome === "stopped") break;
      streak = outcome === "success" ? streak + 1 : 0;
      passes += outcome === "success" ? 1 : 0;
      if (streak >= stopAfter) break;
      await sleep(800); // a beat to see where it ended
    }
    setTraining(null);
  };

  /**
   * Observe → act → score. One agent step; returns the step to record, which
   * the loop sends with the next /act (one round trip per step). A look step
   * turns in place for a panorama instead of moving.
   */
  const step = (i: number, action: Partial<SimAction>, thought = "", look = false) => {
    const s = sim.current!;
    const before = s.observe();
    const panorama = look ? s.panorama() : [];
    const result = look ? { pose: before.pose, blocked: false } : s.act(action);
    const score = s.score(task!.target, task!.thresholdM);
    const after = s.observe();
    setCamera(after.jpeg);
    setTrail((t) => [...t, result.pose]);
    setStatus({ step: i + 1, distance: score.score, thought: look ? `${thought} (looking around)` : thought, blocked: result.blocked });
    const record = { jpeg: before.jpeg, pose: before.pose, action: { forward: action.forward ?? 0, turn: action.turn ?? 0 }, distance: score.score, blocked: result.blocked, thought, look };
    return { score, panorama, record };
  };

  const finish = async (ep: Episode, outcome: Outcome): Promise<Outcome> => {
    const s = sim.current!;
    const finalDistance = s.score(task!.target, task!.thresholdM).score;
    const finalPose = s.observe().pose;
    setMode("idle");
    try {
      const d = await json<{ episode: Episode }>(
        await api(`episodes/${ep.id}/finish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: outcome, finalDistance: Number.isFinite(finalDistance) ? finalDistance : null, finalPose }),
        }),
      );
      if (d.episode.lesson) {
        setNewLesson(d.episode.lesson);
        setLessons((ls) => [d.episode.lesson, ...ls]);
      }
    } catch (e) {
      setError((e as Error).message);
    }
    loadHistory();
    return outcome;
  };

  const agentLoop = async (ep: Episode): Promise<Outcome> => {
    const s = sim.current!;
    let panorama = s.panorama(); // orient at the start: it may be anywhere in the apartment
    let unsent: ReturnType<typeof step>["record"][] = [];
    // Steps not yet sent with an /act are flushed before the attempt is closed.
    const end = async (outcome: Outcome) => {
      if (unsent.length) {
        try {
          await json(
            await api(`episodes/${ep.id}/steps`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: unsent }) }),
          );
        } catch (e) {
          setError((e as Error).message);
        }
      }
      return finish(ep, outcome);
    };
    for (let i = 0; i < task!.maxSteps; i++) {
      if (stopRef.current) return end("stopped");
      const o = s.observe();
      let decision: { thought: string; action: SimAction; look: boolean; done: boolean };
      // The server stores these before deciding, even if the model then fails,
      // so they're never re-sent (a dropped connection loses at most this step).
      const sending = unsent;
      unsent = [];
      try {
        decision = await json(
          await api(`episodes/${ep.id}/act`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jpeg: o.jpeg, pose: o.pose, panorama, ...(sending.length ? { steps: sending } : {}) }),
          }),
        );
      } catch (e) {
        setError((e as Error).message);
        return end("stopped");
      }
      if (stopRef.current) return end("stopped");
      const r = step(i, decision.action, decision.thought, decision.look);
      unsent.push(r.record);
      panorama = r.panorama;
      if (r.score.passed) return end("success");
      if (decision.done) return end("failed"); // it thought it had arrived; the rubric disagrees
    }
    return end("failed");
  };

  /**
   * The agent drives with its own model: post what the robot sees to the
   * relay, wait for the agent's move (it calls the agent-guild sim tools),
   * run it, repeat. Each step's record rides along with the next view.
   */
  const ownLoop = async (ep: Episode): Promise<Outcome> => {
    const s = sim.current!;
    const abort = new AbortController();
    abortRef.current = abort;
    const post = async (body: object) =>
      (
        await json<{ seq: number }>(
          await api(`episodes/${ep.id}/observe`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        )
      ).seq;
    const unsent: ReturnType<typeof step>["record"][] = [];
    const end = async (outcome: Outcome) => {
      setWaiting(false);
      abortRef.current = null;
      if (unsent.length) {
        try {
          await json(
            await api(`episodes/${ep.id}/steps`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ steps: unsent }) }),
          );
        } catch (e) {
          setError((e as Error).message);
        }
      }
      return finish(ep, outcome);
    };
    try {
      const first = s.observe();
      let seq = await post({ jpeg: first.jpeg, pose: first.pose, panorama: s.panorama() }); // orient at the start
      for (let i = 0; i < task!.maxSteps; ) {
        if (stopRef.current) return end("stopped");
        setWaiting(true);
        const d = await json<{ move: DriveMove | null; ended: EpisodeStatus | null }>(
          await api(`episodes/${ep.id}/move?seq=${seq}`, { signal: abort.signal }),
        );
        if (d.ended) return end("stopped");
        if (!d.move) continue; // still thinking: ask again
        setWaiting(false);
        if (stopRef.current) return end("stopped");
        const r = step(i++, d.move.action, d.move.thought, d.move.look);
        const last = r.score.passed || d.move.done || i >= task!.maxSteps;
        if (last) {
          unsent.push(r.record);
          // done: it thought it had arrived; failed unless the rubric agrees
          return end(r.score.passed ? "success" : "failed");
        }
        const after = s.observe();
        seq = await post({ jpeg: after.jpeg, pose: after.pose, panorama: r.panorama, blocked: r.record.blocked, steps: [r.record] });
      }
      return end("failed");
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
      return end("stopped");
    }
  };

  const stop = () => {
    stopRef.current = true;
    abortRef.current?.abort();
  };

  // Idle: hold W/A/S/D or the arrows to drive in real time, watching it live.
  useEffect(() => {
    if (mode !== "idle" || training || simState !== "ready" || !task) return;
    const held = new Set<"f" | "b" | "l" | "r">();
    const vel = { forward: 0, turn: 0 };
    let timer = 0;
    const refresh = (blocked: boolean) => {
      const s = sim.current;
      if (!s) return;
      const o = s.observe();
      setCamera(o.jpeg);
      setTrail((t) => (t.length >= MAX_TRAIL ? [...t.slice(-MAX_TRAIL / 2), o.pose] : [...t, o.pose]));
      setStatus({ step: 0, distance: s.score(task.target, task.thresholdM).score, thought: "", blocked });
    };
    const apply = () => {
      vel.forward = (held.has("f") ? DRIVE_SPEED.f : 0) + (held.has("b") ? DRIVE_SPEED.b : 0);
      vel.turn = (held.has("l") ? DRIVE_SPEED.l : 0) + (held.has("r") ? DRIVE_SPEED.r : 0);
      const r = sim.current?.drive(vel);
      if (held.size && !timer) {
        // drive(vel) again just to read back the pose/blocked state; vel is current.
        timer = window.setInterval(() => refresh(sim.current?.drive(vel).blocked ?? false), DRIVE_REFRESH_MS);
      } else if (!held.size && timer) {
        window.clearInterval(timer);
        timer = 0;
        refresh(r?.blocked ?? false);
      }
    };
    const onDown = (e: KeyboardEvent) => {
      const k = DRIVE_KEYS[e.key.toLowerCase()];
      if (!k || (e.target as HTMLElement)?.closest?.("input, select, textarea")) return;
      e.preventDefault();
      if (e.repeat || held.has(k)) return;
      held.add(k);
      apply();
    };
    const onUp = (e: KeyboardEvent) => {
      const k = DRIVE_KEYS[e.key.toLowerCase()];
      if (k && held.delete(k)) apply();
    };
    const stopAll = () => {
      if (!held.size) return;
      held.clear();
      apply();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", stopAll);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", stopAll);
      window.clearInterval(timer);
      sim.current?.drive({});
    };
  }, [mode, training, simState, task]);

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
  const rate = recentPassRate(curve);
  const idle = mode === "idle" && !training;

  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        dimOS&apos;s DimSim robot simulator: a robot (Unitree Go2, a wheeled rover or a humanoid) in a furnished apartment. Drive it yourself with the
        keyboard, or let your agent drive from the robot&apos;s camera. Each agent attempt is scored by DimSim&apos;s rubric,
        teaches the agent a lesson it keeps in memory, and becomes training data.
      </p>

      {error && <p className="text-red-600">{error}</p>}

      <div className="flex flex-wrap gap-2 items-end">
        <label className="space-y-1">
          <div className="text-muted-foreground">Agent</div>
          <select className={field} value={agentId} disabled={!idle} onChange={(e) => setAgentId(e.target.value)}>
            {options?.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="space-y-1">
          <div className="text-muted-foreground">Robot</div>
          <select
            className={field}
            value={robot}
            disabled={!idle}
            title={options?.robots.find((r) => r.id === robot)?.about}
            onChange={(e) => setRobot(e.target.value as SimRobot)}
          >
            {(options?.robots ?? [{ id: "go2" as const, label: "Unitree Go2 (quadruped)", about: "" }]).map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <div className="text-muted-foreground">Task</div>
          <select className={`${field} max-w-64`} value={taskId} disabled={!idle} onChange={(e) => setTaskId(e.target.value)}>
            <optgroup label="DimSim evals">
              {options?.tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </optgroup>
            {objectTasks.length > 0 && (
              <optgroup label="Any object in the apartment">
                {objectTasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        <label className="flex items-center gap-1.5 py-1.5" title={plan ? "Start each attempt from a random reachable spot, so lessons have to transfer" : "Needs the sim's floor plan"}>
          <input type="checkbox" checked={randomStarts} disabled={!idle || !plan} onChange={(e) => setRandomStarts(e.target.checked)} />
          Random starts
        </label>
        {idle ? (
          <>
            <button
              className="rounded px-3 py-1.5 font-medium disabled:opacity-50"
              style={{ background: token("primary"), color: token("primary-foreground") }}
              disabled={simState !== "ready" || !agentId || (standIn && !options?.canDrive)}
              onClick={start}
            >
              ▶ {standIn ? "Stand-in drives" : `${agent?.name ?? "Agent"} drives`}
            </button>
            <span className="flex items-center gap-1 border rounded px-2 py-1">
              <button className="font-medium disabled:opacity-50" disabled={simState !== "ready" || !agentId || (standIn && !options?.canDrive)} onClick={() => void train()}>
                ⟳ Train ×
              </button>
              <input type="number" min={1} max={20} value={trainN} aria-label="Attempts" className="w-12 bg-transparent tabular-nums" onChange={(e) => setTrainN(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
              <span className="text-xs text-muted-foreground">stop after</span>
              <input type="number" min={1} max={20} value={stopAfter} aria-label="Passes in a row to stop after" className="w-10 bg-transparent tabular-nums" onChange={(e) => setStopAfter(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
              <span className="text-xs text-muted-foreground">passes in a row</span>
            </span>
            {options?.canDrive && (
              <label className="flex items-center gap-1.5 py-1.5" title={`A Claude model on the server (${options.model}) picks the moves instead of your agent`}>
                <input type="checkbox" checked={standIn} onChange={(e) => setStandIn(e.target.checked)} />
                Claude stand-in
              </label>
            )}
          </>
        ) : (
          <button className="border rounded px-3 py-1.5" onClick={stop}>
            ■ Stop{training ? " training" : ""}
          </button>
        )}
        {training && (
          <span className="py-1.5 text-xs text-muted-foreground tabular-nums">
            attempt {training.k}/{training.n} · {training.passes} passed · {training.streak} in a row
          </span>
        )}
      </div>
      {idle && !standIn && (
        <p className="text-xs text-muted-foreground">
          Your agent drives with its own model, through the <code>guild_sim_observe</code> and <code>guild_sim_act</code> tools
          of <code>agent-guild mcp</code> (or <code>agent-guild sim observe|act</code>). Start an attempt, then ask the agent to drive.
          Keep this tab open: the sim runs here.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-2">
          <div className="relative rounded border overflow-hidden bg-black aspect-video">
            {/* View only: keys go to the panel (real-time driving), not the sim's own WASD. */}
            <iframe ref={frame} src={SIM_URL} title="DimSim robot simulator" className="absolute inset-0 w-full h-full pointer-events-none" onLoad={onFrameLoad} />
            {simState !== "ready" && (
              <div className="absolute inset-0 grid place-items-center text-white/80 text-sm bg-black/60">
                {simState === "loading" ? "Loading the apartment and the robot (about 200 MB the first time)…" : "The simulator failed to start."}
              </div>
            )}
            {waiting && (
              <div className="absolute inset-x-2 bottom-2 rounded px-2 py-1 text-xs text-white bg-black/70">
                Waiting for {agent?.name ?? "the agent"} to move… ask it to drive the DimSim robot (<code>guild_sim_observe</code>, then{" "}
                <code>guild_sim_act</code>).
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
          {idle && simState === "ready" && (
            <p className="text-xs text-muted-foreground">
              Hold W/A/S/D or the arrow keys to drive it in real time (not recorded).
            </p>
          )}
        </div>

        <div className="space-y-3">
          {plan && task && (
            <figure className="space-y-1">
              <SimMap plan={plan} target={task.target} thresholdM={task.thresholdM} trail={trail} ghost={ghost} onPick={idle ? (id) => setTaskId(`obj:${id}`) : undefined} />
              <figcaption className="text-xs text-muted-foreground">
                Floor plan: <span style={{ color: token("primary") }}>━</span> this attempt · ┄ best attempt so far · shaded = within {task.thresholdM} m of the target.
                {idle ? " Click any object to make it the target." : ""}
              </figcaption>
            </figure>
          )}
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
          <div className="flex justify-between items-baseline gap-2">
            <div className="font-medium">Learning curve · {task?.label}</div>
            {rate.of > 0 && (
              <div className="text-xs text-muted-foreground tabular-nums">agent passed {rate.passed} of its last {rate.of}</div>
            )}
          </div>
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
