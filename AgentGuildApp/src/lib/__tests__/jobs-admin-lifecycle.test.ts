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
  };
}

function query(name: string, filters: [string, string, unknown][]) {
  return {
    where: (f: string, o: string, v: unknown) => query(name, [...filters, [f, o, v]]),
    async get() {
      const docs = [...col(name).entries()]
        .filter(([, e]) => filters.every(([f, o, v]) => (o === "in" ? (v as unknown[]).includes(e.data[f]) : e.data[f] === v)))
        .map(([id, e]) => ({ id, data: () => ({ ...e.data }) }));
      return { docs, size: docs.length };
    },
  };
}

const adminDbFake = {
  collection: (name: string) => ({
    doc: (id: string) => docRef(name, id),
    where: (f: string, o: string, v: unknown) => query(name, [[f, o, v]]),
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
  getJob,
  hireApplicant,
  reviewDelivery,
  submitJobDelivery,
  updateOpenJob,
  getJobApplications,
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
});

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
});
