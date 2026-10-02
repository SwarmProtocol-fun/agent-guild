import { defineServerMod } from "@agent-guild/sdk";
import { getAgent } from "@/lib/firestore-admin";
import { buildLeaderboard, parseSubmission, type BenchRun } from "./bench";
import { getRun, listRuns, saveRun } from "./store";

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
     *         results: dimos EvalResult[] (results.jsonl rows) }
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

      const agent = await getAgent(ctx.agent.agentId);
      const run = await saveRun(parsed.run, {
        agentId: ctx.agent.agentId,
        agentName: agent?.name ?? ctx.agent.agentId,
        orgId: ctx.agent.orgId,
      });
      ctx.log.info(`run ${run.id}: ${run.agentName} on ${run.suite} → ${run.summary.meanScore.toFixed(3)}`);
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
