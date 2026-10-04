import { defineServerMod } from "@agent-guild/sdk";
import type { Timestamp } from "firebase-admin/firestore";
import { cancelAssignment, getAssignment, AssignmentError, assignmentErrorStatus } from "@/lib/assignments";
import { addMemoryEntry, getAgent, getAgentsByOrg, getMemoryEntries, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import {
  buildLeaderboard, feedbackContext, lineageReport, parseJobRequest, parseReplay, parseSubmission, resolveLineage,
  BENCH_ROBOTS, HARNESSES, SUITE_CATALOG, suiteRobot, type BenchJob, type BenchRun,
} from "./bench";
import {
  SIM_ROBOTS, SIM_TASKS, attemptedTaskIds, episodeRobot, exportLine, findTask, learningCurve, parseDriveMove, parseFrames, parsePoseInput, parseRobot, parseSteps, plainLesson, rankLessons, robotInfo, robotTag,
  type DriveRelay, type Driver, type Episode, type SimTask,
} from "./training";
import { canDrive, decideAction, DriverError, DRIVER_MODEL, reflect } from "./trainer";
import {
  addSteps, createEpisode, getEpisode, getRecentFrames, getSteps, listEpisodes, updateEpisode,
  activeRelay, claimMove, getRelay, setRelay, updateRelay, waitForRelay,
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

/** The agent's DimSim lessons for this robot, ranked by rankLessons (this task's successes first). Memory is best-effort. */
async function lessonsFor(ep: Pick<Episode, "orgId" | "agentId" | "robot">, task: SimTask, max = 8): Promise<string[]> {
  try {
    return rankLessons(await getMemoryEntries(ep.orgId, ep.agentId, "long_term"), task.id, max, episodeRobot(ep));
  } catch {
    return [];
  }
}

/** An episode's task — built-in, or an object task rebuilt from the episode's own task text. */
const episodeTask = (ep: Pick<Episode, "taskId" | "task">) => findTask(ep.taskId, ep.task);

// ── Drive relay: the agent drives with its own model ────────────────────

/**
 * How long one relay request waits for the other side before returning
 * "still waiting" — under the host's function timeout (10 s on Netlify);
 * the CLI re-asks.
 */
const RELAY_WAIT_MS = 8000;
const OWN_MODEL = "own model";

/** Told to the agent with its first view of an attempt. */
const driveGuide = (ep: Pick<Episode, "robot">) => `You are driving ${robotInfo(episodeRobot(ep)).about.replace(/\.$/, "")}, through a simulated apartment (dimOS DimSim), from its front camera.
Each move: turn (degrees, positive = left, -180..180) in place, then walk forward (metres, -1..2; small near obstacles).
The robot stops early if something is in the way ("blocked"). look=true spends the move turning in place to photograph
all four directions instead (front, left, back, right). Set done=true when you believe you have reached the goal.
Pose: x/z in metres on the floor plan, yaw in degrees. Facing yaw θ, forward moves by (sin θ, cos θ) in (x, z):
yaw 0 walks toward +z, yaw 90 toward +x. You never see the scoring distance; drive from what the camera shows.`;

/** What the agent sees: the latest camera view of its attempt, or that the attempt ended. */
async function drivePayload(relay: DriveRelay, ep: Episode, first: boolean) {
  const task = episodeTask(ep);
  const base = { episodeId: ep.id, task: ep.task, stepsLeft: Math.max(0, (task?.maxSteps ?? 0) - ep.steps), step: ep.steps };
  if (relay.ended) {
    return {
      ...base, ended: relay.ended,
      next: relay.ended === "stopped"
        ? "The attempt was stopped from the panel."
        : `The attempt ended: ${relay.ended}. Optionally save what you learned for next time with guild_sim_lesson (episodeId ${ep.id}).`,
    };
  }
  const obs = relay.obs;
  if (!obs) return { ...base, waiting: true, next: "The panel hasn't sent the first camera view yet; call guild_sim_observe again." };
  return {
    ...base,
    seq: obs.seq,
    pose: obs.pose,
    blocked: obs.blocked,
    jpeg: obs.jpeg,
    panorama: obs.panorama,
    robot: episodeRobot(ep),
    ...(first && task ? { guide: driveGuide(ep), lessons: await lessonsFor(ep, task) } : {}),
    next: `Choose a move with guild_sim_act (episodeId ${ep.id}, seq ${obs.seq}).`,
  };
}

/** The relay and episode an agent may drive, or an error response. */
async function agentRelay(agentId: string, episodeId: string | null): Promise<{ relay: DriveRelay; ep: Episode } | Response> {
  const relay = episodeId ? await getRelay(episodeId) : await activeRelay(agentId);
  if (!relay || relay.agentId !== agentId) {
    return Response.json({ error: "No attempt for this agent: start one in the DimSim panel (your agent drives)." }, { status: 404 });
  }
  const ep = await getEpisode(relay.episodeId);
  if (!ep) return Response.json({ error: "Episode not found" }, { status: 404 });
  return { relay, ep };
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
        robots: BENCH_ROBOTS,
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
        robots: SIM_ROBOTS,
        agents: agents.map((a) => ({ id: a.id, name: a.name, orgId: a.orgId })).sort((a, b) => a.name.localeCompare(b.name)),
        /** Whether the Claude stand-in driver is available (a model credential is set). */
        canDrive: canDrive(),
        model: DRIVER_MODEL,
      };
    },

    /**
     * POST /episodes — start an attempt: { agentId, taskId, actor: "human" | "agent", driver?, robot?, startPose?, startDistance? }.
     * taskId is a built-in task or `obj:<assetId>` with the object's `title`.
     * An agent attempt's driver is "own" (default: the agent drives through the
     * relay with its own model) or "server" (the Claude stand-in).
     */
    "POST /episodes": async (req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const task = findTask(b.taskId, typeof b.title === "string" ? b.title : undefined);
      const actor = b.actor === "agent" ? "agent" : b.actor === "human" ? "human" : null;
      if (!task || !actor || typeof b.agentId !== "string") {
        return Response.json({ error: "agentId, a known taskId and actor (human|agent) are required" }, { status: 400 });
      }
      const driver: Driver | undefined = actor === "agent" ? (b.driver === "server" ? "server" : "own") : undefined;
      if (driver === "server" && !canDrive()) {
        return Response.json({ error: "Set ANTHROPIC_API_KEY on the server to use the Claude stand-in" }, { status: 503 });
      }
      const agent = await getAgent(b.agentId);
      if (!agent || !(await sessionOrgIds(session.address)).includes(agent.orgId)) {
        return Response.json({ error: "That agent isn't in one of your orgs" }, { status: 403 });
      }
      const episode = await createEpisode({
        orgId: agent.orgId, agentId: agent.id, agentName: agent.name,
        taskId: task.id, task: task.task, scene: task.scene, actor,
        ...(driver ? { driver } : {}),
        robot: parseRobot(b.robot),
        model: driver === "own" ? OWN_MODEL : driver === "server" ? DRIVER_MODEL : null,
        status: "running", steps: 0,
        startDistance: typeof b.startDistance === "number" && Number.isFinite(b.startDistance) ? b.startDistance : null,
        finalDistance: null, lesson: "",
        startPose: parsePoseInput(b.startPose) ?? task.startPose, finalPose: null,
        createdBy: session.address, createdAt: new Date().toISOString(), finishedAt: null,
      });
      if (driver === "own") {
        await setRelay({ episodeId: episode.id, agentId: agent.id, orgId: agent.orgId, obs: null, move: null, ended: null, updatedAt: new Date().toISOString() });
      }
      return Response.json({ episode, task, lessons: await lessonsFor(episode, task) }, { status: 201 });
    },

    /**
     * POST /episodes/:id/observe — { jpeg, pose, panorama?, blocked?, steps? }:
     * the panel posts what the robot sees now, for the agent driving with its
     * own model (plus the step that led here, recorded first). Returns the
     * observation's seq, which the agent's move has to answer.
     */
    "POST /episodes/:id/observe": async (req, { params, session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      const relay = await getRelay(ep.id);
      if (ep.status !== "running" || !relay || relay.ended) return Response.json({ error: "Not a running own-driver episode" }, { status: 409 });
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const pose = parsePoseInput(b.pose);
      const frames = parseFrames([b.jpeg], 1);
      const panorama = parseFrames(b.panorama, 4);
      if (!pose || !frames?.length || !panorama) {
        return Response.json({ error: "jpeg and pose are required; panorama is up to 4 JPEGs" }, { status: 400 });
      }
      if (b.steps !== undefined) {
        const parsed = parseSteps({ steps: b.steps }, ep.steps);
        if (!parsed.ok) return Response.json({ error: "Invalid steps", details: parsed.errors }, { status: 400 });
        await addSteps(ep.id, parsed.steps);
        await updateEpisode(ep.id, { steps: ep.steps + parsed.steps.length });
      }
      const seq = (relay.obs?.seq ?? 0) + 1;
      await updateRelay(ep.id, { obs: { seq, jpeg: frames[0], pose, panorama, blocked: b.blocked === true }, move: null });
      return { seq };
    },

    /**
     * GET /episodes/:id/move?seq= — the panel waits (up to RELAY_WAIT_MS) for
     * the agent's move on observation `seq`. { move: null } means ask again.
     */
    "GET /episodes/:id/move": async (req, { params, session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      const seq = Number(new URL(req.url).searchParams.get("seq"));
      const relay = await waitForRelay(ep.id, (r) => r.ended != null || r.move?.seq === seq, RELAY_WAIT_MS);
      if (!relay) return Response.json({ error: "Not an own-driver episode" }, { status: 409 });
      return { move: relay.move?.seq === seq ? relay.move : null, ended: relay.ended };
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
     * POST /episodes/:id/act — { jpeg, pose, panorama?, steps? }: the agent looks
     * through the robot's camera (plus its last two frames, and a 4-way
     * panorama at the start or after it chose to look around) and picks the
     * next move. The panel executes it in the sim and sends the recorded step
     * as `steps` with the next /act (same shape as POST /steps), so each step
     * costs one round trip; they are stored before the agent decides.
     */
    "POST /episodes/:id/act": async (req, { params, session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      if (ep.actor !== "agent" || ep.status !== "running") return Response.json({ error: "Not a running agent episode" }, { status: 409 });
      const task = episodeTask(ep);
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const pose = parsePoseInput(b.pose);
      const frames = parseFrames([b.jpeg], 1);
      const panorama = parseFrames(b.panorama, 4);
      if (!task || !pose || !frames?.length || !panorama) {
        return Response.json({ error: "jpeg and pose are required; panorama is up to 4 JPEGs" }, { status: 400 });
      }
      if (b.steps !== undefined) {
        const parsed = parseSteps({ steps: b.steps }, ep.steps);
        if (!parsed.ok) return Response.json({ error: "Invalid steps", details: parsed.errors }, { status: 400 });
        await addSteps(ep.id, parsed.steps);
        ep.steps += parsed.steps.length;
        await updateEpisode(ep.id, { steps: ep.steps });
      }
      try {
        const decision = await decideAction({
          agentName: ep.agentName,
          task,
          robot: robotInfo(episodeRobot(ep)).about,
          lessons: await lessonsFor(ep, task),
          history: await getSteps(ep.id, false),
          jpeg: frames[0],
          pose,
          stepsLeft: Math.max(0, task.maxSteps - ep.steps),
          panorama,
          recent: await getRecentFrames(ep.id, 2),
        });
        return decision;
      } catch (err) {
        if (err instanceof DriverError) return Response.json({ error: err.message }, { status: 502 });
        throw err;
      }
    },

    /**
     * POST /episodes/:id/finish — { status: "success" | "failed" | "stopped", finalDistance, finalPose }.
     * A finished (not stopped) attempt leaves a lesson in the agent's memory:
     * the route for a demonstration, the model's reflection for an agent run.
     */
    "POST /episodes/:id/finish": async (req, { params, session, log }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      if (ep.status !== "running") return Response.json({ error: `Episode is already ${ep.status}` }, { status: 409 });
      const task = episodeTask(ep);
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const status = b.status === "success" || b.status === "failed" || b.status === "stopped" ? b.status : null;
      if (!task || !status) return Response.json({ error: "status must be success, failed or stopped" }, { status: 400 });
      const finalDistance = typeof b.finalDistance === "number" && Number.isFinite(b.finalDistance) ? b.finalDistance : null;
      const finalPose = parsePoseInput(b.finalPose);
      const done: Partial<Episode> = { status, finalDistance, finalPose, finishedAt: new Date().toISOString() };

      if (status !== "stopped" && ep.steps > 0) {
        const steps = await getSteps(ep.id, false);
        let lesson = plainLesson({ ...ep, status, finalDistance, finalPose }, task, steps.map((s) => s.action));
        if (ep.actor === "agent" && ep.driver !== "own" && canDrive()) {
          try {
            lesson = await reflect({ task, robot: robotInfo(episodeRobot(ep)).about, succeeded: status === "success", finalDistance, startPose: ep.startPose ?? task.startPose, finalPose, steps });
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
          tags: ["dimsim", task.id, ep.actor, status, robotTag(episodeRobot(ep))],
          structuredData: { episodeId: ep.id, scene: ep.scene },
        });
      }
      await updateEpisode(ep.id, done);
      if (ep.driver === "own") await updateRelay(ep.id, { ended: status, move: null });
      return { episode: { ...ep, ...done } };
    },

    // ── The agent's side of the drive relay (agent-signed: agent-guild sim …) ──

    /**
     * GET /drive?episodeId=&after= — what the robot sees in this agent's
     * running attempt (the newest, without episodeId). With `after`, waits up
     * to RELAY_WAIT_MS for an observation newer than that seq. The first view
     * of an attempt carries the driving guide and the agent's lessons.
     */
    "GET /drive": async (req, { agent }) => {
      if (!agent) return Response.json({ error: "Agent authentication required" }, { status: 401 });
      const url = new URL(req.url);
      const found = await agentRelay(agent.agentId, url.searchParams.get("episodeId"));
      if (found instanceof Response) return found;
      let { relay } = found;
      const after = url.searchParams.has("after") ? Number(url.searchParams.get("after")) : null;
      if (after != null && !relay.ended && (relay.obs?.seq ?? 0) <= after) {
        relay = (await waitForRelay(relay.episodeId, (r) => r.ended != null || (r.obs?.seq ?? 0) > after, RELAY_WAIT_MS)) ?? relay;
      }
      const ep = (await getEpisode(relay.episodeId)) ?? found.ep;
      return drivePayload(relay, ep, after == null || after === 0);
    },

    /**
     * POST /drive/act — { episodeId, seq, turn, forward, look?, done?, thought? }:
     * the agent's move on observation `seq`. Waits up to RELAY_WAIT_MS for the
     * panel to run it and returns the next view (or { waiting: true }: ask
     * GET /drive?after=seq).
     */
    "POST /drive/act": async (req, { agent }) => {
      if (!agent) return Response.json({ error: "Agent authentication required" }, { status: 401 });
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const seq = Number(b.seq);
      if (typeof b.episodeId !== "string" || !Number.isInteger(seq)) {
        return Response.json({ error: "episodeId and seq (from guild_sim_observe) are required" }, { status: 400 });
      }
      const found = await agentRelay(agent.agentId, b.episodeId);
      if (found instanceof Response) return found;
      const claimed = await claimMove(b.episodeId, parseDriveMove(b, seq));
      if (claimed === "stale") {
        return Response.json({ error: `seq ${seq} isn't the current view (it's ${found.relay.obs?.seq ?? "not sent yet"}); observe again` }, { status: 409 });
      }
      const relay = (await waitForRelay(b.episodeId, (r) => r.ended != null || (r.obs?.seq ?? 0) > seq, RELAY_WAIT_MS)) ?? found.relay;
      const ep = (await getEpisode(b.episodeId)) ?? found.ep;
      if (!relay.ended && (relay.obs?.seq ?? 0) <= seq) {
        return { episodeId: ep.id, waiting: true, next: `The move is queued; the panel hasn't run it yet. Call guild_sim_observe (after ${seq}).` };
      }
      return drivePayload(relay, ep, false);
    },

    /**
     * POST /drive/lesson — { episodeId, lesson }: after an attempt it drove
     * ended, the agent saves its own lesson to its memory (next attempts read
     * it back with their first view).
     */
    "POST /drive/lesson": async (req, { agent }) => {
      if (!agent) return Response.json({ error: "Agent authentication required" }, { status: 401 });
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const lesson = typeof b.lesson === "string" ? b.lesson.trim().slice(0, 600) : "";
      if (typeof b.episodeId !== "string" || !lesson) return Response.json({ error: "episodeId and lesson are required" }, { status: 400 });
      const ep = await getEpisode(b.episodeId);
      if (!ep || ep.agentId !== agent.agentId || ep.driver !== "own") return Response.json({ error: "Not an attempt this agent drove" }, { status: 404 });
      if (ep.status === "running" || ep.status === "stopped") return Response.json({ error: `The attempt is ${ep.status}` }, { status: 409 });
      const task = episodeTask(ep);
      if (!task) return Response.json({ error: "Unknown task" }, { status: 400 });
      await addMemoryEntry({
        orgId: ep.orgId,
        agentId: ep.agentId,
        agentName: ep.agentName,
        type: "long_term",
        title: `DimSim · ${task.label} · ${ep.status} · own lesson`,
        content: lesson,
        tags: ["dimsim", task.id, ep.actor, ep.status, robotTag(episodeRobot(ep))],
        structuredData: { episodeId: ep.id, scene: ep.scene },
      });
      await updateEpisode(ep.id, { lesson });
      return { saved: true };
    },

    /** GET /episodes?agentId=&robot= — an agent's attempts (with one robot, when given), newest first, plus a learning curve per task. */
    "GET /episodes": async (req, { session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const agentId = new URL(req.url).searchParams.get("agentId");
      const agent = agentId ? await getAgent(agentId) : null;
      if (!agent || !(await sessionOrgIds(session.address)).includes(agent.orgId)) {
        return Response.json({ error: "Agent not found" }, { status: 404 });
      }
      const robot = new URL(req.url).searchParams.get("robot");
      const all = await listEpisodes(agent.id);
      const episodes = robot ? all.filter((e) => episodeRobot(e) === parseRobot(robot)) : all;
      return {
        episodes,
        curves: Object.fromEntries(attemptedTaskIds(episodes).map((id) => [id, learningCurve(episodes, id)])),
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

    /** GET /episodes/:id — one attempt with its steps and camera frames, for replay (?images=0: poses only, for the minimap). */
    "GET /episodes/:id": async (req, { params, session }) => {
      if (!session) return Response.json({ error: "Sign in to train agents" }, { status: 401 });
      const ep = await sessionEpisode(params.id, session.address);
      if (ep instanceof Response) return ep;
      return { episode: ep, steps: await getSteps(ep.id, new URL(req.url).searchParams.get("images") !== "0") };
    },

    /** GET /suites — suites that have runs, most-run first, each with the robot it benchmarks on. */
    "GET /suites": async () => {
      const counts = new Map<string, number>();
      for (const run of await listRuns()) counts.set(run.suite, (counts.get(run.suite) ?? 0) + 1);
      return {
        suites: [...counts].map(([suite, runs]) => ({ suite, runs, robot: suiteRobot(suite) })).sort((a, b) => b.runs - a.runs),
        robots: BENCH_ROBOTS,
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
