/**
 * Training data from buyer verdicts — pure logic, no Firestore.
 *
 * Every job an agent delivers ends in a human verdict: approve, or send back
 * for revisions, sometimes with a 1–5 gig rating. That is preference data:
 *
 *   - DPO pairs: a job rejected and later approved gives one prompt with a
 *     worse answer (each rejected delivery) and a better one (the approved
 *     delivery). Rows: { prompt, chosen, rejected } (TRL DPOTrainer).
 *   - KTO rows: every reviewed delivery labelled good or bad on its own —
 *     approved and not rated ≤ 2 is good. Rows: { prompt, completion, label }
 *     (TRL KTOTrainer). Most jobs are approved first time and never make a
 *     pair, so this is the larger set.
 *
 * Deliveries are matched to verdicts by time: a review judges the latest
 * delivery before it. Jobs delivered before deliveryHistory existed only have
 * their final delivery, so they yield KTO rows but no pairs.
 *
 * Secrets in job text are redacted before anything leaves the hub.
 */
import { redactSecrets } from "@/lib/shroud/inspect";

export interface JobRecord {
  jobId: string;
  title: string;
  description: string;
  /** Oldest first. */
  deliveries: { notes: string; at: number }[];
  /** Oldest first. */
  reviews: { approved: boolean; at: number; notes: string }[];
  /** Gig rating on the final approval, if any. */
  rating: number | null;
}

export interface DpoRow {
  prompt: string;
  chosen: string;
  rejected: string;
  meta: { jobId: string; rejectionNotes: string; rating: number | null };
}

export interface KtoRow {
  prompt: string;
  completion: string;
  label: boolean;
  meta: { jobId: string; approved: boolean; rating: number | null; notes: string };
}

export const LOW_RATING = 2;
const MAX_CHARS = 20_000;

const clean = (s: string) => redactSecrets(s.slice(0, MAX_CHARS)).text.trim();

export function promptFor(job: Pick<JobRecord, "title" | "description">): string {
  return clean([job.title.trim(), job.description.trim()].filter(Boolean).join("\n\n"));
}

/** Each review paired with the delivery it judged (the latest one at or before it). */
export function judgedDeliveries(job: JobRecord) {
  const out: { completion: string; approved: boolean; notes: string; final: boolean }[] = [];
  job.reviews.forEach((r, i) => {
    const delivery = [...job.deliveries].reverse().find((d) => d.at <= r.at) ?? (job.deliveries.length === 1 ? job.deliveries[0] : undefined);
    if (!delivery || !delivery.notes.trim()) return;
    out.push({ completion: clean(delivery.notes), approved: r.approved, notes: r.notes, final: i === job.reviews.length - 1 });
  });
  // Two reviews of one delivery (rejected, then approved unchanged) — keep the later verdict.
  return out.filter((d, i) => !out.slice(i + 1).some((later) => later.completion === d.completion));
}

export function buildPreferenceData(jobs: JobRecord[]): { dpo: DpoRow[]; kto: KtoRow[] } {
  const dpo: DpoRow[] = [];
  const kto: KtoRow[] = [];
  for (const job of jobs) {
    const prompt = promptFor(job);
    if (!prompt) continue;
    const judged = judgedDeliveries(job);

    for (const d of judged) {
      const rating = d.final && d.approved ? job.rating : null;
      kto.push({
        prompt,
        completion: d.completion,
        label: d.approved && !(rating !== null && rating <= LOW_RATING),
        meta: { jobId: job.jobId, approved: d.approved, rating, notes: clean(d.notes) },
      });
    }

    const approved = judged.filter((d) => d.approved).at(-1);
    if (!approved || (job.rating !== null && job.rating <= LOW_RATING)) continue;
    for (const r of judged.filter((d) => !d.approved && d.completion !== approved.completion)) {
      dpo.push({ prompt, chosen: approved.completion, rejected: r.completion, meta: { jobId: job.jobId, rejectionNotes: clean(r.notes), rating: job.rating } });
    }
  }
  return { dpo, kto };
}

export function toJsonl(rows: object[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}
