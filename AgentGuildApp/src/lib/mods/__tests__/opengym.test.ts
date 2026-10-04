import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMod, RouteContext } from "../sdk";
import {
  computeStats,
  convertOpenGymState,
  estimate1RM,
  exerciseHistory,
  newRecords,
  parseBodyweightInput,
  parseWorkoutInput,
  weekStart,
  workoutVolumeKg,
  type Workout,
} from "../../../../mods/opengym/logbook";

const NOW = new Date("2026-10-04T12:00:00Z");

function workout(partial: Partial<Workout> & Pick<Workout, "date" | "exercises">): Workout {
  return { id: `w-${partial.date}-${Math.random()}`, orgId: "org1", name: "W", source: "agent", loggedBy: "a1", createdAt: `${partial.date}T10:00:00Z`, ...partial };
}

const squat = (weightKg: number, reps: number, extra: object = {}) => ({ name: "Back squat", key: "back squat", bodyPart: "upper legs", sets: [{ weightKg, reps, ...extra }] });

describe("parseWorkoutInput", () => {
  it("accepts a full workout and converts lb to kg", () => {
    const r = parseWorkoutInput({ date: "2026-10-01", unit: "lb", bodyweight: 200, exercises: [{ name: "  Bench   Press ", sets: [{ reps: 5, weight: 225 }] }] }, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.exercises[0]).toMatchObject({ name: "Bench   Press", key: "bench press", sets: [{ reps: 5, weightKg: 102.06 }] });
    expect(r.value.bodyweightKg).toBe(90.72);
  });

  it("expands the sets shorthand and defaults the date to today", () => {
    const r = parseWorkoutInput({ exercises: [{ name: "Squat", sets: 3, reps: 5, weight: 100 }] }, NOW);
    expect(r.ok && r.value.date).toBe("2026-10-04");
    expect(r.ok && r.value.exercises[0].sets).toHaveLength(3);
  });

  it("rejects bad input", () => {
    expect(parseWorkoutInput({ exercises: [] }, NOW).ok).toBe(false);
    expect(parseWorkoutInput({ date: "10/01/2026", exercises: [{ name: "x", sets: [{ reps: 1 }] }] }, NOW).ok).toBe(false);
    expect(parseWorkoutInput({ exercises: [{ name: "x", sets: [{ weight: 50 }] }] }, NOW).ok).toBe(false);
    expect(parseWorkoutInput({ unit: "stone", exercises: [{ name: "x", sets: [{ reps: 1 }] }] }, NOW).ok).toBe(false);
  });

  it("parses body weight", () => {
    expect(parseBodyweightInput({ weight: 80 }, NOW)).toEqual({ ok: true, value: { date: "2026-10-04", weightKg: 80 } });
    expect(parseBodyweightInput({ weight: 5 }, NOW).ok).toBe(false);
  });
});

describe("stats", () => {
  it("estimates 1RM with Epley, skipping warm-ups and high reps", () => {
    expect(estimate1RM({ reps: 1, weightKg: 100 })).toBe(100);
    expect(estimate1RM({ reps: 5, weightKg: 100 })).toBe(116.7);
    expect(estimate1RM({ reps: 15, weightKg: 100 })).toBeNull();
    expect(estimate1RM({ reps: 5, weightKg: 100, warmup: true })).toBeNull();
  });

  it("computes volume without warm-ups", () => {
    expect(workoutVolumeKg({ exercises: [{ name: "a", key: "a", sets: [{ reps: 5, weightKg: 100 }, { reps: 5, weightKg: 60, warmup: true }] }] })).toBe(500);
  });

  it("flags new records only against earlier history", () => {
    const history = [workout({ date: "2026-09-20", exercises: [squat(100, 5)] }), workout({ date: "2026-10-03", exercises: [squat(140, 3)] })];
    expect(newRecords({ date: "2026-10-04", exercises: [squat(110, 5)] }, history)).toHaveLength(0);
    // Backfilled before the 140 kg session: only the September one counts.
    expect(newRecords({ date: "2026-09-25", exercises: [squat(110, 5)] }, history).map((r) => r.e1rmKg)).toEqual([128.3]);
  });

  it("builds totals, weekly streak and a summary", () => {
    const ws = [
      workout({ date: "2026-10-03", durationMin: 60, exercises: [squat(100, 5)] }),
      workout({ date: "2026-09-24", exercises: [squat(95, 5)] }),
      workout({ date: "2026-09-16", exercises: [squat(90, 5)] }),
      workout({ date: "2026-08-01", exercises: [squat(80, 5)] }),
    ];
    const s = computeStats(ws, [{ orgId: "org1", date: "2026-09-10", weightKg: 82, source: "agent", at: "" }, { orgId: "org1", date: "2026-10-01", weightKg: 80.5, source: "agent", at: "" }], 30, NOW);
    expect(s.totals).toEqual({ workouts: 3, sets: 3, volumeKg: 1425, minutes: 60 });
    expect(s.weekStreak).toBe(3);
    expect(s.weekly).toHaveLength(8);
    expect(s.records[0]).toMatchObject({ exercise: "Back squat", e1rmKg: 116.7 });
    expect(s.bodyweight).toEqual({ latestKg: 80.5, date: "2026-10-01", change30dKg: -1.5 });
    expect(s.summary).toContain("yesterday");
  });

  it("starts weeks on Monday", () => {
    expect(weekStart("2026-10-04")).toBe("2026-09-28");
    expect(weekStart("2026-09-28")).toBe("2026-09-28");
  });

  it("returns per-exercise history", () => {
    const h = exerciseHistory([workout({ date: "2026-10-01", exercises: [squat(100, 5)] })], "BACK  squat");
    expect(h.sessions).toHaveLength(1);
    expect(h.record?.e1rmKg).toBe(116.7);
  });
});

describe("convertOpenGymState", () => {
  it("maps openGym workouts, names, units and warm-ups", () => {
    const out = convertOpenGymState({
      unit: "lb",
      customEx: [{ id: "c1", n: "Sled push", bp: "upper legs" }],
      workouts: [
        {
          id: "w1", d: "2026-10-01", name: "Push", start: Date.parse("2026-10-01T08:00:00Z"), end: Date.parse("2026-10-01T09:05:00Z"), bw: 180,
          entries: [
            { id: "0025", sets: [{ done: true, w: 135, r: 10, phase: "warmup" }, { done: true, w: 225, r: 5 }, { done: false, w: 225, r: 5 }] },
            { id: "c1", sets: [{ done: true, sec: 30 }] },
            { id: "9999x", sets: [{ done: true, r: 12 }] },
          ],
        },
        { id: "w2", d: "2026-10-02", entries: [{ id: "0025", sets: [{ done: false, w: 1, r: 1 }] }] },
      ],
      bodyweight: [{ d: "2026-10-01", w: 180 }, { d: "bad", w: 1 }],
    });
    expect(out.skipped).toBe(1);
    expect(out.workouts).toHaveLength(1);
    const w = out.workouts[0];
    expect(w).toMatchObject({ externalId: "w1", date: "2026-10-01", name: "Push", durationMin: 65, bodyweightKg: 81.65 });
    expect(w.exercises[0].sets).toEqual([{ reps: 10, weightKg: 61.23, warmup: true }, { reps: 5, weightKg: 102.06 }]);
    expect(w.exercises[0].name).not.toMatch(/openGym exercise/);
    expect(w.exercises[1]).toMatchObject({ name: "Sled push", bodyPart: "upper legs", sets: [{ seconds: 30 }] });
    expect(w.exercises[2].name).toBe("openGym exercise 9999x");
    expect(out.bodyweight).toEqual([{ date: "2026-10-01", weightKg: 81.65 }]);
  });

  it("tolerates junk", () => {
    expect(convertOpenGymState(null)).toEqual({ workouts: [], bodyweight: [], skipped: 0 });
    expect(convertOpenGymState({ workouts: [null, 3, { d: "x" }] }).skipped).toBe(3);
  });
});

// ── Routes ───────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  enforceCapability: vi.fn(async () => ({})),
  requireOrgMembershipByAddress: vi.fn(async () => ({ ok: true })),
  sendUpstream: vi.fn(),
  store: {
    workouts: [] as Workout[],
    links: new Map<string, { link: Record<string, unknown>; token: string }>(),
    bodyweight: [] as unknown[],
  },
}));

vi.mock("@/lib/skills", () => ({ enforceCapability: mocks.enforceCapability }));
vi.mock("@/lib/auth-guard", () => ({ requireOrgMembershipByAddress: mocks.requireOrgMembershipByAddress }));
vi.mock("@/lib/firestore-admin", () => ({ getOrganizationsByWalletAdmin: vi.fn(async () => [{ id: "org1", name: "Org" }]) }));
vi.mock("@/lib/vault/egress", () => ({ sendUpstream: mocks.sendUpstream }));
vi.mock("../../../../mods/opengym/store", () => {
  const s = mocks.store;
  return {
    listWorkouts: vi.fn(async (orgId: string) => s.workouts.filter((w) => w.orgId === orgId)),
    getWorkout: vi.fn(async (id: string) => s.workouts.find((w) => w.id === id) ?? null),
    saveWorkout: vi.fn(async (orgId: string, draft: object, source: string, loggedBy: string) => {
      const w = { ...draft, id: `id${s.workouts.length}`, orgId, source, loggedBy, createdAt: new Date().toISOString() } as Workout;
      s.workouts.push(w);
      return w;
    }),
    saveWorkouts: vi.fn(async (orgId: string, drafts: { externalId?: string }[]) => {
      for (const d of drafts) {
        const id = `og-${d.externalId}`;
        s.workouts = s.workouts.filter((w) => w.id !== id);
        s.workouts.push({ ...d, id, orgId, source: "opengym", loggedBy: "x", createdAt: "" } as unknown as Workout);
      }
      return drafts.length;
    }),
    deleteWorkout: vi.fn(async (id: string) => { s.workouts = s.workouts.filter((w) => w.id !== id); }),
    listBodyweight: vi.fn(async () => s.bodyweight),
    saveBodyweight: vi.fn(async (_o: string, entries: unknown[]) => { s.bodyweight.push(...entries); }),
    getLink: vi.fn(async (orgId: string) => s.links.get(orgId)?.link ?? null),
    getLinkToken: vi.fn(async (orgId: string) => s.links.get(orgId) ?? null),
    saveLink: vi.fn(async (link: { orgId: string }, token: string) => { s.links.set(link.orgId, { link, token }); }),
    markSynced: vi.fn(async () => {}),
    deleteLink: vi.fn(async (orgId: string) => { s.links.delete(orgId); }),
  };
});

let mod: ServerMod;
const log = { info: () => {}, warn: () => {}, error: () => {} };

function ctx(over: Partial<RouteContext> = {}): RouteContext {
  return { modId: "opengym", log, emit: async () => {}, params: {}, session: null, agent: { agentId: "a1", orgId: "org1" }, ...over };
}

async function call(route: string, init: { body?: unknown; url?: string; ctx?: Partial<RouteContext> } = {}) {
  const def = mod.routes![route];
  const handler = typeof def === "function" ? def : def.handler;
  const [method] = route.split(" ");
  const req = new Request(init.url ?? "http://x/api/mods/opengym/x", {
    method,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const res = await handler(req, ctx(init.ctx));
  if (res instanceof Response) return { status: res.status, body: await res.json() };
  return { status: 200, body: res as Record<string, unknown> };
}

describe("opengym routes", () => {
  beforeEach(async () => {
    mocks.store.workouts = [];
    mocks.store.bodyweight = [];
    mocks.store.links.clear();
    mocks.enforceCapability.mockReset().mockResolvedValue({});
    mocks.requireOrgMembershipByAddress.mockReset().mockResolvedValue({ ok: true });
    mocks.sendUpstream.mockReset();
    mod = (await import("../../../../mods/opengym/server")).default;
  });

  it("an agent logs a workout into its own org and gets PRs back", async () => {
    const r = await call("POST /workouts", { body: { orgId: "someone-else", exercises: [{ name: "Squat", sets: 3, reps: 5, weight: 100 }] } });
    expect(r.status).toBe(200);
    expect(r.body.workout).toMatchObject({ orgId: "org1", source: "agent", loggedBy: "a1" });
    expect(r.body.newRecords).toHaveLength(1);
    expect(mocks.enforceCapability).toHaveBeenCalledWith("a1", "org1", "opengym-log");
  });

  it("refuses an agent without the capability", async () => {
    mocks.enforceCapability.mockRejectedValueOnce(new Error("no capability"));
    const r = await call("GET /stats");
    expect(r.status).toBe(403);
  });

  it("a session must name an org it belongs to", async () => {
    const session = { address: "0xabc", role: "operator" as const };
    expect((await call("GET /stats", { ctx: { agent: null, session } })).status).toBe(400);
    mocks.requireOrgMembershipByAddress.mockResolvedValueOnce({ ok: false, error: "Not a member", status: 403 } as never);
    expect((await call("GET /stats", { url: "http://x/?orgId=org2", ctx: { agent: null, session } })).status).toBe(403);
    const ok = await call("GET /stats", { url: "http://x/?orgId=org1", ctx: { agent: null, session } });
    expect(ok.status).toBe(200);
    expect(ok.body.summary).toBe("No workouts logged yet.");
  });

  it("does not leak another org's workout", async () => {
    mocks.store.workouts.push(workout({ id: "theirs", orgId: "org2", date: "2026-10-01", exercises: [squat(100, 5)] }));
    expect((await call("GET /workouts/:id", { ctx: { params: { id: "theirs" } } })).status).toBe(404);
    expect((await call("DELETE /workouts/:id", { ctx: { params: { id: "theirs" } } })).status).toBe(404);
    expect(mocks.store.workouts).toHaveLength(1);
  });

  it("links with a pairing code and syncs idempotently", async () => {
    const session = { address: "0xabc", role: "operator" as const };
    expect((await call("POST /link", { body: { orgId: "org1", baseUrl: "gym.example.com", code: "k7wq2mzp" } })).status).toBe(403);

    mocks.sendUpstream.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ token: "tok", user: { name: "Duarte" } }), headers: {}, truncated: false });
    const linked = await call("POST /link", { body: { orgId: "org1", baseUrl: "gym.example.com/settings", code: "k7wq2mzp" }, ctx: { agent: null, session } });
    expect(linked.status).toBe(200);
    const redeem = mocks.sendUpstream.mock.calls[0][0];
    expect(redeem.url.href).toBe("https://gym.example.com/api/pair/redeem");
    expect(JSON.parse(redeem.body)).toEqual({ code: "K7WQ2MZP" });

    const state = { workouts: [{ id: "w1", d: "2026-10-01", entries: [{ id: "0025", sets: [{ done: true, w: 100, r: 5 }] }] }], bodyweight: [] };
    mocks.sendUpstream.mockResolvedValue({ status: 200, body: JSON.stringify({ state, rev: 3 }), headers: {}, truncated: false });
    const first = await call("POST /sync", { body: {} });
    await call("POST /sync", { body: {} });
    expect(first.body.imported).toEqual({ workouts: 1, bodyweight: 0, skipped: 0 });
    expect(mocks.store.workouts).toHaveLength(1);
    expect(mocks.sendUpstream.mock.calls[1][0].headers.authorization).toBe("Bearer tok");
  });

  it("reports an oversized or rejected sync clearly", async () => {
    mocks.store.links.set("org1", { link: { baseUrl: "https://gym.example.com" }, token: "tok" });
    mocks.sendUpstream.mockResolvedValueOnce({ status: 200, body: "{", headers: {}, truncated: true });
    expect((await call("POST /sync", { body: {} })).status).toBe(413);
    mocks.sendUpstream.mockResolvedValueOnce({ status: 401, body: "", headers: {}, truncated: false });
    expect((await call("POST /sync", { body: {} })).status).toBe(401);
  });

  it("imports a backup file", async () => {
    const r = await call("POST /import", { body: { state: { workouts: [{ id: "a", d: "2026-10-01", entries: [{ id: "0025", sets: [{ done: true, w: 50, r: 5 }] }] }], bodyweight: [{ d: "2026-10-01", w: 80 }] } } });
    expect(r.body.imported).toEqual({ workouts: 1, bodyweight: 1, skipped: 0 });
  });
});
