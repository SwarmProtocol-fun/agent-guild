import { defineServerMod } from "@agent-guild/sdk";
import type { Timestamp } from "firebase-admin/firestore";
import { cancelAssignment, getAssignment, AssignmentError, assignmentErrorStatus } from "@/lib/assignments";
import { addMemoryEntry, getAgent, getAgentsByOrg, getMemoryEntries, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import {
  buildLeaderboard, feedbackContext, lineageReport, parseJobRequest, parseReplay, parseSubmission, resolveLineage,
  HARNESSES, SUITE_CATALOG, type BenchJob, type BenchRun,
} from "./bench";
import {
  SIM_TASKS, exportLine, findTask, learningCurve, parsePoseInput, parseSteps, plainLesson, type Episode, type SimTask,
} from "./training";
import { canDrive, decideAction, DriverError, DRIVER_MODEL, reflect } from "./trainer";
import {
  addSteps, createEpisode, getEpisode, getSteps, listEpisodes, updateEpisode,
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

/** The episode, if the signed-in user's orgs include its agent's org. */
async function sessionEpisode(id: string, address: string): Promise<Episode | Response> {
  const ep = await getEpisode(id);
  if (!ep || !(await sessionOrgIds(address)).includes(ep.orgId)) {
    return Response.json({ error: "Episode not found" }, { status: 404 });
  }
  return ep;
}

/** The agent's DimSim lessons, this task's first, newest first. Memory is best-effort. */
async function lessonsFor(ep: Pick<Episode, "orgId" | "agentId">, task: SimTask, max = 8): Promise<string[]> {
  try {
    const entries = (await getMemoryEntries(ep.orgId, ep.agentId, "long_term")).filter((m) => m.tags?.includes("dimsim"));
    const mine = entries.filter((m) => m.tags?.includes(task.id));
    const rest = entries.filter((m) => !m.tags?.includes(task.id));
    return [...mine, ...rest].slice(0, max).map((m) => m.content);
  } catch {
    return [];
  }
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

    // ── Training on DimSim (the robot sim embedded in the panel) ──────────

    /** GET /sim/options — tasks, your agents, and whether agents can drive (model credential set). */
    "GET /sim/options": async (_req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const orgIds = await sessionOrgIds(session.address);
      const agents = (await Promise.all(orgIds.map(getAgentsByOrg))).flat();
      return {
        tasks: SIM_TASKS,
        agents: agents.map((a) => ({ id: a.id, name: a.name, orgId: a.orgId })).sort((a, b) => a.name.localeCompare(b.name)),
        canDrive: canDrive(),
        model: DRIVER_MODEL,
      };
    },

    /** POST /episodes — start an attempt: { agentId, taskId, actor: "human" | "agent" }. */
    "POST /episodes": async (req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const task = findTask(b.taskId);
      const actor = b.actor === "agent" ? "agent" : b.actor === "human" ? "human" : null;
      if (!task || !actor || typeof b.agentId !== "string") {
        return Response.json({ error: "agentId, a known taskId and actor (human|agent) are required" }, { status: 400 });
      }
      if (actor === "agent" && !canDrive()) {
        return Response.json({ error: "Set ANTHROPIC_API_KEY on the server to let agents drive" }, { status: 503 });
      }
      const agent = await getAgent(b.agentId);
      if (!agent || !(await sessionOrgIds(session.address)).includes(agent.orgId)) {
        return Response.json({ error: "That agent isn't in one of your orgs" }, { status: 403 });
      }
      const episode = await createEpisode({
        orgId: agent.orgId, agentId: agent.id, agentName: agent.name,
        taskId: task.id, task: task.task, scene: task.scene, actor,
        model: actor === "agent" ? DRIVER_MODEL : null,
        status: "running", steps: 0,
        startDistance: typeof b.startDistance === "number" ? b.startDistance : null,
        finalDistance: null, lesson: "",
        createdBy: session.address, createdAt: new Date().toISOString(), finishedAt: null,
      });
      return Response.json({ episode, task, lessons: await lessonsFor(episode, task) }, { status: 201 });
    },

    /** POST /episodes/:id/steps — record steps (camera frame, pose, action, distance after). */
    "POST /episodes/:id/steps": async (req, { params, session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      if (ep.status !== "running") return Response.json({ error: `Episode is ${ep.status}` }, { status: 409 });
      const parsed = parseSteps(await req.json().catch(() => null), ep.steps);
      if (!parsed.ok) return Response.json({ error: "Invalid steps", details: parsed.errors }, { status: 400 });
      await addSteps(ep.id, parsed.steps);
      await updateEpisode(ep.id, { steps: ep.steps + parsed.steps.length });
      return { steps: ep.steps + parsed.steps.length };
    },

    /**
     * POST /episodes/:id/act — { jpeg, pose }: the agent looks through the
     * robot's camera and picks the next move. The panel executes it in the
     * sim, then records the step.
     */
    "POST /episodes/:id/act": async (req, { params, session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      if (ep.actor !== "agent" || ep.status !== "running") return Response.json({ error: "Not a running agent episode" }, { status: 409 });
      const task = findTask(ep.taskId);
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const pose = parsePoseInput(b.pose);
      if (!task || !pose || typeof b.jpeg !== "string" || !b.jpeg) {
        return Response.json({ error: "jpeg and pose are required" }, { status: 400 });
      }
      try {
        const decision = await decideAction({
          agentName: ep.agentName,
          task,
          lessons: await lessonsFor(ep, task),
          history: await getSteps(ep.id, false),
          jpeg: b.jpeg,
          pose,
          stepsLeft: Math.max(0, task.maxSteps - ep.steps),
        });
        return decision;
      } catch (err) {
        if (err instanceof DriverError) return Response.json({ error: err.message }, { status: 502 });
        throw err;
      }
    },

    /**
     * POST /episodes/:id/finish — { status: "success" | "failed" | "stopped", finalDistance }.
     * A finished (not stopped) attempt leaves a lesson in the agent's memory:
     * the route for a demonstration, the model's reflection for an agent run.
     */
    "POST /episodes/:id/finish": async (req, { params, session, log }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      if (ep.status !== "running") return Response.json({ error: `Episode is already ${ep.status}` }, { status: 409 });
      const task = findTask(ep.taskId);
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const status = b.status === "success" || b.status === "failed" || b.status === "stopped" ? b.status : null;
      if (!task || !status) return Response.json({ error: "status must be success, failed or stopped" }, { status: 400 });
      const finalDistance = typeof b.finalDistance === "number" && Number.isFinite(b.finalDistance) ? b.finalDistance : null;
      const done: Partial<Episode> = { status, finalDistance, finishedAt: new Date().toISOString() };

      if (status !== "stopped" && ep.steps > 0) {
        const steps = await getSteps(ep.id, false);
        let lesson = plainLesson({ ...ep, status, finalDistance }, task, steps.map((s) => s.action));
        if (ep.actor === "agent" && canDrive()) {
          try {
            lesson = await reflect({ task, succeeded: status === "success", finalDistance, steps });
          } catch (err) {
            log.warn("reflection failed, keeping the plain lesson:", err);
          }
        }
        done.lesson = lesson;
        await addMemoryEntry({
          orgId: ep.orgId,
          agentId: ep.agentId,
          agentName: ep.agentName,
          type: "long_term",
          title: `DimSim · ${task.label} · ${ep.actor === "human" ? "demonstration" : status}`,
          content: lesson,
          tags: ["dimsim", task.id, ep.actor, status],
          structuredData: { episodeId: ep.id, scene: ep.scene },
        });
      }
      await updateEpisode(ep.id, done);
      return { episode: { ...ep, ...done } };
    },

    /** GET /episodes?agentId= — an agent's attempts, newest first, plus a learning curve per task. */
    "GET /episodes": async (req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const agentId = new URL(req.url).searchParams.get("agentId");
      const agent = agentId ? await getAgent(agentId) : null;
      if (!agent || !(await sessionOrgIds(session.address)).includes(agent.orgId)) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
      }
      const episodes = await listEpisodes(agent.id);
      return {
        episodes,
        curves: Object.fromEntries(SIM_TASKS.map((t) => [t.id, learningCurve(episodes, t.id)])),
      };
    },

    /**
     * GET /episodes/export?agentId=&images=1 — every finished step as JSONL
     * (instruction, pose, action, outcome; camera frames with images=1), for
     * fine-tuning or imitation learning.
     */
    "GET /episodes/export": async (req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const url = new URL(req.url);
      const agent = await getAgent(url.searchParams.get("agentId") ?? "");
      if (!agent || !(await sessionOrgIds(session.address)).includes(agent.orgId)) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
      }
      const withImages = url.searchParams.get("images") === "1";
      const episodes = (await listEpisodes(agent.id)).filter((e) => e.status === "success" || e.status === "failed");
      const lines: string[] = [];
      for (const ep of episodes.reverse()) {
        for (const step of await getSteps(ep.id, withImages)) lines.push(exportLine(ep, step, withImages));
      }
      const name = `${agent.name.replace(/[^\w.-]+/g, "_")}-dimsim${withImages ? "-images" : ""}.jsonl`;
      return new Response(lines.join("\n") + (lines.length ? "\n" : ""), {
        headers: { "Content-Type": "application/x-ndjson", "Content-Disposition": `attachment; filename="${name}"` },
      });
    },

    /** GET /episodes/:id — one attempt with its steps and camera frames, for replay. */
    "GET /episodes/:id": async (_req, { params, session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      return { episode: ep, steps: await getSteps(ep.id) };
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
