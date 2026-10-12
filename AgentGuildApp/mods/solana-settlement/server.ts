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
  DevtoolsInputError, clusterStatus, inspectAccount, inspectTransaction, fetchIdl,
  derivePda, decodeProgramError, parseErrorCode, priorityFees, rentExempt, explorerUrl, walletHoldings, addressHistory,
  type SeedSpec,
} from "./devtools";
import type { InstructionSpec } from "./txbuilder";
import {
  CAP, AccessError, SIGNING_CLUSTERS, ANCHOR_VERSIONS, parseCluster, connectionFor, requireCaller, resolveCaller, capabilityMap, hasCapability,
  logActivity, activityFor, getDevWallet, DEV_WALLET_LABEL, ensureDevWallet, sendAsAgent, simulateAsAgent, airdropToAgent,
  createTokenAsAgent, transferAsAgent, enqueueAnchorJob, enableAllUpgrades, getAnchorJob, anchorWorkersOnline, type ServerCluster, type Caller,
} from "./agent";
import { AGENT_TOOLS } from "./tools";
import { swapQuote, tokenPrices } from "./market";
import { listAgentWallets } from "@/lib/agent-wallets";

// ── Request helpers ──────────────────────────────────────────────────────

class NotFoundError extends Error {}

/** Maps thrown errors to statuses: auth/capability → its own, bad input → 400, not found → 404, everything else (RPC) → 502. */
function failure(err: unknown): Response {
  if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
  if (err instanceof AccessError) return Response.json({ error: err.message }, { status: err.status });
  const status = err instanceof DevtoolsInputError || err instanceof SyntaxError ? 400 : 502;
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
        ],
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
        const [capabilities, wallet, workers] = await Promise.all([
          capabilityMap(caller.agentId, caller.orgId),
          getDevWallet(caller),
          anchorWorkersOnline(caller.orgId).catch(() => 0),
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
        const out = await transferAsAgent(caller, cluster, { to: b.to, amount: b.amount as string | number, mint: (b.mint as string | undefined) || null });
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
        if (action === "deploy") await requireCaller(ctx, b.agentId as string, CAP.devnet);
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
  },
});
