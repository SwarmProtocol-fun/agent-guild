import { describe, expect, it } from "vitest";
import {
  clampAction, describeActions, exportLine, learningCurve, parseSteps, plainLesson, SIM_TASKS, MAX_EPISODE_STEPS,
  type Episode, type EpisodeStep,
} from "../../../../mods/dimos-bench/training";

const couch = SIM_TASKS.find((t) => t.id === "go-to-couch")!;
const jpeg = "/9j/4AAQSkZJRg==";
const ep = (over: Partial<Episode> = {}): Episode => ({
  id: "e1", orgId: "o1", agentId: "a1", agentName: "scout", taskId: "go-to-couch", task: "Go to the couch",
  scene: "apartment", actor: "agent", model: "claude-opus-5-5", status: "success", steps: 2,
  startDistance: 3.2, finalDistance: 1.82, lesson: "", createdBy: "0x", createdAt: "2026-10-02T00:00:00Z", finishedAt: null,
  ...over,
});

describe("DimSim training", () => {
  it("clamps actions to what the sim accepts", () => {
    expect(clampAction({ forward: 9, turn: -400 })).toEqual({ forward: 2, turn: -180 });
    expect(clampAction({ forward: -5, turn: 12.6 })).toEqual({ forward: -1, turn: 13 });
    expect(clampAction("nope")).toEqual({ forward: 0, turn: 0 });
  });

  it("describes a route with consecutive moves merged", () => {
    expect(describeActions([
      { turn: 30, forward: 0 }, { turn: 0, forward: 0.5 }, { turn: 0, forward: 0.5 }, { turn: -45, forward: 0.25 },
    ])).toBe("turn 30° left, forward 1 m, turn 45° right, forward 0.25 m");
    expect(describeActions([])).toBe("no movement");
  });

  it("validates steps, numbering them after the ones already recorded", () => {
    const ok = parseSteps({ steps: [{ jpeg, pose: { x: 0, z: 3, yaw: 0 }, action: { forward: 3 }, distance: 2.5 }] }, 4);
    expect(ok.ok && ok.steps[0]).toMatchObject({ i: 4, action: { forward: 2, turn: 0 }, distance: 2.5, blocked: false });
    expect(parseSteps({ steps: [{ pose: { x: 0 } }] }, 0).ok).toBe(false);
    expect(parseSteps({ steps: [{ jpeg: "iVBORw0KGgo=", pose: { x: 0, z: 0, yaw: 0 } }] }, 0).ok).toBe(false);
    expect(parseSteps({ steps: [{ pose: { x: 0, z: 0, yaw: 0 } }] }, MAX_EPISODE_STEPS).ok).toBe(false);
  });

  it("writes a lesson from the route without a model", () => {
    const actions = [{ turn: 90, forward: 0.75 }, { turn: 45, forward: 0.75 }];
    expect(plainLesson(ep({ actor: "human" }), couch, actions)).toBe(
      'Demonstration — "Go to the couch": From the start pose (x 0, z 3, facing 0°): turn 90° left, forward 0.75 m, turn 45° left, forward 0.75 m, ending 1.82 m from the sectional.',
    );
    expect(plainLesson(ep({ status: "failed", finalDistance: 4 }), couch, actions)).toMatch(/^Did not work.*Try a different route\.$/);
  });

  it("exports one JSONL line per step, images only when asked", () => {
    const step: EpisodeStep = { i: 0, jpeg, pose: { x: 0, z: 3, yaw: 0 }, action: { forward: 0.75, turn: 90 }, distance: 2.51, blocked: false, thought: "left is open" };
    const line = JSON.parse(exportLine(ep(), step, false));
    expect(line).toMatchObject({ instruction: "Go to the couch", outcome: "success", action: { forward: 0.75, turn: 90 }, thought: "left is open" });
    expect(line.image_jpeg_base64).toBeUndefined();
    expect(JSON.parse(exportLine(ep(), step, true)).image_jpeg_base64).toBe(jpeg);
  });

  it("orders a task's finished attempts oldest first for the learning curve", () => {
    const curve = learningCurve([
      ep({ id: "b", createdAt: "2026-10-02T02:00:00Z", finalDistance: 1.5 }),
      ep({ id: "a", createdAt: "2026-10-02T01:00:00Z", status: "failed", finalDistance: 4, actor: "human" }),
      ep({ id: "r", createdAt: "2026-10-02T03:00:00Z", status: "running" }),
      ep({ id: "t", taskId: "go-to-tv" }),
    ], "go-to-couch");
    expect(curve.map((p) => [p.attempt, p.episodeId, p.actor])).toEqual([[1, "a", "human"], [2, "b", "agent"]]);
  });
});
