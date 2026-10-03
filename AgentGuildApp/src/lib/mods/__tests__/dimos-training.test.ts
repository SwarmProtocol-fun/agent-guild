import { describe, expect, it } from "vitest";
import {
  attemptedTaskIds, clampAction, cleanTitle, describeActions, exportLine, findTask, learningCurve, objectTask, parseFrames,
  parseDriveMove, parseSteps, plainLesson, rankLessons, recentPassRate, SIM_TASKS, MAX_EPISODE_STEPS,
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
      'Demonstration — "Go to the couch": From x 1.5, z 3.1, facing 0°: turn 90° left, forward 0.75 m, turn 45° left, forward 0.75 m, ending 1.82 m from the sectional.',
    );
    // A random start and where it ended: what carries over to the next start.
    expect(plainLesson(ep({ startPose: { x: -2, z: 1.5, yaw: 90 }, finalPose: { x: 3.1, z: 2.04, yaw: 45 } }), couch, actions)).toBe(
      'Worked — "Go to the couch": From x -2, z 1.5, facing 90°: turn 90° left, forward 0.75 m, turn 45° left, forward 0.75 m, ending 1.82 m from the sectional. It ended at x 3.1, z 2.04.',
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

  it("builds object tasks from the sim's id and (truncated) title, and finds them again", () => {
    expect(cleanTitle("Two-slice chrome toaster with browning control d...")).toBe("Two-slice chrome toaster with browning control d");
    expect(cleanTitle("Wall-mounted range hood\n...")).toBe("Wall-mounted range hood");
    const t = objectTask("59a525468c75d8-19c73105016", "Modern L-shaped sectional")!;
    expect(t).toMatchObject({ id: "obj:59a525468c75d8-19c73105016", task: "Go to the modern l-shaped sectional", target: "59a525468c75d8-19c73105016" });
    expect(findTask(t.id, t.task)).toEqual(t);
    expect(findTask("obj:../../x", "Go to the x")).toBeNull();
    expect(findTask("go-to-tv")?.target).toBe("television");
  });

  it("marks look-around steps as standing still", () => {
    const r = parseSteps({ steps: [{ pose: { x: 0, z: 3, yaw: 0 }, action: { forward: 1, turn: 30 }, look: true }] }, 0);
    expect(r.ok && r.steps[0]).toMatchObject({ look: true, action: { forward: 0, turn: 0 } });
  });

  it("accepts up to N JPEG frames", () => {
    expect(parseFrames(undefined, 4)).toEqual([]);
    expect(parseFrames([jpeg, jpeg], 4)).toEqual([jpeg, jpeg]);
    expect(parseFrames([jpeg, jpeg], 1)).toBeNull();
    expect(parseFrames(["iVBORw0KGgo="], 4)).toBeNull();
  });

  it("ranks this task's successes first, then its failures, then what worked elsewhere", () => {
    const e = (content: string, ...tags: string[]) => ({ content, tags: ["dimsim", ...tags] });
    expect(rankLessons([
      e("tv ok", "go-to-tv", "success"),
      e("couch failed", "go-to-couch", "failed"),
      { content: "not dimsim", tags: ["go-to-couch", "success"] },
      e("couch ok new", "go-to-couch", "success"),
      e("tv failed", "go-to-tv", "failed"),
      e("couch ok old", "go-to-couch", "success"),
    ], "go-to-couch")).toEqual(["couch ok new", "couch ok old", "couch failed", "tv ok", "tv failed"]);
    expect(rankLessons([e("a", "x"), e("b", "x")], "x", 1)).toEqual(["a"]);
  });

  it("lists attempted tasks after the built-ins and counts recent agent passes", () => {
    expect(attemptedTaskIds([ep({ taskId: "obj:abc" }), ep()])).toEqual([...SIM_TASKS.map((t) => t.id), "obj:abc"]);
    const pt = (status: Episode["status"], actor: Episode["actor"] = "agent") => ({ attempt: 0, episodeId: "", actor, status, steps: 1, finalDistance: 1 });
    expect(recentPassRate([pt("success", "human"), pt("failed"), pt("success"), pt("stopped"), pt("success")], 3)).toEqual({ passed: 2, of: 3 });
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

describe("parseDriveMove (an agent driving with its own model)", () => {
  it("clamps the move like the stand-in's and keeps the seq it answers", () => {
    expect(parseDriveMove({ turn: 400, forward: 5, thought: "couch ahead" }, 3)).toEqual({
      seq: 3, action: { turn: 180, forward: 2 }, look: false, done: false, thought: "couch ahead",
    });
  });

  it("a look-around doesn't move, and done wins over look", () => {
    expect(parseDriveMove({ turn: 30, forward: 1, look: true }, 1)).toMatchObject({ action: { turn: 0, forward: 0 }, look: true });
    expect(parseDriveMove({ look: true, done: true }, 1)).toMatchObject({ look: false, done: true });
  });

  it("tolerates junk", () => {
    expect(parseDriveMove(null, 2)).toEqual({ seq: 2, action: { turn: 0, forward: 0 }, look: false, done: false, thought: "" });
    expect(parseDriveMove({ thought: "x".repeat(900) }, 2).thought).toHaveLength(500);
  });
});
