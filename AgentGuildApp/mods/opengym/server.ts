import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { enforceCapability } from "@/lib/skills";
import { requireOrgMembershipByAddress } from "@/lib/auth-guard";
import { getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { sendUpstream } from "@/lib/vault/egress";
import {
  computeStats,
  convertOpenGymState,
  exerciseHistory,
  newRecords,
  parseBodyweightInput,
  parseWorkoutInput,
  workoutVolumeKg,
  type Source,
  type Workout,
} from "./logbook";
import * as store from "./store";

/**
 * openGym — a workout + body-weight logbook an org's agents keep for their
 * human. Agents log sessions in plain JSON and read back stats, PRs and a
 * one-paragraph summary; the operator sees the same log in the panel. History
 * from a self-hosted openGym instance (https://github.com/DuarteSantos8/openGym)
 * comes in through its own pairing-code flow, or from a pasted backup file.
 *
 * The logbook is per org. An agent signature pins the org to the agent's own;
 * a browser session names the org and must be a member of it.
 */

// Capability keys — must match the agentSkills in src/lib/skills.ts.
const CAP_LOG = "opengym-log";
const CAP_READ = "opengym-read";

const MAX_IMPORT_WORKOUTS = 5000;

interface Caller {
  orgId: string;
  source: Source;
  actor: string;
}

function fail(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

async function resolveCaller(req: Request, ctx: RouteContext, capability: string, bodyOrgId?: unknown): Promise<Caller | Response> {
  if (ctx.agent) {
    try {
      await enforceCapability(ctx.agent.agentId, ctx.agent.orgId, capability);
    } catch (err) {
      return fail((err as Error).message, 403);
    }
    return { orgId: ctx.agent.orgId, source: "agent", actor: ctx.agent.agentId };
  }
  if (!ctx.session) return fail("Authentication required", 401);
  const orgId = new URL(req.url).searchParams.get("orgId") || (typeof bodyOrgId === "string" ? bodyOrgId : "");
  if (!orgId) return fail("orgId is required", 400);
  const membership = await requireOrgMembershipByAddress(ctx.session.address, orgId);
  if (!membership.ok) return fail(membership.error ?? "Forbidden", membership.status ?? 403);
  return { orgId, source: "operator", actor: ctx.session.address };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Listing view: everything but the per-set rows. */
function brief(w: Workout) {
  return {
    id: w.id,
    date: w.date,
    name: w.name,
    durationMin: w.durationMin ?? null,
    exercises: w.exercises.map((e) => e.name),
    sets: w.exercises.reduce((n, e) => n + e.sets.filter((s) => !s.warmup).length, 0),
    volumeKg: workoutVolumeKg(w),
    source: w.source,
  };
}

/** Normalise an operator-typed instance URL to its origin. */
function parseBaseUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim().includes("://") ? raw.trim() : `https://${raw.trim()}`);
    return new URL(u.origin);
  } catch {
    return null;
  }
}

async function importState(caller: Caller, state: unknown) {
  const converted = convertOpenGymState(state);
  if (converted.workouts.length > MAX_IMPORT_WORKOUTS) {
    throw new Error(`Import is limited to ${MAX_IMPORT_WORKOUTS} workouts (got ${converted.workouts.length})`);
  }
  await store.saveWorkouts(caller.orgId, converted.workouts, "opengym", caller.actor);
  await store.saveBodyweight(caller.orgId, converted.bodyweight, "opengym");
  return { workouts: converted.workouts.length, bodyweight: converted.bodyweight.length, skipped: converted.skipped };
}

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("opengym mod loaded");
  },

  routes: {
    /** GET /orgs — the signed-in operator's orgs, for the panel's picker. Session only. */
    "GET /orgs": async (_req, ctx) => {
      if (!ctx.session) return fail("Sign in to list your orgs", 401);
      const orgs = await getOrganizationsByWalletAdmin(ctx.session.address);
      return { orgs: orgs.map((o) => ({ id: o.id, name: o.name || o.id })) };
    },

    /**
     * POST /workouts — log a session. Returns the stored workout and any PRs it set.
     *
     * Body: { date?: "YYYY-MM-DD", name?, unit?: "kg"|"lb", durationMin?, notes?, bodyweight?,
     *         exercises: [{ name, bodyPart?, sets: [{ reps?, weight?, seconds?, rir?, warmup? }] }] }
     * A set list can be shorthand: { name: "Squat", sets: 5, reps: 5, weight: 100 }.
     */
    "POST /workouts": async (req, ctx) => {
      const body = await readJson(req);
      if (!body) return fail("Body must be a JSON object", 400);
      const caller = await resolveCaller(req, ctx, CAP_LOG, body.orgId);
      if (caller instanceof Response) return caller;

      const parsed = parseWorkoutInput(body);
      if (!parsed.ok) return fail(parsed.error, 400);

      const history = await store.listWorkouts(caller.orgId);
      const records = newRecords(parsed.value, history);
      const workout = await store.saveWorkout(caller.orgId, parsed.value, caller.source, caller.actor);
      if (parsed.value.bodyweightKg) {
        await store.saveBodyweight(caller.orgId, [{ date: workout.date, weightKg: parsed.value.bodyweightKg }], caller.source);
      }
      return { workout, volumeKg: workoutVolumeKg(workout), newRecords: records };
    },

    /** GET /workouts?from=&to=&exercise=&limit= — newest first, set rows omitted. */
    "GET /workouts": async (req, ctx) => {
      const caller = await resolveCaller(req, ctx, CAP_READ);
      if (caller instanceof Response) return caller;
      const q = new URL(req.url).searchParams;
      const from = q.get("from");
      const to = q.get("to");
      const exercise = q.get("exercise")?.trim().toLowerCase();
      const limit = Math.min(Math.max(parseInt(q.get("limit") || "50", 10) || 50, 1), 500);
      const all = await store.listWorkouts(caller.orgId);
      const filtered = all.filter(
        (w) =>
          (!from || w.date >= from) &&
          (!to || w.date <= to) &&
          (!exercise || w.exercises.some((e) => e.key.includes(exercise))),
      );
      return { total: filtered.length, workouts: filtered.slice(0, limit).map(brief) };
    },

    /** GET /workouts/:id — one session with every set. */
    "GET /workouts/:id": async (req, ctx) => {
      const caller = await resolveCaller(req, ctx, CAP_READ);
      if (caller instanceof Response) return caller;
      const workout = await store.getWorkout(ctx.params.id);
      if (!workout || workout.orgId !== caller.orgId) return fail("Workout not found", 404);
      return { workout, volumeKg: workoutVolumeKg(workout) };
    },

    /** DELETE /workouts/:id */
    "DELETE /workouts/:id": async (req, ctx) => {
      const caller = await resolveCaller(req, ctx, CAP_LOG);
      if (caller instanceof Response) return caller;
      const workout = await store.getWorkout(ctx.params.id);
      if (!workout || workout.orgId !== caller.orgId) return fail("Workout not found", 404);
      await store.deleteWorkout(workout.id);
      return { deleted: workout.id };
    },

    /** POST /bodyweight — { weight, unit?: "kg"|"lb", date? }. One weigh-in per day; a second replaces the first. */
    "POST /bodyweight": async (req, ctx) => {
      const body = await readJson(req);
      if (!body) return fail("Body must be a JSON object", 400);
      const caller = await resolveCaller(req, ctx, CAP_LOG, body.orgId);
      if (caller instanceof Response) return caller;
      const parsed = parseBodyweightInput(body);
      if (!parsed.ok) return fail(parsed.error, 400);
      await store.saveBodyweight(caller.orgId, [parsed.value], caller.source);
      return { entry: parsed.value };
    },

    /** GET /bodyweight — every weigh-in, oldest first. */
    "GET /bodyweight": async (req, ctx) => {
      const caller = await resolveCaller(req, ctx, CAP_READ);
      if (caller instanceof Response) return caller;
      const entries = await store.listBodyweight(caller.orgId);
      return { entries: entries.map(({ date, weightKg, source }) => ({ date, weightKg, source })) };
    },

    /**
     * GET /stats?days=30 — totals, 8-week trend, weekly streak, estimated-1RM
     * records, body-part split, body weight, and `summary`: a few sentences an
     * agent can put straight into its context.
     */
    "GET /stats": async (req, ctx) => {
      const caller = await resolveCaller(req, ctx, CAP_READ);
      if (caller instanceof Response) return caller;
      const days = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get("days") || "30", 10) || 30, 1), 365);
      const [workouts, bodyweight] = await Promise.all([store.listWorkouts(caller.orgId), store.listBodyweight(caller.orgId)]);
      return computeStats(workouts, bodyweight, days);
    },

    /** GET /exercises/:name — every session of one exercise with its best set, plus the record. */
    "GET /exercises/:name": async (req, ctx) => {
      const caller = await resolveCaller(req, ctx, CAP_READ);
      if (caller instanceof Response) return caller;
      const workouts = await store.listWorkouts(caller.orgId);
      return exerciseHistory(workouts, decodeURIComponent(ctx.params.name));
    },

    /** POST /import — { state } — an openGym "Export backup (JSON)" file. Re-importing overwrites, never duplicates. */
    "POST /import": async (req, ctx) => {
      const body = await readJson(req);
      if (!body) return fail("Body must be a JSON object", 400);
      const caller = await resolveCaller(req, ctx, CAP_LOG, body.orgId);
      if (caller instanceof Response) return caller;
      if (!body.state || typeof body.state !== "object") return fail("state (the openGym backup JSON) is required", 400);
      try {
        return { imported: await importState(caller, body.state) };
      } catch (err) {
        return fail((err as Error).message, 400);
      }
    },

    /** GET /link — the linked openGym instance, if any (never the token). */
    "GET /link": async (req, ctx) => {
      const caller = await resolveCaller(req, ctx, CAP_READ);
      if (caller instanceof Response) return caller;
      return { link: await store.getLink(caller.orgId) };
    },

    /**
     * POST /link — { orgId, baseUrl, code }. Session only: a human links their
     * own openGym account. `code` is the 8-character pairing code from openGym
     * Settings → "Pair the mobile app"; it is redeemed once for a Bearer token,
     * which is stored sealed and used only to read GET /api/data.
     */
    "POST /link": async (req, ctx) => {
      if (ctx.agent) return fail("Linking an openGym account is done by a person in the panel", 403);
      const body = await readJson(req);
      if (!body) return fail("Body must be a JSON object", 400);
      const caller = await resolveCaller(req, ctx, CAP_LOG, body.orgId);
      if (caller instanceof Response) return caller;
      const base = parseBaseUrl(body.baseUrl);
      if (!base) return fail("baseUrl must be your openGym address, e.g. https://gym.example.com", 400);
      const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
      if (!/^[A-Z0-9]{6,12}$/.test(code)) return fail("code must be the pairing code openGym shows", 400);

      let res;
      try {
        res = await sendUpstream({
          url: new URL("/api/pair/redeem", base),
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ code }),
        });
      } catch (err) {
        return fail(`Could not reach openGym: ${(err as Error).message}`, 502);
      }
      let data: { token?: unknown; user?: { name?: unknown }; error?: unknown } = {};
      try {
        data = JSON.parse(res.body);
      } catch {
        // fall through to the status check
      }
      if (res.status !== 200 || typeof data.token !== "string") {
        return fail(typeof data.error === "string" ? `openGym: ${data.error}` : `openGym answered ${res.status}`, 400);
      }
      const profileName = typeof data.user?.name === "string" ? data.user.name : null;
      await store.saveLink(
        { orgId: caller.orgId, baseUrl: base.origin, profileName, linkedBy: caller.actor, linkedAt: new Date().toISOString() },
        data.token,
      );
      return { link: await store.getLink(caller.orgId) };
    },

    /** DELETE /link — forget the instance and its token. Logged workouts stay. */
    "DELETE /link": async (req, ctx) => {
      const caller = await resolveCaller(req, ctx, CAP_LOG);
      if (caller instanceof Response) return caller;
      await store.deleteLink(caller.orgId);
      return { unlinked: true };
    },

    /** POST /sync — pull the linked instance's history into the logbook. Idempotent. */
    "POST /sync": async (req, ctx) => {
      const body = (await readJson(req)) ?? {};
      const caller = await resolveCaller(req, ctx, CAP_LOG, body.orgId);
      if (caller instanceof Response) return caller;
      const linked = await store.getLinkToken(caller.orgId);
      if (!linked) return fail("No openGym instance linked — link one in the openGym panel first", 404);

      let res;
      try {
        res = await sendUpstream({
          url: new URL("/api/data", linked.link.baseUrl),
          method: "GET",
          headers: { authorization: `Bearer ${linked.token}`, accept: "application/json" },
        });
      } catch (err) {
        return fail(`Could not reach openGym: ${(err as Error).message}`, 502);
      }
      if (res.status === 401) return fail("openGym rejected the stored token (expired or signed out everywhere) — link it again", 401);
      if (res.status !== 200) return fail(`openGym answered ${res.status}`, 502);
      if (res.truncated) {
        return fail("Your openGym history is over 1 MB — use Export backup (JSON) in openGym and import the file instead", 413);
      }
      let state: unknown;
      try {
        state = (JSON.parse(res.body) as { state?: unknown }).state;
      } catch {
        return fail("openGym returned something that is not JSON", 502);
      }
      if (!state) return { imported: { workouts: 0, bodyweight: 0, skipped: 0 } };
      try {
        const imported = await importState(caller, state);
        await store.markSynced(caller.orgId, imported.workouts);
        return { imported };
      } catch (err) {
        return fail((err as Error).message, 400);
      }
    },
  },
});
