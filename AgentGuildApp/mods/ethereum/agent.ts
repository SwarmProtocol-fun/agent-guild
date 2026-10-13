/**
 * Server-only half of the Ethereum mod's agent upgrade: who the caller is,
 * which capabilities they hold, the agent's testnet wallet, and signing.
 * Never import from client code.
 *
 * Signing model: every agent gets its own custodial "eth-dev" EVM wallet
 * (lib/agent-wallets.ts — encrypted at rest, key never leaves the server),
 * separate from any payout or Hyperliquid wallet. It only ever signs on
 * Sepolia / Base Sepolia: every signing path calls assertSigningNetwork,
 * and the network → RPC mapping is server-controlled (never a caller URL).
 */
import { createPublicClient, createWalletClient, erc20Abi, formatEther, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RouteContext } from "@agent-guild/sdk";
// Server-side capability reads must use the admin SDK (see the Solana mod's agent.ts).
import { enableModCapabilities, getAgent, getAgentCapabilities } from "@/lib/firestore-admin";
import { adminDb } from "@/lib/firebase-admin";
import { requireOrgMembershipByAddress } from "@/lib/auth-guard";
import { generateAgentWallet, getAgentWalletEvmPrivateKey, listAgentWallets } from "@/lib/agent-wallets";
import { DevtoolsInputError, buildCall, decodeRevert, parseAddress, revertOutcome, shortError, simulateCall, toRaw, toUi, type CallSpec, type DecodedRevert, type Simulation } from "./devtools";
import { NETWORKS, NETWORK_IDS, SIGNING_NETWORKS, explorerUrl, type EthNetwork } from "./networks";

// ── Networks ─────────────────────────────────────────────────────────────

const RPC_ENV: Record<EthNetwork, string> = {
  mainnet: "ETH_MAINNET_RPC_URL",
  sepolia: "ETH_SEPOLIA_RPC_URL",
  base: "BASE_RPC_URL",
  "base-sepolia": "BASE_SEPOLIA_RPC_URL",
};

/** The operator's keyed RPC for a network when set, else the public one. Never echoed to callers. */
export function rpcFor(network: EthNetwork): string {
  return process.env[RPC_ENV[network]] || NETWORKS[network].publicRpc;
}

export function parseNetwork(value: unknown): EthNetwork {
  const n = (value ?? "sepolia") as EthNetwork;
  if (!NETWORK_IDS.includes(n)) throw new DevtoolsInputError(`network must be one of ${NETWORK_IDS.join(", ")}`);
  return n;
}

const clients = new Map<string, PublicClient>();
export function clientFor(network: EthNetwork): PublicClient {
  const url = rpcFor(network);
  const cacheKey = `${network}:${url}`;
  let c = clients.get(cacheKey);
  if (!c) {
    c = createPublicClient({ chain: NETWORKS[network].chain, transport: http(url, { timeout: 15_000, retryCount: 1 }) }) as PublicClient;
    clients.set(cacheKey, c);
  }
  return c;
}

export function assertSigningNetwork(network: EthNetwork): void {
  if (!SIGNING_NETWORKS.includes(network)) {
    throw new DevtoolsInputError(`An agent's wallet only signs on ${SIGNING_NETWORKS.join("/")} — use eth_simulate for ${network}`);
  }
}

// ── Capabilities ─────────────────────────────────────────────────────────

/** Capability keys = the agentSkills ids on this mod's SKILL_REGISTRY entry (lib/skills.ts). */
export const CAP = {
  inspect: "eth-inspect",
  simulate: "eth-simulate",
  testnet: "eth-testnet",
  trade: "eth-trade",
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
 * Which agent a request acts as. An agent signature always wins; a browser
 * session must name an agentId in an org it belongs to (the org comes from
 * the agent record, never the request).
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

/** resolveCaller + the capability check. The operator drives the agent's upgrade; they don't bypass it. */
export async function requireCaller(ctx: RouteContext, agentIdHint: string | null | undefined, capability: CapKey): Promise<Caller> {
  const caller = await resolveCaller(ctx, agentIdHint);
  if (!(await hasCapability(caller.agentId, caller.orgId, capability))) {
    throw new AccessError(`Agent ${caller.agentId} doesn't have the "${capability}" upgrade — enable it on the Ethereum panel's Overview`, 403);
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
const REGISTRY_MOD_ID = "mod-ethereum";

/** Turns on every Ethereum upgrade for an org that has the mod (Market install or install doc). */
export async function enableAllUpgrades(orgId: string): Promise<{ installed: boolean; enabled: CapKey[] }> {
  const out = await enableModCapabilities(orgId, REGISTRY_MOD_ID, Object.values(CAP));
  return { installed: out.installed, enabled: out.enabled as CapKey[] };
}

// ── Activity log ─────────────────────────────────────────────────────────

export interface Activity {
  at: string;
  agentId: string;
  orgId: string;
  via: Caller["via"];
  action: string;
  network?: EthNetwork;
  ok: boolean;
  summary: string;
  hash?: string;
  explorerUrl?: string;
}

// Doc ids sort newest-first, so one agent's feed is an equality filter on
// agentId ordered by id — no composite index needed.
const ACTIVITY = "ethModActivity";
const ACTIVITY_ID_CEILING = 9_999_999_999_999;
const activityId = (at: number) => `${String(ACTIVITY_ID_CEILING - at).padStart(13, "0")}-${Math.random().toString(36).slice(2, 8)}`;

/** Records what an agent did. Fire-and-forget: a failed log write never fails the action. */
export function logActivity(caller: Caller, entry: Omit<Activity, "at" | "agentId" | "orgId" | "via">): void {
  const now = Date.now();
  const row: Activity = { at: new Date(now).toISOString(), agentId: caller.agentId, orgId: caller.orgId, via: caller.via, ...entry };
  const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
  void Promise.resolve()
    .then(() => adminDb().collection(ACTIVITY).doc(activityId(now)).set(clean))
    .catch((err) => console.warn("[ethereum] activity log write failed:", (err as Error).message));
}

export async function activityFor(agentId: string, orgId: string, limit = 50): Promise<Activity[]> {
  const snap = await adminDb().collection(ACTIVITY).where("agentId", "==", agentId).orderBy("__name__").limit(limit).get();
  return snap.docs.map((d) => d.data() as Activity).filter((a) => a.orgId === orgId);
}

// ── Dev wallet ───────────────────────────────────────────────────────────

export const DEV_WALLET_LABEL = "eth-dev";

export async function getDevWallet(caller: Caller): Promise<{ walletId: string; address: `0x${string}` } | null> {
  const wallet = (await listAgentWallets(caller.agentId)).find((w) => w.chain === "evm" && w.label === DEV_WALLET_LABEL && w.orgId === caller.orgId);
  return wallet ? { walletId: wallet.id, address: wallet.publicKey as `0x${string}` } : null;
}

export async function ensureDevWallet(caller: Caller, createdBy: string): Promise<{ address: `0x${string}`; created: boolean }> {
  const existing = await getDevWallet(caller);
  if (existing) return { address: existing.address, created: false };
  const wallet = await generateAgentWallet(caller.agentId, caller.orgId, createdBy, { chain: "evm", label: DEV_WALLET_LABEL });
  return { address: wallet.publicKey as `0x${string}`, created: true };
}

export async function requireDevWallet(caller: Caller): Promise<{ walletId: string; address: `0x${string}` }> {
  const wallet = await getDevWallet(caller);
  if (!wallet) throw new DevtoolsInputError("This agent has no Ethereum dev wallet yet — create one first (eth_create_wallet)");
  return wallet;
}

async function devAccount(caller: Caller) {
  const wallet = await requireDevWallet(caller);
  return privateKeyToAccount(await getAgentWalletEvmPrivateKey(wallet.walletId, caller.orgId, caller.agentId));
}

/** ETH balance of the agent's dev wallet on each signing network (null = RPC failed). */
export async function devBalances(address: `0x${string}`): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(SIGNING_NETWORKS.map(async (n) => {
    const wei = await clientFor(n).getBalance({ address }).catch(() => null);
    return [n, wei == null ? null : formatEther(wei)] as const;
  })));
}

// ── Signing (testnets only) ──────────────────────────────────────────────

export interface SendResult {
  network: EthNetwork;
  hash: string | null;
  explorerUrl: string | null;
  /** "rejected" = failed in simulation, nothing was sent or paid. */
  status: "success" | "reverted" | "rejected" | "pending";
  from: string;
  to: string | null;
  contractAddress: string | null;
  gasUsed: string | null;
  feeEth: string | null;
  revert: DecodedRevert | null;
  error: string | null;
  simulation: Simulation;
}

const RECEIPT_TIMEOUT_MS = 90_000;

/**
 * Simulates first (so a failing tx costs nothing and comes back decoded),
 * then signs with the agent's dev wallet and sends, waiting for the receipt.
 */
export async function sendAsAgent(caller: Caller, network: EthNetwork, spec: CallSpec): Promise<SendResult> {
  assertSigningNetwork(network);
  const built = buildCall(spec);
  const account = await devAccount(caller);
  const client = clientFor(network);

  const simulation = await simulateCall(client, account.address, built);
  const base = { network, from: account.address, to: built.to ?? null, simulation };
  if (!simulation.success && simulation.canAfford === false) throw unaffordable(account.address, network);
  if (!simulation.success) {
    return { ...base, hash: null, explorerUrl: null, status: "rejected", contractAddress: null, gasUsed: null, feeEth: null, revert: simulation.revert, error: simulation.error };
  }

  // Most nodes' eth_call doesn't check the sender can pay, so check before signing.
  if (simulation.canAfford === false) throw unaffordable(account.address, network, simulation);
  const wallet = createWalletClient({ account, chain: NETWORKS[network].chain, transport: http(rpcFor(network)) });
  const gas = simulation.gasEstimate ? (BigInt(simulation.gasEstimate) * 12n) / 10n : undefined;
  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({ to: built.to, data: built.data, value: built.value, gas });
  } catch (err) {
    const msg = shortError(err);
    if (/insufficient funds|exceeds the balance/i.test(msg)) throw unaffordable(account.address, network);
    throw err;
  }
  const url = explorerUrl("tx", hash, network);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }).catch(() => null);
  if (!receipt) return { ...base, hash, explorerUrl: url, status: "pending", contractAddress: null, gasUsed: null, feeEth: null, revert: null, error: null };

  let revert: DecodedRevert | null = null;
  if (receipt.status === "reverted") {
    try {
      await client.call({ account: account.address, to: built.to, data: built.data, value: built.value, blockNumber: receipt.blockNumber - 1n });
    } catch (err) {
      const data = revertOutcome(err);
      revert = data != null ? await decodeRevert(data) : null;
    }
  }
  return {
    ...base, hash, explorerUrl: url,
    status: receipt.status === "success" ? "success" : "reverted",
    contractAddress: receipt.contractAddress ?? null,
    gasUsed: receipt.gasUsed.toString(),
    feeEth: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
    revert, error: revert?.message ?? (receipt.status === "reverted" ? "Transaction reverted on-chain" : null),
  };
}

/** The "fund your wallet" error, with the balance and cost when the simulation knows them. */
function unaffordable(address: string, network: EthNetwork, sim?: Simulation): DevtoolsInputError {
  const held = sim?.fromBalanceEth != null ? ` holds ${sim.fromBalanceEth} ETH — not enough for ${sim.valueEth} ETH plus ~${sim.feeEstimateEth ?? "?"} ETH gas` : " can't cover value + gas";
  return new DevtoolsInputError(`The dev wallet ${address}${held} on ${NETWORKS[network].label}. Fund it from a faucet: ${NETWORKS[network].faucets.map((f) => f.url).join(", ")}`);
}

export interface TransferResult extends Omit<SendResult, "simulation" | "contractAddress"> {
  /** null for ETH. */
  token: string | null;
  symbol: string;
  amountUi: string;
}

/** Sends ETH, or an ERC-20 (`token` = its address), from the agent's dev wallet. `amount` in UI units. */
export async function transferAsAgent(caller: Caller, network: EthNetwork, params: { to: string; amount: string | number; token?: string | null }): Promise<TransferResult> {
  assertSigningNetwork(network);
  const to = parseAddress(params.to, "to");
  if (!params.token) {
    const result = await sendAsAgent(caller, network, { to, value: String(params.amount) });
    const { simulation: _s, contractAddress: _c, ...rest } = result;
    return { ...rest, token: null, symbol: "ETH", amountUi: String(params.amount) };
  }
  const token = parseAddress(params.token, "token");
  const client = clientFor(network);
  const wallet = await requireDevWallet(caller);
  const [decimals, symbol, balance] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "tokens"),
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address] }),
  ]).catch((err) => { throw new DevtoolsInputError(`${token} doesn't look like an ERC-20 on ${NETWORKS[network].label}: ${shortError(err)}`); });
  const raw = toRaw(params.amount, decimals);
  if (balance < raw) throw new DevtoolsInputError(`The dev wallet holds ${toUi(balance, decimals)} ${symbol} — not enough to send ${toUi(raw, decimals)}`);
  const result = await sendAsAgent(caller, network, { to: token, signature: "transfer(address,uint256) returns (bool)", args: [to, raw.toString()] });
  const { simulation: _s, contractAddress: _c, ...rest } = result;
  return { ...rest, to, token, symbol, amountUi: toUi(raw, decimals) };
}
