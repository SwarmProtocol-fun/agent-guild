/**
 * Agent Wallets — custodial keypairs (Solana or EVM) generated and held on
 * behalf of an agent, distinct from the agent's own Ed25519 identity wallet
 * (lib/solana/client.ts's solanaAddressFromEd25519Pem, which the agent
 * itself holds the key for). These are platform-generated: the private key
 * never leaves the server, encrypted at rest the same way lib/secrets.ts
 * encrypts API keys (AES-256-GCM, PBKDF2-derived key), but with a
 * server-only master secret instead of one typed in by a human each time —
 * there's no human in the loop for a wallet an agent uses to hold funds.
 *
 * An EVM wallet generated here can optionally be registered with
 * mods/hyperliquid-trading's own wallet store in the same call (Hyperliquid
 * uses plain secp256k1/EVM keys, so one generation covers both). That mod
 * is deliberately zero-knowledge (lib/mods/hyperliquid-store.ts) — the
 * private key there is encrypted with a passphrase only the caller holds,
 * never persisted server-side, so the platform has no standing ability to
 * trade on the agent's behalf. Registration here preserves that: the
 * passphrase is used once, transiently, in this same request, exactly as
 * if a human had pasted the key into the mod's own POST /wallet.
 *
 * Server-only — never import from client-facing code.
 */
import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { Wallet as EvmWallet } from "ethers";
import { encryptValue, decryptValue } from "./secrets";
import { getChain } from "./chains";
import { getBalance as getUsdcBalance } from "./settlement/registry";
import { setAgentWallet as setHyperliquidWallet } from "./mods/hyperliquid-store";

const AGENT_WALLETS_COLLECTION = "agentWallets";

// Hard cap per agent — generation costs a Firestore write and an encrypted
// secret at rest; this bounds both runaway automation and key sprawl.
export const MAX_WALLETS_PER_AGENT = 10;

export type AgentWalletChain = "solana" | "evm";
export type HyperliquidNetwork = "testnet" | "mainnet";

export interface AgentWallet {
  id: string;
  agentId: string;
  orgId: string;
  chain: AgentWalletChain;
  publicKey: string;
  label?: string;
  createdBy: string;
  createdAt: Date | null;
  /** True if this EVM wallet's key was also registered with mods/hyperliquid-trading at generation time. */
  hyperliquidRegistered?: boolean;
  hyperliquidNetwork?: HyperliquidNetwork;
  /** Solana only. The custodial wallet paid-job payouts are labelled against — at most one per agent. */
  payout?: boolean;
}

interface AgentWalletDoc extends Omit<AgentWallet, "id" | "createdAt"> {
  encryptedSecretKey: string;
  iv: string;
  /** Which AGENT_WALLET_ENCRYPTION_KEY(_V{n}) encrypted this doc. Absent on pre-versioning docs — treat as 1. */
  keyVersion: number;
  createdAt: FieldValue;
}

// ── Key versioning ───────────────────────────────────────────────────────
//
// Version 1 lives in the unsuffixed AGENT_WALLET_ENCRYPTION_KEY (so wallets
// generated before this versioning existed keep decrypting with no doc
// migration needed — they have no keyVersion field, which defaults to 1).
// Version 2+ live in AGENT_WALLET_ENCRYPTION_KEY_V{n}. New wallets always
// encrypt under the highest version present. Rotating means: add the next
// AGENT_WALLET_ENCRYPTION_KEY_V{n}, run rotateStaleAgentWallets() to
// re-encrypt everything onto it, THEN remove the old env var — never the
// reverse, or every wallet still on the old version becomes undecryptable.
function keyEnvVarName(version: number): string {
  return version === 1 ? "AGENT_WALLET_ENCRYPTION_KEY" : `AGENT_WALLET_ENCRYPTION_KEY_V${version}`;
}

/** All configured key versions, in order, by scanning env vars until one is missing. */
function configuredKeyVersions(): number[] {
  const versions: number[] = [];
  for (let v = 1; process.env[keyEnvVarName(v)]; v++) {
    versions.push(v);
  }
  return versions;
}

function latestKeyVersion(): number {
  const versions = configuredKeyVersions();
  if (versions.length === 0) {
    throw new Error(
      "AGENT_WALLET_ENCRYPTION_KEY not configured — required to encrypt generated agent wallet keys",
    );
  }
  return versions[versions.length - 1];
}

function masterSecretForVersion(version: number): string {
  const envVar = keyEnvVarName(version);
  const key = process.env[envVar];
  if (!key) {
    throw new Error(`${envVar} not configured — required to decrypt wallets encrypted under key version ${version}`);
  }
  return key;
}

/** Per-agent salt for key derivation, so one agent's leaked key can't decrypt another's. */
function walletSalt(orgId: string, agentId: string): string {
  return `agent-wallet:${orgId}:${agentId}`;
}

function toPublicWallet(id: string, data: Record<string, unknown>): AgentWallet {
  const createdAt = data.createdAt;
  return {
    id,
    agentId: data.agentId as string,
    orgId: data.orgId as string,
    chain: (data.chain as AgentWalletChain) ?? "solana",
    publicKey: data.publicKey as string,
    label: (data.label as string) || undefined,
    createdBy: data.createdBy as string,
    createdAt: createdAt instanceof Timestamp ? createdAt.toDate() : null,
    hyperliquidRegistered: (data.hyperliquidRegistered as boolean) || undefined,
    hyperliquidNetwork: (data.hyperliquidNetwork as HyperliquidNetwork) || undefined,
    payout: (data.payout as boolean) || undefined,
  };
}

export interface GenerateAgentWalletOptions {
  label?: string;
  chain?: AgentWalletChain;
  /**
   * EVM only. If set, the generated key is also handed to
   * mods/hyperliquid-trading's own wallet store, encrypted under this
   * passphrase exactly as that mod's POST /wallet would — the passphrase
   * itself is used here and discarded, never persisted (see module doc).
   */
  hyperliquid?: { masterSecret: string; network?: HyperliquidNetwork };
}

/** Generates a fresh keypair (Solana or EVM) for an agent, stores the secret key encrypted, and returns the public record only. */
export async function generateAgentWallet(
  agentId: string,
  orgId: string,
  createdBy: string,
  options?: GenerateAgentWalletOptions,
): Promise<AgentWallet> {
  const chain: AgentWalletChain = options?.chain ?? "solana";

  const existing = await adminDb()
    .collection(AGENT_WALLETS_COLLECTION)
    .where("agentId", "==", agentId)
    .get();
  if (existing.size >= MAX_WALLETS_PER_AGENT) {
    throw new Error(`Agent already has the maximum of ${MAX_WALLETS_PER_AGENT} wallets`);
  }

  // The first custodial Solana wallet becomes the payout wallet; later ones never take the flag on their own.
  const isFirstSolana = chain === "solana" && !existing.docs.some((d) => (d.data().chain ?? "solana") === "solana");

  let publicKey: string;
  let secretMaterial: string;
  if (chain === "solana") {
    const keypair = Keypair.generate();
    publicKey = keypair.publicKey.toBase58();
    secretMaterial = JSON.stringify(Array.from(keypair.secretKey));
  } else {
    const evmWallet = EvmWallet.createRandom();
    publicKey = evmWallet.address;
    secretMaterial = evmWallet.privateKey;
  }

  const keyVersion = latestKeyVersion();
  const { encryptedValue, iv } = encryptValue(secretMaterial, walletSalt(orgId, agentId), masterSecretForVersion(keyVersion));

  let hyperliquidRegistered = false;
  const hyperliquidNetwork = options?.hyperliquid?.network ?? "testnet";
  if (chain === "evm" && options?.hyperliquid) {
    // Same salt convention (bare agentId) as hyperliquid-store's own
    // resolveAgentWallet decrypt call, so the mod's existing trade
    // endpoints can decrypt this with no changes on their side.
    const { encryptedValue: hlEncrypted, iv: hlIv } = encryptValue(secretMaterial, agentId, options.hyperliquid.masterSecret);
    await setHyperliquidWallet(agentId, { orgId, encryptedValue: hlEncrypted, iv: hlIv, network: hyperliquidNetwork });
    hyperliquidRegistered = true;
  }

  const doc: AgentWalletDoc = {
    agentId,
    orgId,
    chain,
    publicKey,
    encryptedSecretKey: encryptedValue,
    iv,
    keyVersion,
    // Firestore isn't configured with ignoreUndefinedProperties — omit, don't write undefined.
    ...(options?.label ? { label: options.label } : {}),
    createdBy,
    createdAt: FieldValue.serverTimestamp(),
    ...(hyperliquidRegistered ? { hyperliquidRegistered, hyperliquidNetwork } : {}),
    ...(isFirstSolana ? { payout: true } : {}),
  };

  const ref = await adminDb().collection(AGENT_WALLETS_COLLECTION).add(doc);
  const saved = await ref.get();
  return toPublicWallet(ref.id, saved.data()!);
}

/** Lists an agent's custodial wallets, oldest first. Never returns key material. */
export async function listAgentWallets(agentId: string): Promise<AgentWallet[]> {
  const snap = await adminDb()
    .collection(AGENT_WALLETS_COLLECTION)
    .where("agentId", "==", agentId)
    .get();
  return snap.docs
    .map((d) => toPublicWallet(d.id, d.data()))
    .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
}

/**
 * Moves the payout flag to one custodial Solana wallet of this agent and
 * clears it on the agent's other custodial Solana wallets, in one batch.
 * Throws a WalletInputError for anything that isn't a custodial Solana
 * wallet belonging to this agent (EVM, the identity row, another agent's).
 */
export class WalletInputError extends Error {}

export async function setPayoutWallet(agentId: string, orgId: string, walletId: string): Promise<void> {
  if (walletId === IDENTITY_WALLET_ID) throw new WalletInputError("The identity wallet cannot be the payout wallet");
  const snap = await adminDb()
    .collection(AGENT_WALLETS_COLLECTION)
    .where("agentId", "==", agentId)
    .get();
  const target = snap.docs.find((d) => d.id === walletId);
  if (!target || target.data().orgId !== orgId) throw new WalletInputError("Wallet does not belong to this agent");
  if ((target.data().chain ?? "solana") !== "solana") throw new WalletInputError("Only a Solana wallet can be the payout wallet");

  const batch = adminDb().batch();
  for (const d of snap.docs) {
    if ((d.data().chain ?? "solana") !== "solana") continue;
    batch.update(d.ref, { payout: d.id === walletId });
  }
  await batch.commit();
}

/**
 * Decrypts and returns a Solana wallet's keypair — for future server-side
 * signing use only, never exposed over the API. EVM wallets registered for
 * Hyperliquid trading are deliberately not decryptable this way — use that
 * mod's own passphrase-gated resolveAgentWallet() instead, which requires
 * the caller to supply the passphrase on every call (see module doc).
 */
export async function getAgentWalletKeypair(walletId: string, orgId: string, agentId: string): Promise<Keypair> {
  const doc = await adminDb().collection(AGENT_WALLETS_COLLECTION).doc(walletId).get();
  if (!doc.exists) throw new Error("Wallet not found");
  const data = doc.data()!;
  if (data.agentId !== agentId || data.orgId !== orgId) {
    throw new Error("Wallet does not belong to this agent/organization");
  }
  if (data.chain !== "solana") {
    throw new Error(`getAgentWalletKeypair only supports Solana wallets (this wallet is ${data.chain})`);
  }
  const keyVersion = (data.keyVersion as number | undefined) ?? 1;
  const secretKeyJson = decryptValue(data.encryptedSecretKey, data.iv, walletSalt(orgId, agentId), masterSecretForVersion(keyVersion));
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secretKeyJson)));
}

/** EVM counterpart of getAgentWalletKeypair: the wallet's 0x private key, server-side only (lib/intents signs with it). */
export async function getAgentWalletEvmPrivateKey(walletId: string, orgId: string, agentId: string): Promise<`0x${string}`> {
  const doc = await adminDb().collection(AGENT_WALLETS_COLLECTION).doc(walletId).get();
  if (!doc.exists) throw new Error("Wallet not found");
  const data = doc.data()!;
  if (data.agentId !== agentId || data.orgId !== orgId) {
    throw new Error("Wallet does not belong to this agent/organization");
  }
  if (data.chain !== "evm") {
    throw new Error(`getAgentWalletEvmPrivateKey only supports EVM wallets (this wallet is ${data.chain ?? "solana"})`);
  }
  const keyVersion = (data.keyVersion as number | undefined) ?? 1;
  return decryptValue(data.encryptedSecretKey, data.iv, walletSalt(orgId, agentId), masterSecretForVersion(keyVersion)) as `0x${string}`;
}

/**
 * Resets the Hyperliquid trading passphrase for an EVM wallet generated
 * here, by decrypting OUR copy of its key (held under
 * AGENT_WALLET_ENCRYPTION_KEY, same as any other custodial wallet) and
 * re-registering it with mods/hyperliquid-trading under a brand-new
 * passphrase. This does not weaken that mod's zero-knowledge guarantee —
 * its own stored copy still only decrypts with whatever passphrase was
 * last set, and the platform still never retains it. It works here only
 * because the custodial wallet itself (not the mod's copy) is a second,
 * separately-held copy of the same key, which is the whole point of
 * generating it through this flow instead of pasting in an external one.
 * A wallet whose key was only ever pasted directly into the mod (never
 * generated here) has no such second copy — if its passphrase is lost,
 * this cannot help, by design.
 */
export async function resetHyperliquidPassphrase(
  walletId: string,
  orgId: string,
  agentId: string,
  newMasterSecret: string,
  network?: HyperliquidNetwork,
): Promise<void> {
  const ref = adminDb().collection(AGENT_WALLETS_COLLECTION).doc(walletId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Wallet not found");
  const data = doc.data()!;
  if (data.agentId !== agentId || data.orgId !== orgId) {
    throw new Error("Wallet does not belong to this agent/organization");
  }
  if (data.chain !== "evm") {
    throw new Error("Only EVM wallets can be registered for Hyperliquid trading");
  }

  const keyVersion = (data.keyVersion as number | undefined) ?? 1;
  const privateKeyHex = decryptValue(data.encryptedSecretKey, data.iv, walletSalt(orgId, agentId), masterSecretForVersion(keyVersion));

  const resolvedNetwork = network ?? (data.hyperliquidNetwork as HyperliquidNetwork | undefined) ?? "testnet";
  const { encryptedValue, iv } = encryptValue(privateKeyHex, agentId, newMasterSecret);
  await setHyperliquidWallet(agentId, { orgId, encryptedValue, iv, network: resolvedNetwork });

  await ref.update({ hyperliquidRegistered: true, hyperliquidNetwork: resolvedNetwork });
}

/**
 * Re-encrypts one wallet's secret key under the latest configured key
 * version. No-op if it's already current. This is how a key rotation
 * actually gets completed — call rotateStaleAgentWallets() for all of
 * them, confirm it reports staleRemaining: 0, then (and only then) remove
 * the old AGENT_WALLET_ENCRYPTION_KEY(_V{n}) env var.
 */
async function rotateAgentWalletKey(walletId: string): Promise<{ id: string; fromVersion: number; toVersion: number }> {
  const ref = adminDb().collection(AGENT_WALLETS_COLLECTION).doc(walletId);
  const doc = await ref.get();
  if (!doc.exists) throw new Error("Wallet not found");
  const data = doc.data()!;
  const fromVersion = (data.keyVersion as number | undefined) ?? 1;
  const toVersion = latestKeyVersion();

  if (fromVersion === toVersion) {
    return { id: walletId, fromVersion, toVersion };
  }

  const salt = walletSalt(data.orgId, data.agentId);
  const secretKeyJson = decryptValue(data.encryptedSecretKey, data.iv, salt, masterSecretForVersion(fromVersion));
  const { encryptedValue, iv } = encryptValue(secretKeyJson, salt, masterSecretForVersion(toVersion));

  await ref.update({ encryptedSecretKey: encryptedValue, iv, keyVersion: toVersion });
  return { id: walletId, fromVersion, toVersion };
}

export interface RotationResult {
  latestVersion: number;
  rotated: { id: string; fromVersion: number }[];
  failed: { id: string; error: string }[];
  staleRemaining: number;
}

/** Re-encrypts every wallet not already on the latest key version. Safe to re-run; skips anything already current. */
export async function rotateStaleAgentWallets(): Promise<RotationResult> {
  const latest = latestKeyVersion();
  const snap = await adminDb().collection(AGENT_WALLETS_COLLECTION).get();

  const rotated: RotationResult["rotated"] = [];
  const failed: RotationResult["failed"] = [];

  for (const doc of snap.docs) {
    const fromVersion = (doc.data().keyVersion as number | undefined) ?? 1;
    if (fromVersion === latest) continue;
    try {
      await rotateAgentWalletKey(doc.id);
      rotated.push({ id: doc.id, fromVersion });
    } catch (err) {
      failed.push({ id: doc.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { latestVersion: latest, rotated, failed, staleRemaining: failed.length };
}

export interface WalletBalance {
  sol: number | null;
  usdc: number | null;
  /** EVM wallets only — Hyperliquid account equity (margin + unrealized PnL), USD. Null if not registered/no account yet. */
  hyperliquidEquity: number | null;
}

/** Read-only SOL + USDC balance check — same public-RPC pattern mods/tagem-wallet/server.ts uses. */
async function getSolanaBalance(publicKey: string): Promise<Pick<WalletBalance, "sol" | "usdc">> {
  const chain = getChain("solana");
  if (!chain) return { sol: 0, usdc: null };
  const connection = new Connection(chain.rpc, "confirmed");
  const [lamports, usdc] = await Promise.all([
    connection.getBalance(new PublicKey(publicKey)),
    getUsdcBalance("solana", publicKey).then((r) => r.usdc).catch(() => null),
  ]);
  return { sol: lamports / 1_000_000_000, usdc };
}

function hyperliquidInfoUrl(network: HyperliquidNetwork): string {
  return network === "mainnet" ? "https://api.hyperliquid.xyz/info" : "https://api.hyperliquid-testnet.xyz/info";
}

/** Read-only account equity from Hyperliquid's public Info API — no private key or passphrase involved. */
async function getHyperliquidEquity(address: string, network: HyperliquidNetwork): Promise<number | null> {
  try {
    const resp = await fetch(hyperliquidInfoUrl(network), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
    });
    if (!resp.ok) return null;
    const state = await resp.json();
    const accountValue = state?.marginSummary?.accountValue;
    return accountValue != null ? Number(accountValue) : null;
  } catch {
    return null;
  }
}

/** Read-only balance check, branching by chain. Hyperliquid equity is only looked up for a wallet registered there. */
export async function getAgentWalletBalance(
  wallet: Pick<AgentWallet, "publicKey" | "chain" | "hyperliquidNetwork" | "hyperliquidRegistered">,
): Promise<WalletBalance> {
  if (wallet.chain === "evm") {
    const hyperliquidEquity = wallet.hyperliquidRegistered
      ? await getHyperliquidEquity(wallet.publicKey, wallet.hyperliquidNetwork ?? "testnet")
      : null;
    return { sol: null, usdc: null, hyperliquidEquity };
  }
  const { sol, usdc } = await getSolanaBalance(wallet.publicKey);
  return { sol, usdc, hyperliquidEquity: null };
}

// ── Public wallet list ───────────────────────────────────────────────────
//
// The one wallet shape every reader uses: the passport, GET
// /api/v1/agents/:id/wallets, the Connect CLI, and the agent page. The
// identity row (the agent's own Ed25519-derived Solana address, which the
// agent holds the key for) comes first; custodial rows follow, oldest
// first. Built field by field from public data — never a secret.

export const IDENTITY_WALLET_ID = "identity";

const NULL_BALANCE: WalletBalance = { sol: null, usdc: null, hyperliquidEquity: null };

export interface PublicAgentWallet {
  /** "identity", or the agentWallets doc id. */
  id: string;
  chain: AgentWalletChain;
  address: string;
  custodial: boolean;
  label: string | null;
  payout: boolean;
  hyperliquidRegistered: boolean;
  hyperliquidNetwork: HyperliquidNetwork | null;
  balance: WalletBalance;
}

export interface PublicAgentWalletList {
  wallets: PublicAgentWallet[];
  /** Custodial wallets only — what MAX_WALLETS_PER_AGENT counts. */
  generated: number;
  max: number;
}

/**
 * Builds the public wallet list for an agent. Pass `agent` when the caller
 * already has the agent doc, to skip a re-read. A failed balance lookup
 * nulls that one wallet's balance and never fails the list. `balances:
 * false` skips the RPC lookups entirely (every balance null) — for list
 * views that build many of these at once.
 */
export async function listPublicAgentWallets(
  agentId: string,
  agent?: { solanaAddress?: string },
  options: { balances?: boolean } = {},
): Promise<PublicAgentWalletList> {
  const solanaAddress =
    agent !== undefined
      ? agent.solanaAddress
      : ((await adminDb().collection("agents").doc(agentId).get()).data()?.solanaAddress as string | undefined);
  const custodial = await listAgentWallets(agentId);

  // Older wallets predate the payout flag: the oldest custodial Solana wallet is payout until one is set explicitly.
  const solanaCustodial = custodial.filter((w) => w.chain === "solana");
  const payoutId = (solanaCustodial.find((w) => w.payout) ?? solanaCustodial[0])?.id;

  const rows: Omit<PublicAgentWallet, "balance">[] = [];
  if (solanaAddress) {
    rows.push({
      id: IDENTITY_WALLET_ID,
      chain: "solana",
      address: solanaAddress,
      custodial: false,
      label: null,
      payout: false,
      hyperliquidRegistered: false,
      hyperliquidNetwork: null,
    });
  }
  for (const w of custodial) {
    rows.push({
      id: w.id,
      chain: w.chain,
      address: w.publicKey,
      custodial: true,
      label: w.label ?? null,
      payout: w.id === payoutId,
      hyperliquidRegistered: w.hyperliquidRegistered === true,
      hyperliquidNetwork: w.hyperliquidRegistered ? (w.hyperliquidNetwork ?? "testnet") : null,
    });
  }

  const wallets = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      balance: options.balances === false ? NULL_BALANCE : await getAgentWalletBalance({
        publicKey: row.address,
        chain: row.chain,
        hyperliquidRegistered: row.hyperliquidRegistered,
        hyperliquidNetwork: row.hyperliquidNetwork ?? undefined,
      }).catch(() => NULL_BALANCE),
    })),
  );

  return { wallets, generated: custodial.length, max: MAX_WALLETS_PER_AGENT };
}
