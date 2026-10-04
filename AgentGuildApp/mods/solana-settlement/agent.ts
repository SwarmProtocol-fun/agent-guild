/**
 * Server-only half of the Solana mod's agent upgrade: who the caller is,
 * which capabilities they hold, the agent's devnet wallet, signing and
 * sending, and Anchor sandbox jobs. Never import from client code.
 *
 * Signing model: every agent gets its own custodial "solana-dev" wallet
 * (lib/agent-wallets.ts — encrypted at rest, key never leaves the server),
 * separate from its payout wallet so dev experiments never touch earnings.
 * It only ever signs for devnet/testnet: `sendAsAgent` refuses mainnet, and
 * the cluster → RPC mapping is server-controlled (never a caller URL).
 */
import { Connection, LAMPORTS_PER_SOL, PublicKey, type Keypair } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import type { RouteContext } from "@agent-guild/sdk";
// Server-side capability reads must use the admin SDK: lib/skills.ts's
// resolver uses the browser Firestore SDK, which is unauthenticated on the
// server and denied by the rules on modInstallations/agentSkills/subscriptions.
import { getAgent, getAgentCapabilities, getModInstallations } from "@/lib/firestore-admin";
import { adminDb } from "@/lib/firebase-admin";
import { requireOrgMembershipByAddress } from "@/lib/auth-guard";
import { listAgentWallets, generateAgentWallet, getAgentWalletKeypair } from "@/lib/agent-wallets";
import { enqueueTask, getTask, getAvailableWorkers } from "@/lib/gateway/store";
import { PUBLIC_RPC, DevtoolsInputError, explorerUrl } from "./devtools";
import { buildInstructions, computeBudgetInstructions, compileTransaction, decodeTxError, simulate, type InstructionSpec, type BuildOptions } from "./txbuilder";

// ── Clusters ─────────────────────────────────────────────────────────────

export type ServerCluster = "devnet" | "testnet" | "mainnet-beta";
export const SERVER_CLUSTERS: ServerCluster[] = ["devnet", "testnet", "mainnet-beta"];
/** Clusters an agent's wallet may sign on. Mainnet is read/simulate only. */
export const SIGNING_CLUSTERS: ServerCluster[] = ["devnet", "testnet"];

export function rpcFor(cluster: ServerCluster): string {
  // Prefer the operator's configured (usually keyed, higher-limit) RPC when
  // it points at the same cluster; never echo it back to the caller.
  const configured = process.env.SOLANA_RPC_URL || process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (cluster === "mainnet-beta" && process.env.SOLANA_MAINNET_RPC_URL) return process.env.SOLANA_MAINNET_RPC_URL;
  if (configured && configured.includes(cluster === "mainnet-beta" ? "mainnet" : cluster)) return configured;
  return PUBLIC_RPC[cluster];
}

export function parseCluster(value: unknown): ServerCluster {
  const c = (value ?? "devnet") as ServerCluster;
  if (!SERVER_CLUSTERS.includes(c)) throw new DevtoolsInputError(`cluster must be one of ${SERVER_CLUSTERS.join(", ")}`);
  return c;
}

export const connectionFor = (cluster: ServerCluster) => new Connection(rpcFor(cluster), "confirmed");

// ── Capabilities ─────────────────────────────────────────────────────────

/** Capability keys = the agentSkills ids on this mod's SKILL_REGISTRY entry (lib/skills.ts). */
export const CAP = {
  inspect: "solana-dev-inspect",
  simulate: "solana-dev-simulate",
  devnet: "solana-dev-devnet",
  anchor: "solana-dev-anchor",
  settle: "solana-settlement",
} as const;
export type CapKey = (typeof CAP)[keyof typeof CAP];

/** Raised for auth/capability failures; carries the HTTP status to return. */
export class AccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export interface Caller {
  agentId: string;
  orgId: string;
  /** "agent" = a verified agent signature/token; "session" = an operator driving their agent from the panel. */
  via: "agent" | "session";
}

/**
 * Resolves which agent a request acts as and checks it holds `capability`.
 * An agent signature always wins; a browser session must name an agentId
 * in an org it belongs to (the org comes from the agent record, never the
 * request). The capability is enforced either way — the operator drives
 * the agent's upgrade, they don't bypass it.
 */
export async function resolveCaller(ctx: RouteContext, agentIdHint: string | null | undefined): Promise<Caller> {
  if (ctx.agent) return { agentId: ctx.agent.agentId, orgId: ctx.agent.orgId, via: "agent" };
  if (!ctx.session) throw new AccessError("Authentication required", 401);
  if (!agentIdHint) throw new AccessError("agentId is required for a browser session", 400);
  const agent = await getAgent(agentIdHint);
  if (!agent) throw new AccessError("Agent not found", 404);
  const membership = await requireOrgMembershipByAddress(ctx.session.address, agent.orgId);
  if (!membership.ok) throw new AccessError(membership.error ?? "Forbidden", membership.status ?? 403);
  return { agentId: agentIdHint, orgId: agent.orgId, via: "session" };
}

export async function requireCaller(ctx: RouteContext, agentIdHint: string | null | undefined, capability: CapKey): Promise<Caller> {
  const caller = await resolveCaller(ctx, agentIdHint);
  if (!(await hasCapability(caller.agentId, caller.orgId, capability))) {
    throw new AccessError(`Agent ${caller.agentId} doesn't have the "${capability}" upgrade — enable it on the Solana panel's Agent tab`, 403);
  }
  return caller;
}

export async function hasCapability(agentId: string, orgId: string, capability: string): Promise<boolean> {
  return (await getAgentCapabilities(agentId, orgId)).some((c) => c.key === capability);
}

export async function capabilityMap(agentId: string, orgId: string): Promise<Record<CapKey, boolean>> {
  const granted = new Set((await getAgentCapabilities(agentId, orgId)).map((c) => c.key));
  return Object.fromEntries(Object.values(CAP).map((k) => [k, granted.has(k)])) as Record<CapKey, boolean>;
}

/** MOD_REGISTRY id for this mod (lib/skills.ts prefixes the SKILL_REGISTRY id). */
const REGISTRY_MOD_ID = "mod-solana-settlement";

/**
 * Turns on every Solana upgrade for an org's install of this mod. Orgs that
 * installed it before the upgrades existed only hold "solana-settlement",
 * and there's no other UI to toggle capabilities on an existing install.
 */
export async function enableAllUpgrades(orgId: string): Promise<{ installed: boolean; enabled: CapKey[] }> {
  const install = (await getModInstallations(orgId)).find((i) => i.modId === REGISTRY_MOD_ID);
  if (!install) return { installed: false, enabled: [] };
  const missing = Object.values(CAP).filter((c) => !install.enabledCapabilities.includes(c));
  if (missing.length) {
    await adminDb().collection("modInstallations").doc(install.id).update({ enabledCapabilities: [...install.enabledCapabilities, ...missing] });
  }
  return { installed: true, enabled: missing };
}

// ── Activity log ─────────────────────────────────────────────────────────

export interface Activity {
  at: string;
  agentId: string;
  orgId: string;
  via: Caller["via"];
  action: string;
  cluster?: ServerCluster;
  ok: boolean;
  summary: string;
  signature?: string;
  taskId?: string;
  explorerUrl?: string;
}

// In-memory, like the settlement history: per-mod persistent storage isn't
// built yet (docs/mod-sdk.md "Not built yet"). Survives until a restart.
const activity: Activity[] = [];

export function logActivity(caller: Caller, entry: Omit<Activity, "at" | "agentId" | "orgId" | "via">): void {
  activity.unshift({ at: new Date().toISOString(), agentId: caller.agentId, orgId: caller.orgId, via: caller.via, ...entry });
  if (activity.length > 300) activity.length = 300;
}

export function activityFor(agentId: string, limit = 50): Activity[] {
  return activity.filter((a) => a.agentId === agentId).slice(0, limit);
}

// ── Dev wallet ───────────────────────────────────────────────────────────

export const DEV_WALLET_LABEL = "solana-dev";

export async function getDevWallet(caller: Caller): Promise<{ walletId: string; address: string } | null> {
  const wallet = (await listAgentWallets(caller.agentId)).find((w) => w.chain === "solana" && w.label === DEV_WALLET_LABEL && w.orgId === caller.orgId);
  return wallet ? { walletId: wallet.id, address: wallet.publicKey } : null;
}

export async function ensureDevWallet(caller: Caller, createdBy: string): Promise<{ walletId: string; address: string; created: boolean }> {
  const existing = await getDevWallet(caller);
  if (existing) return { ...existing, created: false };
  const wallet = await generateAgentWallet(caller.agentId, caller.orgId, createdBy, { chain: "solana", label: DEV_WALLET_LABEL });
  return { walletId: wallet.id, address: wallet.publicKey, created: true };
}

async function devKeypair(caller: Caller): Promise<Keypair> {
  const wallet = await getDevWallet(caller);
  if (!wallet) throw new DevtoolsInputError("This agent has no dev wallet yet — call POST /dev/wallet first");
  return getAgentWalletKeypair(wallet.walletId, caller.orgId, caller.agentId);
}

function assertSigningCluster(cluster: ServerCluster): void {
  if (!SIGNING_CLUSTERS.includes(cluster)) {
    throw new DevtoolsInputError(`An agent's dev wallet only signs on ${SIGNING_CLUSTERS.join("/")} — use /dev/simulate for ${cluster}`);
  }
}

// ── Acting on devnet ─────────────────────────────────────────────────────

export interface SendResult {
  signature: string;
  explorerUrl: string;
  success: boolean;
  error: ReturnType<typeof decodeTxError>;
  unitsConsumed: number | null;
  newAccounts: Record<string, string>;
  logs: string[];
}

/**
 * Simulates first (so a failing tx costs nothing and comes back decoded),
 * sizes the CU limit from the simulation, then signs with the agent's dev
 * wallet plus any `new:` signers and sends.
 */
export async function sendAsAgent(caller: Caller, cluster: ServerCluster, specs: InstructionSpec[], opts: BuildOptions = {}): Promise<SendResult> {
  assertSigningCluster(cluster);
  const conn = connectionFor(cluster);
  const payer = await devKeypair(caller);

  const built = await buildInstructions(conn, payer.publicKey, specs);
  const newAccounts = Object.fromEntries([...built.newSigners].map(([k, kp]) => [k, kp.publicKey.toBase58()]));

  // Size the CU limit from a real simulation unless the caller fixed one.
  let limit = opts.computeUnitLimit;
  const probeBudget = computeBudgetInstructions({ priorityFee: opts.priorityFee });
  const probe = await compileTransaction(conn, payer.publicKey, [...probeBudget, ...built.instructions]);
  const sim = await conn.simulateTransaction(probe.tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const error = decodeTxError(sim.value.err, [...probeBudget, ...built.instructions], built.idls, probeBudget.length);
    return { signature: "", explorerUrl: "", success: false, error, unitsConsumed: sim.value.unitsConsumed ?? null, newAccounts, logs: sim.value.logs ?? [] };
  }
  limit ??= sim.value.unitsConsumed ? Math.ceil(sim.value.unitsConsumed * 1.1) + 1000 : undefined;

  const budget = computeBudgetInstructions({ computeUnitLimit: limit, priorityFee: opts.priorityFee });
  const all = [...budget, ...built.instructions];
  const { tx, blockhash, lastValidBlockHeight } = await compileTransaction(conn, payer.publicKey, all);
  tx.sign([payer, ...built.newSigners.values()]);
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const confirmation = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const landed = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });

  return {
    signature,
    explorerUrl: explorerUrl("tx", signature, cluster),
    success: !confirmation.value.err,
    error: decodeTxError(confirmation.value.err, all, built.idls, budget.length),
    unitsConsumed: landed?.meta?.computeUnitsConsumed ?? null,
    newAccounts,
    logs: landed?.meta?.logMessages ?? [],
  };
}

export async function simulateAsAgent(caller: Caller, cluster: ServerCluster, specs: InstructionSpec[], opts: BuildOptions = {}, feePayer?: string) {
  // Default payer is the agent's dev wallet so "payer"/"self" placeholders mean the agent.
  const payer = feePayer ? new PublicKey(feePayer) : new PublicKey((await getDevWallet(caller))?.address ?? PublicKey.default);
  return simulate(connectionFor(cluster), payer, specs, opts);
}

export async function airdropToAgent(caller: Caller, cluster: ServerCluster, sol: number): Promise<{ signature: string; explorerUrl: string; balanceSol: number }> {
  assertSigningCluster(cluster);
  if (!(sol > 0 && sol <= 2)) throw new DevtoolsInputError("sol must be between 0 and 2 (faucet limit)");
  const wallet = await getDevWallet(caller);
  if (!wallet) throw new DevtoolsInputError("This agent has no dev wallet yet — call POST /dev/wallet first");
  const conn = connectionFor(cluster);
  const to = new PublicKey(wallet.address);
  const signature = await conn.requestAirdrop(to, Math.round(sol * LAMPORTS_PER_SOL));
  const latest = await conn.getLatestBlockhash();
  await conn.confirmTransaction({ signature, ...latest }, "confirmed");
  return { signature, explorerUrl: explorerUrl("tx", signature, cluster), balanceSol: (await conn.getBalance(to)) / LAMPORTS_PER_SOL };
}

export async function createTokenAsAgent(
  caller: Caller,
  cluster: ServerCluster,
  params: { decimals?: number; mintAmount?: string | number },
): Promise<{ mint: string; tokenAccount: string | null; mintedRaw: string; explorerUrl: string }> {
  assertSigningCluster(cluster);
  const decimals = params.decimals ?? 9;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new DevtoolsInputError("decimals must be an integer 0–9");
  let raw = 0n;
  if (params.mintAmount != null) {
    // UI amount → base units without float rounding.
    const [whole, frac = ""] = String(params.mintAmount).split(".");
    if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > decimals) throw new DevtoolsInputError("mintAmount must be a positive number with at most `decimals` decimals");
    raw = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  }
  const conn = connectionFor(cluster);
  const payer = await devKeypair(caller);
  const mint = await createMint(conn, payer, payer.publicKey, payer.publicKey, decimals);
  let tokenAccount: string | null = null;
  if (raw > 0n) {
    const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, payer.publicKey);
    await mintTo(conn, payer, mint, ata.address, payer, raw);
    tokenAccount = ata.address.toBase58();
  }
  return { mint: mint.toBase58(), tokenAccount, mintedRaw: raw.toString(), explorerUrl: explorerUrl("address", mint.toBase58(), cluster) };
}

// ── Anchor sandbox ───────────────────────────────────────────────────────

export const ANCHOR_VERSIONS = ["0.31.1", "1.0.2"] as const;
export type AnchorAction = "build" | "test" | "deploy";
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 512 * 1024;

/** Project-relative path only: no absolute paths, `..`, or build output. */
function validProjectPath(p: string): boolean {
  return /^[A-Za-z0-9_.\-/]+$/.test(p) && !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === "") && !p.startsWith("target/");
}

export function validateAnchorProject(files: unknown): Record<string, string> {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new DevtoolsInputError("files must be an object of { path: contents }");
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_FILES) throw new DevtoolsInputError(`files must have 1–${MAX_FILES} entries`);
  let total = 0;
  for (const [path, contents] of entries) {
    if (!validProjectPath(path)) throw new DevtoolsInputError(`Invalid file path: ${path}`);
    if (typeof contents !== "string") throw new DevtoolsInputError(`${path}: contents must be a string`);
    total += Buffer.byteLength(contents);
  }
  if (total > MAX_TOTAL_BYTES) throw new DevtoolsInputError(`Project is ${total} bytes — max ${MAX_TOTAL_BYTES}`);
  if (!("Anchor.toml" in (files as object))) throw new DevtoolsInputError("files must include Anchor.toml at the project root");
  return files as Record<string, string>;
}

export async function anchorWorkersOnline(orgId: string): Promise<number> {
  const workers = await getAvailableWorkers(orgId);
  return workers.filter((w) => (w as { capabilities?: { taskTypes?: string[] } }).capabilities?.taskTypes?.includes("solana-anchor")).length;
}

export async function enqueueAnchorJob(
  caller: Caller,
  params: { action: AnchorAction; files: Record<string, string>; anchorVersion?: string; cluster?: ServerCluster },
): Promise<{ taskId: string; workersOnline: number }> {
  const { action } = params;
  if (!["build", "test", "deploy"].includes(action)) throw new DevtoolsInputError("action must be build, test or deploy");
  const anchorVersion = params.anchorVersion ?? ANCHOR_VERSIONS[0];
  if (!(ANCHOR_VERSIONS as readonly string[]).includes(anchorVersion)) throw new DevtoolsInputError(`anchorVersion must be one of ${ANCHOR_VERSIONS.join(", ")}`);
  const files = validateAnchorProject(params.files);

  let deploy: { cluster: ServerCluster; rpcUrl: string } | undefined;
  let privateKey: string | undefined;
  if (action === "deploy") {
    const cluster = params.cluster ?? "devnet";
    assertSigningCluster(cluster);
    // Same pattern as hyperliquid: this agent's own dev key, decrypted for
    // this one task, never a standing worker secret. Stored as
    // `payload.privateKey` on purpose — gateway/store.ts updateTask() deletes
    // that field once the task reaches a terminal state.
    const keypair = await devKeypair(caller);
    deploy = { cluster, rpcUrl: rpcFor(cluster) };
    privateKey = JSON.stringify(Array.from(keypair.secretKey));
  }

  const taskId = await enqueueTask({
    orgId: caller.orgId,
    taskType: "solana-anchor",
    payload: { agentId: caller.agentId, action, anchorVersion, files, ...(deploy ? { deploy, privateKey } : {}) },
    priority: "normal",
    resources: {},
    timeoutMs: action === "build" ? 15 * 60_000 : 25 * 60_000,
    maxRetries: 0,
  });
  return { taskId, workersOnline: await anchorWorkersOnline(caller.orgId) };
}

export async function getAnchorJob(caller: Caller, taskId: string) {
  const task = await getTask(taskId);
  if (!task || task.orgId !== caller.orgId || task.taskType !== "solana-anchor") return null;
  // The deploy payload carries the decrypted key — never echo the payload back.
  return { taskId, status: task.status, result: task.result ?? null, error: task.error ?? null, action: (task.payload as { action?: string }).action };
}
