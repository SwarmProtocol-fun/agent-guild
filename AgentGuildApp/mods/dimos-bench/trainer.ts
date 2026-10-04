/**
 * dimos-bench — the model behind "Agent drives" in the DimSim trainer.
 * Server-only (needs ANTHROPIC_API_KEY or another Anthropic credential).
 *
 * decideAction: one camera frame + pose + what the agent has learned so far →
 * one discrete move. reflect: a finished episode → a lesson for the agent's
 * memory. The agent never sees the rubric distance; it drives from the camera.
 */
import Anthropic from "@anthropic-ai/sdk";
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { clampAction, describeActions, type EpisodeStep, type SimAction, type SimPose, type SimTask } from "./training";

/**
 * Picks every move, so it's on the critical path of each step: Haiku keeps the
 * robot moving at game pace (Opus at low effort took seconds per step).
 * Haiku 4.5 takes neither `effort` nor the server-side refusal fallback.
 */
export const DRIVER_MODEL = "claude-haiku-4-5";
/** Writes the end-of-attempt lesson: once per attempt, off the critical path. */
const LESSON_MODEL = "claude-opus-5-5";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** True when the server can call Claude (any credential the SDK resolves). */
export function canDrive(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const SYSTEM = `You drive a robot through a simulated apartment (DimOS DimSim); which robot is in the first message.
Each turn you get the robot's front camera image and its pose, and you choose ONE action:
- turn: degrees to rotate in place before moving (positive = left, negative = right, -180..180)
- forward: metres to walk after turning (-1..2; small values near obstacles)
- look_around: true to spend this step turning in place and photographing all four directions instead of moving
  (turn/forward are ignored); you get the four views next turn. Use it when you are lost or boxed in, not every step.
The robot stops early if something is in the way ("blocked").
Pose: x/z in metres on the apartment floor plan, yaw in degrees. Facing yaw θ, walking forward moves the robot
by (sin θ, cos θ) in (x, z): yaw 0 walks toward +z, yaw 90 toward +x, yaw -90 toward -x, yaw 180 toward -z.
At the first step you also get a four-way panorama (front, left, back, right) to orient yourself.
Set done=true only when you believe the robot has reached the goal. Be decisive: you have a limited number of steps.
Use the lessons from earlier attempts — they come from this apartment, but the start position may differ from theirs,
so rely on where things are (coordinates, rooms, landmarks) more than on a fixed sequence of moves.`;

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string", description: "One or two sentences: what you see and why this action." },
    turn: { type: "number" },
    forward: { type: "number" },
    look_around: { type: "boolean" },
    done: { type: "boolean" },
  },
  required: ["thought", "turn", "forward", "look_around", "done"],
  additionalProperties: false,
} as const;

export interface Decision {
  thought: string;
  action: SimAction;
  /** Spend this step on a 4-way panorama instead of moving. */
  look: boolean;
  done: boolean;
}

const PANORAMA_LABELS = ["front", "left (+90°)", "back (180°)", "right (-90°)"];
type ImageBlock = { type: "image"; source: { type: "base64"; media_type: "image/jpeg"; data: string } };
const image = (data: string): ImageBlock => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });

export class DriverError extends Error {}

export async function decideAction(args: {
  agentName: string;
  task: SimTask;
  /** The robot, described: its height, camera and what it fits under (training.ts SIM_ROBOTS). */
  robot: string;
  lessons: string[];
  history: Pick<EpisodeStep, "pose" | "action" | "blocked" | "thought" | "look">[];
  jpeg: string;
  pose: SimPose;
  stepsLeft: number;
  /** Front/left/back/right views, when the agent looked around (or at the first step). */
  panorama?: string[];
  /** The camera frames before the last moves, oldest first. */
  recent?: string[];
}): Promise<Decision> {
  const { agentName, task, robot, lessons, history, jpeg, pose, stepsLeft, panorama = [], recent = [] } = args;
  const memory = lessons.length
    ? `What ${agentName} learned in earlier attempts (newest first):\n${lessons.map((l) => `- ${l}`).join("\n")}`
    : `${agentName} has no earlier attempts at this yet.`;
  const past = history.length
    ? history
        .slice(-12)
        .map((h, k) => `${k + 1}. at (${h.pose.x.toFixed(2)}, ${h.pose.z.toFixed(2)}) yaw ${h.pose.yaw}° → ${h.look ? "looked around" : `turn ${h.action.turn}°, forward ${h.action.forward} m${h.blocked ? " (blocked)" : ""}`}`)
        .join("\n")
    : "none yet";

  let response;
  try {
    response = await anthropic().beta.messages.parse({
      model: DRIVER_MODEL,
      max_tokens: 1000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { format: jsonSchemaOutputFormat(ACTION_SCHEMA) },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `You are ${agentName}, driving ${robot} Task: ${task.task}.\n\n${memory}\n\nYour moves so far this attempt:\n${past}` },
            ...(recent.length
              ? [{ type: "text" as const, text: `Your camera before your last ${recent.length === 1 ? "move" : `${recent.length} moves`} (oldest first):` }, ...recent.map(image)]
              : []),
            ...(panorama.length
              ? [{ type: "text" as const, text: "Looking around from where you stand now:" }, ...panorama.flatMap((f, k) => [{ type: "text" as const, text: PANORAMA_LABELS[k] ?? `view ${k + 1}` }, image(f)])]
              : []),
            { type: "text", text: "Your camera now:" },
            image(jpeg),
            { type: "text", text: `Current pose: x ${pose.x.toFixed(2)}, z ${pose.z.toFixed(2)}, yaw ${pose.yaw}°. Steps left: ${stepsLeft}. Choose the next action.` },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new DriverError("The model is rate limited; try again in a moment.");
    if (err instanceof Anthropic.AuthenticationError) throw new DriverError("The server's Anthropic credential was rejected.");
    if (err instanceof Anthropic.APIError) throw new DriverError(`Model error ${err.status}: ${err.message}`);
    throw err;
  }
  if (response.stop_reason === "refusal") throw new DriverError("The model declined this step.");
  const out = response.parsed_output;
  if (!out) throw new DriverError("The model returned no action.");
  const look = out.look_around === true && !out.done;
  return { thought: out.thought.slice(0, 500), action: look ? { forward: 0, turn: 0 } : clampAction(out), look, done: out.done };
}

/** A finished episode → one or two sentences the agent should remember next time. */
export async function reflect(args: {
  task: SimTask;
  robot: string;
  succeeded: boolean;
  finalDistance: number | null;
  startPose: SimPose;
  finalPose: SimPose | null;
  steps: Pick<EpisodeStep, "pose" | "action" | "blocked" | "thought" | "look">[];
}): Promise<string> {
  const { task, robot, succeeded, finalDistance, startPose, finalPose, steps } = args;
  const trace = steps
    .map((s, k) => `${k + 1}. (${s.pose.x.toFixed(2)}, ${s.pose.z.toFixed(2)}) yaw ${s.pose.yaw}° → ${s.look ? "looked around" : `turn ${s.action.turn}°, forward ${s.action.forward} m${s.blocked ? " BLOCKED" : ""}`}${s.thought ? ` — "${s.thought}"` : ""}`)
    .join("\n");
  const response = await anthropic().beta.messages.create({
    model: LESSON_MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: `A robot (${robot.replace(/\.$/, "")}) attempted "${task.task}" in a simulated apartment, starting at x ${startPose.x}, z ${startPose.z}, facing ${startPose.yaw}°.
Outcome: ${succeeded ? "SUCCESS" : "FAILED"}${finalDistance == null ? "" : `, ended ${finalDistance.toFixed(2)} m from the target`}${finalPose ? ` at x ${finalPose.x.toFixed(2)}, z ${finalPose.z.toFixed(2)}` : ""}.
Route taken: ${describeActions(steps.map((s) => s.action))}
Steps:
${trace}

Coordinates: facing yaw θ, forward moves by (sin θ, cos θ) in (x, z).
Write the single most useful lesson for the next attempt at this task, in at most two sentences, concrete enough to act on.
The next attempt may start somewhere else, so state where the target and obstacles are (x/z coordinates, which room, landmarks you saw) rather than only a sequence of turns. No preamble.`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new DriverError("The model declined to summarise.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
  return text.slice(0, 600);
}
