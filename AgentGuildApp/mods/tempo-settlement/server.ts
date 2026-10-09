import { Mppx, tempo as mppTempo } from "mppx/server";
import { isAddress } from "viem";
import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { hashJobResult, verifyReceipt, tempoAdapter } from "@/lib/settlement/registry";
import { getChain, USDC_DECIMALS } from "@/lib/chains";
// Admin SDK on the server: lib/skills.ts's resolver uses the browser
// Firestore SDK, which is unauthenticated here and denied by the rules.
import { getAgentCapabilities, getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { listOrgJobsByStatus } from "@/lib/jobs-admin";
import { generateAgentWallet, listAgentWallets } from "@/lib/agent-wallets";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import type { Job, Organization } from "@/lib/firestore";
import {
  claimPayout, getPayoutsByTx, listPayouts, markPayoutsPaid, releasePayouts,
  type PayoutUnit, type TempoPayout,
} from "@/lib/mods/tempo-payouts-store";

/**
 * Tempo payouts. An org owner pays agents for approved jobs in a TIP-20
 * stablecoin on Tempo; several jobs go out in ONE atomic transaction, and
 * each transfer's memo carries the job's receipt hash so anyone can check
 * the payment against the work on-chain. Agents with the "tempo-settle"
 * upgrade can also settle their own finished tasks (POST /settle).
 *
 * Money comes from the platform payout wallet (PLATFORM_SETTLEMENT_KEY) —
 * testnet funds today. Every unit is claimed in Firestore before the
 * transfer, so nothing is ever paid twice.
 */

/** Capability key — must match the agentSkills id on this mod's entry in lib/skills.ts. */
export const CAP_SETTLE = "tempo-settle";
const MAX_BATCH = 25;

/** Per-payout ceiling, so one bad request can't drain the payout wallet. */
function maxPayout(): number {
  const n = Number(process.env.TEMPO_MAX_PAYOUT_USDC);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function handle(fn: () => Promise<unknown>): Promise<Response> {
  try {
    const out = await fn();
    return out instanceof Response ? out : Response.json(out);
  } catch (err) {
    if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
    if (err instanceof SyntaxError) return Response.json({ error: "Request body must be JSON" }, { status: 400 });
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

// ── Who's calling ────────────────────────────────────────────────────────

interface CallerOrg { org: Organization; isOwner: boolean }

/** A browser session sees every org its wallet belongs to; a signed agent only its own org. */
async function callerOrgs(ctx: RouteContext): Promise<CallerOrg[]> {
  if (!ctx.session?.address) return [];
  const me = canonicalizeWalletAddress(ctx.session.address);
  const orgs = await getOrganizationsByWalletAdmin(ctx.session.address);
  return orgs.map((org) => ({ org, isOwner: !!org.ownerAddress && canonicalizeWalletAddress(org.ownerAddress) === me }));
}

async function callerOrgIds(ctx: RouteContext): Promise<string[]> {
  if (ctx.agent?.orgId) return [ctx.agent.orgId];
  return (await callerOrgs(ctx)).map((o) => o.org.id);
}

async function requireOwner(ctx: RouteContext, orgId: unknown): Promise<Organization> {
  if (ctx.agent) throw new HttpError("Payouts are sent by an org owner, not an agent", 403);
  if (typeof orgId !== "string" || !orgId) throw new HttpError("orgId is required", 400);
  const match = (await callerOrgs(ctx)).find((o) => o.org.id === orgId);
  if (!match) throw new HttpError("Not a member of this organization", 403);
  if (!match.isOwner) throw new HttpError("Only the org owner can send payouts", 403);
  return match.org;
}

// ── Amounts ──────────────────────────────────────────────────────────────

/**
 * A job's reward is free text ("150", "$50", "25 USDC", "0.5 SOL"). Only
 * dollar amounts become a suggested payout; anything else is left for the
 * owner to type, rather than guessing an exchange rate.
 */
export function parseUsdReward(reward: string | undefined): number | null {
  if (!reward) return null;
  const m = reward.trim().match(/^\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(usd|usdc|usdt|pathusd|dollars?)?$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function checkAmount(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(`${label}: amount must be a positive number`, 400);
  if (Math.round(n * 1_000_000) / 1_000_000 !== n) throw new HttpError(`${label}: amount has more than 6 decimals`, 400);
  const cap = maxPayout();
  if (n > cap) throw new HttpError(`${label}: amount is over the ${cap} per-payout limit`, 400);
  return n;
}

const evmWallets = async (agentId: string) =>
  (await listAgentWallets(agentId)).filter((w) => w.chain === "evm").map((w) => ({ address: w.publicKey, label: w.label ?? null }));

/** Approved jobs this org posted that went to an agent and were not already paid some other way. */
function isPayable(job: Job): boolean {
  if (!job.takenByAgentId) return false;
  // Delivery marks a job "completed" with review pending — pay only once the
  // poster approved it (jobs from before reviews existed have no reviewStatus).
  if (job.reviewStatus && job.reviewStatus !== "approved") return false;
  // Escrowed or prepaid gig orders, and Hedera bounties, already moved money.
  if (job.escrow || job.upfrontVerifiedAt || job.hederaScheduledTxId) return false;
  return true;
}

/** Send one atomic batch and record it. Claims must already be held for every unit. */
async function sendBatch(units: PayoutUnit[], items: { to: string; resultHash: string; amountUsdc: number }[]) {
  let tx: { txSig: string; explorerUrl: string };
  try {
    tx = await tempoAdapter.settleBatch(items);
  } catch (err) {
    await releasePayouts(units).catch(() => {});
    throw new HttpError(`Tempo transaction failed: ${(err as Error).message}`, 502);
  }
  const persisted = await markPayoutsPaid(units, tx);
  return { ...tx, persisted };
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Machine Payments Protocol (HTTP 402) — lazily built so a missing
// MPP_SECRET_KEY degrades /paid/ping to a clear 501 instead of crashing setup.
function createMppPayment(secretKey: string) {
  return Mppx.create({ methods: [mppTempo.charge({ testnet: true })], secretKey });
}
let mppPayment: ReturnType<typeof createMppPayment> | null | undefined;
function getMppPayment() {
  if (mppPayment !== undefined) return mppPayment;
  mppPayment = process.env.MPP_SECRET_KEY ? createMppPayment(process.env.MPP_SECRET_KEY) : null;
  return mppPayment;
}

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("tempo-settlement mod loaded");
  },

  routes: {
    /** GET /overview — the payout wallet, its balance, the token, who pays fees, and what's not configured. */
    "GET /overview": (_req, ctx) => handle(async () => {
      const [status, orgs] = await Promise.all([tempoAdapter.payoutStatus(), callerOrgs(ctx)]);
      return {
        ...status,
        maxPayoutUsdc: maxPayout(),
        orgs: orgs.map(({ org, isOwner }) => ({ id: org.id, name: org.name, isOwner })),
      };
    }),

    /**
     * GET /payable?orgId= — approved jobs in this org waiting to be paid,
     * with the agent's Tempo (EVM) wallets and a suggested amount from the
     * job's reward. Jobs already paid or in flight are left out.
     */
    "GET /payable": (req, ctx) => handle(async () => {
      const orgId = new URL(req.url).searchParams.get("orgId");
      const orgs = await callerOrgs(ctx);
      const match = orgs.find((o) => o.org.id === orgId);
      if (!match) throw new HttpError("Not a member of this organization", 403);

      const [{ jobs }, agents, payouts] = await Promise.all([
        listOrgJobsByStatus(match.org.id, "completed", { limit: 100 }),
        getAgentsByOrg(match.org.id),
        listPayouts([match.org.id], 1000),
      ]);
      const handled = new Set(payouts.filter((p) => p.jobId).map((p) => p.jobId));
      const names = new Map(agents.map((a) => [a.id, a.name]));
      const open = jobs.filter((j) => isPayable(j) && !handled.has(j.id));

      const agentIds = [...new Set(open.map((j) => j.takenByAgentId!))];
      const wallets = new Map(await Promise.all(agentIds.map(async (id) => [id, await evmWallets(id)] as const)));

      return {
        jobs: open.map((j) => ({
          jobId: j.id,
          title: j.title,
          reward: j.reward ?? null,
          suggestedUsdc: parseUsdReward(j.reward),
          agentId: j.takenByAgentId!,
          agentName: names.get(j.takenByAgentId!) ?? j.completedByAgentName ?? j.claimedByAgentName ?? null,
          wallets: wallets.get(j.takenByAgentId!) ?? [],
        })),
      };
    }),

    /**
     * POST /payouts — pay approved jobs in one atomic Tempo transaction.
     * Org owner only. Body: { orgId, items: [{ jobId, to, amountUsdc }] }.
     * `to` must be one of the job's agent's Tempo wallets.
     */
    "POST /payouts": (req, ctx) => handle(async () => {
      const body = await req.json();
      const org = await requireOwner(ctx, body.orgId);
      const raw = Array.isArray(body.items) ? body.items : [];
      if (raw.length === 0) throw new HttpError("Pick at least one job to pay", 400);
      if (raw.length > MAX_BATCH) throw new HttpError(`At most ${MAX_BATCH} jobs per payout`, 400);

      const { jobs } = await listOrgJobsByStatus(org.id, "completed", { limit: 100 });
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const agents = new Map((await getAgentsByOrg(org.id)).map((a) => [a.id, a.name]));
      const walletCache = new Map<string, Set<string>>();

      const planned: { unit: PayoutUnit; payout: TempoPayout }[] = [];
      const seen = new Set<string>();
      for (const item of raw) {
        const job = byId.get(String(item?.jobId));
        if (!job || !isPayable(job)) throw new HttpError(`Job ${item?.jobId} is not an approved, unpaid job in this org`, 400);
        if (seen.has(job.id)) throw new HttpError(`Job ${job.id} is listed twice`, 400);
        seen.add(job.id);
        const amountUsdc = checkAmount(item.amountUsdc, job.title);
        const agentId = job.takenByAgentId!;
        if (!walletCache.has(agentId)) {
          walletCache.set(agentId, new Set((await evmWallets(agentId)).map((w) => w.address.toLowerCase())));
        }
        const to = String(item.to ?? "");
        if (!isAddress(to) || !walletCache.get(agentId)!.has(to.toLowerCase())) {
          throw new HttpError(`${job.title}: pay to one of the agent's own Tempo wallets`, 400);
        }
        planned.push({
          unit: { kind: "job", jobId: job.id },
          payout: {
            orgId: org.id, kind: "job", jobId: job.id, jobTitle: job.title,
            agentId, agentName: agents.get(agentId), to, amountUsdc,
            resultHash: hashJobResult({ taskId: `job:${job.id}`, exitCode: 0, executionTimeMs: 0, stdout: job.deliveryNotes }),
            status: "pending", paidBy: canonicalizeWalletAddress(ctx.session!.address), createdAt: new Date().toISOString(),
          },
        });
      }

      // Claim every job before paying any. If one is taken, let the rest go.
      const claimed: PayoutUnit[] = [];
      for (const { unit, payout } of planned) {
        const claim = await claimPayout(unit, payout);
        if (claim.state !== "claimed") {
          await releasePayouts(claimed).catch(() => {});
          throw new HttpError(`${payout.jobTitle} is already ${claim.state === "paid" ? "paid" : "being paid"}`, 409);
        }
        claimed.push(unit);
      }

      const tx = await sendBatch(claimed, planned.map(({ payout }) => ({ to: payout.to, resultHash: payout.resultHash, amountUsdc: payout.amountUsdc })));
      return {
        ...tx,
        paid: planned.length,
        totalUsdc: planned.reduce((s, p) => s + p.payout.amountUsdc, 0),
      };
    }),

    /**
     * POST /wallet — give an agent a Tempo wallet to be paid into (a
     * platform-held EVM key, same as any custodial agent wallet). Org owner only.
     * Body: { orgId, agentId }
     */
    "POST /wallet": (req, ctx) => handle(async () => {
      const body = await req.json();
      const org = await requireOwner(ctx, body.orgId);
      const agent = (await getAgentsByOrg(org.id)).find((a) => a.id === body.agentId);
      if (!agent) throw new HttpError("Agent not found in this org", 404);
      const existing = await evmWallets(agent.id);
      if (existing.length) return { address: existing[0].address, created: false };
      const wallet = await generateAgentWallet(agent.id, org.id, canonicalizeWalletAddress(ctx.session!.address), { chain: "evm", label: "Tempo payouts" });
      return { address: wallet.publicKey, created: true };
    }),

    /**
     * POST /settle — an agent settles one of its own finished tasks. Needs
     * a verified agent signature and the "tempo-settle" upgrade. Pays into
     * the agent's own Tempo wallet (the first, unless `agentWallet` names
     * another of its wallets). A retry with the same taskId returns the
     * first receipt instead of paying again.
     *
     * Body: { taskId, amountUsdc, exitCode?, executionTimeMs?, stdout?, agentWallet? }
     */
    "POST /settle": (req, ctx) => handle(async () => {
      if (!ctx.agent) throw new HttpError("POST /settle needs a signed agent request", 401);
      const { agentId, orgId } = ctx.agent;
      const body = await req.json();
      if (!body.taskId) throw new HttpError("taskId is required", 400);
      const amountUsdc = checkAmount(body.amountUsdc, `task ${body.taskId}`);

      const caps = await getAgentCapabilities(agentId, orgId);
      if (!caps.some((c) => c.key === CAP_SETTLE)) {
        throw new HttpError(`Agent ${agentId} doesn't have the "${CAP_SETTLE}" upgrade`, 403);
      }

      const wallets = (await evmWallets(agentId)).map((w) => w.address);
      const to = body.agentWallet ? wallets.find((w) => w.toLowerCase() === String(body.agentWallet).toLowerCase()) : wallets[0];
      if (!to) throw new HttpError(wallets.length ? "agentWallet is not one of this agent's Tempo wallets" : "This agent has no Tempo wallet yet", 400);

      const unit: PayoutUnit = { kind: "task", agentId, taskId: String(body.taskId) };
      const payout: TempoPayout = {
        orgId, kind: "task", taskId: String(body.taskId), agentId, to, amountUsdc,
        resultHash: hashJobResult({ taskId: String(body.taskId), exitCode: body.exitCode ?? 0, executionTimeMs: body.executionTimeMs ?? 0, stdout: body.stdout }),
        status: "pending", paidBy: `agent:${agentId}`, createdAt: new Date().toISOString(),
      };
      const claim = await claimPayout(unit, payout);
      if (claim.state === "paid") return { receipt: claim.payout, replayed: true };
      if (claim.state === "conflict") throw new HttpError("Task already settled for another org", 409);
      if (claim.state === "pending") throw new HttpError("Settlement already in progress for this task", 409);

      const tx = await sendBatch([unit], [{ to, resultHash: payout.resultHash, amountUsdc }]);
      return { receipt: { ...payout, status: "paid", txSig: tx.txSig, explorerUrl: tx.explorerUrl }, persisted: tx.persisted };
    }),

    /** GET /history — this caller's orgs' payouts, newest first. */
    "GET /history": (_req, ctx) => handle(async () => ({ payouts: await listPayouts(await callerOrgIds(ctx), 100) })),

    /** GET /verify/:txSig — re-read each transfer in the tx and check its memo matches the recorded receipt hash. */
    "GET /verify/:txSig": (_req, ctx) => handle(async () => {
      const orgIds = new Set(await callerOrgIds(ctx));
      const payouts = (await getPayoutsByTx(ctx.params.txSig)).filter((p) => orgIds.has(p.orgId));
      if (!payouts.length) throw new HttpError("No payout with this transaction in your orgs", 404);
      const results = await Promise.all(payouts.map((p) => verifyReceipt("tempo", ctx.params.txSig, p.resultHash)));
      return { found: results.every((r) => r.found), hashVerified: results.every((r) => r.hashVerified), confirmedAt: results[0]?.confirmedAt ?? null };
    }),

    /** GET /export — this caller's payouts as CSV for accounting. */
    "GET /export": async (_req, ctx) => {
      const rows = await listPayouts(await callerOrgIds(ctx), 1000);
      const header = "paidAt,status,orgId,agentId,agentName,jobId,jobTitle,taskId,to,amount,txHash,receiptHash";
      const lines = rows.map((p) =>
        [p.paidAt ?? "", p.status, p.orgId, p.agentId, p.agentName ?? "", p.jobId ?? "", p.jobTitle ?? "", p.taskId ?? "", p.to, p.amountUsdc, p.txSig ?? "", p.resultHash]
          .map((v) => csvEscape(String(v))).join(","),
      );
      return new Response([header, ...lines].join("\n"), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="tempo-payouts.csv"' },
      });
    },

    /**
     * GET /paid/ping — Machine Payments Protocol (HTTP 402) demo: an
     * anonymous machine client pays 0.001 inline (request → 402 challenge →
     * paid retry → 200 + receipt). `public: true` because MPP's own
     * credential check is the auth. It only ever RECEIVES payment.
     * Used by GatewayAgent's mpp-fetch executor as a test target.
     */
    "GET /paid/ping": {
      public: true,
      handler: async (req) => {
        const payment = getMppPayment();
        const chain = getChain("tempo");
        const recipient = process.env.TEMPO_MPP_RECIPIENT ?? chain?.contracts.treasury;

        if (!payment) {
          return Response.json({ error: "MPP not configured — set MPP_SECRET_KEY (from an mpp.dev account)" }, { status: 501 });
        }
        if (!chain?.contracts.usdc || !recipient) {
          return Response.json({ error: "Set TEMPO_USDC_ADDRESS and TEMPO_MPP_RECIPIENT (or TEMPO_TREASURY_ADDRESS)" }, { status: 501 });
        }

        const result = await payment.charge({
          amount: "0.001",
          currency: chain.contracts.usdc,
          decimals: USDC_DECIMALS,
          recipient,
          description: "Tempo Settlement mod — paid ping (MPP demo)",
        })(req);

        if (result.status === 402) return result.challenge;
        return result.withReceipt(Response.json({ pong: true, at: new Date().toISOString() }));
      },
    },
  },
});
