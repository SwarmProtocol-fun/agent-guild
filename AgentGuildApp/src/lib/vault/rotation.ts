/**
 * Scheduled secret rotation.
 *
 * A secret can carry a rotation policy: every N days, either
 *   - remind:  mark it overdue (shown on /vault and recorded in the audit log), or
 *   - webhook: POST to an HTTPS endpoint the org runs, which creates a fresh
 *              credential at the provider and replies { "value": "<new key>" };
 *              the vault seals that in place of the old value.
 *
 * Webhook requests are signed so the receiver can tell they came from us:
 *   x-agent-guild-timestamp: <unix ms>
 *   x-agent-guild-signature: sha256=<hex HMAC-SHA256(signingSecret, `${timestamp}.${body}`)>
 * The signing secret is generated per policy, shown to the owner once, and
 * stored sealed like any other secret.
 *
 * sweepRotations() is driven hourly by netlify/functions/vault-rotation.mts.
 */

import crypto from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { seal, open, type SealedValue } from "./crypto";
import { sendUpstream, checkHostname, insecureEgressAllowed } from "./egress";
import { appendAudit, auditQuietly, rotateSecret, VaultError } from "./store";

const DAY_MS = 86_400_000;
const RETRY_MS = 3_600_000;

export interface RotationInput {
  intervalDays: number;
  mode: "remind" | "webhook";
  webhookUrl?: string;
}

export function validateRotationInput(raw: Record<string, unknown>): RotationInput | string {
  const intervalDays = Number(raw.intervalDays);
  if (!Number.isInteger(intervalDays) || intervalDays < 1 || intervalDays > 365) return "intervalDays must be a whole number from 1 to 365";
  const mode = raw.mode === "webhook" ? "webhook" : raw.mode === "remind" ? "remind" : null;
  if (!mode) return "mode must be remind or webhook";
  if (mode === "remind") return { intervalDays, mode };

  let url: URL;
  try { url = new URL(String(raw.webhookUrl ?? "")); } catch { return "webhookUrl must be an absolute URL"; }
  if (url.protocol !== "https:" && !(insecureEgressAllowed() && url.protocol === "http:")) return "webhookUrl must use https";
  if (url.username || url.password) return "webhookUrl must not contain credentials";
  const hostErr = checkHostname(url.hostname);
  if (hostErr) return hostErr;
  return { intervalDays, mode, webhookUrl: url.toString() };
}

const signingAad = (orgId: string, secretId: string) => `vault:${orgId}:${secretId}:rotation-signing`;

export function signWebhook(signingSecret: string, timestamp: string, body: string): string {
  return `sha256=${crypto.createHmac("sha256", signingSecret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Set or replace a secret's rotation policy. Returns the webhook signing
 * secret when one was generated — the only time it is ever shown.
 */
export async function setRotationPolicy(orgId: string, secretId: string, input: RotationInput): Promise<{ signingSecret: string | null }> {
  const ref = adminDb().collection("vaultSecrets").doc(secretId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("Secret not found", 404);
  const existing = snap.data()!.rotation;

  let signingSecret: string | null = null;
  let sealedSigning: SealedValue | null = existing?.signing ?? null;
  // A new webhook policy (or a changed URL) gets a fresh signing secret.
  if (input.mode === "webhook" && (!sealedSigning || existing?.webhookUrl !== input.webhookUrl)) {
    signingSecret = `whsec_${crypto.randomBytes(24).toString("base64url")}`;
    sealedSigning = await seal(signingSecret, signingAad(orgId, secretId));
  }

  await ref.update({
    rotation: {
      intervalDays: input.intervalDays,
      mode: input.mode,
      webhookUrl: input.mode === "webhook" ? input.webhookUrl : null,
      signing: input.mode === "webhook" ? sealedSigning : null,
      nextAt: Timestamp.fromMillis(Date.now() + input.intervalDays * DAY_MS),
      overdue: false,
      lastError: null,
      lastAttemptAt: null,
    },
  });
  return { signingSecret };
}

export async function clearRotationPolicy(orgId: string, secretId: string): Promise<void> {
  const ref = adminDb().collection("vaultSecrets").doc(secretId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("Secret not found", 404);
  await ref.update({ rotation: null });
}

/** Ask the org's webhook for a new credential and seal it. Throws VaultError with a readable reason on failure. */
export async function rotateViaWebhook(orgId: string, secretId: string, actor: { type: "user" | "agent"; id: string } = { type: "user", id: "scheduler" }) {
  const ref = adminDb().collection("vaultSecrets").doc(secretId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("Secret not found", 404);
  const data = snap.data()!;
  const policy = data.rotation;
  if (!policy || policy.mode !== "webhook" || !policy.webhookUrl || !policy.signing) {
    throw new VaultError("This secret has no rotation webhook configured");
  }

  const signingSecret = await open(policy.signing as SealedValue, signingAad(orgId, secretId));
  const body = JSON.stringify({ event: "secret.rotate", orgId, secretId, secretName: data.name, requestedAt: new Date().toISOString() });
  const timestamp = Date.now().toString();

  let newValue: string;
  try {
    const res = await sendUpstream({
      url: new URL(policy.webhookUrl),
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-guild-timestamp": timestamp,
        "x-agent-guild-signature": signWebhook(signingSecret, timestamp, body),
        "x-agent-guild-event": "secret.rotate",
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`webhook answered HTTP ${res.status}`);
    let parsed: unknown;
    try { parsed = JSON.parse(res.body); } catch { throw new Error("webhook reply is not JSON"); }
    const value = (parsed as { value?: unknown })?.value;
    if (typeof value !== "string" || !value) throw new Error('webhook reply has no "value" string');
    newValue = value;
  } catch (err) {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    await ref.update({
      "rotation.lastError": reason,
      "rotation.lastAttemptAt": Timestamp.now(),
      "rotation.overdue": true,
      "rotation.nextAt": Timestamp.fromMillis(Date.now() + RETRY_MS),
    });
    auditQuietly({ orgId, action: "secret.rotation_failed", actorType: actor.type, actorId: actor.id, target: data.name, detail: { reason } });
    throw new VaultError(`Rotation webhook failed: ${reason}`, 502);
  }

  await rotateSecret(orgId, secretId, newValue);
  await ref.update({ "rotation.lastAttemptAt": Timestamp.now() });
  await appendAudit({ orgId, action: "secret.rotated", actorType: actor.type, actorId: actor.id, target: data.name, detail: { via: "webhook" } });
}

export interface SweepResult {
  rotated: string[];
  failed: { secretId: string; reason: string }[];
  reminded: string[];
}

/** Process every secret whose rotation is due. Idempotent; safe to run as often as you like. */
export async function sweepRotations(now = Date.now()): Promise<SweepResult> {
  const due = await adminDb().collection("vaultSecrets").where("rotation.nextAt", "<=", Timestamp.fromMillis(now)).limit(200).get();
  const result: SweepResult = { rotated: [], failed: [], reminded: [] };

  for (const doc of due.docs) {
    const data = doc.data();
    const policy = data.rotation;
    if (!policy?.intervalDays) continue;

    if (policy.mode === "webhook") {
      try {
        await rotateViaWebhook(data.orgId, doc.id);
        result.rotated.push(doc.id);
      } catch (err) {
        result.failed.push({ secretId: doc.id, reason: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }

    // remind: flag once, then wait for someone to rotate it (which resets the schedule).
    if (!policy.overdue) {
      await doc.ref.update({ "rotation.overdue": true });
      auditQuietly({ orgId: data.orgId, action: "secret.rotation_due", actorType: "user", actorId: "scheduler", target: data.name, detail: { intervalDays: policy.intervalDays } });
      result.reminded.push(doc.id);
    }
    // Don't pick it up again every hour.
    await doc.ref.update({ "rotation.nextAt": Timestamp.fromMillis(now + DAY_MS) });
  }
  return result;
}
