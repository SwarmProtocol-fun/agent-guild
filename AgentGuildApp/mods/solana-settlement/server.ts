import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { settleOnChains, hashJobResult, getBalance, verifyReceipt } from "@/lib/settlement/registry";
import { agentAlreadyRegistered, getAgentSlashingHistoryOnChain, mintIdentityToken } from "@/lib/solana/platform";
import { getScoreEventHistoryForAsn } from "@/lib/solana/client";
import { getAgent, getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { getJob } from "@/lib/jobs-admin";
import { isPayable, parseUsdReward } from "@/lib/job-payouts";
import {
  claimSolanaSettlement, getSolanaSettlement, listSolanaSettlements, markSolanaSettlementPaid,
  releaseSolanaSettlementClaim, saveSolanaSettlement, solanaSettlementTotal,
  type SolanaSettlementRecord,
} from "@/lib/mods/solana-settlement-store";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  DevtoolsInputError, parsePubkey, clusterStatus, inspectAccount, inspectTransaction, fetchIdl,
  derivePda, decodeProgramError, parseErrorCode, priorityFees, rentExempt, explorerUrl, walletHoldings, addressHistory,
  type SeedSpec,
} from "./devtools";
import type { InstructionSpec } from "./txbuilder";
import {
  CAP, AccessError, SIGNING_CLUSTERS, ANCHOR_VERSIONS, parseCluster, connectionFor, rpcFor, requireCaller, resolveCaller, capabilityMap, hasCapability,
  logActivity, activityFor, getDevWallet, DEV_WALLET_LABEL, ensureDevWallet, sendAsAgent, simulateAsAgent, airdropToAgent,
  createTokenAsAgent, transferAsAgent, signExternalAsAgent, enqueueAnchorJob, enableAllUpgrades, getAnchorJob, anchorWorkersOnline, type ServerCluster, type Caller,
} from "./agent";
import { AGENT_TOOLS, HARNESS_ONLY } from "./tools";
import { SYMBOL_MINTS, resolveMint, swapQuote, tokenInfo, tokenPrices, toUi } from "./market";
import { PaperTradeError, normalizePolicy, transferPolicyViolation, valuePortfolio, type PaperWallet } from "./paper";
import { bookPaperTrade, getPaperWallet, getPolicy, listOrgPaperWallets, listPaperTrades, resetPaperWallet, setPolicy } from "./paper-store";
import { listAgentWallets } from "@/lib/agent-wallets";
import {
  checkTrigger, cleanNote, describeTrigger, expiryFrom, fmtUsd, isExpired, newReference, parseOrderAmount, parsePriceTrigger, parseSlippage,
  solanaPayUrl, stepPriceWatch, type PaymentRequest, type StandingOrder, type Watch,
} from "./automation";
import {
  acquireSolanaTickLock, activeWatches, cancelOrder, cancelWatch, claimOrder, createOrder, createPaymentRequest, createWatch,
  getPaymentRequest, listAlerts, listOrders, listPaymentRequests, listWatches, markAlertsRead, openOrders, pendingPaymentRequests,
  pushAlert, releaseSolanaTickLock, updateOrder, updatePaymentRequest, updateWatch,
} from "./automation-store";
import { assessToken, externalSignRefusal, findPayment, parseBase64Tx, previewExternalTx, readMintFacts } from "./chainchecks";

// ── Request helpers ──────────────────────────────────────────────────────

class NotFoundError extends Error {}

/** Maps thrown errors to statuses: auth/capability → its own, bad input → 400, not found → 404, everything else (RPC) → 502. */
function failure(err: unknown): Response {
  if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
  if (err instanceof AccessError) return Response.json({ error: err.message }, { status: err.status });
  const status = err instanceof DevtoolsInputError || err instanceof SyntaxError || err instanceof PaperTradeError ? 400 : 502;
  return Response.json({ error: (err as Error).message }, { status });
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

/**
 * Read-only chain tools. A browser session can use them freely (they read
 * public chain data); an agent needs the solana-dev-inspect upgrade, and
 * its reads land in its activity log so the operator can follow along.
 */
async function readTool<T extends object>(req: Request, ctx: RouteContext, describe: string, fn: (conn: Connection, cluster: ServerCluster) => Promise<T>): Promise<Response> {
  return handle(async () => {
    const cluster = parseCluster(query(req, "cluster"));
    let caller: Caller | null = null;
    if (ctx.agent) caller = await requireCaller(ctx, null, CAP.inspect);
    const result = await fn(connectionFor(cluster), cluster);
    if (caller) logActivity(caller, { action: "inspect", cluster, ok: true, summary: describe });
    return { cluster, ...result };
  });
}

/** "self" in an address slot means the calling agent's dev wallet. */
async function resolveSelf(ctx: RouteContext, req: Request, address: string): Promise<string> {
  if (address !== "self") return address;
  const caller = await resolveCaller(ctx, query(req, "agentId"));
  const wallet = await getDevWallet(caller);
  if (!wallet) throw new DevtoolsInputError("This agent has no dev wallet yet — create one first (solana_create_wallet)");
  return wallet.address;
}

function receiptOf(record: SolanaSettlementRecord) {
  return {
    chain: "solana" as const,
    txSig: record.txSig,
    receiptHash: record.resultHash,
    explorerUrl: record.explorerUrl,
    reputationUpdated: record.reputationUpdated,
  };
}

/** The signed agent settles for its own org. A wallet session sees every org it belongs to. */
async function callerOrgIds(ctx: RouteContext): Promise<string[]> {
  if (ctx.agent?.orgId) return [ctx.agent.orgId];
  if (!ctx.session?.address) return [];
  const orgs = await getOrganizationsByWalletAdmin(ctx.session.address);
  return orgs.map((org) => org.id);
}

// ── Paper trading helpers ────────────────────────────────────────────────

/** Marks a paper wallet to market with Jupiter prices (20 mints per call). */
async function valueWallet(wallet: PaperWallet) {
  const mints = Object.keys(wallet.holdings);
  const prices: Record<string, number | null> = {};
  const symbols: Record<string, string | null> = {};
  for (let i = 0; i < mints.length; i += 20) {
    for (const p of await tokenPrices(mints.slice(i, i + 20))) {
      prices[p.mint] = p.usdPrice;
      symbols[p.mint] = p.symbol;
    }
  }
  return valuePortfolio(wallet, prices, symbols);
}

/** "12.5", "all" or "25%" of the paper holding → a UI amount string. */
function paperAmount(wallet: PaperWallet, mint: string, amount: unknown): string {
  const text = String(amount ?? "").trim().toLowerCase();
  if (text !== "all" && text !== "max" && !text.endsWith("%")) return text;
  const h = wallet.holdings[mint];
  if (!h || BigInt(h.raw) === 0n) throw new PaperTradeError("The paper wallet holds none of the input token");
  const pct = text.endsWith("%") ? Number(text.slice(0, -1)) : 100;
  if (!(pct > 0 && pct <= 100)) throw new PaperTradeError("A percentage amount must be between 0 and 100%");
  const raw = (BigInt(h.raw) * BigInt(Math.round(pct * 100))) / 10_000n;
  if (raw <= 0n) throw new PaperTradeError("That share of the holding rounds to zero");
  return toUi(raw.toString(), h.decimals);
}

/**
 * One paper swap at the live Jupiter quote, booked against the owner's
 * policy. Shared by POST /paper/swap and standing orders filled by the tick.
 */
async function executePaperSwap(
  caller: Caller,
  p: { inputMint: string; outputMint: string; amount: unknown; slippageBps?: number; note: string | null; via?: string },
) {
  const inputMint = resolveMint(p.inputMint, "inputMint");
  const outputMint = resolveMint(p.outputMint, "outputMint");
  const wallet = await getPaperWallet(caller.agentId, caller.orgId);
  const amount = paperAmount(wallet, inputMint, p.amount);
  const quote = await swapQuote({ inputMint, outputMint, amount, slippageBps: p.slippageBps });
  if (quote.usdValue == null) throw new PaperTradeError("Couldn't price this swap in USD — try a more liquid token");
  const action = p.via ?? "paper-swap";
  try {
    const { trade, wallet: next } = await bookPaperTrade(caller.agentId, caller.orgId, {
      inputMint, outputMint, inRaw: BigInt(quote.inAmount), outRaw: BigInt(quote.outAmount),
      inDecimals: quote.inDecimals, outDecimals: quote.outDecimals, usdValue: quote.usdValue,
    }, {
      inSymbol: quote.inSymbol, outSymbol: quote.outSymbol, inUi: quote.inUi, outUi: quote.outUi,
      priceImpactPct: quote.priceImpactPct, route: quote.route, note: p.note,
    });
    logActivity(caller, { action, ok: true, summary: `${trade.inUi} ${trade.inSymbol ?? trade.inputMint.slice(0, 4)} → ${trade.outUi} ${trade.outSymbol ?? trade.outputMint.slice(0, 4)} ($${trade.usdValue.toFixed(2)})` });
    return { trade, portfolio: await valueWallet(next) };
  } catch (err) {
    if (err instanceof PaperTradeError) logActivity(caller, { action, ok: false, summary: err.message.slice(0, 160) });
    throw err;
  }
}

/** Org owner of `orgId`, from a browser session. */
async function requireOrgOwner(ctx: RouteContext, orgId: string): Promise<void> {
  if (!ctx.session) throw new AccessError("Sign in as the org owner", 401);
  const org = (await getOrganizationsByWalletAdmin(ctx.session.address)).find((o) => o.id === orgId);
  const isOwner = !!org?.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session.address);
  if (!isOwner) throw new AccessError("Only the org owner can change this", 403);
}

/** Refuses anything the agent's wallet would sign while its owner has paused it. */
async function assertNotPaused(caller: Caller): Promise<void> {
  if ((await getPolicy(caller.agentId, caller.orgId)).paused) throw new AccessError("Signing is paused for this agent by its org owner", 403);
}


// ── Payment requests ─────────────────────────────────────────────────────

const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** null = SOL. "USDC" means the cluster's USDC; other symbols are mainnet mints. */
function paymentMint(value: unknown, cluster: ServerCluster): string | null {
  if (value == null || value === "") return null;
  const v = String(value).trim();
  if (/^(SOL|WSOL)$/i.test(v)) return null;
  if (/^USDC$/i.test(v)) return cluster === "mainnet-beta" ? SYMBOL_MINTS.USDC : DEVNET_USDC;
  if (cluster !== "mainnet-beta" && SYMBOL_MINTS[v.toUpperCase()]) throw new DevtoolsInputError(`${v} is a mainnet symbol — pass the ${cluster} mint address`);
  return resolveMint(v);
}

/** A wallet the agent owns: "self"/omitted = dev wallet, else its identity or a custodial Solana wallet. */
async function ownSolanaWallet(caller: Caller, requested: unknown): Promise<string> {
  const dev = await getDevWallet(caller);
  if (requested == null || requested === "" || requested === "self") {
    if (!dev) throw new DevtoolsInputError("This agent has no dev wallet — create one (solana_create_wallet) or pass recipient");
    return dev.address;
  }
  const agent = await getAgent(caller.agentId);
  const custodial = (await listAgentWallets(caller.agentId)).filter((w) => w.chain === "solana" && w.orgId === caller.orgId).map((w) => w.publicKey);
  const own = [...(agent?.solanaAddress ? [agent.solanaAddress] : []), ...custodial];
  if (typeof requested !== "string" || !own.includes(requested)) throw new AccessError("recipient must be one of this agent's own Solana wallets", 403);
  return requested;
}

/** Checks a pending request on-chain; marks it paid (and alerts) when verified. */
async function checkPaymentRequest(request: PaymentRequest) {
  const verdict = await findPayment(connectionFor(request.cluster), {
    recipient: request.recipient, mint: request.mint, amount: request.amount, reference: request.reference, memo: request.memo,
  });
  if (!verdict.verified || !verdict.signature) return { request, verdict };
  const paid: PaymentRequest = { ...request, status: "paid", paidSignature: verdict.signature, payer: verdict.payer, paidAt: new Date().toISOString() };
  await updatePaymentRequest(request.id, { status: "paid", paidSignature: verdict.signature, payer: verdict.payer, paidAt: paid.paidAt });
  await pushAlert({
    agentId: request.agentId, orgId: request.orgId, source: "payment", refId: request.id,
    title: `Paid: ${verdict.received} ${request.mint ? "tokens" : "SOL"}${request.label ? ` for ${request.label}` : ""}`,
    detail: `${verdict.payer ?? "Someone"} paid ${verdict.received} ${request.mint ?? "SOL"} to ${request.recipient} on ${request.cluster}${verdict.finalized ? "" : " (confirmed, not yet finalized)"}.`,
    signature: verdict.signature, explorerUrl: explorerUrl("tx", verdict.signature, request.cluster),
  });
  return { request: paid, verdict };
}

// ── Settlement guards ────────────────────────────────────────────────────

/** Mainnet USDC. Paying it from the platform wallet is opt-in (SOLANA_SETTLEMENT_ALLOW_MAINNET=1). */
const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DEFAULT_MAX_SETTLE_USDC = 100;

function assertSettlementChainAllowed(): void {
  const mainnet = process.env.SOLANA_USDC_MINT === MAINNET_USDC_MINT || /mainnet/i.test(process.env.SOLANA_RPC_URL ?? "");
  if (mainnet && process.env.SOLANA_SETTLEMENT_ALLOW_MAINNET !== "1") {
    throw new AccessError("Platform-paid settlement is disabled on mainnet (set SOLANA_SETTLEMENT_ALLOW_MAINNET=1 to allow it)", 403);
  }
}

function maxSettleUsdc(): number {
  const n = Number(process.env.SOLANA_SETTLEMENT_MAX_USDC);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SETTLE_USDC;
}

/** The signed agent settles for itself; a session must own the agent's org. */
async function settleCaller(ctx: RouteContext, agentIdHint: unknown): Promise<{ agentId: string; orgId: string }> {
  if (ctx.agent) return { agentId: ctx.agent.agentId, orgId: ctx.agent.orgId };
  if (!ctx.session) throw new AccessError("Authentication required", 401);
  if (typeof agentIdHint !== "string" || !agentIdHint) throw new DevtoolsInputError("agentId is required for a browser session");
  const agent = await getAgent(agentIdHint);
  if (!agent) throw new NotFoundError("Agent not found");
  const org = (await getOrganizationsByWalletAdmin(ctx.session.address)).find((o) => o.id === agent.orgId);
  const isOwner = !!org?.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session.address);
  if (!isOwner) throw new AccessError("Only the owner of this agent's org can settle its jobs", 403);
  return { agentId: agentIdHint, orgId: agent.orgId };
}

/** The job behind a settlement and what it pays — from Firestore, not the request. */
async function payableJob(taskId: string, agentId: string, orgId: string) {
  const [job, agent] = await Promise.all([getJob(taskId), getAgent(agentId)]);
  if (!job || (job.orgId !== orgId && job.sellerOrgId !== orgId)) throw new NotFoundError(`No job ${taskId} in this org`);
  if (!agent) throw new NotFoundError("Agent not found");
  if (job.takenByAgentId !== agentId) throw new AccessError(`Job ${taskId} was not taken by agent ${agentId}`, 403);
  if (job.status !== "completed" || !isPayable(job)) {
    throw new AccessError(`Job ${taskId} isn't payable — it must be completed, approved by the poster, and not escrowed or prepaid`, 409);
  }
  const amount = parseUsdReward(job.reward);
  if (amount == null) throw new DevtoolsInputError(`Job ${taskId} has no dollar reward ("${job.reward ?? ""}") to settle in USDC`);
  if (amount > maxSettleUsdc()) throw new AccessError(`Job reward ${amount} USDC is over the ${maxSettleUsdc()} USDC settlement cap`, 403);
  return { job, amount, agent };
}

/** The recipient must be one of the agent's own Solana wallets; defaults to its identity wallet. */
async function settlementWallet(agentId: string, orgId: string, identity: string | undefined, requested: unknown): Promise<string> {
  const custodial = (await listAgentWallets(agentId)).filter((w) => w.chain === "solana" && w.orgId === orgId).map((w) => w.publicKey);
  const own = [...(identity ? [identity] : []), ...custodial];
  if (requested == null || requested === "") {
    if (!own.length) throw new DevtoolsInputError("This agent has no Solana wallet to pay — register its identity key or create a wallet");
    return own[0];
  }
  if (typeof requested !== "string" || !own.includes(requested)) {
    throw new AccessError("agentWallet must be one of this agent's own Solana wallets", 403);
  }
  return requested;
}

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("solana-settlement mod loaded");
  },

  routes: {
    /**
     * POST /settle — pays an agent in USDC from the platform's Solana
     * wallet for an approved job, with the job's receipt hash in a Memo.
     *
     * Everything that moves money comes from server records, never the
     * request: the job (taskId = a job id) must be completed, approved,
     * taken by this agent and not paid another way; the amount is the
     * job's dollar reward (capped by SOLANA_SETTLEMENT_MAX_USDC); the
     * recipient must be one of the agent's own Solana wallets; the credit
     * and trust scores written on-chain are the agent record's.
     *
     * Callers: the job's agent (signed), or the owner of that agent's org
     * from a browser session.
     *
     * Body: { taskId, agentWallet?, agentId? (session only), amountUsdc? (must
     *         match the reward if sent), exitCode?, executionTimeMs?, stdout? }
     */
    "POST /settle": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const taskId = typeof b.taskId === "string" ? b.taskId.trim() : "";
        if (!taskId) throw new DevtoolsInputError("taskId (the job id) is required");

        const { agentId, orgId } = await settleCaller(ctx, b.agentId);
        if (!(await hasCapability(agentId, orgId, CAP.settle))) {
          throw new AccessError(`Agent ${agentId} doesn't have the "${CAP.settle}" capability`, 403);
        }
        assertSettlementChainAllowed();

        const { job, amount, agent } = await payableJob(taskId, agentId, orgId);
        if (b.amountUsdc != null && Number(b.amountUsdc) !== amount) {
          throw new DevtoolsInputError(`amountUsdc ${b.amountUsdc} doesn't match job ${taskId}'s reward of ${amount} USDC`);
        }
        const agentWallet = await settlementWallet(agentId, orgId, agent.solanaAddress, b.agentWallet);

        // Claim the task before paying. A retry finds the claim and returns
        // the first receipt instead of sending a second USDC transfer.
        const claim = await claimSolanaSettlement(agentId, taskId, orgId);
        if (claim.state === "conflict") return Response.json({ error: "Task already settled for another org" }, { status: 409 });
        if (claim.state === "pending") return Response.json({ error: "Settlement already in progress for this task" }, { status: 409 });
        if (claim.state === "done") return { receipt: receiptOf(claim.record), replayed: true, persisted: true };

        const resultHash = hashJobResult({
          taskId, exitCode: Number(b.exitCode ?? 0), executionTimeMs: Number(b.executionTimeMs ?? 0),
          stdout: typeof b.stdout === "string" ? b.stdout : job.deliveryNotes,
        });

        let settled: Awaited<ReturnType<typeof settleOnChains>>;
        try {
          settled = await settleOnChains(["solana"], {
            agentId, agentWallet, taskId, resultHash, amountUsdc: amount,
            creditScore: agent.creditScore ?? 680,
            trustScore: agent.trustScore ?? 50,
          });
        } catch (err) {
          await releaseSolanaSettlementClaim(agentId, taskId).catch(() => {});
          throw err;
        }

        const { receipts, errors } = settled;
        if (receipts.length === 0) {
          await releaseSolanaSettlementClaim(agentId, taskId).catch(() => {});
          return Response.json({ error: "Settlement failed", details: errors }, { status: 502 });
        }

        const receipt = receipts[0];
        const record: SolanaSettlementRecord = {
          orgId, agentId, taskId, txSig: receipt.txSig, explorerUrl: receipt.explorerUrl,
          amountUsdc: amount, resultHash: receipt.receiptHash, reputationUpdated: Boolean(receipt.reputationUpdated),
          at: new Date().toISOString(),
        };
        try {
          await saveSolanaSettlement(record);
        } catch (err) {
          // The transfer already landed. Pin the sig on the claim so a retry
          // returns this receipt and does not pay again.
          await markSolanaSettlementPaid(record).catch(() => {});
          return { receipt, amountUsdc: amount, agentWallet, persisted: false, error: (err as Error).message };
        }
        return { receipt, amountUsdc: amount, agentWallet, persisted: true };
      }),

    /** GET /history — this caller's orgs only. Rows survive a process restart. */
    "GET /history": async (_req, ctx) => ({ history: await listSolanaSettlements(await callerOrgIds(ctx)) }),

    /** GET /agent/:agentId/total — lifetime USDC earned by one agent on Solana. */
    "GET /agent/:agentId/total": async (_req, ctx) => {
      const orgIds = await callerOrgIds(ctx);
      const agentId = ctx.params.agentId;
      if (!orgIds.length) return Response.json({ error: "No org for this caller" }, { status: 403 });
      const totals = await Promise.all(orgIds.map((orgId) => solanaSettlementTotal(orgId, agentId)));
      return Response.json({
        agentId,
        totalUsdc: totals.reduce((sum, row) => sum + row.totalUsdc, 0),
        settlementCount: totals.reduce((sum, row) => sum + row.settlementCount, 0),
      });
    },

    /** GET /balance/:wallet — live USDC balance, no signing key needed. */
    "GET /balance/:wallet": async (_req, { params }) => {
      try {
        return Response.json(await getBalance("solana", params.wallet));
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /**
     * GET /verify/:txSig — re-reads the transaction from Solana and checks
     * the memo actually carries the receipt hash this mod recorded, instead
     * of trusting what /settle returned at the time.
     */
    "GET /verify/:txSig": async (_req, ctx) => {
      const record = await getSolanaSettlement(ctx.params.txSig);
      const orgIds = await callerOrgIds(ctx);
      if (!record || !orgIds.includes(record.orgId)) {
        return Response.json({ error: "No local record of this tx" }, { status: 404 });
      }
      try {
        const result = await verifyReceipt("solana", ctx.params.txSig, record.resultHash);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /**
     * GET /registered/:wallet — whether this wallet has an on-chain
     * AgentAccount PDA yet. `/settle`'s reputation update silently no-ops
     * for an unregistered wallet, so this is what the panel checks to
     * explain a settlement that shows `reputationUpdated: false`.
     */
    "GET /registered/:wallet": async (_req, { params }) => {
      return Response.json({ registered: await agentAlreadyRegistered(params.wallet) });
    },

    /** GET /slashing/:asn — approved penalty proposals against this ASN (the on-chain slashing history). */
    "GET /slashing/:asn": async (_req, { params }) => {
      return Response.json({ history: await getAgentSlashingHistoryOnChain(params.asn) });
    },

    /**
     * GET /events/:asn — the ASN's on-chain score-event memo timeline
     * (oldest first), the same feed the core credit explainer reads.
     */
    "GET /events/:asn": async (_req, { params }) => {
      try {
        const events = await getScoreEventHistoryForAsn(params.asn);
        return Response.json({ events });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /**
     * POST /identity/mint — mints a soulbound (frozen SPL) identity token
     * for an agent wallet. Platform-admin only: this is an irreversible,
     * fee-paying on-chain action, not something any signed-in operator
     * should be able to trigger for an arbitrary wallet.
     *
     * Body: { agentAddress }
     */
    "POST /identity/mint": async (req, ctx) => {
      if (ctx.session?.role !== "platform_admin") {
        return Response.json({ error: "platform_admin session required" }, { status: 403 });
      }
      const { agentAddress } = await req.json();
      if (!agentAddress) {
        return Response.json({ error: "agentAddress is required" }, { status: 400 });
      }
      const { mint } = await mintIdentityToken(agentAddress);
      if (!mint) {
        return Response.json({ error: "Mint failed — check SOLANA_PLATFORM_KEYPAIR is configured" }, { status: 502 });
      }
      return Response.json({ mint });
    },

    // ── Agent upgrade: discovery ────────────────────────────────────────

    /** GET /agent/tools — LLM tool definitions for every agent-facing route. Public: describes routes, grants nothing. */
    "GET /agent/tools": {
      public: true,
      handler: () => Response.json({
        mod: "solana-settlement",
        basePath: "/api/mods/solana-settlement",
        auth: "Authorization: Bearer agt_… (mods:call scope), Ed25519 agent/sig/ts, or agentId/apiKey",
        notes: [
          "Every tool takes an optional cluster: devnet (default), testnet, or mainnet-beta.",
          "Signing tools (send, airdrop, create_token, anchor deploy) only work on devnet/testnet with the agent's own solana-dev wallet.",
          "Addresses accept placeholders: \"payer\"/\"self\" = the agent's dev wallet, \"new:<label>\" = a fresh keypair that signs its own creation.",
          "Start every session with solana_alerts: the hub keeps working while you're offline and leaves its results there.",
        ],
        harness: HARNESS_ONLY,
        tools: AGENT_TOOLS,
      }),
    },

    /** GET /me — which Solana upgrades this agent has, its dev wallet + balance, and whether an Anchor sandbox worker is online. */
    "GET /me": (req, ctx) =>
      handle(async () => {
        const agentId = ctx.agent?.agentId ?? query(req, "agentId");
        if (!agentId) throw new DevtoolsInputError("agentId query param is required for a browser session");
        // No capability required: an agent with none should still learn what it could be granted.
        const caller = await resolveCaller(ctx, agentId);
        const [capabilities, wallet, workers, unread] = await Promise.all([
          capabilityMap(caller.agentId, caller.orgId),
          getDevWallet(caller),
          anchorWorkersOnline(caller.orgId).catch(() => 0),
          listAlerts(caller.agentId, caller.orgId, { unreadOnly: true, limit: 200 }).then((a) => a.length).catch(() => null),
        ]);
        let balances: Record<string, number | null> | null = null;
        if (wallet) {
          const pk = new PublicKey(wallet.address);
          const read = (c: ServerCluster) => connectionFor(c).getBalance(pk).then((l) => l / LAMPORTS_PER_SOL).catch(() => null);
          balances = Object.fromEntries(await Promise.all(SIGNING_CLUSTERS.map(async (c) => [c, await read(c)] as const)));
        }
        return {
          agentId: caller.agentId,
          orgId: caller.orgId,
          via: caller.via,
          capabilities,
          devWallet: wallet ? { address: wallet.address, balances } : null,
          anchor: { workersOnline: workers, versions: ANCHOR_VERSIONS },
          unreadAlerts: unread,
        };
      }),

    /** GET /my-agents — the signed-in operator's agents, with each one's Solana upgrades, dev wallet and every Solana wallet it has. Session only. */
    "GET /my-agents": (_req, ctx) =>
      handle(async () => {
        if (!ctx.session) throw new AccessError("Sign in to list your agents", 401);
        const orgs = await getOrganizationsByWalletAdmin(ctx.session.address);
        const perOrg = await Promise.all(orgs.map(async (org) => {
          const agents = await getAgentsByOrg(org.id);
          return Promise.all(agents.map(async (agent) => {
            // One agent's lookup failing must not hide every agent from the picker.
            const [capabilities, custodial] = await Promise.all([
              capabilityMap(agent.id, org.id).catch((err) => {
                console.warn(`[solana] capabilities for ${agent.id} failed:`, err);
                return {} as Awaited<ReturnType<typeof capabilityMap>>;
              }),
              listAgentWallets(agent.id).catch(() => []),
            ]);
            const solanaCustodial = custodial.filter((w) => w.chain === "solana" && w.orgId === org.id);
            const devWallet = solanaCustodial.find((w) => w.label === DEV_WALLET_LABEL)?.publicKey ?? null;
            // Every Solana wallet the agent has: its own identity wallet first, then custodial ones, oldest first.
            const wallets = [
              ...(agent.solanaAddress ? [{ address: agent.solanaAddress, label: "Identity wallet", custodial: false }] : []),
              ...solanaCustodial.map((w) => ({ address: w.publicKey, label: w.label === DEV_WALLET_LABEL ? "Dev wallet" : w.label ?? null, custodial: true })),
            ];
            const isOwner = !!org.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session!.address);
            return { agentId: agent.id, name: agent.name, orgId: org.id, orgName: org.name || org.id, isOwner, capabilities, devWallet, wallets };
          }));
        }));
        return { agents: perOrg.flat() };
      }),

    /**
     * POST /upgrade — enable every Solana upgrade on the org's install of
     * this mod. Org owner only, like installing a mod. Body: { orgId }
     */
    "POST /upgrade": (req, ctx) =>
      handle(async () => {
        if (!ctx.session) throw new AccessError("Sign in as the org owner", 401);
        const { orgId } = await body(req);
        const orgs = await getOrganizationsByWalletAdmin(ctx.session.address);
        const org = orgs.find((o) => o.id === orgId);
        const isOwner = !!org?.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session.address);
        if (!isOwner) throw new AccessError("Only the org owner can enable upgrades", 403);
        const out = await enableAllUpgrades(orgId as string);
        if (!out.installed) throw new NotFoundError("This org hasn't installed the Solana mod — install it from the Market first");
        return out;
      }),

    /** GET /activity — what this agent has done with the mod (newest first). */
    "GET /activity": (req, ctx) =>
      handle(async () => {
        const agentId = ctx.agent?.agentId ?? query(req, "agentId");
        if (!agentId) throw new DevtoolsInputError("agentId query param is required for a browser session");
        const caller = await resolveCaller(ctx, agentId);
        return { activity: await activityFor(caller.agentId, caller.orgId) };
      }),

    // ── Read & debug (every route takes ?cluster=devnet|testnet|mainnet-beta) ──

    /** GET /dev/status — node version, slot, epoch progress, recent TPS. */
    "GET /dev/status": (req, ctx) => readTool(req, ctx, "cluster status", async (conn) => ({ status: await clusterStatus(conn) })),

    /**
     * GET /dev/account/:address — balance, owner, rent status, jsonParsed
     * data, upgradeable-program metadata; `?decode=1` also fetches the
     * owner's Anchor IDL and decodes the account by discriminator.
     */
    "GET /dev/account/:address": (req, ctx) =>
      readTool(req, ctx, `account ${ctx.params.address}`, async (conn, cluster) => {
        const account = await inspectAccount(conn, ctx.params.address, { decodeAnchor: query(req, "decode") === "1" });
        return { account, explorerUrl: explorerUrl("address", account.address, cluster) };
      }),

    /** GET /dev/tx/:signature — status, CU, fee, logs, balance deltas, decoded program error. */
    "GET /dev/tx/:signature": (req, ctx) =>
      readTool(req, ctx, `tx ${ctx.params.signature.slice(0, 16)}…`, async (conn, cluster) => ({
        tx: await inspectTransaction(conn, ctx.params.signature),
        explorerUrl: explorerUrl("tx", ctx.params.signature.trim(), cluster),
      })),

    /** GET /dev/idl/:programId — the program's on-chain Anchor IDL, or 404. */
    "GET /dev/idl/:programId": (req, ctx) =>
      readTool(req, ctx, `IDL ${ctx.params.programId}`, async (conn) => {
        const idl = await fetchIdl(conn, ctx.params.programId);
        if (!idl) throw new NotFoundError("No Anchor IDL published for this program on this cluster");
        return { idl };
      }),

    /** POST /dev/pda — Body: { programId, seeds: [{ type, value }] }. Pure derivation, no RPC. */
    "POST /dev/pda": (req, ctx) =>
      handle(async () => {
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const { programId, seeds } = (await body(req)) as { programId?: string; seeds?: SeedSpec[] };
        if (!programId || !Array.isArray(seeds)) throw new DevtoolsInputError("programId and seeds[] are required");
        const out = derivePda(programId, seeds);
        if (caller) logActivity(caller, { action: "derive-pda", ok: true, summary: `PDA ${out.address}` });
        return out;
      }),

    /**
     * GET /dev/error/:code — decode a program error ("6001", "0x1771").
     * `?programId=` picks System/Token tables or fetches that program's IDL.
     */
    "GET /dev/error/:code": (req, ctx) =>
      readTool(req, ctx, `error ${ctx.params.code}`, async (conn) => {
        const code = parseErrorCode(ctx.params.code);
        const programId = query(req, "programId");
        const idl = programId && code >= 6000 ? await fetchIdl(conn, programId).catch(() => null) : null;
        // `decoded`, not `error` — every failure response uses the `error` key.
        return { decoded: decodeProgramError(code, programId, idl) };
      }),

    /** GET /dev/fees — recent priority fees (µ-lamports/CU); `?accounts=a,b` scopes to writable accounts. */
    "GET /dev/fees": (req, ctx) =>
      readTool(req, ctx, "priority fees", async (conn) => {
        const accounts = (query(req, "accounts") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
        return { fees: await priorityFees(conn, accounts) };
      }),

    /** GET /dev/rent/:bytes — rent-exempt minimum for an account of this size. */
    "GET /dev/rent/:bytes": (req, ctx) =>
      readTool(req, ctx, `rent for ${ctx.params.bytes} bytes`, async (conn) => ({ rent: await rentExempt(conn, Number(ctx.params.bytes)) })),

    /** GET /dev/holdings/:address — SOL plus every non-empty SPL/Token-2022 balance. `self` = the agent's dev wallet. */
    "GET /dev/holdings/:address": (req, ctx) =>
      readTool(req, ctx, `holdings ${ctx.params.address}`, async (conn, cluster) => {
        const holdings = await walletHoldings(conn, await resolveSelf(ctx, req, ctx.params.address));
        return { holdings: { ...holdings, sol: holdings.lamports / LAMPORTS_PER_SOL }, explorerUrl: explorerUrl("address", holdings.address, cluster) };
      }),

    /** GET /dev/history/:address — recent transactions, newest first. ?limit=1–100&before=<signature> pages back. */
    "GET /dev/history/:address": (req, ctx) =>
      readTool(req, ctx, `history ${ctx.params.address}`, async (conn) => {
        const address = await resolveSelf(ctx, req, ctx.params.address);
        const limit = query(req, "limit");
        const history = await addressHistory(conn, address, { limit: limit ? Number(limit) : undefined, before: query(req, "before") ?? undefined });
        return { address, history, nextBefore: history.at(-1)?.signature ?? null };
      }),

    // ── Market data (mainnet, read-only, via Jupiter) ──────────────────

    /** GET /market/price?mints=SOL,USDC,<mint> — USD prices and 24h change. */
    "GET /market/price": (req, ctx) =>
      handle(async () => {
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const mints = (query(req, "mints") ?? "").split(",").map((m) => m.trim()).filter(Boolean);
        const prices = await tokenPrices(mints);
        if (caller) logActivity(caller, { action: "price", ok: true, summary: prices.map((p) => `${p.symbol ?? p.mint.slice(0, 6)} $${p.usdPrice ?? "?"}`).join(", ").slice(0, 160) });
        return { prices };
      }),

    /** GET /market/quote?inputMint=SOL&outputMint=USDC&amount=1.5&slippageBps=50 — best mainnet swap route. Quote only; nothing is signed. */
    "GET /market/quote": (req, ctx) =>
      handle(async () => {
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const [inputMint, outputMint, amount] = ["inputMint", "outputMint", "amount"].map((k) => query(req, k));
        if (!inputMint || !outputMint || !amount) throw new DevtoolsInputError("inputMint, outputMint and amount are required");
        const slippage = query(req, "slippageBps");
        const quote = await swapQuote({ inputMint, outputMint, amount, slippageBps: slippage ? Number(slippage) : undefined });
        if (caller) logActivity(caller, { action: "quote", ok: true, summary: `${quote.inUi} → ${quote.outUi} via ${quote.route.join(" › ") || "?"}` });
        return { quote };
      }),

    // ── Paper trading (live Jupiter quotes, virtual wallet) ─────────────

    /** GET /paper — the agent's paper wallet marked to market: equity, P&L, holdings. */
    "GET /paper": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        const wallet = await getPaperWallet(caller.agentId, caller.orgId);
        const [portfolio, policy] = await Promise.all([valueWallet(wallet), getPolicy(caller.agentId, caller.orgId)]);
        const today = new Date().toISOString().slice(0, 10);
        return { portfolio, policy, volumeTodayUsd: wallet.volumeDay === today ? wallet.volumeToday : 0, since: wallet.resetAt ?? wallet.createdAt };
      }),

    /**
     * POST /paper/swap — swap at the live Jupiter quote in the paper wallet.
     * Body: { agentId?, inputMint, outputMint, amount ("1.5" | "all" | "25%"), slippageBps?, note? }
     */
    "POST /paper/swap": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.trade);
        if (typeof b.inputMint !== "string" || typeof b.outputMint !== "string") throw new DevtoolsInputError("inputMint and outputMint are required");
        return executePaperSwap(caller, {
          inputMint: b.inputMint, outputMint: b.outputMint, amount: b.amount,
          slippageBps: b.slippageBps != null ? Number(b.slippageBps) : undefined, note: cleanNote(b.note),
        });
      }),

    /** GET /paper/trades — this paper wallet's fills since its last reset, newest first. ?limit=1–200 */
    "GET /paper/trades": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        const limit = Math.min(Math.max(Number(query(req, "limit") ?? 50) || 50, 1), 200);
        const [trades, wallet] = await Promise.all([listPaperTrades(caller.agentId, caller.orgId, limit), getPaperWallet(caller.agentId, caller.orgId)]);
        const since = wallet.resetAt ?? "";
        return { trades: trades.filter((t) => t.at >= since) };
      }),

    /** POST /paper/reset — back to 10,000 USDC. Org owner only, so an agent can't wipe its own record. Body: { agentId } */
    "POST /paper/reset": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await resolveCaller(ctx, b.agentId as string);
        await requireOrgOwner(ctx, caller.orgId);
        const wallet = await resetPaperWallet(caller.agentId, caller.orgId);
        logActivity(caller, { action: "paper-reset", ok: true, summary: `paper wallet reset to $${wallet.startUsd.toLocaleString()}` });
        return { portfolio: await valueWallet(wallet) };
      }),

    /** GET /paper/leaderboard — every paper wallet in the caller's org(s), ranked by return. */
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

    // ── Policy (owner-set limits per agent) ─────────────────────────────

    /** GET /policy — this agent's limits: pause, trade size, daily volume, allowed tokens, transfer allowlist. */
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
        const isAddress = (v: string) => { try { return !!new PublicKey(v); } catch { return false; } };
        const { agentId: _a, ...fields } = b;
        const mints = Array.isArray(fields.allowedMints) ? fields.allowedMints.map((m) => { try { return resolveMint(String(m)); } catch { return String(m); } }) : undefined;
        const policy = normalizePolicy({ ...fields, ...(mints ? { allowedMints: mints } : {}) }, await getPolicy(caller.agentId, caller.orgId), isAddress);
        await setPolicy(caller.agentId, caller.orgId, policy, ctx.session!.address);
        logActivity(caller, { action: "policy", ok: true, summary: policy.paused ? "paused by owner" : "limits updated by owner" });
        return { policy };
      }),

    // ── Build & simulate ────────────────────────────────────────────────

    /**
     * POST /dev/simulate — build a transaction from instruction specs (Anchor
     * by name + JSON args, raw, or transfer) and simulate it without signing.
     * Body: { agentId?, cluster?, instructions, computeUnitLimit?, priorityFee?, feePayer? }
     * Returns logs, CU used, decoded error, and the unsigned tx (base64).
     */
    "POST /dev/simulate": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.simulate);
        const cluster = parseCluster(b.cluster);
        const sim = await simulateAsAgent(caller, cluster, b.instructions as InstructionSpec[], {
          computeUnitLimit: b.computeUnitLimit as number | undefined, priorityFee: b.priorityFee as number | undefined,
        }, b.feePayer as string | undefined);
        logActivity(caller, {
          action: "simulate", cluster, ok: sim.success,
          summary: sim.success ? `${sim.instructionCount} ix · ${sim.unitsConsumed ?? "?"} CU` : `failed: ${sim.error?.name ?? JSON.stringify(sim.err)}`,
        });
        return { cluster, simulation: sim };
      }),

    // ── Act on devnet (agent's own solana-dev wallet) ───────────────────

    /** POST /dev/wallet — create (or return) this agent's devnet wallet. Body: { agentId? } */
    "POST /dev/wallet": (req, ctx) =>
      handle(async () => {
        const b = await body(req).catch(() => ({} as Record<string, unknown>));
        const caller = await requireCaller(ctx, b.agentId as string, CAP.devnet);
        const createdBy = ctx.session?.address ?? `agent:${caller.agentId}`;
        const wallet = await ensureDevWallet(caller, createdBy);
        if (wallet.created) logActivity(caller, { action: "create-wallet", ok: true, summary: `dev wallet ${wallet.address}` });
        return { address: wallet.address, created: wallet.created };
      }),

    /** POST /dev/airdrop — Body: { agentId?, cluster?, sol } — faucet SOL to the agent's dev wallet. */
    "POST /dev/airdrop": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.devnet);
        const cluster = parseCluster(b.cluster);
        try {
          const out = await airdropToAgent(caller, cluster, Number(b.sol ?? 1));
          logActivity(caller, { action: "airdrop", cluster, ok: true, summary: `+${b.sol ?? 1} SOL`, signature: out.signature, explorerUrl: out.explorerUrl });
          return { cluster, ...out };
        } catch (err) {
          const msg = (err as Error).message;
          if (err instanceof DevtoolsInputError) throw err;
          logActivity(caller, { action: "airdrop", cluster, ok: false, summary: msg.slice(0, 160) });
          // Faucets rate-limit per IP and every agent shares this server's.
          return Response.json({ error: /429|limit/i.test(msg) ? `Faucet rate-limited — fund ${(await getDevWallet(caller))?.address} at faucet.solana.com` : msg }, { status: 502 });
        }
      }),

    /**
     * POST /dev/send — simulate, then sign with the agent's dev wallet (plus
     * any new:<label> signers) and send. devnet/testnet only.
     * Body: { agentId?, cluster?, instructions, computeUnitLimit?, priorityFee? }
     */
    "POST /dev/send": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.devnet);
        const cluster = parseCluster(b.cluster);
        await assertNotPaused(caller);
        const result = await sendAsAgent(caller, cluster, b.instructions as InstructionSpec[], {
          computeUnitLimit: b.computeUnitLimit as number | undefined, priorityFee: b.priorityFee as number | undefined,
        });
        logActivity(caller, {
          action: "send", cluster, ok: result.success,
          summary: result.success ? `${result.unitsConsumed ?? "?"} CU` : `${result.signature ? "failed" : "rejected in simulation"}: ${result.error?.name ?? "unknown error"}`,
          ...(result.signature ? { signature: result.signature, explorerUrl: result.explorerUrl } : {}),
        });
        return { cluster, ...result };
      }),

    /** POST /dev/transfer — send SOL or a token from the agent's dev wallet. Body: { agentId?, cluster?, to, amount (UI units), mint? } */
    "POST /dev/transfer": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.devnet);
        const cluster = parseCluster(b.cluster);
        if (typeof b.to !== "string" || b.amount == null) throw new DevtoolsInputError("to and amount are required");
        const mint = (b.mint as string | undefined) || null;
        const violation = transferPolicyViolation(await getPolicy(caller.agentId, caller.orgId), { to: b.to.trim(), sol: mint ? null : Number(b.amount) });
        if (violation) throw new AccessError(violation, 403);
        const out = await transferAsAgent(caller, cluster, { to: b.to, amount: b.amount as string | number, mint });
        logActivity(caller, {
          action: "transfer", cluster, ok: true, signature: out.signature, explorerUrl: out.explorerUrl,
          summary: `${out.amountUi} ${out.mint ? out.mint.slice(0, 6) + "…" : "SOL"} → ${out.to.slice(0, 6)}…`,
        });
        return { cluster, ...out };
      }),

    /** POST /dev/token — create an SPL mint owned by the agent; optionally mint to itself. Body: { agentId?, cluster?, decimals?, mintAmount? } */
    "POST /dev/token": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.devnet);
        const cluster = parseCluster(b.cluster);
        await assertNotPaused(caller);
        const out = await createTokenAsAgent(caller, cluster, { decimals: b.decimals as number | undefined, mintAmount: b.mintAmount as string | undefined });
        logActivity(caller, { action: "create-token", cluster, ok: true, summary: `mint ${out.mint}`, explorerUrl: out.explorerUrl });
        return { cluster, ...out };
      }),

    // ── Anchor sandbox (GatewayAgent "solana-anchor" task) ──────────────

    /**
     * POST /dev/anchor — build, test or deploy an Anchor project in a
     * sandboxed container on a GatewayAgent worker. Returns a taskId to poll.
     * Body: { agentId?, action: "build"|"test"|"deploy", files: { path: contents }, anchorVersion?, cluster? }
     */
    "POST /dev/anchor": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.anchor);
        const action = b.action as "build" | "test" | "deploy";
        // Deploying signs with the agent's dev wallet, so it needs the devnet upgrade too.
        if (action === "deploy") {
          await requireCaller(ctx, b.agentId as string, CAP.devnet);
          await assertNotPaused(caller);
        }
        const cluster = b.cluster != null ? parseCluster(b.cluster) : undefined;
        const out = await enqueueAnchorJob(caller, { action, files: b.files as Record<string, string>, anchorVersion: b.anchorVersion as string | undefined, cluster });
        logActivity(caller, { action: `anchor-${action}`, ...(cluster ? { cluster } : {}), ok: true, summary: `queued (${out.workersOnline} worker${out.workersOnline === 1 ? "" : "s"} online)`, taskId: out.taskId });
        return {
          ...out,
          ...(out.workersOnline === 0 ? { warning: "No GatewayAgent worker with the solana-anchor runtime is online for this org — the job will wait in the queue until one registers." } : {}),
        };
      }),

    /** GET /dev/anchor/:taskId — status and result (IDL, program ids, .so sizes, log tail) of an Anchor job. */
    "GET /dev/anchor/:taskId": (req, ctx) =>
      handle(async () => {
        const caller = await requireCaller(ctx, query(req, "agentId"), CAP.anchor);
        const job = await getAnchorJob(caller, ctx.params.taskId);
        if (!job) throw new NotFoundError("Anchor job not found");
        return job;
      }),

    // ── Runs while the agent is offline (filled by runSolanaTick) ───────

    /**
     * POST /orders — a standing paper order: when `trigger` fires, swap
     * `amount` of inputMint into outputMint at the live quote.
     * Body: { agentId?, inputMint, outputMint, amount, trigger: { mint, op: above|below|trail, usd | trailPct }, ttlDays?, slippageBps?, note? }
     */
    "POST /orders": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.trade);
        if ((await getPolicy(caller.agentId, caller.orgId)).paused) throw new AccessError("Trading is paused for this agent by its org owner", 403);
        if (typeof b.inputMint !== "string" || typeof b.outputMint !== "string") throw new DevtoolsInputError("inputMint and outputMint are required");
        const inputMint = resolveMint(b.inputMint, "inputMint");
        const outputMint = resolveMint(b.outputMint, "outputMint");
        if (inputMint === outputMint) throw new DevtoolsInputError("inputMint and outputMint are the same token");
        const trigger = parsePriceTrigger(b.trigger, (v) => resolveMint(v, "trigger.mint"));
        const [price] = await tokenPrices([trigger.mint]);
        if (price.usdPrice == null) throw new DevtoolsInputError(`Jupiter has no price for ${trigger.mint}, so the trigger could never fire`);
        const order = await createOrder({
          agentId: caller.agentId, orgId: caller.orgId, status: "open", createdAt: new Date().toISOString(), expiresAt: expiryFrom(b.ttlDays),
          inputMint, outputMint, amount: parseOrderAmount(b.amount), slippageBps: parseSlippage(b.slippageBps),
          trigger: trigger.op === "trail" ? { ...trigger, peakUsd: price.usdPrice } : trigger, note: cleanNote(b.note),
        });
        const desc = describeTrigger(order.trigger, price.symbol);
        logActivity(caller, { action: "order", ok: true, summary: `when ${desc}: ${order.amount} ${b.inputMint} → ${b.outputMint}` });
        return { order, currentPriceUsd: price.usdPrice, fires: `when ${desc}`, note: "The hub checks this every minute while you're offline. Read solana_alerts when you wake." };
      }),

    /** GET /orders — this agent's standing orders, newest first. */
    "GET /orders": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        return { orders: await listOrders(caller.agentId, caller.orgId) };
      }),

    /** POST /orders/:id/cancel */
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
     *     | { agentId?, kind: "activity", address ("self" ok), cluster?, repeat? (default true), ttlDays?, note? }
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
          const trigger = parsePriceTrigger(b.trigger, (v) => resolveMint(v, "trigger.mint"));
          const [price] = await tokenPrices([trigger.mint]);
          if (price.usdPrice == null) throw new DevtoolsInputError(`Jupiter has no price for ${trigger.mint}`);
          const armed = !checkTrigger(trigger, price.usdPrice).hit;
          const armedTrigger = trigger.op === "trail" ? { ...trigger, peakUsd: price.usdPrice } : trigger;
          watch = await createWatch({ ...common, kind: "price", repeat: b.repeat === true, armed, trigger: armedTrigger });
          summary = `price: ${describeTrigger(armedTrigger, price.symbol)}${armed ? "" : " (already true — fires after it next clears and crosses again)"}`;
        } else if (b.kind === "activity") {
          if (typeof b.address !== "string") throw new DevtoolsInputError("address is required");
          const cluster = parseCluster(b.cluster);
          const address = parsePubkey(await resolveSelf(ctx, req, b.address.trim()), "address").toBase58();
          const [newest] = await connectionFor(cluster).getSignaturesForAddress(new PublicKey(address), { limit: 1 });
          watch = await createWatch({ ...common, kind: "activity", repeat: b.repeat !== false, address, cluster, lastSignature: newest?.signature ?? null });
          summary = `activity on ${address} (${cluster})`;
        } else {
          throw new DevtoolsInputError("kind must be price or activity");
        }
        logActivity(caller, { action: "watch", ok: true, summary });
        return { watch, watching: summary };
      }),

    /** GET /watches — this agent's watches, newest first. */
    "GET /watches": (req, ctx) =>
      handle(async () => {
        const caller = await resolveCaller(ctx, query(req, "agentId"));
        return { watches: await listWatches(caller.agentId, caller.orgId) };
      }),

    /** POST /watches/:id/cancel */
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

    // ── Get paid directly (Solana Pay) ──────────────────────────────────

    /**
     * POST /payments/request — a Solana Pay link with a fresh reference.
     * The tick watches the reference and alerts the agent once it's paid.
     * Body: { agentId?, amount, mint? (omit = SOL; "USDC" ok), recipient? (one of the agent's own wallets; default dev wallet),
     *         cluster?, label?, message?, memo?, ttlDays? }
     */
    "POST /payments/request": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.inspect);
        const cluster = parseCluster(b.cluster);
        const mint = paymentMint(b.mint, cluster);
        const amount = String(b.amount ?? "").trim();
        if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) throw new DevtoolsInputError("amount must be a positive decimal, e.g. \"5\" or \"0.25\"");
        const recipient = await ownSolanaWallet(caller, b.recipient);
        const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
        const reference = newReference();
        const fields = { recipient, amount, mint, reference, label: text(b.label, 64), message: text(b.message, 140), memo: text(b.memo, 120) };
        const request = await createPaymentRequest({
          agentId: caller.agentId, orgId: caller.orgId, status: "pending", createdAt: new Date().toISOString(), expiresAt: expiryFrom(b.ttlDays),
          cluster, ...fields, url: solanaPayUrl(fields),
        });
        logActivity(caller, { action: "payment-request", cluster, ok: true, summary: `${amount} ${mint ? mint.slice(0, 6) + "…" : "SOL"} to ${recipient.slice(0, 6)}…` });
        return { request, payUrl: request.url, note: "Send payUrl (or a QR of it) to the payer. The hub checks for it every minute and posts an alert when it lands; solana_payment_status checks now." };
      }),

    /** GET /payments — this agent's payment requests, newest first. */
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
        const check = await checkPaymentRequest(request);
        return { request: check.request, check: check.verdict };
      }),

    /**
     * POST /payments/verify — did `recipient` really get paid? By signature,
     * or by Solana Pay reference. Body: { recipient ("self" ok), amount?, mint?, signature?, reference?, memo?, cluster? }
     */
    "POST /payments/verify": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const cluster = parseCluster(b.cluster);
        if (typeof b.recipient !== "string") throw new DevtoolsInputError("recipient is required");
        const recipient = await resolveSelf(ctx, req, b.recipient.trim());
        const verdict = await findPayment(connectionFor(cluster), {
          recipient, mint: paymentMint(b.mint, cluster), amount: b.amount != null ? String(b.amount) : null,
          signature: typeof b.signature === "string" ? b.signature : null, reference: typeof b.reference === "string" ? b.reference : null,
          memo: typeof b.memo === "string" ? b.memo : null,
        });
        if (caller) logActivity(caller, { action: "verify-payment", cluster, ok: verdict.verified, summary: verdict.verified ? `verified ${verdict.received} from ${verdict.payer?.slice(0, 6)}…` : `not verified: ${verdict.reason}`, ...(verdict.signature ? { signature: verdict.signature } : {}) });
        return { cluster, ...verdict, ...(verdict.signature ? { explorerUrl: explorerUrl("tx", verdict.signature, cluster) } : {}) };
      }),

    // ── Due diligence ───────────────────────────────────────────────────

    /** GET /token/safety/:mint — rug-risk report: authorities, Token-2022 traps, concentration, liquidity. ?cluster= (default mainnet-beta) */
    "GET /token/safety/:mint": (req, ctx) =>
      handle(async () => {
        const caller = ctx.agent ? await requireCaller(ctx, null, CAP.inspect) : null;
        const cluster = parseCluster(query(req, "cluster") ?? "mainnet-beta");
        const mint = resolveMint(ctx.params.mint, "mint");
        const conn = connectionFor(cluster);
        const facts = await readMintFacts(conn, mint);
        const [largest, info, price] = await Promise.all([
          // No retry loop: public RPCs rate-limit this call hard, and Jupiter's holder share is the fallback.
          new Connection(rpcFor(cluster), { commitment: "confirmed", disableRetryOnRateLimit: true })
            .getTokenLargestAccounts(new PublicKey(mint)).then((r) => r.value.map((a) => a.amount)).catch(() => [] as string[]),
          cluster === "mainnet-beta" ? tokenInfo(mint).catch(() => null) : Promise.resolve(null),
          cluster === "mainnet-beta" ? tokenPrices([mint]).then(([p]) => p.usdPrice).catch(() => null) : Promise.resolve(null),
        ]);
        let sellImpactPct: number | null = null;
        if (price && price > 0 && mint !== SYMBOL_MINTS.USDC) {
          const amount = (1000 / price).toFixed(Math.min(facts.decimals, 6));
          sellImpactPct = await swapQuote({ inputMint: mint, outputMint: SYMBOL_MINTS.USDC, amount, slippageBps: 100 }).then((q) => q.priceImpactPct).catch(() => null);
        } else if (mint === SYMBOL_MINTS.USDC) {
          sellImpactPct = 0;
        }
        const report = assessToken({ mint, facts, largestRaw: largest, info, priceUsd: price, sellImpactPct });
        if (caller) logActivity(caller, { action: "token-safety", cluster, ok: true, summary: `${report.symbol ?? mint.slice(0, 6)}: ${report.verdict}` });
        return { cluster, report };
      }),

    /**
     * POST /tx/preview — decode and simulate a transaction someone else
     * built, and report what it does to the agent's dev wallet.
     * Body: { agentId?, transaction (base64), cluster?, wallet? (preview as this address instead) }
     */
    "POST /tx/preview": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.simulate);
        const cluster = parseCluster(b.cluster);
        const tx = parseBase64Tx(b.transaction as string);
        const wallet = typeof b.wallet === "string" && b.wallet ? parsePubkey(b.wallet, "wallet").toBase58() : (await getDevWallet(caller))?.address;
        if (!wallet) throw new DevtoolsInputError("This agent has no dev wallet — create one or pass wallet");
        const preview = await previewExternalTx(connectionFor(cluster), tx, wallet);
        logActivity(caller, { action: "tx-preview", cluster, ok: preview.simulation.success, summary: `${preview.verdict}: ${preview.instructions.length} ix, ${preview.forAgent.solDelta} SOL` });
        return { cluster, wallet, preview };
      }),

    /**
     * POST /tx/sign — preview, then sign with the agent's dev wallet and send
     * (devnet/testnet). Refuses a high-risk preview unless acceptRisks is
     * true, and always refuses one that would fail or hand over the wallet.
     * Body: { agentId?, transaction (base64), cluster?, acceptRisks? }
     */
    "POST /tx/sign": (req, ctx) =>
      handle(async () => {
        const b = await body(req);
        const caller = await requireCaller(ctx, b.agentId as string, CAP.devnet);
        const cluster = parseCluster(b.cluster);
        if (!SIGNING_CLUSTERS.includes(cluster)) throw new DevtoolsInputError(`The dev wallet only signs on ${SIGNING_CLUSTERS.join("/")} — use /tx/preview for ${cluster}`);
        const policy = await getPolicy(caller.agentId, caller.orgId);
        if (policy.paused) throw new AccessError("Signing is paused for this agent by its org owner", 403);
        const wallet = await getDevWallet(caller);
        if (!wallet) throw new DevtoolsInputError("This agent has no dev wallet yet — call solana_create_wallet first");
        const tx = parseBase64Tx(b.transaction as string);
        const preview = await previewExternalTx(connectionFor(cluster), tx, wallet.address);
        const refusal = externalSignRefusal(preview, policy.maxTransferSol, b.acceptRisks === true);
        if (refusal) {
          logActivity(caller, { action: "tx-sign", cluster, ok: false, summary: `refused: ${refusal}`.slice(0, 160) });
          return Response.json({ error: refusal, preview }, { status: 409 });
        }
        const sent = await signExternalAsAgent(caller, cluster, tx);
        logActivity(caller, { action: "tx-sign", cluster, ok: sent.success, summary: `${preview.instructions.length} ix, ${preview.forAgent.solDelta} SOL`, signature: sent.signature, explorerUrl: sent.explorerUrl });
        return { cluster, ...sent, preview };
      }),
  },
});


// ── The minute tick ──────────────────────────────────────────────────────

const TICK_BUDGET_MS = 20_000;

/** Prices for many mints, 20 per Jupiter call. Failed batches come back missing. */
async function priceMap(mints: string[]): Promise<Map<string, { usd: number | null; symbol: string | null }>> {
  const out = new Map<string, { usd: number | null; symbol: string | null }>();
  const unique = [...new Set(mints)];
  for (let i = 0; i < unique.length; i += 20) {
    try {
      for (const p of await tokenPrices(unique.slice(i, i + 20))) out.set(p.mint, { usd: p.usdPrice, symbol: p.symbol });
    } catch (err) {
      console.warn("[solana-tick] price batch failed:", (err as Error).message);
    }
  }
  return out;
}

const tickCaller = (row: { agentId: string; orgId: string }): Caller => ({ agentId: row.agentId, orgId: row.orgId, via: "agent" });

async function fillOrder(order: StandingOrder, priceUsd: number, symbol: string | null): Promise<"filled" | "failed" | "skipped"> {
  if (!(await claimOrder(order.id))) return "skipped";
  const caller = tickCaller(order);
  const fired = `${describeTrigger(order.trigger, symbol)} (now $${fmtUsd(priceUsd)})`;
  try {
    if (!(await hasCapability(order.agentId, order.orgId, CAP.trade))) throw new PaperTradeError(`The "${CAP.trade}" upgrade was turned off`);
    const { trade } = await executePaperSwap(caller, {
      inputMint: order.inputMint, outputMint: order.outputMint, amount: order.amount, slippageBps: order.slippageBps ?? undefined,
      note: `[standing order ${order.id}] ${order.note ?? fired}`.slice(0, 280), via: "standing-order",
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

async function stepActivityWatch(watch: Extract<Watch, { kind: "activity" }>): Promise<boolean> {
  const conn = connectionFor(watch.cluster);
  const sigs = await conn.getSignaturesForAddress(new PublicKey(watch.address), { limit: 10, ...(watch.lastSignature ? { until: watch.lastSignature } : {}) });
  if (!sigs.length) return false;
  const newest = sigs[0];
  const failed = sigs.filter((s) => s.err).length;
  await pushAlert({
    agentId: watch.agentId, orgId: watch.orgId, source: "watch", refId: watch.id,
    title: `${sigs.length === 10 ? "10+" : sigs.length} new transaction${sigs.length === 1 ? "" : "s"} on ${watch.address.slice(0, 6)}…`,
    detail: `${watch.address} (${watch.cluster})${failed ? `, ${failed} failed` : ""}. Newest: ${newest.signature}${newest.memo ? ` memo ${newest.memo}` : ""}. Inspect with solana_inspect_transaction.${watch.note ? ` Your note: ${watch.note}` : ""}`,
    signature: newest.signature, explorerUrl: explorerUrl("tx", newest.signature, watch.cluster),
  });
  await updateWatch(watch.id, { lastSignature: newest.signature, fireCount: watch.fireCount + 1, lastFiredAt: new Date().toISOString(), ...(watch.repeat ? {} : { status: "done" as const }) });
  return true;
}

/**
 * One minute of the hub working for agents that aren't running: fills
 * standing orders whose trigger fired, fires watches, and confirms payment
 * requests. A Firestore lock makes overlapping calls a no-op.
 */
export async function runSolanaTick(now = Date.now()) {
  const result = { orders: 0, filled: 0, failed: 0, expired: 0, watches: 0, alerts: 0, payments: 0, paid: 0, errors: 0, locked: false };
  const holder = `tick-${now}-${Math.random().toString(36).slice(2, 8)}`;
  if (!(await acquireSolanaTickLock(holder, 50_000, now))) return { ...result, locked: true };
  const started = Date.now();
  const inBudget = () => Date.now() - started < TICK_BUDGET_MS;
  const safe = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (err) { result.errors++; console.error(`[solana-tick] ${what}:`, (err as Error).message); }
  };
  try {
    const [orders, watches, payments] = await Promise.all([openOrders(), activeWatches(), pendingPaymentRequests()]);
    result.orders = orders.length;
    result.watches = watches.length;
    result.payments = payments.length;
    const prices = await priceMap([
      ...orders.map((o) => o.trigger.mint),
      ...watches.flatMap((w) => (w.kind === "price" ? [w.trigger.mint] : [])),
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
        const p = prices.get(order.trigger.mint);
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
        const p = prices.get(watch.trigger.mint);
        const step = stepPriceWatch(watch, p?.usd ?? null);
        if (step.fire) {
          await pushAlert({
            agentId: watch.agentId, orgId: watch.orgId, source: "watch", refId: watch.id,
            title: `Price alert: ${describeTrigger(watch.trigger, p?.symbol)}`,
            detail: `${p?.symbol ?? watch.trigger.mint} is $${fmtUsd(p!.usd!)}.${watch.note ? ` Your note: ${watch.note}` : ""}`,
          });
          result.alerts++;
          await updateWatch(watch.id, { ...step.next, fireCount: watch.fireCount + 1, lastFiredAt: new Date(now).toISOString(), ...(watch.repeat ? {} : { status: "done" as const }) });
        } else if (step.changed) {
          await updateWatch(watch.id, { trigger: step.next.trigger, armed: step.next.armed });
        }
      });
    }

    for (const request of payments) {
      if (!inBudget()) break;
      await safe(`payment ${request.id}`, async () => {
        const checked = await checkPaymentRequest(request);
        if (checked.request.status === "paid") { result.paid++; result.alerts++; return; }
        if (isExpired(request.expiresAt, now)) {
          await updatePaymentRequest(request.id, { status: "expired" });
          await pushAlert({ agentId: request.agentId, orgId: request.orgId, source: "payment", refId: request.id, title: "Payment request expired unpaid", detail: `${request.amount} ${request.mint ?? "SOL"} to ${request.recipient} (${request.cluster}). ${checked.verdict.reason ?? ""}`.trim() });
        }
      });
    }
    return result;
  } finally {
    await releaseSolanaTickLock(holder).catch(() => {});
  }
}
