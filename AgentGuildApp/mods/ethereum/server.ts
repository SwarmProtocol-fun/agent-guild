import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { encodeDeployData, formatEther, type Abi, type PublicClient } from "viem";
import { getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { listAgentWallets } from "@/lib/agent-wallets";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import {
  ConfigError, DevtoolsInputError, addressHistory, buildCall, decodeCalldata, decodeRevert, gasOracle, holdings, inspectAddress,
  coerceArgs, inspectTransaction, networkStatus, parseAddress, parseEthAmount, parseHash, parseHexData, readContract, resolveEns, simulateCall,
  type CallSpec,
} from "./devtools";
import { ethUtil, getLogs, mappingSlot, multiRead, parseStateOverride, readStorage } from "./chaintools";
import { compileSolidity, contractAbi, parseSources, pickContract, verifyOnSourcify, type CompileResult } from "./solidity";
import {
  AccessError, CAP, DEV_WALLET_LABEL, activityFor, capabilityMap, clientFor, devBalances, enableAllUpgrades, ensureDevWallet,
  getDevWallet, logActivity, parseNetwork, requireCaller, resolveCaller, sendAsAgent, signAsAgent, transferAsAgent, type Caller, type SendResult,
} from "./agent";
import { NETWORKS, explorerUrl, type EthNetwork } from "./networks";
import { AGENT_TOOLS } from "./tools";
import { NATIVE, resolveToken, swapQuote, tokenPrices } from "./market";
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
async function resolveTarget(ctx: RouteContext, req: Request, value: string): Promise<`0x${string}`> {
  const v = decodeURIComponent(value).trim();
  if (v === "self") {
    const caller = await resolveCaller(ctx, query(req, "agentId"));
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
        ],
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
        const inputToken = resolveToken(b.inputToken, "inputToken");
        const outputToken = resolveToken(b.outputToken, "outputToken");
        const wallet = await getPaperWallet(caller.agentId, caller.orgId);
        const amount = paperAmount(wallet, inputToken, b.amount);
        const quote = await swapQuote({ inputToken, outputToken, amount, slippageBps: b.slippageBps != null ? Number(b.slippageBps) : undefined });
        if (quote.usdValue == null) throw new PaperTradeError("Couldn't price this swap in USD — try a more liquid token");
        const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 280) : null;
        try {
          const { trade, wallet: next } = await bookPaperTrade(caller.agentId, caller.orgId, {
            inputToken, outputToken, inRaw: BigInt(quote.inAmount), outRaw: BigInt(quote.outAmount),
            inDecimals: quote.inDecimals, outDecimals: quote.outDecimals, inSymbol: quote.inSymbol, outSymbol: quote.outSymbol,
            usdValue: quote.usdValue, gasUsd: quote.gasUsd ?? 1,
          }, { inUi: quote.inUi, outUi: quote.outUi, priceImpactPct: quote.priceImpactPct, route: quote.route, note });
          logActivity(caller, { action: "paper-swap", ok: true, summary: `${trade.inUi} ${trade.inSymbol ?? ""} → ${trade.outUi} ${trade.outSymbol ?? ""} ($${trade.usdValue.toFixed(2)}, gas $${trade.gasUsd.toFixed(2)})` });
          return { trade, portfolio: await valueWallet(next) };
        } catch (err) {
          if (err instanceof PaperTradeError) logActivity(caller, { action: "paper-swap", ok: false, summary: err.message.slice(0, 160) });
          throw err;
        }
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
        const address = await resolveTarget(ctx, req, String(b.address ?? ""));
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
  },
});

