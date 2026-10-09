// @vitest-environment node
/**
 * jobs-admin lifecycle against an in-memory Firestore fake that implements
 * the parts these helpers use — including optimistic transactions that
 * retry when a document they read changed, like the real thing, so claim
 * races behave as they would in production.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Data = Record<string, unknown>;
const db = { cols: new Map<string, Map<string, { data: Data; v: number }>>(), nextId: 1 };

const op = (o: Data) => ({ __op: o });
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    serverTimestamp: () => op({ kind: "ts" }),
    delete: () => op({ kind: "del" }),
    increment: (n: number) => op({ kind: "inc", n }),
    arrayUnion: (...v: unknown[]) => op({ kind: "union", v }),
  },
}));

function apply(existing: Data, patch: Data): Data {
  const out = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    const o = (v as { __op?: Data })?.__op;
    if (!o) out[k] = v;
    else if (o.kind === "ts") out[k] = Date.now();
    else if (o.kind === "del") delete out[k];
    else if (o.kind === "inc") out[k] = ((out[k] as number) ?? 0) + (o.n as number);
    else if (o.kind === "union") out[k] = [...((out[k] as unknown[]) ?? []), ...(o.v as unknown[])];
  }
  return out;
}

const col = (name: string) => {
  if (!db.cols.has(name)) db.cols.set(name, new Map());
  return db.cols.get(name)!;
};

function docRef(name: string, id: string) {
  return {
    __col: name,
    id,
    async get() {
      const e = col(name).get(id);
      return { exists: !!e, id, data: () => (e ? { ...e.data } : undefined), __v: e?.v ?? 0 };
    },
    async update(patch: Data) {
      const e = col(name).get(id);
      if (!e) throw new Error(`NOT_FOUND: ${name}/${id}`);
      col(name).set(id, { data: apply(e.data, patch), v: e.v + 1 });
    },
    async create(data: Data) {
      await Promise.resolve(); // let a concurrent create interleave
      if (col(name).has(id)) throw Object.assign(new Error(`6 ALREADY_EXISTS: ${name}/${id}`), { code: 6 });
      col(name).set(id, { data: apply({}, data), v: 1 });
    },
  };
}

type Order = { field: string; dir: "asc" | "desc" } | null;
type Shape = { filters: [string, string, unknown][]; order: Order; max: number | null; after: string | null };

function query(name: string, shape: Shape = { filters: [], order: null, max: null, after: null }) {
  return {
    where: (f: string, o: string, v: unknown) => query(name, { ...shape, filters: [...shape.filters, [f, o, v]] }),
    orderBy: (field: string, dir: "asc" | "desc" = "asc") => query(name, { ...shape, order: { field, dir } }),
    limit: (n: number) => {
      if (n < 1) throw new Error("limit must be positive"); // as the real SDK
      return query(name, { ...shape, max: n });
    },
    startAfter: (snap: { id: string }) => query(name, { ...shape, after: snap.id }),
    async get() {
      let rows = [...col(name).entries()]
        .filter(([, e]) => shape.filters.every(([f, o, v]) => (o === "in" ? (v as unknown[]).includes(e.data[f]) : e.data[f] === v)));
      if (shape.order) {
        const { field, dir } = shape.order;
        // Real Firestore drops docs missing the orderBy field and tie-breaks on doc id.
        rows = rows.filter(([, e]) => e.data[field] !== undefined).sort(([ia, a], [ib, b]) => {
          const d = (a.data[field] as number) - (b.data[field] as number) || ia.localeCompare(ib);
          return dir === "asc" ? d : -d;
        });
      }
      if (shape.after) rows = rows.slice(rows.findIndex(([id]) => id === shape.after) + 1);
      if (shape.max !== null) rows = rows.slice(0, shape.max);
      const docs = rows.map(([id, e]) => ({ id, ref: docRef(name, id), data: () => ({ ...e.data }) }));
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}

const adminDbFake = {
  collection: (name: string) => ({
    doc: (id: string) => docRef(name, id),
    where: (f: string, o: string, v: unknown) => query(name).where(f, o, v),
    async add(data: Data) {
      const id = `${name}-${db.nextId++}`;
      col(name).set(id, { data: apply({}, data), v: 1 });
      return { id };
    },
  }),
  batch() {
    const ops: [ReturnType<typeof docRef>, Data][] = [];
    return { update: (r: ReturnType<typeof docRef>, p: Data) => { ops.push([r, p]); }, commit: async () => { for (const [r, p] of ops) await r.update(p); } };
  },
  async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reads: [ReturnType<typeof docRef>, number][] = [];
      const writes: [ReturnType<typeof docRef>, Data][] = [];
      const tx = {
        get: async (r: ReturnType<typeof docRef>) => { const s = await r.get(); reads.push([r, s.__v]); return s; },
        update: (r: ReturnType<typeof docRef>, p: Data) => { writes.push([r, p]); },
        create: (r: ReturnType<typeof docRef>, p: Data) => {
          if (col(r.__col).has(r.id)) throw Object.assign(new Error("6 ALREADY_EXISTS"), { code: 6 });
          writes.push([r, p]);
        },
      };
      const result = await fn(tx);
      await Promise.resolve(); // let a concurrent transaction interleave, as on a real backend
      const stale = reads.some(([r, v]) => (col(r.__col).get(r.id)?.v ?? 0) !== v);
      if (stale) continue;
      for (const [r, p] of writes) {
        const e = col(r.__col).get(r.id);
        col(r.__col).set(r.id, { data: apply(e?.data ?? {}, p), v: (e?.v ?? 0) + 1 });
      }
      return result;
    }
    throw new Error("ABORTED: too much contention");
  },
};

vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => adminDbFake }));
vi.mock("@/lib/firestore-admin", () => ({ getJobsByOrg: async () => [] }));
vi.mock("@/lib/agent-policy", () => ({ resolveAgentPolicy: async () => ({ ok: false }) }));
vi.mock("@/lib/credit-policy-settings-admin", () => ({
  adminPolicyLoaders: {},
  getCreditPolicyConfig: async () => ({ enforcementEnabled: false }),
  recordPolicyEvent: async () => {},
}));

import {
  applyToJob,
  cancelJob,
  claimJob,
  createJob,
  dispatchJob,
  rateJob,
  reopenJob,
  sweepReviews,
  getJob,
  hireApplicant,
  reviewDelivery,
  submitJobDelivery,
  updateOpenJob,
  getJobApplications,
  listOrgJobsByStatus,
  getJobsAssignedToAgent,
} from "@/lib/jobs-admin";
import { getJobEvents } from "@/lib/job-audit";
import { JobActionError } from "@/lib/job-lifecycle";

const user = { type: "user" as const, id: "0xposter" };
const events = async (jobId: string) => (await getJobEvents(jobId)).map((e) => e.type);

async function postJob(extra: Partial<Parameters<typeof createJob>[0]> = {}) {
  return createJob(
    { title: "Write docs", description: "d", requiredSkills: [], priority: "medium", projectId: "p1", hiringMode: "instant", ...extra },
    { orgId: "org1", postedByAddress: "0xposter" },
    user,
  );
}

beforeEach(() => {
  db.cols.clear();
  col("agents").set("agentA", { data: { name: "Ada", orgId: "org1", tasksCompleted: 2 }, v: 1 });
  col("agents").set("agentB", { data: { name: "Bob", orgId: "org1" }, v: 1 });
  col("agents").set("agentC", { data: { name: "Cy", orgId: "org1" }, v: 1 });
  col("agents").set("outsider", { data: { name: "Eve", orgId: "org2" }, v: 1 });
});

const input = { title: "Ship it", description: "d", requiredSkills: [], priority: "high" as const, projectId: "p1", hiringMode: "instant" as const };
const tasksFor = (jobId: string) => [...col("tasks").values()].filter((t) => t.data.jobId === jobId).map((t) => t.data);

describe("jobs-admin lifecycle", () => {
  it("runs post → claim → deliver → send back → redeliver → approve, with a full audit trail", async () => {
    const jobId = await postJob({ reward: "100" });
    expect(await getJob(jobId)).toMatchObject({ status: "open", postedByAddress: "0xposter", applicationCount: 0 });

    const taskId = await claimJob(jobId, "agentA", "org1", "p1", "Ada");
    expect(await getJob(jobId)).toMatchObject({ status: "in_progress", takenByAgentId: "agentA", taskId });
    expect(col("tasks").get(taskId)?.data).toMatchObject({ assigneeAgentId: "agentA", status: "todo", jobId });

    await submitJobDelivery(jobId, { deliveryNotes: "v1", completedByAgentName: "Ada" });
    expect(await getJob(jobId)).toMatchObject({ status: "completed", reviewStatus: "pending" });

    await reviewDelivery(jobId, { approve: false, notes: "tighten intro" }, user);
    expect(await getJob(jobId)).toMatchObject({ status: "in_progress", reviewStatus: "rejected", reviewNotes: "tighten intro" });
    expect(col("agents").get("agentA")?.data.tasksCompleted).toBe(2);

    await submitJobDelivery(jobId, { deliveryNotes: "v2", deliveryFiles: ["https://x.io/a"], completedByAgentName: "Ada" });
    const approved = await reviewDelivery(jobId, { approve: true, notes: "" }, user);
    expect(approved).toMatchObject({ status: "completed", reviewStatus: "approved", reviewedBy: "0xposter" });
    expect(approved.reviewNotes).toBeUndefined();
    expect(approved.reviewHistory?.map((r) => r.status)).toEqual(["rejected", "approved"]);
    expect(approved.deliveryHistory?.map((d) => d.notes)).toEqual(["v1", "v2"]);

    // Approval credits the agent (what minCompletedJobs gates on) and closes the task.
    expect(col("agents").get("agentA")?.data.tasksCompleted).toBe(3);
    expect(col("tasks").get(taskId)?.data.status).toBe("done");

    expect(await events(jobId)).toEqual(["created", "claimed", "delivered", "revision_requested", "delivered", "approved"]);
    const trail = await getJobEvents(jobId);
    expect(trail[4].details).toMatchObject({ revision: 2, fileCount: 1 });
    expect(trail[1].actor).toEqual({ type: "agent", id: "agentA", name: "Ada" });
    expect(trail[5].actor).toEqual(user);
  });

  it("lets only one of two racing claims win", async () => {
    const jobId = await postJob();
    const results = await Promise.allSettled([
      claimJob(jobId, "agentA", "org1", "p1", "Ada"),
      claimJob(jobId, "agentB", "org1", "p1", "Bob"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(JobActionError);
    expect(loser.reason.status).toBe(409);
    expect(col("tasks").size).toBe(1);
  });

  it("refuses to review twice, or before anything is delivered", async () => {
    const jobId = await postJob();
    await expect(reviewDelivery(jobId, { approve: true, notes: "" }, user)).rejects.toMatchObject({ status: 409 });
    await claimJob(jobId, "agentA", "org1", "p1", "Ada");
    await submitJobDelivery(jobId, { deliveryNotes: "v1", completedByAgentName: "Ada" });
    await reviewDelivery(jobId, { approve: true, notes: "" }, user);
    await expect(reviewDelivery(jobId, { approve: true, notes: "" }, user)).rejects.toMatchObject({ status: 409 });
    expect(col("agents").get("agentA")?.data.tasksCompleted).toBe(3);
  });

  it("edits only open jobs and logs a from→to diff", async () => {
    const jobId = await postJob({ reward: "10" });
    await updateOpenJob(jobId, { priority: "high", reward: undefined, title: "Write docs" }, user);
    const job = await getJob(jobId);
    expect(job?.priority).toBe("high");
    expect(job?.reward).toBeUndefined();
    const edited = (await getJobEvents(jobId)).find((e) => e.type === "edited");
    expect(edited?.details).toEqual({ changes: { priority: { from: "medium", to: "high" }, reward: { from: "10", to: null } } });

    // A no-op edit records nothing.
    await updateOpenJob(jobId, { priority: "high" }, user);
    expect((await events(jobId)).filter((t) => t === "edited")).toHaveLength(1);

    await claimJob(jobId, "agentA", "org1", "p1", "Ada");
    await expect(updateOpenJob(jobId, { title: "new" }, user)).rejects.toMatchObject({ status: 409 });
  });

  it("cancels: closes the job and the agent's task, declines pending bids, and blocks after delivery", async () => {
    const apps = await postJob({ hiringMode: "applications" });
    await applyToJob({ jobId: apps, orgId: "org1", agentId: "agentA", agentName: "Ada", quote: "50" });
    await cancelJob(apps, "budget cut", user);
    expect(await getJob(apps)).toMatchObject({ status: "closed", cancelReason: "budget cut", cancelledBy: "0xposter" });
    expect((await getJobApplications(apps)).map((a) => a.status)).toEqual(["rejected"]);
    expect(await events(apps)).toEqual(["created", "applied", "cancelled"]);

    const working = await postJob();
    const taskId = await claimJob(working, "agentA", "org1", "p1", "Ada");
    await cancelJob(working, "", user);
    expect(col("tasks").get(taskId)?.data).toMatchObject({ status: "done", cancelled: true });
    expect((await getJob(working))?.cancelReason).toBeUndefined();

    const delivered = await postJob();
    await claimJob(delivered, "agentA", "org1", "p1", "Ada");
    await submitJobDelivery(delivered, { deliveryNotes: "v1", completedByAgentName: "Ada" });
    await expect(cancelJob(delivered, "", user)).rejects.toMatchObject({ status: 409 });
  });

  it("records hiring as a 'hired' event by whoever picked the bid", async () => {
    const jobId = await postJob({ hiringMode: "applications" });
    await applyToJob({ jobId, orgId: "org1", agentId: "agentA", agentName: "Ada" });
    await applyToJob({ jobId, orgId: "org1", agentId: "agentB", agentName: "Bob" });
    const [ada] = (await getJobApplications(jobId)).filter((a) => a.agentId === "agentA");
    await hireApplicant(jobId, ada, "org1", "p1", user);
    expect((await getJobApplications(jobId)).map((a) => [a.agentId, a.status]).sort()).toEqual([["agentA", "accepted"], ["agentB", "rejected"]]);
    const hired = (await getJobEvents(jobId)).find((e) => e.type === "hired");
    expect(hired).toMatchObject({ actor: user, details: { agentId: "agentA" } });
  });

  it("dispatches a team: first agent leads and holds the job, the rest collaborate", async () => {
    const { jobId, taskIds } = await dispatchJob(input, { orgId: "org1", postedByAddress: "0xposter" }, ["agentA", "agentB", "agentC", "agentB"], user);
    expect(taskIds).toHaveLength(3);
    expect(await getJob(jobId)).toMatchObject({ status: "in_progress", takenByAgentId: "agentA", collaboratorAgentIds: ["agentB", "agentC"] });
    expect(tasksFor(jobId).map((t) => t.assigneeAgentId).sort()).toEqual(["agentA", "agentB", "agentC"]);
    const trail = await getJobEvents(jobId);
    expect(trail.map((e) => [e.type, e.details?.agentId ?? null, e.details?.role ?? null])).toEqual([
      ["created", null, null],
      ["hired", "agentA", null],
      ["hired", "agentB", "collaborator"],
      ["hired", "agentC", "collaborator"],
    ]);

    // Approval closes every task on the job, but only the lead is credited.
    await submitJobDelivery(jobId, { deliveryNotes: "done", completedByAgentName: "Ada" });
    await reviewDelivery(jobId, { approve: true, notes: "" }, user);
    expect(tasksFor(jobId).every((t) => t.status === "done")).toBe(true);
    expect(col("agents").get("agentA")?.data.tasksCompleted).toBe(3);
    expect(col("agents").get("agentB")?.data.tasksCompleted).toBeUndefined();
  });

  it("refuses to dispatch to agents outside the org, before creating anything", async () => {
    await expect(dispatchJob(input, { orgId: "org1", postedByAddress: "0xposter" }, ["agentA", "outsider"], user))
      .rejects.toMatchObject({ status: 404 });
    await expect(dispatchJob(input, { orgId: "org1", postedByAddress: "0xposter" }, [], user)).rejects.toMatchObject({ status: 400 });
    expect(col("jobs").size).toBe(0);
  });

  it("reopens an in-progress job: unassigns everyone, closes their tasks, keeps history", async () => {
    const { jobId } = await dispatchJob(input, { orgId: "org1", postedByAddress: "0xposter" }, ["agentA", "agentB"], user);
    await submitJobDelivery(jobId, { deliveryNotes: "v1", completedByAgentName: "Ada" });
    await reviewDelivery(jobId, { approve: false, notes: "redo" }, user);
    await reopenJob(jobId, "agent stalled", user);

    const job = await getJob(jobId);
    expect(job).toMatchObject({ status: "open", reviewStatus: "rejected" });
    expect(job?.takenByAgentId).toBeUndefined();
    expect(job?.collaboratorAgentIds).toBeUndefined();
    expect(job?.deliveryHistory).toHaveLength(1);
    expect(tasksFor(jobId).every((t) => t.status === "done" && t.cancelled === true)).toBe(true);
    expect((await getJobEvents(jobId)).at(-1)).toMatchObject({ type: "unassigned", details: { agentId: "agentA", reason: "agent stalled" } });

    // Back on the board — a new agent can claim it.
    await claimJob(jobId, "agentC", "org1", "p1", "Cy");
    expect((await getJob(jobId))?.takenByAgentId).toBe("agentC");
  });

  it("won't reopen open, delivered or gig jobs", async () => {
    const open = await postJob();
    await expect(reopenJob(open, "", user)).rejects.toMatchObject({ status: 409 });
    await claimJob(open, "agentA", "org1", "p1", "Ada");
    await submitJobDelivery(open, { deliveryNotes: "v1", completedByAgentName: "Ada" });
    await expect(reopenJob(open, "", user)).rejects.toMatchObject({ status: 409 });

    col("jobs").set("gig1", { data: { orgId: "org1", status: "in_progress", gigId: "g", takenByAgentId: "agentA" }, v: 1 });
    await expect(reopenJob("gig1", "", user)).rejects.toMatchObject({ status: 409 });
  });
});

describe("job board queries", () => {
  // Pin createdAt so ordering doesn't depend on jobs posted in the same millisecond.
  const at = (jobId: string, createdAt: number) => { col("jobs").get(jobId)!.data.createdAt = createdAt; };

  it("pages an org's open jobs oldest first, skipping other statuses and orgs", async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) { const id = await postJob({ title: `j${i}` }); at(id, 1000 + i); ids.push(id); }
    await claimJob(ids[1], "agentA", "org1", "p1", "Ada"); // no longer open
    col("jobs").set("other", { data: { orgId: "org2", status: "open", createdAt: 1 }, v: 1 });

    const p1 = await listOrgJobsByStatus("org1", "open", { limit: 2 });
    expect(p1.jobs.map((j) => j.id)).toEqual([ids[0], ids[2]]);
    expect(p1.nextCursor).toBe(ids[2]);

    const p2 = await listOrgJobsByStatus("org1", "open", { limit: 2, cursor: p1.nextCursor });
    expect(p2.jobs.map((j) => j.id)).toEqual([ids[3], ids[4]]);
    expect(p2.nextCursor).toBeNull(); // exactly filled the page — no empty extra page

    expect((await listOrgJobsByStatus("org1", "in_progress", { limit: 10 })).jobs.map((j) => j.id)).toEqual([ids[1]]);
  });

  it("rejects a cursor that doesn't exist or belongs to another org", async () => {
    await expect(listOrgJobsByStatus("org1", "open", { limit: 5, cursor: "nope" })).rejects.toMatchObject({ status: 400 });
    col("jobs").set("theirs", { data: { orgId: "org2", status: "open", createdAt: 1 }, v: 1 });
    await expect(listOrgJobsByStatus("org1", "open", { limit: 5, cursor: "theirs" })).rejects.toMatchObject({ status: 400 });
  });

  it("lists an agent's jobs newest first, including gig orders from buyer orgs, but not other orgs' jobs", async () => {
    const old = await postJob(); at(old, 1000);
    const recent = await postJob(); at(recent, 3000);
    await claimJob(old, "agentA", "org1", "p1", "Ada");
    await claimJob(recent, "agentA", "org1", "p1", "Ada");
    col("jobs").set("gigOrder", { data: { orgId: "buyerOrg", sellerOrgId: "org1", status: "in_progress", takenByAgentId: "agentA", createdAt: 2000 }, v: 1 });
    col("jobs").set("stale", { data: { orgId: "org9", status: "completed", takenByAgentId: "agentA", createdAt: 4000 }, v: 1 });

    expect((await getJobsAssignedToAgent("agentA", "org1", 10)).map((j) => j.id)).toEqual([recent, "gigOrder", old]);
    expect(await getJobsAssignedToAgent("agentB", "org1", 10)).toEqual([]);
  });
});

describe("applications", () => {
  it("lets an agent apply once per job, even with concurrent requests", async () => {
    const jobId = await postJob({ hiringMode: "applications" });
    const results = await Promise.allSettled([
      applyToJob({ jobId, orgId: "org1", agentId: "agentA", agentName: "Ada" }),
      applyToJob({ jobId, orgId: "org1", agentId: "agentA", agentName: "Ada" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(JobActionError);
    expect(rejected.reason).toMatchObject({ status: 409 });

    expect(await getJobApplications(jobId)).toHaveLength(1);
    expect((await getJob(jobId))?.applicationCount).toBe(1);
    expect((await events(jobId)).filter((t) => t === "applied")).toHaveLength(1);

    // A different agent still can.
    await applyToJob({ jobId, orgId: "org1", agentId: "agentB", agentName: "Bob" });
    expect((await getJob(jobId))?.applicationCount).toBe(2);
  });

  it("stamps a review deadline on each delivery and restarts it on redelivery", async () => {
    const jobId = await postJob({ reviewWindowDays: 3 });
    await claimJob(jobId, "agentA", "org1", "p1", "Ada");
    const t0 = Date.now();
    await submitJobDelivery(jobId, { deliveryNotes: "v1", completedByAgentName: "Ada" });
    const due1 = (await getJob(jobId))!.reviewDueAt!;
    expect(due1 - t0).toBeGreaterThanOrEqual(3 * DAY - 1000);
    expect(due1 - t0).toBeLessThanOrEqual(3 * DAY + 1000);
    col("jobs").get(jobId)!.data.reviewReminderSentAt = 1;
    await reviewDelivery(jobId, { approve: false, notes: "redo" }, user);
    await submitJobDelivery(jobId, { deliveryNotes: "v2", completedByAgentName: "Ada" });
    expect((await getJob(jobId))!.reviewReminderSentAt).toBeUndefined();
  });

  it("rates approved work once, into the agent's average", async () => {
    const deliveredJob = async () => {
      const id = await postJob();
      await claimJob(id, "agentA", "org1", "p1", "Ada");
      await submitJobDelivery(id, { deliveryNotes: "v1", completedByAgentName: "Ada" });
      return id;
    };
    const j1 = await deliveredJob();
    await expect(rateJob(j1, { rating: 5, comment: "" }, user)).rejects.toMatchObject({ status: 409 }); // not approved yet
    await reviewDelivery(j1, { approve: true, notes: "" }, user);
    const rated = await rateJob(j1, { rating: 5, comment: "excellent" }, user);
    expect(rated).toMatchObject({ rating: 5, ratingComment: "excellent", ratedBy: "0xposter" });
    await expect(rateJob(j1, { rating: 1, comment: "" }, user)).rejects.toMatchObject({ status: 409 });

    const j2 = await deliveredJob();
    await reviewDelivery(j2, { approve: true, notes: "" }, user);
    await rateJob(j2, { rating: 2, comment: "" }, user);
    expect(col("agents").get("agentA")?.data).toMatchObject({ ratingSum: 7, ratingCount: 2, avgRating: 3.5 });
    expect((await getJobEvents(j1)).at(-1)).toMatchObject({ type: "rated", details: { rating: 5, agentId: "agentA" } });
  });

  it("rating a gig order also reviews the gig listing", async () => {
    col("gigs").set("g1", { data: { avgRating: 4, ratingCount: 1 }, v: 1 });
    col("jobs").set("order1", { data: {
      orgId: "org1", gigId: "g1", sellerOrgId: "org2", status: "completed", reviewStatus: "approved", takenByAgentId: "agentA",
    }, v: 1 });
    await rateJob("order1", { rating: 2, comment: "late" }, user);
    expect(col("gigs").get("g1")?.data).toMatchObject({ avgRating: 3, ratingCount: 2 });
    expect(col("gigReviews").get("order1")?.data).toMatchObject({ gigId: "g1", rating: 2, review: "late" });
    expect(col("agents").get("agentA")?.data.avgRating).toBe(2);
  });

  it("sweeps: starts legacy clocks, reminds once, auto-approves, flags escrow it can't release", async () => {
    const delivered = async (extra: Record<string, unknown> = {}) => {
      const id = await postJob();
      await claimJob(id, "agentA", "org1", "p1", "Ada");
      await submitJobDelivery(id, { deliveryNotes: "v1", completedByAgentName: "Ada" });
      Object.assign(col("jobs").get(id)!.data, extra);
      return id;
    };
    const now = Date.now();
    const legacy = await delivered();
    delete col("jobs").get(legacy)!.data.reviewDueAt;
    const soon = await delivered({ reviewDueAt: now + DAY / 2 });
    const overdue = await delivered({ reviewDueAt: now - 1 });
    const escrowed = await delivered({ reviewDueAt: now - 1, escrow: { status: "delivered" } });
    const fresh = await delivered();

    const r1 = await sweepReviews(now);
    expect(r1).toMatchObject({ clockStarted: [legacy], reminded: [soon], autoApproved: [overdue], flaggedOverdue: [escrowed], errors: [] });
    expect(r1.checked).toBe(5);
    expect(await getJob(overdue)).toMatchObject({ status: "completed", reviewStatus: "approved", autoApproved: true });
    expect(col("agents").get("agentA")?.data.tasksCompleted).toBe(3); // credited like any approval
    expect((await getJobEvents(overdue)).at(-1)).toMatchObject({ type: "auto_approved", actor: { type: "system" } });
    expect((await getJob(legacy))!.reviewDueAt).toBeGreaterThan(now); // a fresh window, not instant approval
    expect((await getJob(fresh))!.reviewStatus).toBe("pending");

    // Second run: nothing repeats.
    const r2 = await sweepReviews(now);
    expect([r2.reminded, r2.autoApproved, r2.flaggedOverdue, r2.clockStarted]).toEqual([[], [], [], []]);
  });
});

const DAY = 86_400_000;
