import { defineServerMod } from "@agent-guild/sdk";
import type { Timestamp } from "firebase-admin/firestore";
import { cancelAssignment, getAssignment, AssignmentError, assignmentErrorStatus } from "@/lib/assignments";
import { getAgent, getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import {
  buildLeaderboard, feedbackContext, lineageReport, parseJobRequest, parseReplay, parseSubmission, resolveLineage,
  HARNESSES, SUITE_CATALOG, type BenchJob, type BenchRun,
} from "./bench";
import {
  claimJob, createJob, getAncestors, getJob, getReplay, getRun, heartbeat, lineageExists, listJobs, listReplays, listRuns,
  listWorkers, newRunId, saveReplay, saveRun, updateJob,
} from "./store";

const iso = (t: Timestamp | null | undefined) => (t ? t.toDate().toISOString() : null);

/** A non-negative number query param, or the fallback when absent/invalid. */
function numParam(url: URL, name: string, fallback: number): number {
  const v = Number(url.searchParams.get(name));
  return url.searchParams.has(name) && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** A worker is "online" if it polled within this long. */
const WORKER_FRESH_MS = 60_000;

/** The orgs a signed-in wallet belongs to. */
async function sessionOrgIds(address: string): Promise<string[]> {
  return (await getOrganizationsByWalletAdmin(address)).map((o) => o.id);
}

/** A job the calling worker holds, or an error response. */
async function workerJob(jobId: string, agentId: string): Promise<BenchJob | Response> {
  const job = await getJob(jobId);
  if (!job || job.workerAgentId !== agentId) return Response.json({ error: "Job not found" }, { status: 404 });
  if (job.status !== "running") return Response.json({ error: `Job is ${job.status}` }, { status: 409 });
  return job;
}

/** A run without its per-case rows — what list views need. */
function brief(run: BenchRun): Omit<BenchRun, "results"> {
  const copy: Partial<BenchRun> = { ...run };
  delete copy.results;
  return copy as Omit<BenchRun, "results">;
}

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("dimos-bench mod loaded");
  },

  routes: {
    /**
     * POST /runs — submit one `dimos evals run` result. Agent-signed only
     * (agent/sig/ts over "POST:/mods/dimos-bench/runs:<ts>"): the run is
     * attributed to ctx.agent, never to an agentId in the body, so a run
     * can't be filed under someone else's agent. The python client in
     * ./python does the signing with the agent's ~/.agent-guild key.
     *
     * Body: { suite, agentModule, model?, tags?, code?: { git_sha, dirty },
     *         results: dimos EvalResult[] (results.jsonl rows),
     *         lineageId?, parentRunId?, harnessSha?, improvement? }
     *
     * Lineage: with parentRunId the parent must be this agent's run on the
     * same suite, and the run becomes generation parent + 1 of its lineage.
     * A submitted `generation` is ignored — the server derives it.
     *
     * Scores are self-reported — the summary is recomputed from the cases,
     * but the cases themselves are only as honest as the submitter. The
     * dimos git sha is kept so a run can be reproduced.
     */
    "POST /runs": async (req, ctx) => {
      if (!ctx.agent) {
        return Response.json({ error: "Runs must be submitted by an agent (signed request)" }, { status: 403 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }
      const parsed = parseSubmission(body);
      if (!parsed.ok) return Response.json({ error: "Invalid run", details: parsed.errors }, { status: 400 });

      // A run for a panel-queued job is filed under the job's agent, not the worker that ran it.
      let job: BenchJob | null = null;
      if (body && typeof body === "object" && typeof (body as { jobId?: unknown }).jobId === "string") {
        const held = await workerJob((body as { jobId: string }).jobId, ctx.agent.agentId);
        if (held instanceof Response) return held;
        job = held;
        if (parsed.run.suite !== job.suite) {
          return Response.json({ error: `job is for suite ${job.suite}, not ${parsed.run.suite}` }, { status: 400 });
        }
      }
      const subjectId = job?.targetAgentId ?? ctx.agent.agentId;

      const { parentRunId, lineageId } = parsed.lineage;
      const runId = newRunId();
      const lineage = resolveLineage({
        runId,
        agentId: subjectId,
        suite: parsed.run.suite,
        claim: parsed.lineage,
        parent: parentRunId ? await getRun(parentRunId) : null,
        lineageTaken: !parentRunId && !!lineageId && (await lineageExists(lineageId)),
      });
      if (!lineage.ok) return Response.json({ error: lineage.error }, { status: lineage.status });

      const agent = await getAgent(subjectId);
      const run = await saveRun(
        runId,
        parsed.run,
        {
          agentId: subjectId,
          agentName: agent?.name ?? subjectId,
          orgId: job?.orgId ?? ctx.agent.orgId,
          ranBy: job ? ctx.agent.agentId : null,
          jobId: job?.id ?? null,
        },
        { lineageId: lineage.lineageId, parentRunId: lineage.parentRunId, generation: lineage.generation },
      );
      ctx.log.info(
        `run ${run.id}: ${run.agentName} on ${run.suite} gen ${run.generation} → ${run.summary.meanScore.toFixed(3)}`,
      );
      if (job) {
        await updateJob(job.id, { status: "done", runId: run.id, finishedAt: new Date().toISOString() });
      }
      return Response.json({ run: brief(run) }, { status: 201 });
    },

    /** GET /runs?suite=…|agentId=… — newest 50 runs, without per-case rows. */
    "GET /runs": async (req) => {
      const url = new URL(req.url);
      const runs = await listRuns({
        suite: url.searchParams.get("suite") ?? undefined,
        agentId: url.searchParams.get("agentId") ?? undefined,
      });
      return { runs: runs.slice(0, 50).map(brief) };
    },

    /** GET /runs/:runId — one run with every case. */
    "GET /runs/:runId": async (_req, { params }) => {
      const run = await getRun(params.runId);
      return run ? { run } : Response.json({ error: "Run not found" }, { status: 404 });
    },

    /**
     * PUT /runs/:runId/media/:caseId — attach what the robot did in one case:
     * its odometry path, a few camera keyframes, and the agent's tool calls.
     * Agent-signed, and only by the agent that submitted the run, for a case
     * the run has. Re-uploading replaces it.
     */
    "PUT /runs/:runId/media/:caseId": async (req, { params, agent }) => {
      if (!agent) return Response.json({ error: "Agent signature required" }, { status: 403 });
      const run = await getRun(params.runId);
      if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
      if (run.agentId !== agent.agentId && run.ranBy !== agent.agentId) {
        return Response.json({ error: "Not your run" }, { status: 403 });
      }
      if (!run.results.some((c) => c.caseId === params.caseId)) {
        return Response.json({ error: `Run has no case ${params.caseId}` }, { status: 404 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }
      const parsed = parseReplay(body, { runId: run.id, caseId: params.caseId });
      if (!parsed.ok) return Response.json({ error: "Invalid replay", details: parsed.errors }, { status: 400 });
      await saveReplay(parsed.replay);
      return { runId: run.id, caseId: params.caseId, poses: parsed.replay.path.length, frames: parsed.replay.frames.length };
    },

    /** GET /runs/:runId/media — which cases have a robot replay (no images). */
    "GET /runs/:runId/media": async (_req, { params }) => ({ replays: await listReplays(params.runId) }),

    /** GET /runs/:runId/media/:caseId — one case's replay, keyframes included. */
    "GET /runs/:runId/media/:caseId": async (_req, { params }) => {
      const replay = await getReplay(params.runId, params.caseId);
      return replay ? { replay } : Response.json({ error: "No replay for this case" }, { status: 404 });
    },

    /**
     * GET /runs/:runId/feedback — what a feedback / meta agent needs to
     * propose the next harness change: the failed and errored cases with
     * their answers, steps, tool calls and tokens, plus the lineage's
     * improvement notes so far (oldest first, ending with this run's).
     */
    "GET /runs/:runId/feedback": async (_req, { params }) => {
      const run = await getRun(params.runId);
      if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
      return feedbackContext(run, await getAncestors(run));
    },

    /**
     * GET /lineages/:lineageId?patience=3&minDelta=0 — best score per
     * generation, its change from the previous generation, and a plateau
     * flag + continue/stop decision for a scheduler (no new best in
     * `patience` generations).
     */
    "GET /lineages/:lineageId": async (req, { params }) => {
      const url = new URL(req.url);
      const report = lineageReport(await listRuns({ lineageId: params.lineageId }), {
        patience: Math.max(1, Math.floor(numParam(url, "patience", 3))),
        minDelta: numParam(url, "minDelta", 0),
      });
      return report ?? Response.json({ error: "Lineage not found" }, { status: 404 });
    },

    /**
     * GET /assignments/:id — status and completion notes of an assignment
     * the calling agent issued. Core's /v1/assignments only lists an
     * agent's *incoming* work, so the python remote adapter (which hands an
     * eval case to another agent as an assignment) polls its answer here.
     */
    "GET /assignments/:id": async (_req, { params, agent }) => {
      if (!agent) return Response.json({ error: "Agent signature required" }, { status: 403 });
      const a = await getAssignment(params.id);
      if (!a || a.fromAgentId !== agent.agentId) {
        return Response.json({ error: "Assignment not found" }, { status: 404 });
      }
      return {
        id: a.id,
        status: a.status,
        toAgentId: a.toAgentId,
        toAgentName: a.toAgentName,
        completionNotes: a.completionNotes ?? null,
        rejectionReason: a.rejectionReason ?? null,
        createdAt: iso(a.createdAt),
        completedAt: iso(a.completedAt),
      };
    },

    /** POST /assignments/:id/cancel — withdraw an unanswered eval case (issuer only). */
    "POST /assignments/:id/cancel": async (_req, { params, agent }) => {
      if (!agent) return Response.json({ error: "Agent signature required" }, { status: 403 });
      try {
        await cancelAssignment(params.id, agent.agentId);
        return { id: params.id, status: "cancelled" };
      } catch (err) {
        if (err instanceof AssignmentError) {
          return Response.json({ error: err.message }, { status: assignmentErrorStatus(err.code) });
        }
        throw err;
      }
    },

    // ── Benchmarks queued from the panel ─────────────────────────────────

    /** GET /bench-options — what the "Run a benchmark" form offers: your agents, workers, suites, harnesses. */
    "GET /bench-options": async (_req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to run benchmarks" }, { status: 401 });
      const orgIds = await sessionOrgIds(session.address);
      const [agents, workers] = await Promise.all([
        Promise.all(orgIds.map(getAgentsByOrg)).then((all) => all.flat()),
        listWorkers(orgIds),
      ]);
      const now = Date.now();
      return {
        agents: agents.map((a) => ({ id: a.id, name: a.name, orgId: a.orgId })).sort((a, b) => a.name.localeCompare(b.name)),
        workers: workers.map((w) => ({ ...w, online: now - Date.parse(w.lastSeen) < WORKER_FRESH_MS })),
        suites: SUITE_CATALOG,
        harnesses: HARNESSES,
      };
    },

    /** POST /jobs — queue a benchmark of one of your agents; a worker in its org picks it up. */
    "POST /jobs": async (req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to run benchmarks" }, { status: 401 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }
      const parsed = parseJobRequest(body);
      if (!parsed.ok) return Response.json({ error: "Invalid benchmark", details: parsed.errors }, { status: 400 });
      const agent = await getAgent(parsed.job.targetAgentId);
      const orgIds = await sessionOrgIds(session.address);
      if (!agent || !orgIds.includes(agent.orgId)) {
        return Response.json({ error: "That agent isn't in one of your orgs" }, { status: 403 });
      }
      const job = await createJob({
        ...parsed.job,
        orgId: agent.orgId,
        targetAgentName: agent.name,
        requestedBy: session.address,
        status: "queued",
        workerAgentId: null,
        workerName: null,
        casesDone: 0,
        casesTotal: null,
        lastCase: null,
        runId: null,
        error: "",
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      });
      return Response.json({ job }, { status: 201 });
    },

    /** GET /jobs — your orgs' benchmarks, newest first. */
    "GET /jobs": async (_req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to run benchmarks" }, { status: 401 });
      return { jobs: await listJobs(await sessionOrgIds(session.address)) };
    },

    /** POST /jobs/:id/cancel — withdraw a queued job, or ask a running one's worker to stop. */
    "POST /jobs/:id/cancel": async (_req, { params, session }) => {
      if (!session) return Response.json({ error: "Sign in to run benchmarks" }, { status: 401 });
      const job = await getJob(params.id);
      if (!job || !(await sessionOrgIds(session.address)).includes(job.orgId)) {
        return Response.json({ error: "Job not found" }, { status: 404 });
      }
      if (job.status !== "queued" && job.status !== "running") {
        return Response.json({ error: `Job is already ${job.status}` }, { status: 409 });
      }
      await updateJob(job.id, { status: "cancelled", finishedAt: new Date().toISOString() });
      return { id: job.id, status: "cancelled" };
    },

    /**
     * POST /jobs/claim — a worker (agent-signed) asks for its org's oldest
     * queued job. Doubles as the worker's heartbeat. `{ job: null }` when idle.
     */
    "POST /jobs/claim": async (_req, { agent }) => {
      if (!agent) return Response.json({ error: "Agent signature required" }, { status: 403 });
      const me = await getAgent(agent.agentId);
      const name = me?.name ?? agent.agentId;
      const job = await claimJob(agent.orgId, { agentId: agent.agentId, name });
      await heartbeat({ agentId: agent.agentId, name, orgId: agent.orgId, lastSeen: new Date().toISOString(), busyJobId: job?.id ?? null });
      return { job };
    },

    /**
     * POST /jobs/:id/progress — the worker reports a finished case. The
     * response says whether to keep going (false once the job is cancelled).
     */
    "POST /jobs/:id/progress": async (req, { params, agent }) => {
      if (!agent) return Response.json({ error: "Agent signature required" }, { status: 403 });
      const job = await getJob(params.id);
      if (!job || job.workerAgentId !== agent.agentId) return Response.json({ error: "Job not found" }, { status: 404 });
      if (job.status !== "running") return { continue: false };
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const last = b.lastCase && typeof b.lastCase === "object" ? (b.lastCase as Record<string, unknown>) : null;
      await updateJob(job.id, {
        casesDone: typeof b.casesDone === "number" ? Math.max(0, Math.floor(b.casesDone)) : job.casesDone,
        casesTotal: typeof b.casesTotal === "number" ? Math.max(0, Math.floor(b.casesTotal)) : job.casesTotal,
        lastCase: last
          ? {
              caseId: String(last.caseId ?? "").slice(0, 200),
              passed: last.passed === true,
              score: typeof last.score === "number" ? Math.min(1, Math.max(0, last.score)) : 0,
              error: String(last.error ?? "").slice(0, 300),
            }
          : job.lastCase,
      });
      await heartbeat({ agentId: agent.agentId, name: job.workerName ?? agent.agentId, orgId: agent.orgId, lastSeen: new Date().toISOString(), busyJobId: job.id });
      return { continue: true };
    },

    /** POST /jobs/:id/fail — the worker gives up on a job (dimOS missing, suite won't import, crash). */
    "POST /jobs/:id/fail": async (req, { params, agent }) => {
      if (!agent) return Response.json({ error: "Agent signature required" }, { status: 403 });
      const held = await workerJob(params.id, agent.agentId);
      if (held instanceof Response) return held;
      const b = (await req.json().catch(() => ({}))) as { error?: unknown };
      await updateJob(held.id, { status: "failed", error: String(b.error ?? "worker failed").slice(0, 1000), finishedAt: new Date().toISOString() });
      return { id: held.id, status: "failed" };
    },

    /** GET /suites — suites that have runs, most-run first. */
    "GET /suites": async () => {
      const counts = new Map<string, number>();
      for (const run of await listRuns()) counts.set(run.suite, (counts.get(run.suite) ?? 0) + 1);
      return {
        suites: [...counts].map(([suite, runs]) => ({ suite, runs })).sort((a, b) => b.runs - a.runs),
      };
    },

    /** GET /leaderboard?suite=… — best run per (agent, model, agent module). */
    "GET /leaderboard": async (req) => {
      const suite = new URL(req.url).searchParams.get("suite");
      if (!suite) return Response.json({ error: "suite is required" }, { status: 400 });
      return { suite, rows: buildLeaderboard(await listRuns({ suite })) };
    },
  },
});
