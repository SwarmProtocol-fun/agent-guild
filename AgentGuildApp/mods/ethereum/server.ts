import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { encodeDeployData, formatEther, type Abi, type Hex, type PublicClient } from "viem";
import { getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { listAgentWallets } from "@/lib/agent-wallets";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import {
  ConfigError, DevtoolsInputError, addressHistory, buildCall, decodeCalldata, decodeRevert, gasOracle, holdings, inspectAddress,
  coerceArgs, inspectTransaction, networkStatus, parseAddress, parseEthAmount, parseHash, parseHexData, readContract, resolveEns, simulateCall,
  toRaw, toUi, tokenInfo, type CallSpec,
} from "./devtools";
import { ethUtil, getLogs, mappingSlot, multiRead, parseStateOverride, readStorage } from "./chaintools";
import { compileSolidity, contractAbi, parseSources, pickContract, verifyOnSourcify, type CompileResult } from "./solidity";
import {
  AccessError, CAP, DEV_WALLET_LABEL, activityFor, assertSigningNetwork, capabilityMap, clientFor, devBalances, enableAllUpgrades, ensureDevWallet,
  getDevWallet, hasCapability, logActivity, parseNetwork, requireCaller, resolveCaller, sendAsAgent, signAsAgent, transferAsAgent, type Caller, type SendResult,
} from "./agent";
import { KNOWN_TOKENS, NETWORKS, explorerUrl, type EthNetwork } from "./networks";
import { AGENT_TOOLS, HARNESS_ONLY } from "./tools";
import { NATIVE, USDC, resolveToken, swapQuote, symbolOf, tokenPrices } from "./market";
import {
  checkTrigger, cleanNote, describeTrigger, eip681Url, expiryFrom, fmtUsd, isExpired, parseOrderAmount, parsePriceTrigger, parseSlippage,
  scanRange, stepPriceWatch, summarizeActivity, taggedAmount, type PaymentRequest, type StandingOrder, type TokenMove, type Watch,
} from "./automation";
import {
  acquireEthTickLock, activeWatches, cancelOrder, cancelPaymentRequest, cancelWatch, claimOrder, createOrder, createPaymentRequest, createWatch,
  getPaymentRequest, listAlerts, listOrders, listPaymentRequests, listWatches, markAlertsRead, openOrders, pendingPaymentRequests, pushAlert,
  releaseEthTickLock, updateOrder, updatePaymentRequest, updateWatch,
} from "./automation-store";
import {
  externalSignRefusal, findEthPayment, findTokenPayment, parseTxCall, previewExternalTx, tokenVerdict, verifyPaymentTx,
  type TokenFacts, type TokenMarket,
} from "./chainchecks";
import { PaperTradeError, normalizePolicy, transferPolicyViolation, valuePortfolio, type PaperWallet } from "./paper";
import { bookPaperTrade, getPaperWallet, getPolicy, listOrgPaperWallets, listPaperTrades, resetPaperWallet, setPolicy } from "./paper-store";

// ── Request helpers ──────────────────────────────────────────────────────

class NotFoundError extends Error {}

/** Auth/capability → its own status, bad input → 400, not found → 404, missing config → 503, upstream (RPC/API) → 502. */
function failure(err: unknown): Response {
  if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
  if (err instanceof AccessError) return Response.json({ error: err.message }, { status: err.status });
  if (err instanceof ConfigError) return Response.json({ error: err.message }, { status: 503 });
  const status = err instanceof DevtoolsInputError || err instanceof SyntaxError || err instanceof PaperTradeError ? 400 : 502;
  return Response.json({ error: (err as Error).message?.split("\n")[0] ?? String(err) }, { status });
}

async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    const out = await fn();
    return out instanceof Response ? out : Response.json(out);
  } catch (err) {
    return failure(err);
  }
}

const query = (req: Request, key: string) => new URL(req.url).searchParams.get(key);

async function body(req: Request): Promise<Record<string, unknown>> {
  const parsed = await req.json().catch(() => {
    throw new DevtoolsInputError("Request body must be JSON");
  });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DevtoolsInputError("Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

const callSpecOf = (b: Record<string, unknown>): CallSpec => ({
  to: b.to as string | undefined, value: b.value as string | undefined, data: b.data as string | undefined,
  signature: b.signature as string | undefined, args: b.args, bytecode: b.bytecode as string | undefined,
  constructorSignature: b.constructorSignature as string | undefined,
});

const optionalBlock = (v: unknown): bigint | undefined => {
  if (v == null || v === "") return undefined;
  if (!/^\d+$/.test(String(v).trim())) throw new DevtoolsInputError("blockNumber must be a block number");
  return BigInt(String(v).trim());
};

const compileOptsOf = (b: Record<string, unknown>) => ({
  optimize: b.optimize == null ? undefined : b.optimize !== false && b.optimize !== "false",
  runs: b.runs == null ? undefined : Number(b.runs),
  evmVersion: typeof b.evmVersion === "string" ? b.evmVersion : undefined,
});

/** What an agent sees of a compile: no std-JSON echo, bytecode only on request. */
function compileView(out: CompileResult, includeBytecode: boolean) {
  return {
    ok: out.ok, compilerVersion: out.compilerVersion, errors: out.errors, warnings: out.warnings,
    contracts: out.contracts.map((c) => ({
      name: c.name, identifier: c.identifier, constructorSignature: c.constructorSignature, functions: c.functions,
      deployedBytecodeSize: c.deployedBytecodeSize, overSizeLimit: c.deployedBytecodeSize > 24_576,
      abi: c.abi, ...(includeBytecode ? { bytecode: c.bytecode } : {}),
    })),
  };
}

/**
 * Read-only chain tools. A browser session can use them freely (they read
 * public chain data); an agent needs the eth-inspect upgrade, and its reads
 * land in its activity log so the operator can follow along.
 */
async function readTool<T extends object>(
  req: Request, ctx: RouteContext, describe: string, network: EthNetwork | null,
  fn: (client: PublicClient, network: EthNetwork) => Promise<T>,
): Promise<Response> {
  return handle(async () => {
    const net = network ?? parseNetwork(query(req, "network"));
    const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
    const result = await fn(clientFor(net), net);
    if (caller) logActivity(caller, { action: "inspect", network: net, ok: true, summary: describe });
    return { network: net, ...result };
  });
}

/** "self" = the calling agent's dev wallet; "name.eth" = its mainnet ENS address; else a 0x address. */
async function resolveTarget(ctx: RouteContext, req: Request, value: string, agentIdHint?: unknown): Promise<`0x${string}`> {
  const v = decodeURIComponent(value).trim();
  if (v === "self") {
    // A session may name its agent in the JSON body instead of the query string.
    const caller = await resolveCaller(ctx, query(req, "agentId") ?? (typeof agentIdHint === "string" ? agentIdHint : null));
    const wallet = await getDevWallet(caller);
    if (!wallet) throw new DevtoolsInputError("This agent has no Ethereum dev wallet yet — create one first (eth_create_wallet)");
    return wallet.address;
  }
  if (/\.eth$/i.test(v)) return resolveEns(clientFor("mainnet"), v);
  return parseAddress(v);
}

/** The signed agent's own org; a wallet session sees every org it belongs to. */
async function callerOrgIds(ctx: RouteContext): Promise<string[]> {
  if (ctx.agent?.orgId) return [ctx.agent.orgId];
  if (!ctx.session?.address) return [];
  return (await getOrganizationsByWalletAdmin(ctx.session.address)).map((org) => org.id);
}

async function requireOrgOwner(ctx: RouteContext, orgId: string): Promise<void> {
  if (!ctx.session) throw new AccessError("Sign in as the org owner", 401);
  const org = (await getOrganizationsByWalletAdmin(ctx.session.address)).find((o) => o.id === orgId);
  const isOwner = !!org?.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session.address);
  if (!isOwner) throw new AccessError("Only the org owner can change this", 403);
}

async function ethUsd(): Promise<number | null> {
  return (await tokenPrices(["ETH"]).catch(() => []))[0]?.usdPrice ?? null;
}

/** One activity row for anything the agent's wallet sent. */
function logSend(caller: Caller, action: string, result: Pick<SendResult, "network" | "status" | "hash" | "explorerUrl" | "error">, summary: string) {
  logActivity(caller, {
    action, network: result.network, ok: result.status === "success" || result.status === "pending",
    summary: result.status === "success" || result.status === "pending" ? summary : `${result.status}: ${result.error ?? "unknown error"}`.slice(0, 160),
    ...(result.hash ? { hash: result.hash, explorerUrl: result.explorerUrl ?? undefined } : {}),
  });
}

// ── Paper trading helpers ────────────────────────────────────────────────

/** Marks a paper wallet to market with DefiLlama prices (30 tokens per call). */
async function valueWallet(wallet: PaperWallet) {
  const tokens = Object.keys(wallet.holdings);
  const prices: Record<string, number | null> = {};
  for (let i = 0; i < tokens.length; i += 30) {
    for (const p of await tokenPrices(tokens.slice(i, i + 30))) prices[p.token.toLowerCase()] = p.usdPrice;
  }
  return valuePortfolio(wallet, prices);
}

/** "12.5", "all" or "25%" of the paper holding → a UI amount string. */
function paperAmount(wallet: PaperWallet, token: string, amount: unknown): string {
  const text = String(amount ?? "").trim().toLowerCase();
  if (text !== "all" && text !== "max" && !text.endsWith("%")) return text;
  const h = wallet.holdings[token.toLowerCase()];
  if (!h || BigInt(h.raw) === 0n) throw new PaperTradeError("The paper wallet holds none of the input token");
  const pct = text.endsWith("%") ? Number(text.slice(0, -1)) : 100;
  if (!(pct > 0 && pct <= 100)) throw new PaperTradeError("A percentage amount must be between 0 and 100%");
  const raw = (BigInt(h.raw) * BigInt(Math.round(pct * 100))) / 10_000n;
  if (raw <= 0n) throw new PaperTradeError("That share of the holding rounds to zero");
  const s = raw.toString().padStart(h.decimals + 1, "0");
  const frac = s.slice(-h.decimals).replace(/0+$/, "");
  return `${s.slice(0, s.length - h.decimals)}${frac ? `.${frac}` : ""}`;
}

/**
 * One paper swap at the live quote, booked under the owner's policy. Used
 * by POST /paper/swap and by standing orders the tick fills.
 */
async function executePaperSwap(
  caller: Caller,
  p: { inputToken: string; outputToken: string; amount: unknown; slippageBps?: number; note: string | null },
) {
  const inputToken = resolveToken(p.inputToken, "inputToken");
  const outputToken = resolveToken(p.outputToken, "outputToken");
  const wallet = await getPaperWallet(caller.agentId, caller.orgId);
  const amount = paperAmount(wallet, inputToken, p.amount);
  const quote = await swapQuote({ inputToken, outputToken, amount, slippageBps: p.slippageBps });
  if (quote.usdValue == null) throw new PaperTradeError("Couldn't price this swap in USD — try a more liquid token");
  try {
    const out = await bookPaperTrade(caller.agentId, caller.orgId, {
      inputToken, outputToken, inRaw: BigInt(quote.inAmount), outRaw: BigInt(quote.outAmount),
      inDecimals: quote.inDecimals, outDecimals: quote.outDecimals, inSymbol: quote.inSymbol, outSymbol: quote.outSymbol,
      usdValue: quote.usdValue, gasUsd: quote.gasUsd ?? 1,
    }, { inUi: quote.inUi, outUi: quote.outUi, priceImpactPct: quote.priceImpactPct, route: quote.route, note: p.note });
    const { trade } = out;
    logActivity(caller, { action: "paper-swap", ok: true, summary: `${trade.inUi} ${trade.inSymbol ?? ""} → ${trade.outUi} ${trade.outSymbol ?? ""} ($${trade.usdValue.toFixed(2)}, gas $${trade.gasUsd.toFixed(2)})` });
    return out;
  } catch (err) {
    if (err instanceof PaperTradeError) logActivity(caller, { action: "paper-swap", ok: false, summary: err.message.slice(0, 160) });
    throw err;
  }
}

// ── Automation helpers ───────────────────────────────────────────────────

/** Base's canonical L1StandardBridge proxy on Sepolia (OTHER_BRIDGE = the L2 bridge predeploy 0x4200…0010). */
const BASE_SEPOLIA_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120";

/** "ETH"/null → native; "USDC" → the network's USDC; else an ERC-20 address, read for its decimals. */
async function paymentAsset(client: PublicClient, network: EthNetwork, value: unknown): Promise<{ token: `0x${string}` | null; symbol: string; decimals: number }> {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || v.toUpperCase() === "ETH" || v.toLowerCase() === NATIVE.toLowerCase()) return { token: null, symbol: "ETH", decimals: 18 };
  const known = KNOWN_TOKENS[network].find((t) => t.symbol.toUpperCase() === v.toUpperCase());
  const token = known?.address ?? parseAddress(v, "token");
  const info = await tokenInfo(client, token);
  if (!info || info.decimals == null) throw new DevtoolsInputError(`${token} isn't an ERC-20 on ${NETWORKS[network].label}`);
  return { token, symbol: info.symbol ?? known?.symbol ?? "tokens", decimals: info.decimals };
}

/** One of the calling agent's own EVM wallets (default: its dev wallet). Payments only ever go to the agent. */
async function ownEvmWallet(caller: Caller, requested: unknown): Promise<`0x${string}`> {
  const wallets = (await listAgentWallets(caller.agentId)).filter((w) => w.chain === "evm" && w.orgId === caller.orgId);
  if (requested == null || requested === "" || requested === "self") {
    const dev = wallets.find((w) => w.label === DEV_WALLET_LABEL);
    if (!dev) throw new DevtoolsInputError("This agent has no Ethereum dev wallet yet — create one first (eth_create_wallet), or pass one of its wallets as recipient");
    return dev.publicKey as `0x${string}`;
  }
  const addr = parseAddress(requested, "recipient");
  const own = wallets.find((w) => w.publicKey.toLowerCase() === addr.toLowerCase());
  if (!own) throw new DevtoolsInputError("recipient must be one of this agent's own wallets");
  return own.publicKey as `0x${string}`;
}

/** Is `address` a contract, and is its source verified? Cached per tick/request. */
async function contractLookup(network: EthNetwork, address: string) {
  const client = clientFor(network);
  const code = await client.getCode({ address: address as `0x${string}` }).catch(() => undefined);
  if (!code || code === "0x") return { isContract: false, verified: false, name: null };
  const abi = await contractAbi(NETWORKS[network].chainId, address).catch(() => null);
  return { isContract: true, verified: !!abi?.verified || !!abi?.abi, name: abi?.name ?? null };
}

/** Gathers facts and (mainnet) market probes for an ERC-20, then grades them. */
async function tokenSafety(network: EthNetwork, token: `0x${string}`) {
  const client = clientFor(network);
  const info = await inspectAddress(client, token);
  const abi = info.isContract ? await contractAbi(NETWORKS[network].chainId, token, info.proxy?.implementation ?? null).catch(() => null) : null;
  const owner = info.isContract
    ? await readContract(client, token, "owner() view returns (address)").then((r) => String(r.result)).catch(() => null)
    : null;
  const renounced = owner != null && /^0x0{40}$/i.test(owner);
  const facts: TokenFacts = {
    address: token, isContract: info.isContract, name: info.token?.name ?? null, symbol: info.token?.symbol ?? null,
    decimals: info.token?.decimals ?? null, totalSupply: info.token?.totalSupply ?? null,
    verified: !!abi?.verified, implementation: info.proxy?.implementation ?? null, proxyAdmin: info.proxy?.admin ?? null,
    owner: renounced ? null : owner, ownerRenounced: renounced, functions: abi?.functions ?? [],
  };
  let market: TokenMarket | null = null;
  if (network === "mainnet" && info.token?.decimals != null && token.toLowerCase() !== USDC.toLowerCase()) {
    const [price] = await tokenPrices([token]).catch(() => [null]);
    const buy = await swapQuote({ inputToken: USDC, outputToken: token, amount: "1000", slippageBps: 100 }).catch(() => null);
    const sell = buy ? await swapQuote({ inputToken: token, outputToken: USDC, amount: buy.outUi, slippageBps: 100 }).catch(() => null) : null;
    market = {
      priceUsd: price?.usdPrice ?? null,
      buyImpactPct: buy?.priceImpactPct ?? null,
      sellImpactPct: sell?.priceImpactPct ?? null,
      roundTripLossPct: sell ? Math.max(0, (1 - Number(sell.outUi) / 1000) * 100) : null,
    };
  }
  return tokenVerdict(facts, market);
}

/** Most blocks a payment request scans per check: logs are cheap, native ETH reads whole blocks. */
const TOKEN_SCAN_BLOCKS = 5_000n;
const ETH_SCAN_BLOCKS = 60n;

/** Scans for a pending request's payment, marks it paid and alerts the agent when found. */
async function checkPaymentRequest(request: PaymentRequest, blockCache?: Map<bigint, { hash: Hex; from: string; to: string | null; value: bigint }[]>): Promise<PaymentRequest> {
  const client = clientFor(request.network);
  const latest = await client.getBlockNumber();
  const range = scanRange(BigInt(request.scannedThrough), latest, request.token ? TOKEN_SCAN_BLOCKS : ETH_SCAN_BLOCKS);
  if (!range) return request;
  const amountRaw = BigInt(request.amountRaw);
  const hit = request.token
    ? await findTokenPayment(client, { token: request.token, recipient: request.recipient, amountRaw, fromBlock: range.from, toBlock: range.to })
    : await findEthPayment(client, { recipient: request.recipient, amountRaw, fromBlock: range.from, toBlock: range.to }, blockCache);
  if (!hit) {
    await updatePaymentRequest(request.id, { scannedThrough: range.to.toString() });
    return { ...request, scannedThrough: range.to.toString() };
  }
  const paid: PaymentRequest = { ...request, status: "paid", paidTx: hit.hash, payer: hit.payer, paidAt: new Date().toISOString(), scannedThrough: range.to.toString() };
  await updatePaymentRequest(request.id, { status: "paid", paidTx: hit.hash, payer: hit.payer, paidAt: paid.paidAt, scannedThrough: paid.scannedThrough });
  await pushAlert({
    agentId: request.agentId, orgId: request.orgId, source: "payment", refId: request.id,
    title: `Paid: ${request.amountUi} ${request.symbol}${request.label ? ` for ${request.label}` : ""}`,
    detail: `${hit.payer} paid ${request.amountUi} ${request.symbol} to ${request.recipient} on ${NETWORKS[request.network].label} in block ${hit.block}.`,
    hash: hit.hash, explorerUrl: explorerUrl("tx", hit.hash, request.network),
  });
  return paid;
}

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("ethereum mod loaded");
  },

  routes: {
    // ── Discovery & status ──────────────────────────────────────────────

    /** GET /agent/tools — LLM tool definitions for every agent-facing route. Public: describes routes, grants nothing. */
    "GET /agent/tools": {
      public: true,
      handler: () => Response.json({
        mod: "ethereum",
        basePath: "/api/mods/ethereum",
        auth: "Authorization: Bearer agt_… (mods:call scope), Ed25519 agent/sig/ts, or agentId/apiKey",
        notes: [
          "Every chain tool takes an optional network: sepolia (default), base-sepolia, mainnet, or base.",
          "Signing tools (send, transfer, deploy) only work on sepolia/base-sepolia with the agent's own eth-dev wallet. Mainnets are read and simulate only.",
          "Address inputs accept \"self\" (the agent's dev wallet) and ENS names.",
          "Paper trades fill at live Ethereum mainnet KyberSwap quotes and pay that route's real gas.",
          "Don't compute hashes, selectors, addresses or storage slots yourself, and don't guess a contract's functions from memory: use eth_util and eth_contract_abi. They're exact.",
          "To ship a contract: eth_compile until it builds, then eth_deploy_source (compiles, deploys, verifies on Sourcify).",
          "When you wake, read eth_alerts first: standing orders, watches and payment requests keep running while you're offline.",
          "Never sign a transaction someone else built without eth_preview_transaction.",
        ],
        harness: HARNESS_ONLY,
        tools: AGENT_TOOLS,
      }),
    },

    /** GET /me — which Ethereum upgrades this agent has and its dev wallet + testnet balances. */
    "GET /me": (req, ctx) =>
      handle(async () => {
        const agentId = ctx.agent?.agentId ?? query(req, "agentId");
        if (!agentId) throw new DevtoolsInputError("agentId query param is required for a browser session");
        // No capability required: an agent with none should still learn what it could be granted.
        const caller = await resolveCaller(ctx, agentId);
        const [capabilities, wallet] = await Promise.all([capabilityMap(caller.agentId, caller.orgId), getDevWallet(caller)]);
        return {
          agentId: caller.agentId, orgId: caller.orgId, via: caller.via, capabilities,
          devWallet: wallet ? { address: wallet.address, balances: await devBalances(wallet.address) } : null,
          faucets: Object.fromEntries(Object.values(NETWORKS).filter((n) => n.testnet).map((n) => [n.id, n.faucets])),
        };
      }),

    /** GET /my-agents — the signed-in operator's agents with their Ethereum upgrades and dev wallet. Session only. */
    "GET /my-agents": (_req, ctx) =>
      handle(async () => {
        if (!ctx.session) throw new AccessError("Sign in to list your agents", 401);
        const orgs = await getOrganizationsByWalletAdmin(ctx.session.address);
        const perOrg = await Promise.all(orgs.map(async (org) => {
          const agents = await getAgentsByOrg(org.id);
          return Promise.all(agents.map(async (agent) => {
            // One agent's lookup failing must not hide every agent from the picker.
            const [capabilities, wallets] = await Promise.all([
              capabilityMap(agent.id, org.id).catch((err) => {
                console.warn(`[ethereum] capabilities for ${agent.id} failed:`, err);
                return {} as Awaited<ReturnType<typeof capabilityMap>>;
              }),
              listAgentWallets(agent.id).catch(() => []),
            ]);
            const devWallet = wallets.find((w) => w.chain === "evm" && w.label === DEV_WALLET_LABEL && w.orgId === org.id)?.publicKey ?? null;
            const isOwner = !!org.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session!.address);
            return { agentId: agent.id, name: agent.name, orgId: org.id, orgName: org.name || org.id, isOwner, capabilities, devWallet };
          }));
        }));
        return { agents: perOrg.flat() };
      }),

    /** POST /upgrade — enable every Ethereum upgrade on the org's install. Org owner only. Body: { orgId } */
    "POST /upgrade": (req, ctx) =>
      handle(async () => {
        const { orgId } = await body(req);
        if (typeof orgId !== "string" || !orgId) throw new DevtoolsInputError("orgId is required");
        await requireOrgOwner(ctx, orgId);
        const out = await enableAllUpgrades(orgId);
        if (!out.installed) throw new NotFoundError("This org hasn't installed the Ethereum mod — install it from the Market first");
        return out;
      }),

    /** GET /activity — what this agent has done with the mod (newest first). */
    "GET /activity": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, ctx.agent?.agentId ?? query(req, "agentId"));
        return { activity: await activityFor(caller.agentId, caller.orgId) };
      }),

    // ── Read & debug (?network=mainnet|sepolia|base|base-sepolia) ───────

    "GET /dev/status": (req, ctx) => readTool(req, ctx, "network status", null, async (client) => ({ status: await networkStatus(client) })),

    /** GET /dev/gas — fee tiers and the cost of common actions, in ETH and (on ETH-gas chains) USD. */
    "GET /dev/gas": (req, ctx) =>
      readTool(req, ctx, "gas", null, async (client) => {
        const [gas, usd] = await Promise.all([gasOracle(client), ethUsd()]);
        return { gas: { ...gas, ethUsd: usd, costs: gas.costs.map((c) => ({ ...c, usd: usd != null ? Number(c.eth) * usd : null })) } };
      }),

    "GET /dev/address/:address": (req, ctx) =>
      readTool(req, ctx, `address ${ctx.params.address}`, null, async (client, network) => {
        const address = await resolveTarget(ctx, req, ctx.params.address);
        const info = await inspectAddress(client, address, network === "mainnet" ? client : clientFor("mainnet"));
        return { account: info, explorerUrl: explorerUrl("address", address, network) };
      }),

    "GET /dev/tx/:hash": (req, ctx) =>
      readTool(req, ctx, `tx ${ctx.params.hash.slice(0, 14)}…`, null, async (client, network) => {
        const hash = parseHash(ctx.params.hash);
        return { tx: await inspectTransaction(client, hash), explorerUrl: explorerUrl("tx", hash, network) };
      }),

    /** GET /dev/holdings/:address — ETH + known/extra token balances. ?tokens=0x…,0x… */
    "GET /dev/holdings/:address": (req, ctx) =>
      readTool(req, ctx, `holdings ${ctx.params.address}`, null, async (client, network) => {
        const address = await resolveTarget(ctx, req, ctx.params.address);
        const extra = (query(req, "tokens") ?? "").split(",").map((t) => t.trim()).filter(Boolean).map((t) => parseAddress(t, "tokens"));
        return { holdings: await holdings(client, network, address, extra), explorerUrl: explorerUrl("address", address, network) };
      }),

    /** GET /dev/history/:address — recent transactions via Etherscan v2 (needs ETHERSCAN_API_KEY). ?limit=&page= */
    "GET /dev/history/:address": (req, ctx) =>
      readTool(req, ctx, `history ${ctx.params.address}`, null, async (_client, network) => {
        const address = await resolveTarget(ctx, req, ctx.params.address);
        const history = await addressHistory(NETWORKS[network].chainId, address, { limit: Number(query(req, "limit")) || undefined, page: Number(query(req, "page")) || undefined });
        return { address, history };
      }),

    "GET /dev/ens/:name": (req, ctx) =>
      readTool(req, ctx, `ENS ${ctx.params.name}`, "mainnet", async (client) => {
        const name = decodeURIComponent(ctx.params.name);
        return { name, address: await resolveEns(client, name) };
      }),

    /** POST /dev/read — Body: { network?, address, signature, args?, blockNumber? } */
    "POST /dev/read": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const network = parseNetwork(b.network);
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const address = parseAddress(b.address, "address");
        const block = b.blockNumber != null && b.blockNumber !== "" ? BigInt(String(b.blockNumber)) : undefined;
        const out = await readContract(clientFor(network), address, b.signature as string, b.args, block);
        if (caller) logActivity(caller, { action: "read", network, ok: true, summary: `${out.signature} on ${address.slice(0, 10)}…` });
        return { network, address, ...out };
      }),

    /** POST /dev/decode — Body: { data, kind?: auto|calldata|revert, signature?, abi? }. No RPC. */
    "POST /dev/decode": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const data = parseHexData(b.data);
        if (data === "0x") throw new DevtoolsInputError("data is required");
        const abi = Array.isArray(b.abi) ? (b.abi as never) : undefined;
        const kind = b.kind ?? "auto";
        let out: Record<string, unknown>;
        if (kind === "revert") {
          out = { kind: "revert", revert: await decodeRevert(data, abi) };
        } else if (kind === "calldata") {
          out = { kind: "calldata", call: await decodeCalldata(data, { signature: b.signature as string | undefined, abi }) };
        } else {
          // Auto: a recognised error decode wins; else try it as a function call.
          const revert = await decodeRevert(data, abi);
          out = revert.kind === "error-string" || revert.kind === "panic" || (revert.kind === "custom" && !b.signature)
            ? { kind: "revert", revert }
            : { kind: "calldata", call: await decodeCalldata(data, { signature: b.signature as string | undefined, abi }) };
        }
        if (caller) logActivity(caller, { action: "decode", ok: true, summary: `${data.slice(0, 10)} as ${out.kind}` });
        return out;
      }),

    // ── Market data (Ethereum mainnet, read-only) ──────────────────────

    /** GET /market/price?tokens=ETH,USDC,0x… */
    "GET /market/price": (req, ctx) =>
      handle(async () => {
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const tokens = (query(req, "tokens") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
        const prices = await tokenPrices(tokens);
        if (caller) logActivity(caller, { action: "price", ok: true, summary: prices.map((p) => `${p.symbol ?? p.token.slice(0, 8)} $${p.usdPrice ?? "?"}`).join(", ").slice(0, 160) });
        return { prices };
      }),

    /** GET /market/quote?inputToken=ETH&outputToken=USDC&amount=1&slippageBps=50 — quote only. */
    "GET /market/quote": (req, ctx) =>
      handle(async () => {
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const [inputToken, outputToken, amount] = ["inputToken", "outputToken", "amount"].map((k) => query(req, k));
        if (!inputToken || !outputToken || !amount) throw new DevtoolsInputError("inputToken, outputToken and amount are required");
        const slippage = query(req, "slippageBps");
        const quote = await swapQuote({ inputToken, outputToken, amount, slippageBps: slippage ? Number(slippage) : undefined });
        if (caller) logActivity(caller, { action: "quote", ok: true, summary: `${quote.inUi} ${quote.inSymbol ?? ""} → ${quote.outUi} ${quote.outSymbol ?? ""} via ${quote.route.join(" › ") || "?"}` });
        return { quote };
      }),

    // ── Paper trading ───────────────────────────────────────────────────

    "GET /paper": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        const wallet = await getPaperWallet(caller.agentId, caller.orgId);
        const [portfolio, policy] = await Promise.all([valueWallet(wallet), getPolicy(caller.agentId, caller.orgId)]);
        const today = new Date().toISOString().slice(0, 10);
        return { portfolio, policy, volumeTodayUsd: wallet.volumeDay === today ? wallet.volumeToday : 0, since: wallet.resetAt ?? wallet.createdAt };
      }),

    /** POST /paper/swap — Body: { agentId?, inputToken, outputToken, amount ("1.5" | "all" | "25%"), slippageBps?, note? } */
    "POST /paper/swap": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.trade);
        if (typeof b.inputToken !== "string" || typeof b.outputToken !== "string") throw new DevtoolsInputError("inputToken and outputToken are required");
        const { trade, wallet } = await executePaperSwap(caller, {
          inputToken: b.inputToken, outputToken: b.outputToken, amount: b.amount,
          slippageBps: b.slippageBps != null ? Number(b.slippageBps) : undefined,
          note: typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 280) : null,
        });
        return { trade, portfolio: await valueWallet(wallet) };
      }),

    "GET /paper/trades": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        const limit = Math.min(Math.max(Number(query(req, "limit") ?? 50) || 50, 1), 200);
        const [trades, wallet] = await Promise.all([listPaperTrades(caller.agentId, caller.orgId, limit), getPaperWallet(caller.agentId, caller.orgId)]);
        const since = wallet.resetAt ?? "";
        return { trades: trades.filter((t) => t.at >= since) };
      }),

    /** POST /paper/reset — back to 10,000 USDC. Org owner only, so an agent can't wipe its own record. */
    "POST /paper/reset": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await resolveCaller(ctx, b.agentId as string);
        await requireOrgOwner(ctx, caller.orgId);
        const wallet = await resetPaperWallet(caller.agentId, caller.orgId);
        logActivity(caller, { action: "paper-reset", ok: true, summary: `paper wallet reset to $${wallet.startUsd.toLocaleString()}` });
        return { portfolio: await valueWallet(wallet) };
      }),

    "GET /paper/leaderboard": (_req, ctx) =>
      handle(async () => {
        const orgIds = await callerOrgIds(ctx);
        if (!orgIds.length) throw new AccessError("No org for this caller", 403);
        const rows = (await Promise.all(orgIds.map(async (orgId) => {
          const [wallets, agents] = await Promise.all([listOrgPaperWallets(orgId), getAgentsByOrg(orgId)]);
          const names = new Map(agents.map((a) => [a.id, a.name]));
          return Promise.all(wallets.filter((w) => w.tradeCount > 0).map(async (w) => {
            const p = await valueWallet(w);
            return { agentId: w.agentId, name: names.get(w.agentId) ?? w.agentId, orgId, equityUsd: p.equityUsd, pnlUsd: p.pnlUsd, returnPct: p.returnPct, tradeCount: p.tradeCount, volumeUsd: p.volumeUsd };
          }));
        }))).flat();
        rows.sort((a, b) => b.returnPct - a.returnPct);
        return { leaderboard: rows };
      }),

    // ── Policy ──────────────────────────────────────────────────────────

    "GET /policy": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        return { policy: await getPolicy(caller.agentId, caller.orgId) };
      }),

    /** POST /policy — org owner edits an agent's limits. Body: { agentId, ...fields to change } */
    "POST /policy": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await resolveCaller(ctx, b.agentId as string);
        await requireOrgOwner(ctx, caller.orgId);
        const { agentId: _a, ...fields } = b;
        // Symbols are allowed in the token list; store addresses.
        const tokens = Array.isArray(fields.allowedTokens) ? fields.allowedTokens.map((t) => { try { return resolveToken(String(t)); } catch { return String(t); } }) : undefined;
        const policy = normalizePolicy({ ...fields, ...(tokens ? { allowedTokens: tokens } : {}) }, await getPolicy(caller.agentId, caller.orgId));
        await setPolicy(caller.agentId, caller.orgId, policy, ctx.session!.address);
        logActivity(caller, { action: "policy", ok: true, summary: policy.paused ? "paused by owner" : "limits updated by owner" });
        return { policy };
      }),

    // ── Build & simulate ────────────────────────────────────────────────

    /**
     * POST /dev/simulate — eth_call + estimateGas on any network.
     * Body: { network?, from?, to?, value?, data? | signature + args, bytecode?, constructorSignature?, agentId? }
     * An agent (or a session driving one) needs eth-simulate and runs as its
     * dev wallet by default; a session without an agent must pass `from`.
     */
    "POST /dev/simulate": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const network = parseNetwork(b.network);
        const built = buildCall(callSpecOf(b));
        const caller = ctx.agent || b.agentId ? await requireCaller(ctx, b.agentId as string, CAP.simulate) : null;
        if (!caller && !ctx.session) throw new AccessError("Authentication required", 401);
        let from: `0x${string}`;
        if (b.from) from = parseAddress(b.from, "from");
        else if (caller) {
          const wallet = await getDevWallet(caller);
          if (!wallet) throw new DevtoolsInputError("This agent has no dev wallet yet — create one (eth_create_wallet) or pass a `from` address to simulate as");
          from = wallet.address;
        } else throw new DevtoolsInputError("Pass a `from` address to simulate as, or pick an agent");
        const blockNumber = optionalBlock(b.blockNumber);
        const simulation = await simulateCall(clientFor(network), from, built, { stateOverride: parseStateOverride(b.stateOverride), blockNumber });
        if (caller) {
          logActivity(caller, {
            action: "simulate", network, ok: simulation.success,
            summary: simulation.success ? `${built.to ? `call ${built.to.slice(0, 10)}…` : "deploy"} · ${simulation.gasEstimate ?? "?"} gas` : `reverts: ${simulation.error}`.slice(0, 160),
          });
        }
        return { network, simulation };
      }),

    /**
     * POST /dev/compile — Solidity → ABI + bytecode with the pinned solc.
     * Body: { source | sources, optimize?, runs?, evmVersion?, includeBytecode? }
     * Pure compute, so a session can use it freely; an agent needs eth-simulate.
     */
    "POST /dev/compile": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = ctx.agent || b.agentId ? await requireCaller(ctx, b.agentId as string, CAP.simulate) : null;
        if (!caller && !ctx.session) throw new AccessError("Authentication required", 401);
        const out = await compileSolidity(parseSources(b.source, b.sources), compileOptsOf(b));
        if (caller) logActivity(caller, { action: "compile", ok: out.ok, summary: out.ok ? `compiled ${out.contracts.map((c) => c.name).join(", ") || "nothing deployable"}` : `compile failed: ${out.errors[0]?.message.split("\n")[0] ?? "?"}`.slice(0, 160) });
        return compileView(out, b.includeBytecode === true);
      }),

    /**
     * POST /dev/verify — submit source for an already-deployed contract to Sourcify.
     * Body: { network?, address, source | sources, contract?, optimize?, runs?, evmVersion?, creationTxHash? }
     */
    "POST /dev/verify": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = ctx.agent || b.agentId ? await requireCaller(ctx, b.agentId as string, CAP.simulate) : null;
        if (!caller && !ctx.session) throw new AccessError("Authentication required", 401);
        const network = parseNetwork(b.network);
        const address = parseAddress(b.address, "address");
        const out = await compileSolidity(parseSources(b.source, b.sources), compileOptsOf(b));
        if (!out.ok) return Response.json({ error: "Source doesn't compile", errors: out.errors }, { status: 400 });
        const contract = pickContract(out, b.contract as string | undefined);
        const verification = await verifyOnSourcify({
          chainId: NETWORKS[network].chainId, address, stdJsonInput: out.stdJsonInput, compilerVersion: out.compilerVersion,
          identifier: contract.identifier, creationTxHash: typeof b.creationTxHash === "string" ? b.creationTxHash : null,
        });
        if (caller) logActivity(caller, { action: "verify", network, ok: verification.status !== "failed", summary: `${contract.name} at ${address.slice(0, 10)}… ${verification.status}` });
        return { network, address, contract: contract.name, verification };
      }),

    // ── Exact math & deeper reads ───────────────────────────────────────

    /** POST /dev/util — hashing, ABI encoding, address/slot derivation. Body: { op, ...input }. No RPC. */
    "POST /dev/util": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const { op, ...input } = b;
        const result = ethUtil(op, input);
        if (caller) logActivity(caller, { action: "util", ok: true, summary: String(op) });
        return { op, ...result };
      }),

    /** GET /dev/abi/:address — a verified contract's ABI (Sourcify, then Etherscan), proxies resolved. */
    "GET /dev/abi/:address": (req, ctx) =>
      readTool(req, ctx, `abi ${ctx.params.address}`, null, async (client, network) => {
        const address = await resolveTarget(ctx, req, ctx.params.address);
        const info = await inspectAddress(client, address).catch(() => null);
        if (info && !info.isContract) throw new DevtoolsInputError(`${address} has no code on ${NETWORKS[network].label}. It's a wallet, not a contract`);
        const out = await contractAbi(NETWORKS[network].chainId, address, info?.proxy?.implementation ?? null);
        const full = query(req, "full") === "true";
        return { contract: full ? out : { ...out, abi: undefined }, explorerUrl: explorerUrl("address", address, network) };
      }),

    /** POST /dev/logs — Body: { network?, address?, event?, args?, fromBlock?, toBlock?, limit? } */
    "POST /dev/logs": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const network = parseNetwork(b.network);
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const out = await getLogs(clientFor(network), b);
        if (caller) logActivity(caller, { action: "logs", network, ok: true, summary: `${String(b.event ?? "logs").split("(")[0]} · ${out.total} in ${out.fromBlock}–${out.toBlock}` });
        return { network, ...out };
      }),

    /**
     * POST /dev/storage — raw storage. Body: { network?, address, slot | slots, keys?, blockNumber? }.
     * With `keys` ([{ type, value }], outermost first) the slot is a mapping's base slot.
     */
    "POST /dev/storage": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const network = parseNetwork(b.network);
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const address = await resolveTarget(ctx, req, String(b.address ?? ""), b.agentId);
        let slots = b.slots ?? b.slot;
        if (Array.isArray(b.keys) && b.keys.length) {
          let slot: unknown = b.slot;
          for (const k of b.keys as { type: string; value: unknown }[]) slot = mappingSlot(String(k?.type), k?.value, slot);
          slots = slot;
        }
        const values = await readStorage(clientFor(network), address, slots, optionalBlock(b.blockNumber));
        if (caller) logActivity(caller, { action: "storage", network, ok: true, summary: `${values.length} slot(s) of ${address.slice(0, 10)}…` });
        return { network, address, values };
      }),

    /** POST /dev/multicall — Body: { network?, calls: [{ address, signature, args? }], blockNumber? } */
    "POST /dev/multicall": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const network = parseNetwork(b.network);
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const results = await multiRead(clientFor(network), b.calls, optionalBlock(b.blockNumber));
        if (caller) logActivity(caller, { action: "multicall", network, ok: true, summary: `${results.length} reads, ${results.filter((r) => !r.ok).length} failed` });
        return { network, results };
      }),

    // ── Act on testnets: source → verified contract, and signatures ─────

    /**
     * POST /dev/deploy-source — compile, deploy from the dev wallet, verify on Sourcify.
     * Body: { agentId?, network?, source | sources, contract?, args?, value?, optimize?, runs?, evmVersion?, verify? }
     */
    "POST /dev/deploy-source": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.testnet);
        const network = parseNetwork(b.network);
        const compiled = await compileSolidity(parseSources(b.source, b.sources), compileOptsOf(b));
        if (!compiled.ok) {
          logActivity(caller, { action: "deploy", network, ok: false, summary: `compile failed: ${compiled.errors[0]?.message.split("\n")[0] ?? "?"}`.slice(0, 160) });
          return Response.json({ status: "compile-failed", errors: compiled.errors, warnings: compiled.warnings }, { status: 400 });
        }
        const contract = pickContract(compiled, b.contract as string | undefined);
        if (contract.deployedBytecodeSize > 24_576) throw new DevtoolsInputError(`${contract.name} is ${contract.deployedBytecodeSize} bytes; the EIP-170 limit is 24,576. Turn the optimizer on or split it`);
        const ctor = contract.abi.find((i) => i.type === "constructor") as { inputs: readonly { type: string }[] } | undefined;
        const bytecode = encodeDeployData({ abi: contract.abi as Abi, bytecode: contract.bytecode, args: (ctor ? coerceArgs(ctor, b.args) : []) as never });
        const spec: CallSpec = { bytecode, value: b.value as string | undefined };
        const eth = Number(formatEther(parseEthAmount(spec.value)));
        const violation = transferPolicyViolation(await getPolicy(caller.agentId, caller.orgId), { to: null, eth: eth > 0 ? eth : null });
        if (violation) throw new AccessError(violation, 403);
        const result = await sendAsAgent(caller, network, spec);
        logSend(caller, "deploy", result, `deployed ${contract.name} at ${result.contractAddress ?? "?"}`);
        const verification = result.status === "success" && result.contractAddress && b.verify !== false
          ? await verifyOnSourcify({ chainId: NETWORKS[network].chainId, address: result.contractAddress, stdJsonInput: compiled.stdJsonInput, compilerVersion: compiled.compilerVersion, identifier: contract.identifier, creationTxHash: result.hash })
          : null;
        const { simulation: _s, ...rest } = result;
        return {
          ...rest, contract: contract.name, functions: contract.functions, compilerVersion: compiled.compilerVersion, warnings: compiled.warnings,
          contractExplorerUrl: result.contractAddress ? explorerUrl("address", result.contractAddress, network) : null, verification,
        };
      }),

    /** POST /dev/sign — EIP-191 message or EIP-712 typed data (testnet domains only) with the dev wallet. Body: { agentId?, message | typedData } */
    "POST /dev/sign": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.testnet);
        if ((await getPolicy(caller.agentId, caller.orgId)).paused) throw new AccessError("Signing is paused for this agent by its org owner", 403);
        const out = await signAsAgent(caller, { message: b.message, typedData: b.typedData });
        logActivity(caller, { action: "sign", ok: true, summary: out.kind === "message" ? `signed message "${String(b.message).slice(0, 60)}"` : `signed ${(b.typedData as { primaryType?: string }).primaryType ?? "typed data"}` });
        return out;
      }),

    // ── Act on testnets (agent's own eth-dev wallet) ────────────────────

    /** POST /dev/wallet — create (or return) this agent's dev wallet. */
    "POST /dev/wallet": (req, ctx) =>
      handle(async () => {
        const b = await body(req).catch(() => ({} as Record<string, unknown>));
        const caller = await requireCaller(ctx, b.agentId as string, CAP.testnet);
        const wallet = await ensureDevWallet(caller, ctx.session?.address ?? `agent:${caller.agentId}`);
        if (wallet.created) logActivity(caller, { action: "create-wallet", ok: true, summary: `dev wallet ${wallet.address}` });
        return { ...wallet, balances: await devBalances(wallet.address), faucets: { sepolia: NETWORKS.sepolia.faucets, "base-sepolia": NETWORKS["base-sepolia"].faucets } };
      }),

    /** POST /dev/send — simulate, then sign and send. Body: { agentId?, network?, ...call spec } */
    "POST /dev/send": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.testnet);
        const network = parseNetwork(b.network);
        const spec = callSpecOf(b);
        const eth = Number(formatEther(parseEthAmount(spec.value)));
        const violation = transferPolicyViolation(await getPolicy(caller.agentId, caller.orgId), { to: eth > 0 && spec.to ? spec.to : null, eth: eth > 0 ? eth : null });
        if (violation) throw new AccessError(violation, 403);
        const result = await sendAsAgent(caller, network, spec);
        logSend(caller, spec.bytecode ? "deploy" : "send", result, spec.bytecode ? `deployed ${result.contractAddress ?? "?"}` : `${spec.signature?.split("(")[0] ?? "tx"} → ${result.to?.slice(0, 10) ?? "?"}… · ${result.gasUsed ?? "?"} gas`);
        return result;
      }),

    /** POST /dev/deploy — Body: { agentId?, network?, bytecode, constructorSignature?, args?, value? } */
    "POST /dev/deploy": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.testnet);
        const network = parseNetwork(b.network);
        if (b.bytecode == null) throw new DevtoolsInputError("bytecode is required");
        const spec: CallSpec = { bytecode: b.bytecode as string, constructorSignature: b.constructorSignature as string | undefined, args: b.args, value: b.value as string | undefined };
        const eth = Number(formatEther(parseEthAmount(spec.value)));
        const violation = transferPolicyViolation(await getPolicy(caller.agentId, caller.orgId), { to: null, eth: eth > 0 ? eth : null });
        if (violation) throw new AccessError(violation, 403);
        const result = await sendAsAgent(caller, network, spec);
        logSend(caller, "deploy", result, `deployed ${result.contractAddress ?? "?"}`);
        return { ...result, contractExplorerUrl: result.contractAddress ? explorerUrl("address", result.contractAddress, network) : null };
      }),

    /** POST /dev/transfer — ETH or an ERC-20. Body: { agentId?, network?, to, amount, token? } */
    "POST /dev/transfer": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.testnet);
        const network = parseNetwork(b.network);
        if (typeof b.to !== "string" || b.amount == null || b.amount === "") throw new DevtoolsInputError("to and amount are required");
        const token = typeof b.token === "string" && b.token.trim() && b.token.trim().toLowerCase() !== NATIVE.toLowerCase() && b.token.trim().toUpperCase() !== "ETH" ? b.token.trim() : null;
        const to = /\.eth$/i.test(b.to.trim()) ? await resolveEns(clientFor("mainnet"), b.to) : parseAddress(b.to, "to");
        const violation = transferPolicyViolation(await getPolicy(caller.agentId, caller.orgId), { to, eth: token ? null : Number(b.amount) });
        if (violation) throw new AccessError(violation, 403);
        const result = await transferAsAgent(caller, network, { to, amount: b.amount as string, token });
        logSend(caller, "transfer", result, `${result.amountUi} ${result.symbol} → ${to.slice(0, 10)}…`);
        return result;
      }),

    // ── Bridge testnet ETH (Sepolia → Base Sepolia) ─────────────────────

    /**
     * POST /dev/bridge — moves the dev wallet's Sepolia ETH to Base Sepolia
     * through Base's canonical L1StandardBridge. Arrives in a few minutes.
     * Faucets are per-network, so this is how an agent with Sepolia ETH
     * gets gas on Base Sepolia. Body: { agentId?, amount }
     */
    "POST /dev/bridge": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.testnet);
        const amount = String(b.amount ?? "").trim();
        if (!(Number(amount) > 0)) throw new DevtoolsInputError("amount (ETH) must be greater than 0");
        const violation = transferPolicyViolation(await getPolicy(caller.agentId, caller.orgId), { to: null, eth: Number(amount) });
        if (violation) throw new AccessError(violation, 403);
        const result = await sendAsAgent(caller, "sepolia", { to: BASE_SEPOLIA_BRIDGE, signature: "depositETH(uint32 minGasLimit, bytes extraData)", args: ["200000", "0x"], value: amount });
        logSend(caller, "bridge", result, `bridged ${amount} ETH Sepolia → Base Sepolia`);
        const { simulation: _s, ...rest } = result;
        return { ...rest, amountEth: amount, arrivesOn: "base-sepolia", note: result.status === "success" ? "Deposits land on Base Sepolia in about 1–5 minutes, at the same address. Check with eth_me." : undefined };
      }),

    // ── Runs while the agent is offline (filled by runEthTick) ──────────

    /**
     * POST /orders — a standing paper order: when `trigger` fires, swap
     * `amount` of inputToken into outputToken at the live quote.
     * Body: { agentId?, inputToken, outputToken, amount, trigger: { token, op: above|below|trail, usd | trailPct }, ttlDays?, slippageBps?, note? }
     */
    "POST /orders": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.trade);
        if ((await getPolicy(caller.agentId, caller.orgId)).paused) throw new AccessError("Trading is paused for this agent by its org owner", 403);
        if (typeof b.inputToken !== "string" || typeof b.outputToken !== "string") throw new DevtoolsInputError("inputToken and outputToken are required");
        const inputToken = resolveToken(b.inputToken, "inputToken");
        const outputToken = resolveToken(b.outputToken, "outputToken");
        if (inputToken === outputToken) throw new DevtoolsInputError("inputToken and outputToken are the same token");
        const trigger = parsePriceTrigger(b.trigger, (v) => resolveToken(v, "trigger.token"));
        const [price] = await tokenPrices([trigger.token]);
        if (price.usdPrice == null) throw new DevtoolsInputError(`DefiLlama has no price for ${trigger.token}, so the trigger could never fire`);
        const order = await createOrder({
          agentId: caller.agentId, orgId: caller.orgId, status: "open", createdAt: new Date().toISOString(), expiresAt: expiryFrom(b.ttlDays),
          inputToken, outputToken, amount: parseOrderAmount(b.amount), slippageBps: parseSlippage(b.slippageBps),
          trigger: trigger.op === "trail" ? { ...trigger, peakUsd: price.usdPrice } : trigger, note: cleanNote(b.note),
        });
        const desc = describeTrigger(order.trigger, price.symbol);
        logActivity(caller, { action: "order", ok: true, summary: `when ${desc}: ${order.amount} ${symbolOf(inputToken) ?? inputToken.slice(0, 8)} → ${symbolOf(outputToken) ?? outputToken.slice(0, 8)}` });
        return { order, currentPriceUsd: price.usdPrice, fires: `when ${desc}`, note: "The hub checks this every minute while you're offline. Read eth_alerts when you wake." };
      }),

    "GET /orders": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        return { orders: await listOrders(caller.agentId, caller.orgId) };
      }),

    "POST /orders/:id/cancel": (req, ctx) =>
      handle(async () => {
        const b = await body(req).catch(() => ({} as Record<string, unknown>));
        const caller = await resolveCaller(ctx, (b.agentId as string) ?? query(req, "agentId"));
        const order = await cancelOrder(ctx.params.id, caller.agentId, caller.orgId);
        if (!order) throw new NotFoundError("Order not found");
        logActivity(caller, { action: "order-cancel", ok: true, summary: `cancelled ${order.id}` });
        return { order };
      }),

    /**
     * POST /watches — alert this agent when something happens.
     * Body: { agentId?, kind: "price", trigger, repeat?, ttlDays?, note? }
     *     | { agentId?, kind: "activity", address ("self" ok), network?, repeat? (default true), ttlDays?, note? }
     *     | { agentId?, kind: "event", event, address?, args?, network?, repeat? (default true), ttlDays?, note? }
     */
    "POST /watches": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.inspect);
        const common = {
          agentId: caller.agentId, orgId: caller.orgId, status: "active" as const, createdAt: new Date().toISOString(),
          expiresAt: expiryFrom(b.ttlDays), note: cleanNote(b.note), fireCount: 0,
        };
        let watch: Watch;
        let summary: string;
        if (b.kind === "price") {
          const trigger = parsePriceTrigger(b.trigger, (v) => resolveToken(v, "trigger.token"));
          const [price] = await tokenPrices([trigger.token]);
          if (price.usdPrice == null) throw new DevtoolsInputError(`DefiLlama has no price for ${trigger.token}`);
          const armed = !checkTrigger(trigger, price.usdPrice).hit;
          const armedTrigger = trigger.op === "trail" ? { ...trigger, peakUsd: price.usdPrice } : trigger;
          watch = await createWatch({ ...common, kind: "price", repeat: b.repeat === true, armed, trigger: armedTrigger });
          summary = `price: ${describeTrigger(armedTrigger, price.symbol)}${armed ? "" : " (already true — fires after it next clears and crosses again)"}`;
        } else if (b.kind === "activity") {
          if (typeof b.address !== "string") throw new DevtoolsInputError("address is required");
          const network = parseNetwork(b.network);
          const address = await resolveTarget(ctx, req, b.address, b.agentId);
          const client = clientFor(network);
          const latest = await client.getBlockNumber();
          const [nonce, balance] = await Promise.all([client.getTransactionCount({ address, blockNumber: latest }), client.getBalance({ address, blockNumber: latest })]);
          watch = await createWatch({ ...common, kind: "activity", repeat: b.repeat !== false, network, address, lastBlock: latest.toString(), lastNonce: nonce, lastBalanceWei: balance.toString() });
          summary = `activity on ${address} (${NETWORKS[network].label})`;
        } else if (b.kind === "event") {
          if (typeof b.event !== "string" || !b.event.trim()) throw new DevtoolsInputError("event is required, e.g. \"Transfer(address indexed from, address indexed to, uint256 value)\"");
          const network = parseNetwork(b.network);
          const address = b.address ? await resolveTarget(ctx, req, String(b.address), b.agentId) : null;
          const args = b.args && typeof b.args === "object" && !Array.isArray(b.args) ? (b.args as Record<string, unknown>) : null;
          // A dry query validates the event and filters before the watch is stored.
          const probe = await getLogs(clientFor(network), { address, event: b.event, args, fromBlock: "-1", limit: 1 });
          watch = await createWatch({ ...common, kind: "event", repeat: b.repeat !== false, network, address, event: b.event.trim(), args, lastBlock: probe.toBlock });
          summary = `${b.event.split("(")[0]} events${address ? ` on ${address}` : ""}${args ? ` where ${Object.entries(args).map(([k, v]) => `${k}=${String(v)}`).join(", ")}` : ""} (${NETWORKS[network].label})`;
        } else {
          throw new DevtoolsInputError("kind must be price, activity or event");
        }
        logActivity(caller, { action: "watch", ok: true, summary: summary.slice(0, 160) });
        return { watch, watching: summary };
      }),

    "GET /watches": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        return { watches: await listWatches(caller.agentId, caller.orgId) };
      }),

    "POST /watches/:id/cancel": (req, ctx) =>
      handle(async () => {
        const b = await body(req).catch(() => ({} as Record<string, unknown>));
        const caller = await resolveCaller(ctx, (b.agentId as string) ?? query(req, "agentId"));
        const watch = await cancelWatch(ctx.params.id, caller.agentId, caller.orgId);
        if (!watch) throw new NotFoundError("Watch not found");
        return { watch };
      }),

    /** GET /alerts — what fired while the agent was away, newest first. ?unread=1&limit=1–200 */
    "GET /alerts": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        const alerts = await listAlerts(caller.agentId, caller.orgId, { unreadOnly: query(req, "unread") === "1", limit: Number(query(req, "limit") ?? 50) || 50 });
        return { alerts, unread: alerts.filter((a) => !a.read).length };
      }),

    /** POST /alerts/read — Body: { agentId?, ids?: string[], all?: true } */
    "POST /alerts/read": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await resolveCaller(ctx, b.agentId as string);
        const ids = b.all === true
          ? (await listAlerts(caller.agentId, caller.orgId, { unreadOnly: true, limit: 200 })).map((a) => a.id)
          : Array.isArray(b.ids) ? b.ids.map(String) : [];
        if (!ids.length && b.all !== true) throw new DevtoolsInputError("Pass ids or all: true");
        return { marked: await markAlertsRead(caller.agentId, caller.orgId, ids) };
      }),

    // ── Get paid directly (EIP-681) ─────────────────────────────────────

    /**
     * POST /payments/request — an EIP-681 payment link for an exact,
     * request-unique amount. The tick watches the chain and alerts the agent
     * once it's paid. Receiving is safe on mainnets too.
     * Body: { agentId?, amount, token? ("ETH" default, "USDC", or 0x address), network?, recipient? (one of the agent's own wallets; default dev wallet), label?, ttlDays? }
     */
    "POST /payments/request": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.inspect);
        const network = parseNetwork(b.network);
        const client = clientFor(network);
        const asset = await paymentAsset(client, network, b.token);
        const amount = String(b.amount ?? "").trim();
        if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) throw new DevtoolsInputError("amount must be a positive decimal, e.g. \"5\" or \"0.25\"");
        const recipient = await ownEvmWallet(caller, b.recipient);
        const amountRaw = taggedAmount(toRaw(amount, asset.decimals), asset.decimals);
        const latest = await client.getBlockNumber();
        const request = await createPaymentRequest({
          agentId: caller.agentId, orgId: caller.orgId, status: "pending", createdAt: new Date().toISOString(), expiresAt: expiryFrom(b.ttlDays),
          network, recipient, token: asset.token, symbol: asset.symbol, decimals: asset.decimals,
          requestedUi: amount, amountUi: toUi(amountRaw, asset.decimals), amountRaw: amountRaw.toString(),
          startBlock: latest.toString(), scannedThrough: (latest - 1n).toString(),
          label: typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 64) : null,
          url: eip681Url({ chainId: NETWORKS[network].chainId, recipient, token: asset.token, amountRaw: amountRaw.toString() }),
        });
        logActivity(caller, { action: "payment-request", network, ok: true, summary: `${request.amountUi} ${asset.symbol} to ${recipient.slice(0, 10)}…` });
        return {
          request, payUrl: request.url, payExactly: `${request.amountUi} ${asset.symbol}`,
          note: `Ask the payer to send EXACTLY ${request.amountUi} ${asset.symbol} on ${NETWORKS[network].label} to ${recipient} (the extra digits identify this request), or to open payUrl in their wallet. The hub checks every minute and posts an alert; eth_payment_status checks now.`,
        };
      }),

    "GET /payments": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        return { requests: await listPaymentRequests(caller.agentId, caller.orgId) };
      }),

    /** GET /payments/:id — a request, re-checked on-chain right now if still pending. */
    "GET /payments/:id": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        const request = await getPaymentRequest(ctx.params.id, caller.agentId, caller.orgId);
        if (!request) throw new NotFoundError("Payment request not found");
        if (request.status !== "pending") return { request };
        return { request: await checkPaymentRequest(request) };
      }),

    "POST /payments/:id/cancel": (req, ctx) =>
      handle(async () => {
        const b = await body(req).catch(() => ({} as Record<string, unknown>));
        const caller = await resolveCaller(ctx, (b.agentId as string) ?? query(req, "agentId"));
        const request = await cancelPaymentRequest(ctx.params.id, caller.agentId, caller.orgId);
        if (!request) throw new NotFoundError("Payment request not found");
        return { request };
      }),

    /**
     * POST /payments/verify — did `recipient` really receive this payment?
     * Body: { hash, recipient ("self" ok), token? (ETH default, "USDC", 0x), amount? (minimum), network? }
     */
    "POST /payments/verify": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        if (!ctx.agent && !ctx.session) throw new AccessError("Authentication required", 401);
        const network = parseNetwork(b.network);
        const client = clientFor(network);
        if (typeof b.recipient !== "string") throw new DevtoolsInputError("recipient is required");
        const recipient = await resolveTarget(ctx, req, b.recipient, b.agentId);
        const asset = await paymentAsset(client, network, b.token);
        const minRaw = b.amount != null && b.amount !== "" ? toRaw(String(b.amount), asset.decimals) : null;
        const verdict = await verifyPaymentTx(client, { hash: parseHash(b.hash), recipient, token: asset.token, decimals: asset.decimals, minRaw });
        if (caller) logActivity(caller, { action: "verify-payment", network, ok: verdict.verified, summary: verdict.verified ? `verified ${verdict.received} ${asset.symbol} from ${verdict.payer?.slice(0, 10)}…` : `not verified: ${verdict.reason}`.slice(0, 160), ...(verdict.hash ? { hash: verdict.hash } : {}) });
        return { network, symbol: asset.symbol, ...verdict, ...(verdict.hash ? { explorerUrl: explorerUrl("tx", verdict.hash, network) } : {}) };
      }),

    // ── Due diligence ───────────────────────────────────────────────────

    /** GET /token/safety/:token — ERC-20 risk report. ?network= (default mainnet) */
    "GET /token/safety/:token": (req, ctx) =>
      handle(async () => {
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        if (!ctx.agent && !ctx.session) throw new AccessError("Authentication required", 401);
        const network = parseNetwork(query(req, "network") ?? "mainnet");
        const raw = decodeURIComponent(ctx.params.token).trim();
        const token = network === "mainnet" ? resolveToken(raw, "token") : parseAddress(raw, "token");
        if (token === NATIVE) throw new DevtoolsInputError("ETH is the native coin, not a token contract");
        const report = await tokenSafety(network, token as `0x${string}`);
        if (caller) logActivity(caller, { action: "token-safety", network, ok: true, summary: `${report.symbol ?? token.slice(0, 10)}: ${report.verdict}` });
        return { network, report };
      }),

    /**
     * POST /tx/preview — decode and simulate a transaction someone else built
     * (a dapp, an API, another agent) and report what it does to the agent's
     * wallet. Body: { agentId?, network?, transaction: { to, data, value (wei) }, from? }
     */
    "POST /tx/preview": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = ctx.agent || b.agentId ? await requireCaller(ctx, b.agentId as string, CAP.simulate) : null;
        if (!caller && !ctx.session) throw new AccessError("Authentication required", 401);
        const network = parseNetwork(b.network);
        const tx = parseTxCall((b.transaction ?? b) as Record<string, unknown>);
        let from: `0x${string}`;
        if (b.from) from = parseAddress(b.from, "from");
        else if (caller) from = (await getDevWallet(caller))?.address ?? (() => { throw new DevtoolsInputError("This agent has no dev wallet — create one or pass from"); })();
        else throw new DevtoolsInputError("Pass `from`, or pick an agent");
        const preview = await previewExternalTx(clientFor(network), { from, to: tx.to, data: tx.data, value: tx.valueWei }, { contract: (a) => contractLookup(network, a) });
        if (caller) logActivity(caller, { action: "tx-preview", network, ok: preview.simulation.success, summary: `${preview.verdict}: ${preview.decoded?.functionName ?? (tx.to ? "call" : "deploy")} → ${tx.to?.slice(0, 10) ?? "new contract"}` });
        return { network, preview };
      }),

    /**
     * POST /tx/sign — preview, then sign with the dev wallet and send
     * (Sepolia / Base Sepolia). Refuses a tx that fails in simulation, one
     * over the owner's ETH limit, and a high-risk one unless acceptRisks.
     * Body: { agentId?, network?, transaction: { to, data, value (wei) }, acceptRisks? }
     */
    "POST /tx/sign": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.testnet);
        const network = parseNetwork(b.network);
        assertSigningNetwork(network);
        const policy = await getPolicy(caller.agentId, caller.orgId);
        if (policy.paused) throw new AccessError("Signing is paused for this agent by its org owner", 403);
        const wallet = await getDevWallet(caller);
        if (!wallet) throw new DevtoolsInputError("This agent has no dev wallet yet — call eth_create_wallet first");
        const tx = parseTxCall((b.transaction ?? b) as Record<string, unknown>);
        const valueEth = formatEther(tx.valueWei);
        const allow = transferPolicyViolation(policy, { to: tx.valueWei > 0n ? tx.to : null, eth: tx.valueWei > 0n ? Number(valueEth) : null });
        if (allow) throw new AccessError(allow, 403);
        const preview = await previewExternalTx(clientFor(network), { from: wallet.address, to: tx.to, data: tx.data, value: tx.valueWei }, { contract: (a) => contractLookup(network, a) });
        const refusal = externalSignRefusal(preview, policy, b.acceptRisks === true);
        if (refusal) {
          logActivity(caller, { action: "tx-sign", network, ok: false, summary: `refused: ${refusal}`.slice(0, 160) });
          return Response.json({ error: refusal, preview }, { status: 409 });
        }
        const result = await sendAsAgent(caller, network, tx.to ? { to: tx.to, data: tx.data, value: valueEth } : { bytecode: tx.data, value: valueEth });
        logSend(caller, "tx-sign", result, `${preview.decoded?.functionName ?? "tx"} → ${tx.to?.slice(0, 10) ?? "deploy"}… (${preview.verdict})`);
        const { simulation: _s, ...rest } = result;
        return { ...rest, preview };
      }),
  },
});

// ── The minute tick ──────────────────────────────────────────────────────

const TICK_BUDGET_MS = 20_000;

/** Prices for many tokens, 30 per DefiLlama call. Failed batches come back missing. */
async function priceMap(tokens: string[]): Promise<Map<string, { usd: number | null; symbol: string | null }>> {
  const out = new Map<string, { usd: number | null; symbol: string | null }>();
  const unique = [...new Set(tokens)];
  for (let i = 0; i < unique.length; i += 30) {
    try {
      for (const p of await tokenPrices(unique.slice(i, i + 30))) out.set(p.token.toLowerCase(), { usd: p.usdPrice, symbol: p.symbol });
    } catch (err) {
      console.warn("[eth-tick] price batch failed:", (err as Error).message);
    }
  }
  return out;
}

const tickCaller = (row: { agentId: string; orgId: string }): Caller => ({ agentId: row.agentId, orgId: row.orgId, via: "agent" });

async function fillOrder(order: StandingOrder, priceUsd: number, symbol: string | null): Promise<"filled" | "failed" | "skipped"> {
  if (!(await claimOrder(order.id))) return "skipped";
  const fired = `${describeTrigger(order.trigger, symbol)} (now $${fmtUsd(priceUsd)})`;
  try {
    if (!(await hasCapability(order.agentId, order.orgId, CAP.trade))) throw new PaperTradeError(`The "${CAP.trade}" upgrade was turned off`);
    const { trade } = await executePaperSwap(tickCaller(order), {
      inputToken: order.inputToken, outputToken: order.outputToken, amount: order.amount, slippageBps: order.slippageBps ?? undefined,
      note: `[standing order ${order.id}] ${order.note ?? fired}`.slice(0, 280),
    });
    const result = `${trade.inUi} ${trade.inSymbol ?? ""} → ${trade.outUi} ${trade.outSymbol ?? ""} ($${trade.usdValue.toFixed(2)})`.replace(/\s+/g, " ");
    await updateOrder(order.id, { status: "filled", closedAt: new Date().toISOString(), firedPriceUsd: priceUsd, tradeId: trade.id, result });
    await pushAlert({ agentId: order.agentId, orgId: order.orgId, source: "order", refId: order.id, title: `Order filled: ${result}`, detail: `Fired when ${fired}.${order.note ? ` Your note: ${order.note}` : ""}` });
    return "filled";
  } catch (err) {
    const msg = (err as Error).message.slice(0, 240);
    await updateOrder(order.id, { status: "failed", closedAt: new Date().toISOString(), firedPriceUsd: priceUsd, result: msg });
    await pushAlert({ agentId: order.agentId, orgId: order.orgId, source: "order", refId: order.id, title: "Order fired but didn't fill", detail: `Fired when ${fired}, then: ${msg}` });
    return "failed";
  }
}

const TRANSFER_EVENT = "Transfer(address indexed from, address indexed to, uint256 value)";

/** New outgoing txs (nonce), ETH balance change and ERC-20 transfers in or out since the last check. */
async function stepActivityWatch(watch: Extract<Watch, { kind: "activity" }>): Promise<boolean> {
  const client = clientFor(watch.network);
  const latest = await client.getBlockNumber();
  const range = scanRange(BigInt(watch.lastBlock), latest);
  if (!range) return false;
  const address = watch.address as `0x${string}`;
  const [nonce, balance, incoming, outgoing] = await Promise.all([
    client.getTransactionCount({ address, blockNumber: range.to }),
    client.getBalance({ address, blockNumber: range.to }),
    getLogs(client, { event: TRANSFER_EVENT, args: { to: address }, fromBlock: range.from.toString(), toBlock: range.to.toString(), limit: 200 }),
    getLogs(client, { event: TRANSFER_EVENT, args: { from: address }, fromBlock: range.from.toString(), toBlock: range.to.toString(), limit: 200 }),
  ]);
  // ERC-721 Transfers share the topic but index the token id; keep fungible ones (value is a data field).
  const rows = [...incoming.logs.map((l) => ({ l, dir: "in" as const })), ...outgoing.logs.map((l) => ({ l, dir: "out" as const }))]
    .filter(({ l }) => l.args && typeof (l.args as { value?: unknown }).value === "string");
  const tokens = [...new Set(rows.map(({ l }) => l.address))].slice(0, 8);
  const meta = new Map(await Promise.all(tokens.map(async (t) => [t, await tokenInfo(client, t as `0x${string}`).catch(() => null)] as const)));
  const moves: TokenMove[] = rows.filter(({ l }) => meta.get(l.address)?.decimals != null).map(({ l, dir }) => ({
    token: l.address, symbol: meta.get(l.address)!.symbol ?? "tokens", decimals: meta.get(l.address)!.decimals!, direction: dir, raw: String((l.args as { value: string }).value),
  }));
  const summary = summarizeActivity({ address, sentTxs: Math.max(0, nonce - watch.lastNonce), balanceDeltaWei: balance - BigInt(watch.lastBalanceWei), moves });
  const state = { lastBlock: range.to.toString(), lastNonce: nonce, lastBalanceWei: balance.toString() };
  if (!summary) {
    await updateWatch(watch.id, state);
    return false;
  }
  const newest = rows.map(({ l }) => l).sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)))[0];
  await pushAlert({
    agentId: watch.agentId, orgId: watch.orgId, source: "watch", refId: watch.id,
    title: `Activity on ${address.slice(0, 8)}…: ${summary}`.slice(0, 200),
    detail: `${address} on ${NETWORKS[watch.network].label}, blocks ${range.from}–${range.to}: ${summary}.${newest ? ` Latest transfer tx ${newest.tx}; inspect with eth_inspect_transaction.` : ""}${watch.note ? ` Your note: ${watch.note}` : ""}`,
    ...(newest ? { hash: newest.tx, explorerUrl: explorerUrl("tx", newest.tx, watch.network) } : {}),
  });
  await updateWatch(watch.id, { ...state, fireCount: watch.fireCount + 1, lastFiredAt: new Date().toISOString(), ...(watch.repeat ? {} : { status: "done" as const }) });
  return true;
}

/** New logs matching the watch's event (and address/args filters) since the last check. */
async function stepEventWatch(watch: Extract<Watch, { kind: "event" }>): Promise<boolean> {
  const client = clientFor(watch.network);
  const latest = await client.getBlockNumber();
  const range = scanRange(BigInt(watch.lastBlock), latest);
  if (!range) return false;
  const out = await getLogs(client, { address: watch.address, event: watch.event, args: watch.args, fromBlock: range.from.toString(), toBlock: range.to.toString(), limit: 5 });
  if (!out.total) {
    await updateWatch(watch.id, { lastBlock: range.to.toString() });
    return false;
  }
  const newest = out.logs[0];
  const name = watch.event.split("(")[0];
  await pushAlert({
    agentId: watch.agentId, orgId: watch.orgId, source: "watch", refId: watch.id,
    title: `${out.total} new ${name} event${out.total === 1 ? "" : "s"}${watch.address ? ` on ${watch.address.slice(0, 8)}…` : ""}`,
    detail: `${NETWORKS[watch.network].label}, blocks ${range.from}–${range.to}. Newest: ${JSON.stringify(newest.args ?? newest).slice(0, 300)} in tx ${newest.tx}. Query more with eth_logs.${watch.note ? ` Your note: ${watch.note}` : ""}`,
    hash: newest.tx, explorerUrl: explorerUrl("tx", newest.tx, watch.network),
  });
  await updateWatch(watch.id, { lastBlock: range.to.toString(), fireCount: watch.fireCount + 1, lastFiredAt: new Date().toISOString(), ...(watch.repeat ? {} : { status: "done" as const }) });
  return true;
}

/**
 * One minute of the hub working for Ethereum agents that aren't running:
 * fills standing orders whose trigger fired, fires watches, and confirms
 * payment requests. A Firestore lock makes overlapping calls a no-op.
 */
export async function runEthTick(now = Date.now()) {
  const result = { orders: 0, filled: 0, failed: 0, expired: 0, watches: 0, alerts: 0, payments: 0, paid: 0, errors: 0, locked: false };
  const holder = `tick-${now}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await acquireEthTickLock(holder, 50_000, now))) return { ...result, locked: true };
  const started = Date.now();
  const inBudget = () => Date.now() - started < TICK_BUDGET_MS;
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) { result.errors++; console.error(`[eth-tick] ${what}:`, (err as Error).message); }
  };
  try {
    const [orders, watches, payments] = await Promise.all([openOrders(), activeWatches(), pendingPaymentRequests()]);
    result.orders = orders.length;
    result.watches = watches.length;
    result.payments = payments.length;
    const prices = await priceMap([
      ...orders.map((o) => o.trigger.token),
      ...watches.flatMap((w) => (w.kind === "price" ? [w.trigger.token] : [])),
    ]);

    for (const order of orders) {
      if (!inBudget()) break;
      await safe(`order ${order.id}`, async () => {
        if (isExpired(order.expiresAt, now)) {
          await updateOrder(order.id, { status: "expired", closedAt: new Date(now).toISOString() });
          await pushAlert({ agentId: order.agentId, orgId: order.orgId, source: "order", refId: order.id, title: "Order expired unfilled", detail: `Waited for ${describeTrigger(order.trigger)} until ${order.expiresAt}.` });
          result.expired++;
          return;
        }
        const p = prices.get(order.trigger.token.toLowerCase());
        const check = checkTrigger(order.trigger, p?.usd ?? null);
        if (check.hit) {
          const out = await fillOrder({ ...order, trigger: check.next }, p!.usd!, p!.symbol);
          if (out === "filled") result.filled++;
          if (out === "failed") result.failed++;
          if (out !== "skipped") result.alerts++;
        } else if (check.changed) {
          await updateOrder(order.id, { trigger: check.next });
        }
      });
    }

    for (const watch of watches) {
      if (!inBudget()) break;
      await safe(`watch ${watch.id}`, async () => {
        if (isExpired(watch.expiresAt, now)) {
          await updateWatch(watch.id, { status: "expired" });
          return;
        }
        if (watch.kind === "activity") {
          if (await stepActivityWatch(watch)) result.alerts++;
          return;
        }
        if (watch.kind === "event") {
          if (await stepEventWatch(watch)) result.alerts++;
          return;
        }
        const p = prices.get(watch.trigger.token.toLowerCase());
        const step = stepPriceWatch(watch, p?.usd ?? null);
        if (step.fire) {
          await pushAlert({
            agentId: watch.agentId, orgId: watch.orgId, source: "watch", refId: watch.id,
            title: `Price alert: ${describeTrigger(watch.trigger, p?.symbol)}`,
            detail: `${p?.symbol ?? watch.trigger.token} is $${fmtUsd(p!.usd!)}.${watch.note ? ` Your note: ${watch.note}` : ""}`,
          });
          result.alerts++;
          await updateWatch(watch.id, { ...step.next, fireCount: watch.fireCount + 1, lastFiredAt: new Date(now).toISOString(), ...(watch.repeat ? {} : { status: "done" as const }) });
        } else if (step.changed) {
          await updateWatch(watch.id, { trigger: step.next.trigger, armed: step.next.armed });
        }
      });
    }

    // Native-ETH requests on one network read the same blocks; share them.
    const blockCaches = new Map<EthNetwork, Map<bigint, { hash: Hex; from: string; to: string | null; value: bigint }[]>>();
    for (const request of payments) {
      if (!inBudget()) break;
      await safe(`payment ${request.id}`, async () => {
        if (!blockCaches.has(request.network)) blockCaches.set(request.network, new Map());
        const checked = await checkPaymentRequest(request, blockCaches.get(request.network));
        if (checked.status === "paid") { result.paid++; result.alerts++; return; }
        if (isExpired(request.expiresAt, now)) {
          await updatePaymentRequest(request.id, { status: "expired" });
          await pushAlert({ agentId: request.agentId, orgId: request.orgId, source: "payment", refId: request.id, title: "Payment request expired unpaid", detail: `${request.amountUi} ${request.symbol} to ${request.recipient} on ${NETWORKS[request.network].label}.` });
        }
      });
    }
    return result;
  } finally {
    await releaseEthTickLock(holder).catch(() => {});
  }
}
