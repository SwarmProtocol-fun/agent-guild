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

export const DRIVER_MODEL = "claude-opus-5-5";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/** True when the server can call Claude (any credential the SDK resolves). */
export function canDrive(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

const SYSTEM = `You drive a Unitree Go2 quadruped robot through a simulated apartment (DimOS DimSim).
Each turn you get the robot's front camera image and its pose, and you choose ONE action:
- turn: degrees to rotate in place before moving (positive = left, negative = right, -180..180)
- forward: metres to walk after turning (-1..2; small values near obstacles)
The robot stops early if something is in the way ("blocked"). Pose: x/z in metres on the floor plan, yaw in degrees.
Set done=true only when you believe the robot has reached the goal. Be decisive: you have a limited number of steps.
Use the lessons from earlier attempts — they come from this exact apartment and start position.`;

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    thought: { type: "string", description: "One or two sentences: what you see and why this action." },
    turn: { type: "number" },
    forward: { type: "number" },
    done: { type: "boolean" },
  },
  required: ["thought", "turn", "forward", "done"],
  additionalProperties: false,
} as const;

export interface Decision {
  thought: string;
  action: SimAction;
  done: boolean;
}

export class DriverError extends Error {}

export async function decideAction(args: {
  agentName: string;
  task: SimTask;
  lessons: string[];
  history: Pick<EpisodeStep, "pose" | "action" | "blocked" | "thought">[];
  jpeg: string;
  pose: SimPose;
  stepsLeft: number;
}): Promise<Decision> {
  const { agentName, task, lessons, history, jpeg, pose, stepsLeft } = args;
  const memory = lessons.length
    ? `What ${agentName} learned in earlier attempts (newest first):\n${lessons.map((l) => `- ${l}`).join("\n")}`
    : `${agentName} has no earlier attempts at this yet.`;
  const past = history.length
    ? history
        .slice(-12)
        .map((h, k) => `${k + 1}. at (${h.pose.x.toFixed(2)}, ${h.pose.z.toFixed(2)}) yaw ${h.pose.yaw}° → turn ${h.action.turn}°, forward ${h.action.forward} m${h.blocked ? " (blocked)" : ""}`)
        .join("\n")
    : "none yet";

  let response;
  try {
    response = await anthropic().beta.messages.parse({
      model: DRIVER_MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: jsonSchemaOutputFormat(ACTION_SCHEMA) },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `You are ${agentName}. Task: ${task.task}.\n\n${memory}\n\nYour moves so far this attempt:\n${past}` },
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg } },
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
  return { thought: out.thought.slice(0, 500), action: clampAction(out), done: out.done };
}

/** A finished episode → one or two sentences the agent should remember next time. */
export async function reflect(args: {
  task: SimTask;
  succeeded: boolean;
  finalDistance: number | null;
  steps: Pick<EpisodeStep, "pose" | "action" | "blocked" | "thought">[];
}): Promise<string> {
  const { task, succeeded, finalDistance, steps } = args;
  const trace = steps
    .map((s, k) => `${k + 1}. (${s.pose.x.toFixed(2)}, ${s.pose.z.toFixed(2)}) yaw ${s.pose.yaw}° → turn ${s.action.turn}°, forward ${s.action.forward} m${s.blocked ? " BLOCKED" : ""}${s.thought ? ` — "${s.thought}"` : ""}`)
    .join("\n");
  const response = await anthropic().beta.messages.create({
    model: DRIVER_MODEL,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    messages: [
      {
        role: "user",
        content: `A robot attempted "${task.task}" in a simulated apartment, starting at x ${task.startPose.x}, z ${task.startPose.z}, facing ${task.startPose.yaw}°.
Outcome: ${succeeded ? "SUCCESS" : "FAILED"}${finalDistance == null ? "" : `, ended ${finalDistance.toFixed(2)} m from the ${task.target}`}.
Route taken: ${describeActions(steps.map((s) => s.action))}
Steps:
${trace}

Write the single most useful lesson for the next attempt at this task, in at most two sentences, concrete enough to act on (headings, distances, obstacles). No preamble.`,
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new DriverError("The model declined to summarise.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ").trim();
  return text.slice(0, 600);
}
