/**
 * Vault access for hosted runtimes (org compute machines).
 *
 * A machine never receives a raw secret, and never holds an agent's private
 * key. Instead:
 *
 *   1. An org owner connects a computer to one of the org's agents, choosing
 *      token scopes and (optionally) which bindings it may use.
 *   2. The hub creates a one-time enrollment code (10 min, single use) and
 *      pushes an install command through the provider's `bash` action — or
 *      hands the command to the owner to paste when the push isn't possible.
 *   3. On the machine the command redeems the code for a runtime credential
 *      (agrt_…, in /etc/agent-guild/runtime.env, readable by local users —
 *      provider run-command usually installs as root while the agent runs as
 *      a desktop user, and on a single-tenant agent machine every local
 *      process is the agent anyway) and installs two helpers:
 *      `agent-guild-token` prints a fresh 1-hour agt_ token, and
 *      `agent-guild` runs the CLI with that token (keyless mode).
 *   4. Revoking the runtime kills the credential; tokens it already minted
 *      expire within the hour, or immediately via "Revoke tokens".
 *
 * Only hashes of the code and credential are stored. Cloud command history
 * (SSM / run-command logs) only ever contains a spent enrollment code.
 *
 *   vaultRuntimes/{computerId}  { orgId, agentId, scopes, bindings, credentialHash,
 *                                 enrollHash, enrollExpiresAt, enrolledAt, revoked }
 */

import crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase-admin";
import { issueAgentToken, type TokenScope } from "@/lib/agent-tokens";
import { getComputer } from "@/lib/compute/firestore";
import { VaultError } from "./store";

const ENROLL_TTL_MS = 10 * 60 * 1000;
const RUNTIME_TOKEN_TTL = 3600;
export const RUNTIME_CREDENTIAL_PREFIX = "agrt_";
const ENROLL_PREFIX = "agen_";

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const col = () => adminDb().collection("vaultRuntimes");

export interface RuntimeSummary {
  computerId: string;
  agentId: string;
  scopes: TokenScope[];
  bindings: string[] | null;
  enrolled: boolean;
  enrolledAt: number | null;
  lastTokenAt: number | null;
  revoked: boolean;
  createdBy: string;
}

/**
 * Create (or re-create) a runtime connection and its enrollment code.
 * Re-connecting a computer invalidates any credential it held before.
 */
export async function connectRuntime(opts: {
  orgId: string;
  computerId: string;
  agentId: string;
  scopes: TokenScope[];
  bindings?: string[];
  createdBy: string;
}): Promise<{ enrollCode: string }> {
  const [computer, agent] = await Promise.all([
    getComputer(opts.computerId),
    adminDb().collection("agents").doc(opts.agentId).get(),
  ]);
  if (!computer || computer.orgId !== opts.orgId) throw new VaultError("Computer not found in this organization", 404);
  if (!agent.exists || (agent.data()!.orgId || agent.data()!.organizationId) !== opts.orgId) {
    throw new VaultError("Agent not found in this organization", 404);
  }

  const enrollCode = `${ENROLL_PREFIX}${crypto.randomBytes(18).toString("base64url")}`;
  await col().doc(opts.computerId).set({
    orgId: opts.orgId,
    computerId: opts.computerId,
    agentId: opts.agentId,
    scopes: opts.scopes,
    bindings: opts.bindings?.length ? opts.bindings : null,
    credentialHash: null,
    enrollHash: sha256(enrollCode),
    enrollExpiresAt: Timestamp.fromMillis(Date.now() + ENROLL_TTL_MS),
    enrolledAt: null,
    lastTokenAt: null,
    revoked: false,
    createdBy: opts.createdBy,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { enrollCode };
}

/** Machine side: trade a one-time code for the long-lived runtime credential. */
export async function enrollRuntime(enrollCode: string): Promise<{ runtimeId: string; credential: string }> {
  if (!enrollCode.startsWith(ENROLL_PREFIX)) throw new VaultError("Invalid enrollment code", 401);
  const snap = await col().where("enrollHash", "==", sha256(enrollCode)).limit(1).get();
  if (snap.empty) throw new VaultError("Invalid or already used enrollment code", 401);
  const ref = snap.docs[0].ref;
  const credential = `${RUNTIME_CREDENTIAL_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;

  await adminDb().runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const d = doc.data();
    if (!d || d.revoked || d.enrollHash !== sha256(enrollCode)) throw new VaultError("Invalid or already used enrollment code", 401);
    if ((d.enrollExpiresAt as Timestamp).toMillis() < Date.now()) throw new VaultError("Enrollment code expired — connect the runtime again", 401);
    tx.update(ref, { enrollHash: null, enrollExpiresAt: null, credentialHash: sha256(credential), enrolledAt: FieldValue.serverTimestamp() });
  });
  return { runtimeId: ref.id, credential };
}

/** Machine side: trade the runtime credential for a short-lived agent token. */
export async function runtimeToken(runtimeId: string, credential: string) {
  if (!credential.startsWith(RUNTIME_CREDENTIAL_PREFIX)) throw new VaultError("Invalid runtime credential", 401);
  const snap = await col().doc(runtimeId).get();
  const d = snap.data();
  const expected = d?.credentialHash ? Buffer.from(d.credentialHash, "hex") : null;
  const given = Buffer.from(sha256(credential), "hex");
  if (!d || d.revoked || !expected || !crypto.timingSafeEqual(expected, given)) {
    throw new VaultError("Invalid or revoked runtime credential", 401);
  }
  const agent = await adminDb().collection("agents").doc(d.agentId).get();
  if (!agent.exists || (agent.data()!.orgId || agent.data()!.organizationId) !== d.orgId) {
    throw new VaultError("The runtime's agent no longer belongs to this organization", 403);
  }
  const issued = await issueAgentToken(
    { agentId: d.agentId, orgId: d.orgId, agentName: agent.data()!.name || d.agentId },
    { scopes: d.scopes, bindings: d.bindings ?? undefined, ttlSeconds: RUNTIME_TOKEN_TTL },
  );
  snap.ref.update({ lastTokenAt: FieldValue.serverTimestamp() }).catch(() => {});
  return { token: issued.token, expiresAt: issued.claims.expiresAt * 1000 };
}

export async function revokeRuntime(orgId: string, computerId: string): Promise<void> {
  const ref = col().doc(computerId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()!.orgId !== orgId) throw new VaultError("Runtime not found", 404);
  await ref.update({ revoked: true, credentialHash: null, enrollHash: null, revokedAt: FieldValue.serverTimestamp() });
}

export async function listRuntimes(orgId: string): Promise<RuntimeSummary[]> {
  const snap = await col().where("orgId", "==", orgId).get();
  const ms = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : null);
  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      computerId: doc.id,
      agentId: d.agentId,
      scopes: d.scopes || [],
      bindings: d.bindings ?? null,
      enrolled: Boolean(d.credentialHash),
      enrolledAt: ms(d.enrolledAt),
      lastTokenAt: ms(d.lastTokenAt),
      revoked: Boolean(d.revoked),
      createdBy: d.createdBy,
    };
  });
}

/**
 * The shell command that enrolls a machine. Safe to show and log: the code
 * inside is single-use and expires in 10 minutes. Needs curl; the
 * `agent-guild` wrapper additionally needs node (agent-guild-token doesn't).
 */
export function installCommand(hub: string, enrollCode: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const tokenHelper = [
    "#!/bin/sh",
    "# Prints a fresh 1-hour Agent Guild token for this runtime (cached until 5 min before expiry).",
    "set -e",
    ". /etc/agent-guild/runtime.env",
    'CACHE="${XDG_RUNTIME_DIR:-/tmp}/agent-guild-token.$(id -u)"',
    'if [ -f "$CACHE" ] && [ $(( $(date +%s) + 300 )) -lt "$(cut -d" " -f1 "$CACHE")" ]; then cut -d" " -f2 "$CACHE"; exit 0; fi',
    'R=$(curl -fsS -X POST "$AGENT_GUILD_HUB/api/v1/runtime/token" -H "Authorization: Runtime $AGENT_GUILD_RUNTIME_CREDENTIAL" -H "x-runtime-id: $AGENT_GUILD_RUNTIME_ID")',
    'T=$(printf %s "$R" | sed -n \'s/.*"token":"\\([^"]*\\)".*/\\1/p\')',
    'E=$(printf %s "$R" | sed -n \'s/.*"expiresAt":\\([0-9]*\\).*/\\1/p\')',
    '[ -n "$T" ] || { echo "agent-guild-token: $R" >&2; exit 1; }',
    'umask 077; printf "%s %s" "$((E / 1000))" "$T" > "$CACHE"',
    'printf "%s\\n" "$T"',
  ].join("\n");
  const cliWrapper = [
    "#!/bin/sh",
    ". /etc/agent-guild/runtime.env",
    'AGENT_GUILD_TOKEN="$(agent-guild-token)" AGENT_GUILD_HUB="$AGENT_GUILD_HUB" exec node /usr/local/lib/agent-guild/agent-guild.mjs "$@"',
  ].join("\n");

  return [
    "set -e",
    `HUB=${q(hub)}`,
    "sudo mkdir -p /etc/agent-guild /usr/local/lib/agent-guild /usr/local/bin",
    'sudo curl -fsSL "$HUB/agent-guild.mjs" -o /usr/local/lib/agent-guild/agent-guild.mjs',
    `R=$(curl -fsS -X POST "$HUB/api/v1/runtime/enroll" -H 'content-type: application/json' -d ${q(JSON.stringify({ code: enrollCode }))})`,
    `ID=$(printf %s "$R" | sed -n 's/.*"runtimeId":"\\([^"]*\\)".*/\\1/p')`,
    `CRED=$(printf %s "$R" | sed -n 's/.*"credential":"\\([^"]*\\)".*/\\1/p')`,
    '[ -n "$CRED" ] || { echo "enrollment failed: $R" >&2; exit 1; }',
    `printf 'AGENT_GUILD_HUB=%s\\nAGENT_GUILD_RUNTIME_ID=%s\\nAGENT_GUILD_RUNTIME_CREDENTIAL=%s\\n' "$HUB" "$ID" "$CRED" | sudo tee /etc/agent-guild/runtime.env >/dev/null`,
    "sudo chmod 644 /etc/agent-guild/runtime.env",
    `printf '%s\\n' ${q(tokenHelper)} | sudo tee /usr/local/bin/agent-guild-token >/dev/null`,
    `printf '%s\\n' ${q(cliWrapper)} | sudo tee /usr/local/bin/agent-guild >/dev/null`,
    "sudo chmod 755 /usr/local/bin/agent-guild-token /usr/local/bin/agent-guild",
    'echo "Agent Guild runtime connected: $ID"',
  ].join("\n");
}
