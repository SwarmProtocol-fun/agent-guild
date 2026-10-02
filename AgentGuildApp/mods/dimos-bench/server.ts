import { defineServerMod } from "@agent-guild/sdk";
import type { Timestamp } from "firebase-admin/firestore";
import { cancelAssignment, getAssignment, AssignmentError, assignmentErrorStatus } from "@/lib/assignments";
import { getAgent } from "@/lib/firestore-admin";
import { buildLeaderboard, feedbackContext, lineageReport, parseReplay, parseSubmission, resolveLineage, type BenchRun } from "./bench";
import { getAncestors, getReplay, getRun, lineageExists, listReplays, listRuns, newRunId, saveReplay, saveRun } from "./store";

const iso = (t: Timestamp | null | undefined) => (t ? t.toDate().toISOString() : null);

/** A non-negative number query param, or the fallback when absent/invalid. */
function numParam(url: URL, name: string, fallback: number): number {
  const v = Number(url.searchParams.get(name));
  return url.searchParams.has(name) && Number.isFinite(v) && v >= 0 ? v : fallback;
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

      const { parentRunId, lineageId } = parsed.lineage;
      const runId = newRunId();
      const lineage = resolveLineage({
        runId,
        agentId: ctx.agent.agentId,
        suite: parsed.run.suite,
        claim: parsed.lineage,
        parent: parentRunId ? await getRun(parentRunId) : null,
        lineageTaken: !parentRunId && !!lineageId && (await lineageExists(lineageId)),
      });
      if (!lineage.ok) return Response.json({ error: lineage.error }, { status: lineage.status });

      const agent = await getAgent(ctx.agent.agentId);
      const run = await saveRun(
        runId,
        parsed.run,
        { agentId: ctx.agent.agentId, agentName: agent?.name ?? ctx.agent.agentId, orgId: ctx.agent.orgId },
        { lineageId: lineage.lineageId, parentRunId: lineage.parentRunId, generation: lineage.generation },
      );
      ctx.log.info(
        `run ${run.id}: ${run.agentName} on ${run.suite} gen ${run.generation} → ${run.summary.meanScore.toFixed(3)}`,
      );
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
      if (run.agentId !== agent.agentId) return Response.json({ error: "Not your run" }, { status: 403 });
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
