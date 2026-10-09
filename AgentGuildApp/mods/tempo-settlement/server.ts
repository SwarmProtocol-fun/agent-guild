import { createHash } from "crypto";
import { Mppx, tempo as mppTempo } from "mppx/server";
import { isAddress, isHash, parseUnits, type Hex } from "viem";
import { defineServerMod, type RouteContext } from "@agent-guild/sdk";
import { verifyReceipt, tempoAdapter } from "@/lib/settlement/registry";
import { getChain, USDC_DECIMALS } from "@/lib/chains";
// Admin SDK on the server: lib/skills.ts's resolver uses the browser
// Firestore SDK, which is unauthenticated here and denied by the rules.
import { getAgentsByOrg, getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { listOrgJobsByStatus } from "@/lib/jobs-admin";
import { generateAgentWallet, listAgentWallets } from "@/lib/agent-wallets";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import type { Job, Organization } from "@/lib/firestore";
import {
  claimPayout, getPayout, getPayoutsByTx, listPayouts, markPayoutsPaid, releasePayouts,
  type PayoutUnit, type TempoPayout,
} from "@/lib/mods/tempo-payouts-store";

/**
 * Tempo payouts. An org owner pays their agents for approved jobs in a
 * TIP-20 stablecoin on Tempo, FROM THEIR OWN WALLET. The server never holds
 * or signs with the money; it:
 *
 *   1. lists approved, unpaid jobs and each agent's wallet (POST /wallet
 *      gives an agent one if it has none),
 *   2. reserves the jobs being paid and hands back the exact transfers —
 *      recipient, amount, and a memo derived from the job's delivery
 *      (POST /payouts/start),
 *   3. after the owner's wallet sends them, finds each transfer on-chain by
 *      its memo and checks recipient and amount before marking the job paid
 *      (POST /payouts/confirm).
 *
 * A reserved job can't be paid twice; it's only released (POST
 * /payouts/cancel) after the chain shows nothing was sent for it.
 */

const MAX_BATCH = 25;

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

async function requireMember(ctx: RouteContext, orgId: unknown): Promise<CallerOrg> {
  if (typeof orgId !== "string" || !orgId) throw new HttpError("orgId is required", 400);
  const match = (await callerOrgs(ctx)).find((o) => o.org.id === orgId);
  if (!match) throw new HttpError("Not a member of this organization", 403);
  return match;
}

async function requireOwner(ctx: RouteContext, orgId: unknown): Promise<Organization> {
  if (ctx.agent) throw new HttpError("Payouts are sent by an org owner, not an agent", 403);
  const match = await requireMember(ctx, orgId);
  if (!match.isOwner) throw new HttpError("Only the org owner can pay agents", 403);
  return match.org;
}

// ── Amounts and memos ────────────────────────────────────────────────────

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
  return n;
}

/**
 * The 32-byte memo a job's payment carries: a hash of the org, the job and
 * what the agent delivered. Unique per job (so the transfer can be found by
 * memo alone) and checkable by anyone holding the delivery.
 */
export function jobReceiptHash(job: Pick<Job, "id" | "orgId" | "deliveryNotes">): string {
  return createHash("sha256").update(`agent-guild/job-payout/v1\n${job.orgId}\n${job.id}\n${job.deliveryNotes ?? ""}`).digest("hex");
}

const memoOf = (p: TempoPayout) => `0x${p.resultHash}` as Hex;
const jobUnit = (jobId: string): PayoutUnit => ({ kind: "job", jobId });

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

/** What the owner's wallet has to send for one reserved job. */
function transferOf(p: TempoPayout) {
  return { jobId: p.jobId!, jobTitle: p.jobTitle, to: p.to, amountUsdc: p.amountUsdc, amountBase: p.amountBase!, memo: memoOf(p) };
}

/**
 * Look for a reserved job's transfer on-chain — right memo, to the agent's
 * wallet, for the full amount — and if it's there, mark the job paid.
 * Returns the payout as it now stands.
 */
async function confirmOnChain(payout: TempoPayout, txHash?: Hex): Promise<TempoPayout> {
  if (payout.status === "paid") return payout;
  const found = await tempoAdapter.findMemoTransfer({
    memo: memoOf(payout),
    to: payout.to,
    minAmount: BigInt(payout.amountBase ?? "0"),
    txHash,
    fromBlock: payout.fromBlock ? BigInt(payout.fromBlock) : undefined,
  });
  if (!found) return payout;
  const explorerUrl = getChain("tempo")?.explorer.txUrl(found.txHash) ?? "";
  // paidBy becomes the wallet that actually sent it, as seen on-chain.
  const tx = { txSig: found.txHash, explorerUrl, paidBy: found.from.toLowerCase() };
  await markPayoutsPaid([jobUnit(payout.jobId!)], tx);
  return { ...payout, ...tx, status: "paid", paidAt: new Date().toISOString() };
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
    /**
     * GET /overview?payer= — the Tempo network and token payouts use, the
     * payer wallet's balance of it (when `payer` is given), and the caller's orgs.
     */
    "GET /overview": (req, ctx) => handle(async () => {
      const payer = new URL(req.url).searchParams.get("payer") ?? undefined;
      const [token, orgs] = await Promise.all([tempoAdapter.payoutToken(payer), callerOrgs(ctx)]);
      return { ...token, orgs: orgs.map(({ org, isOwner }) => ({ id: org.id, name: org.name, isOwner })) };
    }),

    /**
     * GET /payable?orgId= — approved jobs in this org not paid yet, with the
     * agent's Tempo (EVM) wallets and a suggested amount from the job's
     * reward; plus `waiting`: jobs reserved for a payment the chain hasn't
     * shown yet.
     */
    "GET /payable": (req, ctx) => handle(async () => {
      const { org } = await requireMember(ctx, new URL(req.url).searchParams.get("orgId"));

      const [{ jobs }, agents, payouts] = await Promise.all([
        listOrgJobsByStatus(org.id, "completed", { limit: 100 }),
        getAgentsByOrg(org.id),
        listPayouts([org.id], 1000),
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
        waiting: payouts
          .filter((p) => p.kind === "job" && p.status === "pending" && p.amountBase)
          .map((p) => ({ ...transferOf(p), agentId: p.agentId, agentName: p.agentName ?? null, createdAt: p.createdAt })),
      };
    }),

    /**
     * POST /payouts/start — reserve approved jobs for payment and return the
     * transfers the owner's wallet must send. Org owner only.
     * Body: { orgId, items: [{ jobId, to, amountUsdc }] }. `to` must be one
     * of the job's agent's Tempo wallets. Starting a job that's already
     * reserved (with the same recipient and amount) returns the same transfer.
     */
    "POST /payouts/start": (req, ctx) => handle(async () => {
      const body = await req.json();
      const org = await requireOwner(ctx, body.orgId);
      const raw = Array.isArray(body.items) ? body.items : [];
      if (raw.length === 0) throw new HttpError("Pick at least one job to pay", 400);
      if (raw.length > MAX_BATCH) throw new HttpError(`At most ${MAX_BATCH} jobs at a time`, 400);

      const token = await tempoAdapter.payoutToken();
      if (token.missing.length) throw new HttpError(`Payouts are off until the server has ${token.missing.join(" and ")} set`, 503);

      const { jobs } = await listOrgJobsByStatus(org.id, "completed", { limit: 100 });
      const byId = new Map(jobs.map((j) => [j.id, j]));
      const agents = new Map((await getAgentsByOrg(org.id)).map((a) => [a.id, a.name]));
      const walletCache = new Map<string, Set<string>>();
      const fromBlock = String(await tempoAdapter.blockNumber());

      const planned: TempoPayout[] = [];
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
          orgId: org.id, kind: "job", jobId: job.id, jobTitle: job.title,
          agentId, agentName: agents.get(agentId), to, amountUsdc,
          amountBase: parseUnits(String(amountUsdc), token.decimals).toString(),
          resultHash: jobReceiptHash(job),
          status: "pending", paidBy: canonicalizeWalletAddress(ctx.session!.address),
          fromBlock, createdAt: new Date().toISOString(),
        });
      }

      // Reserve every job before handing any transfer out. If one is taken, let the new ones go.
      const transfers: ReturnType<typeof transferOf>[] = [];
      const reserved: PayoutUnit[] = [];
      for (const payout of planned) {
        const unit = jobUnit(payout.jobId!);
        const claim = await claimPayout(unit, payout);
        if (claim.state === "claimed") {
          reserved.push(unit);
          transfers.push(transferOf(payout));
          continue;
        }
        const existing = claim.state === "pending" ? await getPayout(unit) : null;
        if (existing && existing.amountBase === payout.amountBase && existing.to.toLowerCase() === payout.to.toLowerCase()) {
          transfers.push(transferOf(existing));
          continue;
        }
        await releasePayouts(reserved).catch(() => {});
        throw new HttpError(
          claim.state === "paid" ? `${payout.jobTitle} is already paid`
            : `${payout.jobTitle} is already waiting on a payment — finish or cancel that one first`,
          409,
        );
      }

      return { token: token.token, tokenSymbol: token.tokenSymbol, chain: token.chain, transfers };
    }),

    /**
     * POST /payouts/confirm — find a reserved job's transfer on-chain (by tx
     * hash if given, else by memo and recipient) and mark it paid if it paid
     * the agent's wallet in full. Any org member may ask. Body: { orgId, jobId, txHash? }
     */
    "POST /payouts/confirm": (req, ctx) => handle(async () => {
      const body = await req.json();
      const { org } = await requireMember(ctx, body.orgId);
      const payout = await getPayout(jobUnit(String(body.jobId ?? "")));
      if (!payout || payout.orgId !== org.id) throw new HttpError("No payment was started for this job", 404);
      const txHash = body.txHash ? String(body.txHash) : undefined;
      if (txHash && !isHash(txHash)) throw new HttpError("txHash is not a transaction hash", 400);
      const now = await confirmOnChain(payout, txHash as Hex | undefined);
      return { status: now.status, txSig: now.txSig ?? null, explorerUrl: now.explorerUrl ?? null };
    }),

    /**
     * POST /payouts/cancel — release a reserved job so it can be paid again.
     * Checks the chain first: if the transfer did go out, the job is marked
     * paid instead. Org owner only. Body: { orgId, jobId }
     */
    "POST /payouts/cancel": (req, ctx) => handle(async () => {
      const body = await req.json();
      const org = await requireOwner(ctx, body.orgId);
      const unit = jobUnit(String(body.jobId ?? ""));
      const payout = await getPayout(unit);
      if (!payout || payout.orgId !== org.id) throw new HttpError("No payment was started for this job", 404);
      const now = await confirmOnChain(payout);
      if (now.status === "paid") return { cancelled: false, status: "paid", txSig: now.txSig, explorerUrl: now.explorerUrl };
      await releasePayouts([unit]);
      return { cancelled: true, status: "cancelled" };
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
     * GET /paid/ping — not part of payouts: a Machine Payments Protocol
     * (HTTP 402) test target for GatewayAgent's mpp-fetch executor, which
     * points at this path. An anonymous machine client pays 0.001 inline
     * (request → 402 challenge → paid retry → 200 + receipt). `public: true`
     * because MPP's own credential check is the auth. It only ever RECEIVES payment.
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
