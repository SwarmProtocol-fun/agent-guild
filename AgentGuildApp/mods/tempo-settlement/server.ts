import { defineServerMod } from "@agent-guild/sdk";
import { settleOnChains, hashJobResult, getBalance, verifyReceipt } from "@/lib/settlement/registry";
import { enforceCapability } from "@/lib/skills";

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
  at: string;
}

// In-memory for the demo panel — see solana-settlement mod for the same note.
const history: SettlementRecord[] = [];

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
     *         stdout?, amountUsdc, creditScore, trustScore, invoiceRef? }
     *
     * Requires the calling agent to hold the "tempo-settle" capability.
     * orgId/agentId fall back to the body only for browser-session calls —
     * a verified agent signature (ctx.agent) always takes precedence.
     */
    "POST /settle": async (req, ctx) => {
      const body = await req.json();
      const agentId = ctx.agent?.agentId ?? body.agentId;
      const orgId = ctx.agent?.orgId ?? body.orgId;
      const { agentWallet, taskId, exitCode, executionTimeMs, stdout, amountUsdc, creditScore, trustScore, invoiceRef } = body;

      if (!orgId || !agentId || !agentWallet || !taskId || amountUsdc == null) {
        return Response.json({ error: "orgId, agentId, agentWallet, taskId, amountUsdc are required" }, { status: 400 });
      }

      try {
        await enforceCapability(agentId, orgId, "tempo-settle");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const resultHash = hashJobResult({ taskId, exitCode: exitCode ?? 0, executionTimeMs: executionTimeMs ?? 0, stdout });

      const { receipts, errors } = await settleOnChains(["tempo"], {
        agentId,
        agentWallet,
        taskId,
        resultHash,
        amountUsdc,
        creditScore: creditScore ?? 680,
        trustScore: trustScore ?? 50,
      });

      if (receipts.length === 0) {
        return Response.json({ error: "Settlement failed", details: errors }, { status: 502 });
      }

      const receipt = receipts[0];
      history.unshift({
        agentId, taskId, txSig: receipt.txSig, explorerUrl: receipt.explorerUrl,
        amountUsdc, resultHash: receipt.receiptHash, invoiceRef, at: new Date().toISOString(),
      });
      if (history.length > 50) history.length = 50;

      return Response.json({ receipt });
    },

    "GET /history": () => ({ history: history.slice(0, 20) }),

    /** GET /agent/:agentId/total — lifetime USDC earned by one agent on Tempo. */
    "GET /agent/:agentId/total": (_req, { params }) => {
      const rows = history.filter((h) => h.agentId === params.agentId);
      return Response.json({ agentId: params.agentId, totalUsdc: rows.reduce((s, h) => s + h.amountUsdc, 0), settlementCount: rows.length });
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
  },
});
