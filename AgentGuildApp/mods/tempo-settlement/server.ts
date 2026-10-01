import { ethers } from "ethers";
import { Mppx, tempo as mppTempo } from "mppx/server";
import { defineServerMod } from "@agent-guild/sdk";
import { settleOnChains, hashJobResult, getBalance, verifyReceipt, tempoAdapter } from "@/lib/settlement/registry";
import { enforceCapability } from "@/lib/skills";
import { getChain, USDC_DECIMALS } from "@/lib/chains";

// Machine Payments Protocol (Stripe/Tempo's HTTP 402 payment standard) —
// lazily built so a missing MPP_SECRET_KEY degrades /paid/ping to a clear
// 501 instead of crashing mod setup.
function createMppPayment(secretKey: string) {
  return Mppx.create({ methods: [mppTempo.charge({ testnet: true })], secretKey });
}
let mppPayment: ReturnType<typeof createMppPayment> | null | undefined;
function getMppPayment() {
  if (mppPayment !== undefined) return mppPayment;
  mppPayment = process.env.MPP_SECRET_KEY ? createMppPayment(process.env.MPP_SECRET_KEY) : null;
  return mppPayment;
}

interface SettlementRecord {
  agentId: string;
  taskId: string;
  txSig: string;
  explorerUrl: string;
  amountUsdc: number;
  resultHash: string;
  /** Tempo's API supports payments metadata for invoice reconciliation —
   *  kept here (not embedded in the on-chain memo) so /verify's on-chain
   *  comparison stays a simple exact match against the receipt hash. */
  invoiceRef?: string;
  /** Client-supplied dedupe key (e.g. a webhook delivery id) — a retried
   *  webhook with the same key returns the original receipt instead of
   *  attempting a second on-chain settlement. */
  idempotencyKey?: string;
  /** Set when an operator voids/disputes a settlement after the fact.
   *  Voided records are excluded from totals, stats, and history by
   *  default but never deleted — the on-chain transaction already happened. */
  void?: boolean;
  voidReason?: string;
  at: string;
}

// In-memory for the demo panel — see solana-settlement mod for the same note.
const history: SettlementRecord[] = [];
const idempotencyIndex = new Map<string, SettlementRecord>();

// Per-agent micropayment meter: accrues small amounts off-chain (e.g. one
// per request/tick) so a stream of sub-cent charges can be flushed to a
// single on-chain settlement instead of paying gas per micro-charge —
// Tempo's stablecoin-native design is built for exactly this pattern.
interface MeterEntry {
  agentId: string;
  orgId: string;
  pendingUsdc: number;
  taskIds: string[];
}
const meters = new Map<string, MeterEntry>();

interface SettleItem {
  taskId: string;
  exitCode?: number;
  executionTimeMs?: number;
  stdout?: string;
  amountUsdc: number;
  invoiceRef?: string;
  idempotencyKey?: string;
}

async function settleOne(
  agentId: string,
  agentWallet: string,
  creditScore: number,
  trustScore: number,
  item: SettleItem,
): Promise<{ ok: true; record: SettlementRecord } | { ok: false; taskId: string; error: string }> {
  if (item.idempotencyKey) {
    const existing = idempotencyIndex.get(item.idempotencyKey);
    if (existing) return { ok: true, record: existing };
  }

  const resultHash = hashJobResult({
    taskId: item.taskId,
    exitCode: item.exitCode ?? 0,
    executionTimeMs: item.executionTimeMs ?? 0,
    stdout: item.stdout,
  });

  const { receipts, errors } = await settleOnChains(["tempo"], {
    agentId,
    agentWallet,
    taskId: item.taskId,
    resultHash,
    amountUsdc: item.amountUsdc,
    creditScore,
    trustScore,
  });

  if (receipts.length === 0) {
    return { ok: false, taskId: item.taskId, error: errors[0]?.error ?? "Settlement failed" };
  }

  const receipt = receipts[0];
  const record: SettlementRecord = {
    agentId,
    taskId: item.taskId,
    txSig: receipt.txSig,
    explorerUrl: receipt.explorerUrl,
    amountUsdc: item.amountUsdc,
    resultHash: receipt.receiptHash,
    invoiceRef: item.invoiceRef,
    idempotencyKey: item.idempotencyKey,
    at: new Date().toISOString(),
  };
  history.unshift(record);
  if (history.length > 500) history.length = 500;
  if (item.idempotencyKey) idempotencyIndex.set(item.idempotencyKey, record);

  return { ok: true, record };
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("tempo-settlement mod loaded");
  },

  routes: {
    /**
     * POST /settle — same contract as the Solana mod's /settle, routed to
     * Tempo instead. Tempo has no Swarm AgentRegistry deployed yet, so
     * EvmSettlementAdapter falls back to its calldata-memo path — payment
     * and receipt still land in one transaction, just without the on-chain
     * reputation write until a contract is deployed there.
     *
     * Body: { orgId, agentId, agentWallet, taskId, exitCode, executionTimeMs,
     *         stdout?, amountUsdc, creditScore, trustScore, invoiceRef?,
     *         idempotencyKey? }
     *
     * Requires the calling agent to hold the "tempo-settle" capability.
     * orgId/agentId fall back to the body only for browser-session calls —
     * a verified agent signature (ctx.agent) always takes precedence.
     */
    "POST /settle": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { agentWallet, taskId, exitCode, executionTimeMs, stdout, amountUsdc, creditScore, trustScore, invoiceRef, idempotencyKey } = body;

      if (!orgId || !agentId || !agentWallet || !taskId || amountUsdc == null) {
        return Response.json({ error: "orgId, agentId, agentWallet, taskId, amountUsdc are required" }, { status: 400 });
      }

      try {
        await enforceCapability(agentId, orgId, "tempo-settle");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const result = await settleOne(agentId, agentWallet, creditScore ?? 680, trustScore ?? 50, {
        taskId, exitCode, executionTimeMs, stdout, amountUsdc, invoiceRef, idempotencyKey,
      });

      if (!result.ok) return Response.json({ error: "Settlement failed", details: result.error }, { status: 502 });
      return Response.json({ receipt: result.record });
    },

    /**
     * POST /settle/batch — settle several completed jobs from the same
     * agent in ONE atomic Tempo transaction (via the `calls` array on a
     * Tempo transaction — every transfer+memo either all lands or all
     * revert together), instead of N sequential transactions. Items with a
     * previously-used idempotencyKey are resolved from history and skipped
     * on-chain rather than re-settled.
     *
     * Body: { orgId, agentId, agentWallet, settlements: SettleItem[] }
     */
    "POST /settle/batch": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { agentWallet, settlements } = body;

      if (!orgId || !agentId || !agentWallet || !Array.isArray(settlements) || settlements.length === 0) {
        return Response.json({ error: "orgId, agentId, agentWallet, settlements[] are required" }, { status: 400 });
      }
      if (settlements.length > 25) {
        return Response.json({ error: "Batch is limited to 25 settlements per call" }, { status: 400 });
      }
      if (settlements.some((s: SettleItem) => !s.taskId || s.amountUsdc == null)) {
        return Response.json({ error: "Every settlement needs taskId and amountUsdc" }, { status: 400 });
      }

      try {
        await enforceCapability(agentId, orgId, "tempo-settle");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const items = settlements as SettleItem[];
      const already = new Map<string, SettlementRecord>();
      const pending = items.filter((item) => {
        if (!item.idempotencyKey) return true;
        const existing = idempotencyIndex.get(item.idempotencyKey);
        if (existing) already.set(item.taskId, existing);
        return !existing;
      });

      const resultHashes = pending.map((item) => ({
        item,
        resultHash: hashJobResult({
          taskId: item.taskId,
          exitCode: item.exitCode ?? 0,
          executionTimeMs: item.executionTimeMs ?? 0,
          stdout: item.stdout,
        }),
      }));

      let receipts: SettlementRecord[] = [...already.values()];
      let batchError: string | null = null;

      if (resultHashes.length > 0) {
        try {
          const { txSig, explorerUrl } = await tempoAdapter.settleBatch(
            agentWallet,
            resultHashes.map(({ resultHash, item }) => ({ resultHash, amountUsdc: item.amountUsdc })),
          );
          for (const { item, resultHash } of resultHashes) {
            const record: SettlementRecord = {
              agentId, taskId: item.taskId, txSig, explorerUrl,
              amountUsdc: item.amountUsdc, resultHash, invoiceRef: item.invoiceRef,
              idempotencyKey: item.idempotencyKey, at: new Date().toISOString(),
            };
            history.unshift(record);
            if (item.idempotencyKey) idempotencyIndex.set(item.idempotencyKey, record);
            receipts.push(record);
          }
          if (history.length > 500) history.length = 500;
        } catch (err) {
          batchError = (err as Error).message;
        }
      }

      if (batchError) return Response.json({ error: "Batch settlement failed", details: batchError }, { status: 502 });
      return Response.json({ receipts, settled: receipts.length, batchTxSig: receipts.find((r) => !already.has(r.taskId))?.txSig ?? null });
    },

    /**
     * POST /meter/accrue — record a micro-charge against an agent's pending
     * balance without touching the chain. Call this once per request/tick;
     * call /meter/flush periodically (or above a threshold) to commit the
     * accrued total as a single settlement.
     *
     * Body: { orgId, agentId, amountUsdc, taskId }
     */
    "POST /meter/accrue": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { amountUsdc, taskId } = body;

      if (!orgId || !agentId || amountUsdc == null || !taskId) {
        return Response.json({ error: "orgId, agentId, amountUsdc, taskId are required" }, { status: 400 });
      }

      try {
        await enforceCapability(agentId, orgId, "tempo-settle");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const entry: MeterEntry = meters.get(agentId) ?? { agentId, orgId, pendingUsdc: 0, taskIds: [] };
      entry.pendingUsdc += amountUsdc;
      entry.taskIds.push(taskId);
      meters.set(agentId, entry);

      return Response.json({ agentId, pendingUsdc: entry.pendingUsdc, meteredTasks: entry.taskIds.length });
    },

    /** GET /meter/:agentId — view an agent's accrued, not-yet-settled balance. */
    "GET /meter/:agentId": (_req, { params }) => {
      const entry = meters.get(params.agentId);
      return Response.json({
        agentId: params.agentId,
        pendingUsdc: entry?.pendingUsdc ?? 0,
        meteredTasks: entry?.taskIds.length ?? 0,
      });
    },

    /**
     * POST /meter/flush/:agentId — settle the agent's entire pending meter
     * balance in one on-chain transaction, then clear it.
     *
     * Body: { agentWallet, creditScore?, trustScore? }
     */
    "POST /meter/flush/:agentId": async (req, { params }) => {
      const body = await req.json();
      const { agentWallet, creditScore, trustScore } = body;
      const entry = meters.get(params.agentId);

      if (!entry || entry.pendingUsdc <= 0) {
        return Response.json({ error: "Nothing accrued for this agent" }, { status: 400 });
      }
      if (!agentWallet) {
        return Response.json({ error: "agentWallet is required" }, { status: 400 });
      }

      try {
        await enforceCapability(params.agentId, entry.orgId, "tempo-settle");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const flushTaskId = `meter:${params.agentId}:${Date.now()}`;
      const result = await settleOne(params.agentId, agentWallet, creditScore ?? 680, trustScore ?? 50, {
        taskId: flushTaskId,
        amountUsdc: entry.pendingUsdc,
        executionTimeMs: 0,
        exitCode: 0,
        stdout: `meter flush: ${entry.taskIds.length} accrued charge(s)`,
      });

      if (!result.ok) return Response.json({ error: "Flush failed", details: result.error }, { status: 502 });

      meters.delete(params.agentId);
      return Response.json({ receipt: result.record, flushedTaskCount: entry.taskIds.length });
    },

    /**
     * POST /void/:txSig — mark a past settlement as voided/disputed. The
     * on-chain transaction is permanent; this only removes it from totals,
     * stats, and default history so an operator can flag a bad settlement
     * (wrong amount, disputed job, etc.) without hiding the record.
     *
     * Body: { reason }
     */
    "POST /void/:txSig": async (req, { params }) => {
      const record = history.find((h) => h.txSig === params.txSig);
      if (!record) return Response.json({ error: "No local record of this tx" }, { status: 404 });

      const body = await req.json().catch(() => ({}));
      record.void = true;
      record.voidReason = body.reason || "unspecified";

      return Response.json({ ok: true, record });
    },

    /**
     * GET /history — optionally filtered/paginated. Query params: agentId,
     * taskId, since (ISO timestamp), limit (default 20, max 100),
     * includeVoid (default false).
     */
    "GET /history": (req) => {
      const url = new URL(req.url);
      const agentId = url.searchParams.get("agentId");
      const taskId = url.searchParams.get("taskId");
      const since = url.searchParams.get("since");
      const includeVoid = url.searchParams.get("includeVoid") === "true";
      const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);

      const rows = history.filter((h) => {
        if (!includeVoid && h.void) return false;
        if (agentId && h.agentId !== agentId) return false;
        if (taskId && h.taskId !== taskId) return false;
        if (since && h.at < since) return false;
        return true;
      });

      return Response.json({ history: rows.slice(0, limit), total: rows.length });
    },

    /** GET /agent/:agentId/total — lifetime USDC earned by one agent on Tempo (excludes voided). */
    "GET /agent/:agentId/total": (_req, { params }) => {
      const rows = history.filter((h) => h.agentId === params.agentId && !h.void);
      return Response.json({ agentId: params.agentId, totalUsdc: rows.reduce((s, h) => s + h.amountUsdc, 0), settlementCount: rows.length });
    },

    /** GET /stats — aggregate settlement analytics across all agents. */
    "GET /stats": () => {
      const live = history.filter((h) => !h.void);
      const byAgent = new Map<string, { agentId: string; totalUsdc: number; count: number }>();
      for (const h of live) {
        const entry = byAgent.get(h.agentId) ?? { agentId: h.agentId, totalUsdc: 0, count: 0 };
        entry.totalUsdc += h.amountUsdc;
        entry.count += 1;
        byAgent.set(h.agentId, entry);
      }
      const topAgents = [...byAgent.values()].sort((a, b) => b.totalUsdc - a.totalUsdc).slice(0, 5);
      const totalUsdc = live.reduce((s, h) => s + h.amountUsdc, 0);

      return Response.json({
        settlementCount: live.length,
        voidCount: history.length - live.length,
        totalUsdc,
        avgUsdc: live.length ? totalUsdc / live.length : 0,
        uniqueAgents: byAgent.size,
        topAgents,
      });
    },

    /** GET /export — settlement history as a CSV file for accounting/reconciliation. */
    "GET /export": () => {
      const header = "agentId,taskId,txSig,amountUsdc,resultHash,invoiceRef,void,voidReason,at";
      const rows = history.map((h) =>
        [h.agentId, h.taskId, h.txSig, h.amountUsdc, h.resultHash, h.invoiceRef ?? "", h.void ? "true" : "false", h.voidReason ?? "", h.at]
          .map((v) => csvEscape(String(v)))
          .join(","),
      );
      const csv = [header, ...rows].join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="tempo-settlements.csv"',
        },
      });
    },

    /** GET /estimate — current Tempo network fee estimate, so a caller can budget before settling. */
    "GET /estimate": async () => {
      const chain = getChain("tempo");
      if (!chain) return Response.json({ error: "Unknown chain: tempo" }, { status: 500 });
      try {
        const provider = new ethers.JsonRpcProvider(chain.rpc);
        const fee = await provider.getFeeData();
        return Response.json({
          chain: "tempo",
          gasPrice: fee.gasPrice?.toString() ?? null,
          maxFeePerGas: fee.maxFeePerGas?.toString() ?? null,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas?.toString() ?? null,
        });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /balance/:wallet — live USDC balance, no signing key needed. */
    "GET /balance/:wallet": async (_req, { params }) => {
      try {
        return Response.json(await getBalance("tempo", params.wallet));
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /verify/:txSig — re-reads the tx from Tempo and checks the calldata memo. */
    "GET /verify/:txSig": async (_req, { params }) => {
      const record = history.find((h) => h.txSig === params.txSig);
      if (!record) return Response.json({ error: "No local record of this tx" }, { status: 404 });
      try {
        return Response.json(await verifyReceipt("tempo", params.txSig, record.resultHash));
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /invoice/:ref — look up settlements by Tempo's invoice reconciliation metadata. */
    "GET /invoice/:ref": (_req, { params }) => {
      const matches = history.filter((h) => h.invoiceRef === params.ref);
      return Response.json({ invoiceRef: params.ref, settlements: matches, totalUsdc: matches.reduce((s, h) => s + h.amountUsdc, 0) });
    },

    /**
     * GET /paid/ping — demonstrates Tempo's Machine Payments Protocol (MPP):
     * an anonymous machine client can pay for this resource inline, in one
     * HTTP round trip (request → 402 challenge → paid retry → 200 + receipt),
     * with no session, API key, or signup. `public: true` because that
     * caller has no platform session — MPP's own challenge/credential
     * verification is the auth. This endpoint only ever RECEIVES payment;
     * it never spends funds or calls out to a caller-supplied URL.
     *
     * Requires MPP_SECRET_KEY (from an mpp.dev account) and either
     * TEMPO_MPP_RECIPIENT or TEMPO_TREASURY_ADDRESS to be configured;
     * returns 501 with a clear reason otherwise.
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
