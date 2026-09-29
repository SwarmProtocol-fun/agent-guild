import { defineServerMod } from "@swarm/sdk";
import { settleOnChains, hashJobResult, getBalance, verifyReceipt } from "@/lib/settlement/registry";
import { enforceCapability } from "@/lib/skills";

interface SettlementRecord {
  agentId: string;
  taskId: string;
  txSig: string;
  explorerUrl: string;
  amountUsdc: number;
  resultHash: string;
  at: string;
}

// In-memory for the demo panel — per-mod persistent storage isn't built yet
// (see docs/mod-sdk.md "Not built yet"). Swap for a real store post-hackathon.
const history: SettlementRecord[] = [];

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

      if (!orgId || !agentId || !agentWallet || !taskId || amountUsdc == null) {
        return Response.json({ error: "orgId, agentId, agentWallet, taskId, amountUsdc are required" }, { status: 400 });
      }

      try {
        await enforceCapability(agentId, orgId, "solana-settle");
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 403 });
      }

      const resultHash = hashJobResult({ taskId, exitCode: exitCode ?? 0, executionTimeMs: executionTimeMs ?? 0, stdout });

      const { receipts, errors } = await settleOnChains(["solana"], {
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
        amountUsdc, resultHash: receipt.receiptHash, at: new Date().toISOString(),
      });
      if (history.length > 50) history.length = 50;

      return Response.json({ receipt });
    },

    "GET /history": () => ({ history: history.slice(0, 20) }),

    /** GET /agent/:agentId/total — lifetime USDC earned by one agent on Solana. */
    "GET /agent/:agentId/total": (_req, { params }) => {
      const total = history
        .filter((h) => h.agentId === params.agentId)
        .reduce((sum, h) => sum + h.amountUsdc, 0);
      return Response.json({ agentId: params.agentId, totalUsdc: total, settlementCount: history.filter((h) => h.agentId === params.agentId).length });
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
    "GET /verify/:txSig": async (_req, { params }) => {
      const record = history.find((h) => h.txSig === params.txSig);
      if (!record) return Response.json({ error: "No local record of this tx" }, { status: 404 });
      try {
        const result = await verifyReceipt("solana", params.txSig, record.resultHash);
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },
  },
});
