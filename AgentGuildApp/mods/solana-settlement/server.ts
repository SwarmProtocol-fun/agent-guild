import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { settleOnChains, hashJobResult, getBalance, verifyReceipt } from "@/lib/settlement/registry";
import { agentAlreadyRegistered, getAgentSlashingHistoryOnChain, mintIdentityToken } from "@/lib/solana/platform";
import { getScoreEventHistoryForAsn } from "@/lib/solana/client";
import { getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import {
  claimSolanaSettlement, getSolanaSettlement, listSolanaSettlements, markSolanaSettlementPaid,
  releaseSolanaSettlementClaim, saveSolanaSettlement, solanaSettlementTotal,
  type SolanaSettlementRecord,
} from "@/lib/mods/solana-settlement-store";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  DevtoolsInputError, clusterStatus, inspectAccount, inspectTransaction, fetchIdl,
  derivePda, decodeProgramError, parseErrorCode, priorityFees, rentExempt, explorerUrl,
  type SeedSpec,
} from "./devtools";
import type { InstructionSpec } from "./txbuilder";
import {
  CAP, AccessError, SIGNING_CLUSTERS, ANCHOR_VERSIONS, parseCluster, connectionFor, requireCaller, resolveCaller, capabilityMap, hasCapability,
  logActivity, activityFor, getDevWallet, ensureDevWallet, sendAsAgent, simulateAsAgent, airdropToAgent,
  createTokenAsAgent, enqueueAnchorJob, enableAllUpgrades, getAnchorJob, anchorWorkersOnline, type ServerCluster, type Caller,
} from "./agent";
import { AGENT_TOOLS } from "./tools";

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

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("solana-settlement mod loaded");
  },

  routes: {
    /**
     * POST /settle — called when a GatewayAgent job finishes. Expects the
     * job's raw result so the receipt hash is computed the same way on
     * every call, not trusted from the caller. Requires the calling agent
     * to hold the "solana-settle" capability (installed via this plugin's
     * SKILL_REGISTRY entry) — see docs/mod-sdk.md's capability system.
     *
     * Body: { orgId?, agentId?, agentWallet, taskId, exitCode, executionTimeMs,
     *         stdout?, amountUsdc, creditScore, trustScore }
     *
     * orgId/agentId are only read from the body as a fallback for browser
     * sessions — a request carrying a verified agent signature (ctx.agent)
     * always wins, so a session can't settle a payment on behalf of an
     * agentId it merely typed into the request.
     */
    "POST /settle": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { agentWallet, taskId, exitCode, executionTimeMs, stdout, amountUsdc, creditScore, trustScore } = body;
      const amount = typeof amountUsdc === "number" ? amountUsdc : Number(amountUsdc);

      if (!orgId || !agentId || !agentWallet || !taskId || amountUsdc == null || !Number.isFinite(amount)) {
        return Response.json({ error: "orgId, agentId, agentWallet, taskId, amountUsdc are required" }, { status: 400 });
      }

      // Capability key must match the agentSkills id in lib/skills.ts. Resolved
      // with the admin SDK (see agent.ts) — the browser-SDK resolver is denied server-side.
      if (!(await hasCapability(agentId, orgId, CAP.settle))) {
        return Response.json({ error: `Agent ${agentId} doesn't have the "${CAP.settle}" capability` }, { status: 403 });
      }

      // Claim the task before paying. A retry finds the claim and returns
      // the first receipt instead of sending a second USDC transfer.
      const claim = await claimSolanaSettlement(agentId, taskId, orgId);
      if (claim.state === "conflict") return Response.json({ error: "Task already settled for another org" }, { status: 409 });
      if (claim.state === "pending") return Response.json({ error: "Settlement already in progress for this task" }, { status: 409 });
      if (claim.state === "done") return Response.json({ receipt: receiptOf(claim.record), replayed: true, persisted: true });

      const resultHash = hashJobResult({ taskId, exitCode: exitCode ?? 0, executionTimeMs: executionTimeMs ?? 0, stdout });

      let settled: Awaited<ReturnType<typeof settleOnChains>>;
      try {
        settled = await settleOnChains(["solana"], {
          agentId,
          agentWallet,
          taskId,
          resultHash,
          amountUsdc: amount,
          creditScore: creditScore ?? 680,
          trustScore: trustScore ?? 50,
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
        return Response.json({ receipt, persisted: false, error: (err as Error).message });
      }

      return Response.json({ receipt, persisted: true });
    },

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

    /** GET /my-agents — the signed-in operator's agents, with each one's Solana upgrades and dev wallet. Session only. */
    "GET /my-agents": (_req, ctx) =>
      handle(async () => {
        if (!ctx.session) throw new AccessError("Sign in to list your agents", 401);
        const orgs = await getOrganizationsByWalletAdmin(ctx.session.address);
        const perOrg = await Promise.all(orgs.map(async (org) => {
          const agents = await getAgentsByOrg(org.id);
          return Promise.all(agents.map(async (agent) => {
            const caller: Caller = { agentId: agent.id, orgId: org.id, via: "session" };
            // One agent's lookup failing must not hide every agent from the picker.
            const [capabilities, wallet] = await Promise.all([
              capabilityMap(agent.id, org.id).catch((err) => {
                console.warn(`[solana] capabilities for ${agent.id} failed:`, err);
                return {} as Awaited<ReturnType<typeof capabilityMap>>;
              }),
              getDevWallet(caller).catch(() => null),
            ]);
            const isOwner = !!org.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === canonicalizeWalletAddress(ctx.session!.address);
            return { agentId: agent.id, name: agent.name, orgId: org.id, orgName: org.name || org.id, isOwner, capabilities, devWallet: wallet?.address ?? null };
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
        return { activity: activityFor(caller.agentId) };
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
