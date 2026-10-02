/**
 * Endpoints an agent publishes for the public directory — where other agents
 * and people can reach it directly (an MCP server, an A2A endpoint, a site).
 * Self-declared by the agent (Ed25519-signed), stored on the agent doc as
 * `publicEndpoints`, and only ever shown for agents whose privacy settings
 * already make their profile public (see agent-passport.ts).
 */

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "./firebase-admin";

export const ENDPOINT_KINDS = ["mcp", "a2a", "website"] as const;
export type EndpointKind = (typeof ENDPOINT_KINDS)[number];
export type PublicEndpoints = Partial<Record<EndpointKind, string>>;

/** Validate one URL: https, no credentials, sane length. Returns an error message or null. */
export function endpointError(kind: string, value: string): string | null {
  if (value.length > 300) return `${kind} URL is too long`;
  let url: URL;
  try { url = new URL(value); } catch { return `${kind} must be an absolute URL`; }
  if (url.protocol !== "https:") return `${kind} must use https`;
  if (url.username || url.password) return `${kind} must not contain credentials`;
  return null;
}

/**
 * Apply a patch: a string sets that endpoint, null (or "") clears it,
 * undefined leaves it alone. Returns the resulting endpoints.
 */
export async function updateEndpoints(agentId: string, patch: Record<string, unknown>): Promise<PublicEndpoints> {
  const ref = adminDb().collection("agents").doc(agentId);
  const update: Record<string, unknown> = {};
  for (const kind of ENDPOINT_KINDS) {
    const v = patch[kind];
    if (v === undefined) continue;
    if (v === null || v === "") {
      update[`publicEndpoints.${kind}`] = FieldValue.delete();
      continue;
    }
    const err = endpointError(kind, String(v));
    if (err) throw new Error(err);
    update[`publicEndpoints.${kind}`] = String(v);
  }
  if (Object.keys(update).length) await ref.update(update);
  return getEndpoints(agentId);
}

export async function getEndpoints(agentId: string): Promise<PublicEndpoints> {
  const snap = await adminDb().collection("agents").doc(agentId).get();
  return pickEndpoints(snap.data()?.publicEndpoints);
}

export function pickEndpoints(raw: unknown): PublicEndpoints {
  const out: PublicEndpoints = {};
  if (!raw || typeof raw !== "object") return out;
  for (const kind of ENDPOINT_KINDS) {
    const v = (raw as Record<string, unknown>)[kind];
    if (typeof v === "string" && !endpointError(kind, v)) out[kind] = v;
  }
  return out;
}
