/**
 * openGym mod — pure logbook logic: input validation, stats, PR detection and
 * conversion of an openGym state blob. No Firestore, no fetch — store.ts and
 * server.ts own those, so everything here is unit-testable.
 *
 * Weights are stored in kg. Callers may send lb; it is converted on the way in.
 */

import { OPENGYM_EXERCISES } from "./exercise-names";

export const LB_TO_KG = 0.45359237;
export const MAX_EXERCISES = 40;
export const MAX_SETS = 40;
/** Rep counts above this give a meaningless 1RM estimate (openGym uses the same cap). */
export const E1RM_REP_CAP = 12;

export type Unit = "kg" | "lb";
export type Source = "agent" | "operator" | "opengym";

export interface GymSet {
  reps?: number;
  weightKg?: number;
  seconds?: number;
  rir?: number;
  warmup?: boolean;
}

export interface GymExercise {
  name: string;
  /** Lower-cased, whitespace-collapsed name — what PRs and history group by. */
  key: string;
  bodyPart?: string;
  sets: GymSet[];
}

export interface Workout {
  id: string;
  orgId: string;
  date: string;
  name: string;
  startedAt?: string;
  durationMin?: number;
  notes?: string;
  bodyweightKg?: number;
  exercises: GymExercise[];
  source: Source;
  loggedBy: string;
  /** openGym workout id, for idempotent re-sync. */
  externalId?: string;
  createdAt: string;
}

export type WorkoutDraft = Omit<Workout, "id" | "orgId" | "source" | "loggedBy" | "createdAt">;

export interface BodyweightEntry {
  orgId: string;
  date: string;
  weightKg: number;
  source: Source;
  at: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function exerciseKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function todayUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function isValidDate(s: unknown): s is string {
  return typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function num(v: unknown, min: number, max: number): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return undefined;
  return n;
}

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/**
 * Validate a workout from an agent or the panel. Accepts a friendly shape:
 *
 *   { date?, name?, unit?: "kg"|"lb", durationMin?, notes?, bodyweight?,
 *     exercises: [{ name, bodyPart?, sets: [{ reps?, weight?, seconds?, rir?, warmup? }] }] }
 *
 * `sets` may also be a shorthand `{ sets: 3, reps: 5, weight: 100 }` — three identical sets.
 */
export function parseWorkoutInput(body: unknown, now = new Date()): Result<WorkoutDraft> {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;

  const date = b.date == null ? todayUtc(now) : b.date;
  if (!isValidDate(date)) return { ok: false, error: "date must be YYYY-MM-DD" };

  const unit: Unit = b.unit === "lb" ? "lb" : "kg";
  if (b.unit != null && b.unit !== "kg" && b.unit !== "lb") return { ok: false, error: 'unit must be "kg" or "lb"' };
  const toKg = (w: number) => round(unit === "lb" ? w * LB_TO_KG : w, 2);

  if (!Array.isArray(b.exercises) || b.exercises.length === 0) {
    return { ok: false, error: "exercises[] is required (at least one exercise)" };
  }
  if (b.exercises.length > MAX_EXERCISES) return { ok: false, error: `At most ${MAX_EXERCISES} exercises per workout` };

  const exercises: GymExercise[] = [];
  for (const [i, raw] of b.exercises.entries()) {
    if (!raw || typeof raw !== "object") return { ok: false, error: `exercises[${i}] must be an object` };
    const e = raw as Record<string, unknown>;
    const name = text(e.name, 120);
    if (!name) return { ok: false, error: `exercises[${i}].name is required` };

    let rawSets: unknown[];
    if (Array.isArray(e.sets)) {
      rawSets = e.sets;
    } else if (typeof e.sets === "number") {
      const count = Math.floor(e.sets);
      if (count < 1 || count > MAX_SETS) return { ok: false, error: `exercises[${i}].sets must be 1–${MAX_SETS}` };
      rawSets = Array.from({ length: count }, () => ({ reps: e.reps, weight: e.weight, seconds: e.seconds, rir: e.rir }));
    } else {
      return { ok: false, error: `exercises[${i}].sets must be an array or a count` };
    }
    if (rawSets.length === 0) return { ok: false, error: `exercises[${i}] has no sets` };
    if (rawSets.length > MAX_SETS) return { ok: false, error: `At most ${MAX_SETS} sets per exercise` };

    const sets: GymSet[] = [];
    for (const [j, rs] of rawSets.entries()) {
      if (!rs || typeof rs !== "object") return { ok: false, error: `exercises[${i}].sets[${j}] must be an object` };
      const s = rs as Record<string, unknown>;
      const reps = num(s.reps, 0, 1000);
      const weight = num(s.weight ?? s.weightKg, -500, 2000);
      const seconds = num(s.seconds, 0, 86_400);
      const rir = num(s.rir, 0, 10);
      if (reps === undefined && seconds === undefined) {
        return { ok: false, error: `exercises[${i}].sets[${j}] needs reps or seconds` };
      }
      const set: GymSet = {};
      if (reps !== undefined) set.reps = Math.round(reps);
      if (weight !== undefined) set.weightKg = toKg(weight);
      if (seconds !== undefined) set.seconds = Math.round(seconds);
      if (rir !== undefined) set.rir = rir;
      if (s.warmup === true) set.warmup = true;
      sets.push(set);
    }

    const bodyPart = text(e.bodyPart, 40);
    exercises.push({ name, key: exerciseKey(name), ...(bodyPart ? { bodyPart } : {}), sets });
  }

  const draft: WorkoutDraft = { date, name: text(b.name, 120) ?? "Workout", exercises };
  const durationMin = num(b.durationMin, 0, 24 * 60);
  if (durationMin !== undefined) draft.durationMin = Math.round(durationMin);
  const notes = text(b.notes, 2000);
  if (notes) draft.notes = notes;
  const bw = num(b.bodyweight, 20, 700);
  if (bw !== undefined) draft.bodyweightKg = toKg(bw);
  const startedAt = typeof b.startedAt === "string" && !Number.isNaN(Date.parse(b.startedAt)) ? new Date(b.startedAt).toISOString() : undefined;
  if (startedAt) draft.startedAt = startedAt;
  return { ok: true, value: draft };
}

export function parseBodyweightInput(body: unknown, now = new Date()): Result<{ date: string; weightKg: number }> {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const date = b.date == null ? todayUtc(now) : b.date;
  if (!isValidDate(date)) return { ok: false, error: "date must be YYYY-MM-DD" };
  if (b.unit != null && b.unit !== "kg" && b.unit !== "lb") return { ok: false, error: 'unit must be "kg" or "lb"' };
  const w = num(b.weight, 20, 700);
  if (w === undefined) return { ok: false, error: "weight is required (20–700)" };
  return { ok: true, value: { date, weightKg: round(b.unit === "lb" ? w * LB_TO_KG : w, 2) } };
}

// ── Stats ────────────────────────────────────────────────────────────────

/** Epley estimate; null for warm-ups, timed sets, no load, or reps past the cap. */
export function estimate1RM(set: GymSet): number | null {
  if (set.warmup || !set.reps || set.reps < 1 || set.reps > E1RM_REP_CAP) return null;
  const w = set.weightKg ?? 0;
  if (w <= 0) return null;
  return round(set.reps === 1 ? w : w * (1 + set.reps / 30));
}

export function setVolumeKg(set: GymSet): number {
  if (set.warmup || !set.reps || !set.weightKg || set.weightKg <= 0) return 0;
  return set.weightKg * set.reps;
}

export function workoutVolumeKg(w: Pick<Workout, "exercises">): number {
  return round(w.exercises.reduce((sum, e) => sum + e.sets.reduce((s, set) => s + setVolumeKg(set), 0), 0), 0);
}

export interface PersonalRecord {
  exercise: string;
  key: string;
  e1rmKg: number;
  weightKg: number;
  reps: number;
  date: string;
  workoutId?: string;
}

function bestSet(e: GymExercise): { e1rm: number; set: GymSet } | null {
  let best: { e1rm: number; set: GymSet } | null = null;
  for (const set of e.sets) {
    const est = estimate1RM(set);
    if (est !== null && (!best || est > best.e1rm)) best = { e1rm: est, set };
  }
  return best;
}

/** Best estimated 1RM per exercise across the given workouts. */
export function personalRecords(workouts: Workout[]): Map<string, PersonalRecord> {
  const prs = new Map<string, PersonalRecord>();
  for (const w of workouts) {
    for (const e of w.exercises) {
      const b = bestSet(e);
      if (!b) continue;
      const prev = prs.get(e.key);
      if (!prev || b.e1rm > prev.e1rmKg) {
        prs.set(e.key, { exercise: e.name, key: e.key, e1rmKg: b.e1rm, weightKg: b.set.weightKg ?? 0, reps: b.set.reps ?? 0, date: w.date, workoutId: w.id });
      }
    }
  }
  return prs;
}

/**
 * PRs a new workout sets against everything logged before it. Only history
 * dated on or before the new workout counts, so backfilling an old session
 * never claims a record that a later one already beat.
 */
export function newRecords(workout: Pick<Workout, "date" | "exercises">, history: Workout[]): PersonalRecord[] {
  const prior = personalRecords(history.filter((h) => h.date <= workout.date));
  const out: PersonalRecord[] = [];
  for (const e of workout.exercises) {
    const b = bestSet(e);
    if (!b) continue;
    const prev = prior.get(e.key);
    if (!prev || b.e1rm > prev.e1rmKg) {
      out.push({ exercise: e.name, key: e.key, e1rmKg: b.e1rm, weightKg: b.set.weightKg ?? 0, reps: b.set.reps ?? 0, date: workout.date });
    }
  }
  return out;
}

/** Monday of the ISO week containing `date` (YYYY-MM-DD). */
export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface GymStats {
  windowDays: number;
  totals: { workouts: number; sets: number; volumeKg: number; minutes: number };
  weekly: { weekStart: string; workouts: number; volumeKg: number }[];
  /** Consecutive weeks, ending this week or last, with at least one workout. */
  weekStreak: number;
  lastWorkout: { id: string; date: string; name: string } | null;
  bodyParts: { bodyPart: string; sets: number }[];
  records: PersonalRecord[];
  bodyweight: { latestKg: number; date: string; change30dKg: number | null } | null;
  summary: string;
}

export function computeStats(workouts: Workout[], bodyweight: BodyweightEntry[], windowDays = 30, now = new Date()): GymStats {
  const today = todayUtc(now);
  const from = addDays(today, -(windowDays - 1));
  const sorted = [...workouts].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const inWindow = sorted.filter((w) => w.date >= from && w.date <= today);

  const totals = { workouts: inWindow.length, sets: 0, volumeKg: 0, minutes: 0 };
  const parts = new Map<string, number>();
  for (const w of inWindow) {
    totals.volumeKg += workoutVolumeKg(w);
    totals.minutes += w.durationMin ?? 0;
    for (const e of w.exercises) {
      const working = e.sets.filter((s) => !s.warmup).length;
      totals.sets += working;
      if (e.bodyPart) parts.set(e.bodyPart, (parts.get(e.bodyPart) ?? 0) + working);
    }
  }

  const thisWeek = weekStart(today);
  const weekly: GymStats["weekly"] = [];
  for (let i = 7; i >= 0; i--) {
    const ws = addDays(thisWeek, -7 * i);
    const we = addDays(ws, 6);
    const ofWeek = sorted.filter((w) => w.date >= ws && w.date <= we);
    weekly.push({ weekStart: ws, workouts: ofWeek.length, volumeKg: ofWeek.reduce((s, w) => s + workoutVolumeKg(w), 0) });
  }

  const trained = new Set(sorted.map((w) => weekStart(w.date)));
  let cursor = trained.has(thisWeek) ? thisWeek : addDays(thisWeek, -7);
  let weekStreak = 0;
  while (trained.has(cursor)) {
    weekStreak++;
    cursor = addDays(cursor, -7);
  }

  const records = [...personalRecords(sorted).values()].sort((a, b) => b.e1rmKg - a.e1rmKg);

  const bw = [...bodyweight].sort((a, b) => a.date.localeCompare(b.date));
  let bodyweightStat: GymStats["bodyweight"] = null;
  if (bw.length) {
    const latest = bw[bw.length - 1];
    const cutoff = addDays(latest.date, -30);
    const base = bw.find((e) => e.date >= cutoff);
    bodyweightStat = {
      latestKg: latest.weightKg,
      date: latest.date,
      change30dKg: base && base !== latest ? round(latest.weightKg - base.weightKg) : null,
    };
  }

  const last = sorted[0];
  const stats: GymStats = {
    windowDays,
    totals: { ...totals, volumeKg: round(totals.volumeKg, 0) },
    weekly,
    weekStreak,
    lastWorkout: last ? { id: last.id, date: last.date, name: last.name } : null,
    bodyParts: [...parts.entries()].map(([bodyPart, sets]) => ({ bodyPart, sets })).sort((a, b) => b.sets - a.sets),
    records,
    bodyweight: bodyweightStat,
    summary: "",
  };
  stats.summary = summarize(stats, today);
  return stats;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** A few plain sentences an agent can drop straight into its context. */
function summarize(s: GymStats, today: string): string {
  if (!s.lastWorkout) return "No workouts logged yet.";
  const lines: string[] = [];
  const ago = daysBetween(s.lastWorkout.date, today);
  lines.push(`Last workout: ${s.lastWorkout.name} on ${s.lastWorkout.date} (${ago === 0 ? "today" : ago === 1 ? "yesterday" : `${ago} days ago`}).`);
  lines.push(`Last ${s.windowDays} days: ${s.totals.workouts} workouts, ${s.totals.sets} working sets, ${s.totals.volumeKg.toLocaleString("en-US")} kg volume.`);
  lines.push(`Weekly streak: ${s.weekStreak} week${s.weekStreak === 1 ? "" : "s"}.`);
  if (s.records.length) {
    lines.push(`Top estimated 1RMs: ${s.records.slice(0, 3).map((r) => `${r.exercise} ${r.e1rmKg} kg`).join(", ")}.`);
  }
  if (s.bodyweight) {
    const ch = s.bodyweight.change30dKg;
    lines.push(`Body weight: ${s.bodyweight.latestKg} kg on ${s.bodyweight.date}${ch != null ? ` (${ch >= 0 ? "+" : ""}${ch} kg over 30 days)` : ""}.`);
  }
  if (s.bodyParts.length >= 2) {
    const least = s.bodyParts[s.bodyParts.length - 1];
    lines.push(`Least-trained body part this window: ${least.bodyPart} (${least.sets} sets).`);
  }
  return lines.join(" ");
}

/** Every logged session of one exercise, newest first, with its best set. */
export function exerciseHistory(workouts: Workout[], name: string) {
  const key = exerciseKey(name);
  const sessions = [];
  for (const w of [...workouts].sort((a, b) => b.date.localeCompare(a.date))) {
    for (const e of w.exercises) {
      if (e.key !== key) continue;
      const b = bestSet(e);
      sessions.push({
        workoutId: w.id,
        date: w.date,
        sets: e.sets,
        volumeKg: round(e.sets.reduce((s, set) => s + setVolumeKg(set), 0), 0),
        bestE1rmKg: b?.e1rm ?? null,
      });
    }
  }
  return { exercise: name, key, sessions, record: personalRecords(workouts).get(key) ?? null };
}

// ── openGym import ──────────────────────────────────────────────────────

export interface OpenGymImport {
  workouts: (WorkoutDraft & { externalId: string })[];
  bodyweight: { date: string; weightKg: number }[];
  skipped: number;
}

/**
 * Convert an openGym state blob (GET /api/data `.state`, or an "Export backup
 * (JSON)" file — the same object) into logbook drafts. Only completed sets are
 * kept; sessions without one are skipped. Field names follow openGym's state:
 * workouts[].{id,d,name,start,end,bw,entries[].{id,sets[].{done,w,r,sec,min,phase,warmup}}},
 * bodyweight[].{d,w}, customEx[].{id,n,bp}, unit.
 */
export function convertOpenGymState(state: unknown): OpenGymImport {
  const S = (state && typeof state === "object" ? state : {}) as Record<string, unknown>;
  const lb = S.unit === "lb";
  const toKg = (v: number) => round(lb ? v * LB_TO_KG : v, 2);
  const custom = new Map<string, { n?: string; bp?: string }>();
  for (const c of Array.isArray(S.customEx) ? S.customEx : []) {
    if (c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string") custom.set((c as { id: string }).id, c as { n?: string; bp?: string });
  }
  const nameOf = (id: string): [string, string | undefined] => {
    const c = custom.get(id);
    if (c?.n) return [c.n, c.bp || undefined];
    const lib = OPENGYM_EXERCISES[id];
    if (lib) return [lib[0], lib[1] || undefined];
    return [`openGym exercise ${id}`, undefined];
  };

  const out: OpenGymImport = { workouts: [], bodyweight: [], skipped: 0 };
  for (const raw of Array.isArray(S.workouts) ? S.workouts : []) {
    const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const start = typeof w.start === "number" ? w.start : undefined;
    const date = isValidDate(w.d) ? w.d : start ? new Date(start).toISOString().slice(0, 10) : null;
    if (!date) {
      out.skipped++;
      continue;
    }
    const exercises: GymExercise[] = [];
    for (const rawEntry of Array.isArray(w.entries) ? w.entries : []) {
      const e = (rawEntry && typeof rawEntry === "object" ? rawEntry : {}) as Record<string, unknown>;
      if (typeof e.id !== "string") continue;
      const sets: GymSet[] = [];
      for (const rawSet of Array.isArray(e.sets) ? e.sets : []) {
        const s = (rawSet && typeof rawSet === "object" ? rawSet : {}) as Record<string, unknown>;
        if (!s.done) continue;
        const set: GymSet = {};
        const r = Number(s.r);
        const wt = Number(s.w);
        const sec = Number(s.sec) || Number(s.min) * 60;
        if (Number.isFinite(r) && r > 0) set.reps = Math.round(r);
        if (Number.isFinite(wt) && wt !== 0) set.weightKg = toKg(wt);
        if (Number.isFinite(sec) && sec > 0) set.seconds = Math.round(sec);
        if (s.phase === "warmup" || (s.phase == null && s.warmup === true)) set.warmup = true;
        if (set.reps !== undefined || set.seconds !== undefined) sets.push(set);
      }
      if (!sets.length) continue;
      const [name, bodyPart] = nameOf(e.id);
      exercises.push({ name, key: exerciseKey(name), ...(bodyPart ? { bodyPart } : {}), sets: sets.slice(0, MAX_SETS) });
    }
    if (!exercises.length) {
      out.skipped++;
      continue;
    }
    const end = typeof w.end === "number" ? w.end : undefined;
    const draft: WorkoutDraft & { externalId: string } = {
      externalId: typeof w.id === "string" && w.id ? w.id : `${date}-${start ?? 0}`,
      date,
      name: (typeof w.name === "string" && w.name.trim()) || "openGym workout",
      exercises: exercises.slice(0, MAX_EXERCISES),
    };
    if (start) draft.startedAt = new Date(start).toISOString();
    if (start && end && end > start) draft.durationMin = Math.round((end - start) / 60_000);
    const bw = Number(w.bw);
    if (Number.isFinite(bw) && bw > 0) draft.bodyweightKg = toKg(bw);
    out.workouts.push(draft);
  }

  for (const raw of Array.isArray(S.bodyweight) ? S.bodyweight : []) {
    const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const w = Number(b.w);
    if (isValidDate(b.d) && Number.isFinite(w) && w > 0) out.bodyweight.push({ date: b.d, weightKg: toKg(w) });
  }
  return out;
}
