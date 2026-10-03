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

/** DimSim's apartment eval workflows (scenes/apartment/evals/*.js), as panel tasks. */
export const SIM_TASKS: SimTask[] = [
  { id: "go-to-couch", scene: "apartment", label: "Go to the couch", task: "Go to the couch", target: "sectional", thresholdM: 2.0, startPose: { x: 0, z: 3, yaw: 0 }, maxSteps: 25 },
  { id: "go-to-kitchen", scene: "apartment", label: "Go to the kitchen", task: "Go to the kitchen", target: "refrigerator", thresholdM: 3.0, startPose: { x: 0, z: 3, yaw: 0 }, maxSteps: 25 },
  { id: "go-to-tv", scene: "apartment", label: "Go to the TV", task: "Go to the TV", target: "television", thresholdM: 2.0, startPose: { x: 0, z: 3, yaw: 0 }, maxSteps: 25 },
];

export type Actor = "human" | "agent";
export type EpisodeStatus = "running" | "success" | "failed" | "stopped";

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
  model: string | null;
  status: EpisodeStatus;
  steps: number;
  startDistance: number | null;
  finalDistance: number | null;
  /** What was written to the agent's memory when it finished. */
  lesson: string;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
}

export function findTask(id: unknown): SimTask | null {
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
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, steps };
}

export function parsePoseInput(v: unknown): SimPose | null {
  return parsePose(v);
}

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
export function plainLesson(ep: Pick<Episode, "task" | "actor" | "status" | "finalDistance">, task: SimTask, actions: SimAction[]): string {
  const route = describeActions(actions);
  const start = `From the start pose (x ${task.startPose.x}, z ${task.startPose.z}, facing ${task.startPose.yaw}°)`;
  const dist = ep.finalDistance == null ? "" : `, ending ${ep.finalDistance.toFixed(2)} m from the ${task.target}`;
  if (ep.status === "success") {
    return `${ep.actor === "human" ? "Demonstration" : "Worked"} — "${ep.task}": ${start}: ${route}${dist}.`;
  }
  return `Did not work — "${ep.task}": ${start}: ${route}${dist}. Try a different route.`;
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

/** An agent's attempts at one task in order, for the learning curve. */
export function learningCurve(episodes: Episode[], taskId: string): LearningPoint[] {
  return episodes
    .filter((e) => e.taskId === taskId && e.status !== "running")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((e, k) => ({ attempt: k + 1, episodeId: e.id, actor: e.actor, status: e.status, steps: e.steps, finalDistance: e.finalDistance }));
}
