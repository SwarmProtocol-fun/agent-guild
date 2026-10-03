/**
 * dimos-bench — training on DimSim, pure logic (no Firestore, no model calls).
 *
 * An episode is one attempt at a DimSim task in the panel, driven either by a
 * person (a demonstration) or by the agent (a vision model picks each action
 * from the robot's camera frame). Every step is recorded as
 * (camera frame, pose, action), scored by DimSim's own objectDistance rubric.
 * What an episode teaches is written to the agent's memory, and episodes
 * export as JSONL for fine-tuning.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export const MAX_EPISODE_STEPS = 60;
export const MAX_STEP_JPEG_B64 = 60_000;
const JPEG_B64_RE = /^\/9j\/[A-Za-z0-9+/]+=*$/;

export interface SimTask {
  id: string;
  scene: string;
  label: string;
  /** The instruction the agent is given. */
  task: string;
  /** DimSim asset the rubric measures to, and the pass distance. */
  target: string;
  thresholdM: number;
  startPose: { x: number; z: number; yaw: number };
  maxSteps: number;
}

/**
 * Open floor in the main room. DimSim's evals start at (0, 3), which is under
 * the kitchen table. Keep in sync with DEFAULT_START in dimsim/src/agentGuildEmbed.js.
 */
const APARTMENT_START = { x: 1.5, z: 3.1, yaw: 0 };

/** DimSim's apartment eval workflows (scenes/apartment/evals/*.js), as panel tasks. */
export const SIM_TASKS: SimTask[] = [
  { id: "go-to-couch", scene: "apartment", label: "Go to the couch", task: "Go to the couch", target: "sectional", thresholdM: 2.0, startPose: APARTMENT_START, maxSteps: 25 },
  { id: "go-to-kitchen", scene: "apartment", label: "Go to the kitchen", task: "Go to the kitchen", target: "refrigerator", thresholdM: 3.0, startPose: APARTMENT_START, maxSteps: 25 },
  { id: "go-to-tv", scene: "apartment", label: "Go to the TV", task: "Go to the TV", target: "television", thresholdM: 2.0, startPose: APARTMENT_START, maxSteps: 25 },
];

export type Actor = "human" | "agent";
export type EpisodeStatus = "running" | "success" | "failed" | "stopped";
export type Driver = "own" | "server";

/** What the robot sees after a move, as the panel posts it to the drive relay. */
export interface DriveObservation {
  /** Increments with every observation; the agent's move must name the one it answers. */
  seq: number;
  jpeg: string;
  pose: SimPose;
  /** Front/left/back/right views: at the start, and after a look-around. */
  panorama: string[];
  /** Whether the last move stopped short of an obstacle. */
  blocked: boolean;
}

/** The agent's move, waiting for the panel to run it. */
export interface DriveMove {
  seq: number;
  action: SimAction;
  look: boolean;
  done: boolean;
  thought: string;
}

/**
 * The relay between an open panel (which runs the sim) and the agent driving
 * it with its own model: one document per own-driver attempt.
 */
export interface DriveRelay {
  episodeId: string;
  agentId: string;
  orgId: string;
  obs: DriveObservation | null;
  move: DriveMove | null;
  /** Set when the attempt ends. */
  ended: EpisodeStatus | null;
  updatedAt: string;
}

/** The agent's move from a request body: the same limits as the stand-in's. */
export function parseDriveMove(b: unknown, seq: number): DriveMove {
  const o = isObj(b) ? b : {};
  const look = o.look === true && o.done !== true;
  return {
    seq,
    action: look ? { forward: 0, turn: 0 } : clampAction(o),
    look,
    done: o.done === true,
    thought: typeof o.thought === "string" ? o.thought.slice(0, 500) : "",
  };
}

export interface SimPose {
  x: number;
  z: number;
  /** degrees */
  yaw: number;
}

export interface SimAction {
  /** metres, negative = back up */
  forward: number;
  /** degrees, positive = left */
  turn: number;
}

export interface EpisodeStep {
  i: number;
  /** Robot camera frame before the action, base64 JPEG. */
  jpeg: string;
  pose: SimPose;
  action: SimAction;
  /** Rubric distance to the target after the action (metres). */
  distance: number | null;
  blocked: boolean;
  /** The agent's reasoning for this action (agent episodes). */
  thought: string;
  /** The agent spent this step looking around (4-way panorama) instead of moving. */
  look?: boolean;
}

export interface Episode {
  id: string;
  orgId: string;
  agentId: string;
  agentName: string;
  taskId: string;
  task: string;
  scene: string;
  actor: Actor;
  /**
   * Who picks an agent attempt's moves: "own" — the agent itself, with its own
   * model, through the drive relay (agent-guild sim tools); "server" — a Claude
   * stand-in on the server. Absent on older episodes, which were all "server".
   */
  driver?: Driver;
  model: string | null;
  status: EpisodeStatus;
  steps: number;
  startDistance: number | null;
  finalDistance: number | null;
  /** What was written to the agent's memory when it finished. */
  lesson: string;
  /** Where the attempt started (random starts) and ended; absent on older episodes. */
  startPose?: SimPose | null;
  finalPose?: SimPose | null;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
}

/** A scene object as a target: task id `obj:<assetId>`; the rubric matches the asset by id. */
export const OBJECT_TASK_PREFIX = "obj:";
const ASSET_ID_RE = /^[\w-]{1,64}$/;
const OBJECT_THRESHOLD_M = 1.5;

/** DimSim titles are often truncated captions ("Two-slice chrome toaster with browning control d..."). */
export function cleanTitle(title: string): string {
  return title.split("\n")[0].replace(/\.{3}$/, "").trim().slice(0, 80);
}

/** A "go to this object" task, from the asset's id and title as the sim reports them. */
export function objectTask(assetId: string, title: string): SimTask | null {
  const name = cleanTitle(title);
  if (!ASSET_ID_RE.test(assetId) || !name) return null;
  return {
    id: `${OBJECT_TASK_PREFIX}${assetId}`,
    scene: "apartment",
    label: `Go to the ${name.toLowerCase()}`,
    task: `Go to the ${name.toLowerCase()}`,
    target: assetId,
    thresholdM: OBJECT_THRESHOLD_M,
    startPose: SIM_TASKS[0].startPose,
    maxSteps: 30,
  };
}

/** A built-in task, or an object task when `title` is given (episodes keep it as their `task` text). */
export function findTask(id: unknown, title?: string): SimTask | null {
  if (typeof id === "string" && id.startsWith(OBJECT_TASK_PREFIX)) {
    const name = title?.replace(/^Go to the /i, "") ?? "";
    return objectTask(id.slice(OBJECT_TASK_PREFIX.length), name);
  }
  return SIM_TASKS.find((t) => t.id === id) ?? null;
}

function parsePose(v: unknown): SimPose | null {
  if (!isObj(v) || !finite(v.x) || !finite(v.z) || !finite(v.yaw)) return null;
  return { x: v.x, z: v.z, yaw: v.yaw };
}

/** Clamp an action to what the sim accepts: ≤2 m forward, ≤1 m back, ±180°. */
export function clampAction(v: unknown): SimAction {
  const o = isObj(v) ? v : {};
  const forward = finite(o.forward) ? Math.min(2, Math.max(-1, o.forward)) : 0;
  const turn = finite(o.turn) ? Math.min(180, Math.max(-180, o.turn)) : 0;
  return { forward: Math.round(forward * 100) / 100, turn: Math.round(turn) };
}

/** Validate recorded steps (POST /episodes/:id/steps). */
export function parseSteps(body: unknown, from: number):
  | { ok: true; steps: EpisodeStep[] }
  | { ok: false; errors: string[] } {
  const raw = isObj(body) && Array.isArray(body.steps) ? body.steps : null;
  if (!raw || !raw.length) return { ok: false, errors: ["steps must be a non-empty array"] };
  if (from + raw.length > MAX_EPISODE_STEPS) return { ok: false, errors: [`an episode has at most ${MAX_EPISODE_STEPS} steps`] };
  const errors: string[] = [];
  const steps: EpisodeStep[] = [];
  raw.forEach((s, k) => {
    const pose = isObj(s) ? parsePose(s.pose) : null;
    if (!isObj(s) || !pose) return errors.push(`steps[${k}] needs a pose {x, z, yaw}`);
    const jpeg = typeof s.jpeg === "string" ? s.jpeg : "";
    if (jpeg && (jpeg.length > MAX_STEP_JPEG_B64 || !JPEG_B64_RE.test(jpeg))) return errors.push(`steps[${k}].jpeg must be a base64 JPEG under ${MAX_STEP_JPEG_B64} chars`);
    steps.push({
      i: from + k,
      jpeg,
      pose,
      action: clampAction(s.action),
      distance: finite(s.distance) ? s.distance : null,
      blocked: s.blocked === true,
      thought: typeof s.thought === "string" ? s.thought.slice(0, 500) : "",
      ...(s.look === true ? { look: true, action: { forward: 0, turn: 0 } } : {}),
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, steps };
}

export function parsePoseInput(v: unknown): SimPose | null {
  return parsePose(v);
}

/** Up to `max` base64 JPEG frames (panorama views, recent frames), or null if any is malformed. */
export function parseFrames(v: unknown, max: number): string[] | null {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  return v.every((f) => typeof f === "string" && f.length <= MAX_STEP_JPEG_B64 && JPEG_B64_RE.test(f)) ? (v as string[]) : null;
}

export interface LessonEntry {
  content: string;
  tags?: string[];
}

/**
 * Which lessons the driver reads, newest-first input: this task's successes,
 * then its failures, then what worked on other tasks (where things are in the
 * apartment carries over), then the rest.
 */
export function rankLessons(entries: LessonEntry[], taskId: string, max = 8): string[] {
  const rank = (e: LessonEntry) => {
    const mine = e.tags?.includes(taskId) ?? false;
    const ok = e.tags?.includes("success") ?? false;
    return mine ? (ok ? 0 : 1) : ok ? 2 : 3;
  };
  return entries
    .filter((e) => e.tags?.includes("dimsim"))
    .map((e, k) => ({ e, k, r: rank(e) }))
    .sort((a, b) => a.r - b.r || a.k - b.k)
    .slice(0, max)
    .map(({ e }) => e.content);
}

const fmtPose = (p: SimPose) => `x ${+p.x.toFixed(2)}, z ${+p.z.toFixed(2)}, facing ${Math.round(p.yaw)}°`;

/** "turn 90° left, forward 1.5 m, …" — consecutive moves merged, for memory and prompts. */
export function describeActions(actions: SimAction[]): string {
  const parts: string[] = [];
  let fwd = 0;
  const flush = () => {
    if (Math.abs(fwd) > 1e-6) parts.push(fwd > 0 ? `forward ${+fwd.toFixed(2)} m` : `back ${+(-fwd).toFixed(2)} m`);
    fwd = 0;
  };
  for (const a of actions) {
    if (a.turn) {
      flush();
      parts.push(`turn ${Math.abs(a.turn)}° ${a.turn > 0 ? "left" : "right"}`);
    }
    fwd += a.forward;
  }
  flush();
  return parts.join(", ") || "no movement";
}

/** The memory entry a finished episode leaves, without a model call (demos, or no API key). */
export function plainLesson(
  ep: Pick<Episode, "task" | "actor" | "status" | "finalDistance" | "startPose" | "finalPose">,
  task: SimTask,
  actions: SimAction[],
): string {
  const route = describeActions(actions.filter((a) => a.forward || a.turn));
  const start = `From ${fmtPose(ep.startPose ?? task.startPose)}`;
  const target = task.id.startsWith(OBJECT_TASK_PREFIX) ? "target" : task.target;
  const dist = ep.finalDistance == null ? "" : `, ending ${ep.finalDistance.toFixed(2)} m from the ${target}`;
  // Where it ended is what transfers to a different start.
  const end = ep.finalPose ? ` It ended at x ${+ep.finalPose.x.toFixed(2)}, z ${+ep.finalPose.z.toFixed(2)}.` : "";
  if (ep.status === "success") {
    return `${ep.actor === "human" ? "Demonstration" : "Worked"} — "${ep.task}": ${start}: ${route}${dist}.${end}`;
  }
  return `Did not work — "${ep.task}": ${start}: ${route}${dist}.${end} Try a different route.`;
}

/** One JSONL line per step: what a fine-tuning or imitation pipeline needs. */
export function exportLine(ep: Episode, step: EpisodeStep, withImages: boolean): string {
  return JSON.stringify({
    episode_id: ep.id,
    agent_id: ep.agentId,
    task_id: ep.taskId,
    instruction: ep.task,
    scene: ep.scene,
    actor: ep.actor,
    model: ep.model,
    outcome: ep.status,
    step: step.i,
    pose: step.pose,
    action: step.action,
    thought: step.thought || undefined,
    look: step.look || undefined,
    start_pose: ep.startPose ?? undefined,
    distance_to_target: step.distance,
    blocked: step.blocked,
    image_jpeg_base64: withImages && step.jpeg ? step.jpeg : undefined,
  });
}

export interface LearningPoint {
  attempt: number;
  episodeId: string;
  actor: Actor;
  status: EpisodeStatus;
  steps: number;
  finalDistance: number | null;
}

/** Every task an agent has attempted, built-in tasks first. */
export function attemptedTaskIds(episodes: Episode[]): string[] {
  const ids = new Set(SIM_TASKS.map((t) => t.id));
  for (const e of episodes) ids.add(e.taskId);
  return [...ids];
}

/** Agent passes among its last `n` finished attempts at a task. */
export function recentPassRate(points: LearningPoint[], n = 10): { passed: number; of: number } {
  const recent = points.filter((p) => p.actor === "agent" && p.status !== "stopped").slice(-n);
  return { passed: recent.filter((p) => p.status === "success").length, of: recent.length };
}

/** An agent's attempts at one task in order, for the learning curve. */
export function learningCurve(episodes: Episode[], taskId: string): LearningPoint[] {
  return episodes
    .filter((e) => e.taskId === taskId && e.status !== "running")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((e, k) => ({ attempt: k + 1, episodeId: e.id, actor: e.actor, status: e.status, steps: e.steps, finalDistance: e.finalDistance }));
}
