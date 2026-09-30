import { createHash } from "node:crypto";
import { EvmSettlementAdapter } from "./evm-adapter";
import { SolanaSettlementAdapter } from "./solana-adapter";
import type { SettleJobParams, SettlementAdapter, SettlementReceipt, VerifyResult } from "./types";

export type { SettleJobParams, SettlementReceipt, VerifyResult };

const adapters: Record<string, SettlementAdapter> = {
  base: new EvmSettlementAdapter("base"),
  baseSepolia: new EvmSettlementAdapter("baseSepolia"),
  sepolia: new EvmSettlementAdapter("sepolia"),
  tempo: new EvmSettlementAdapter("tempo"),
  solana: new SolanaSettlementAdapter(),
};

export function supportedChains(): string[] {
  return Object.keys(adapters);
}

/** Deterministic receipt hash for a completed job — same shape every chain commits. */
export function hashJobResult(result: { taskId: string; exitCode: number; executionTimeMs: number; stdout?: string }): string {
  const payload = `${result.taskId}:${result.exitCode}:${result.executionTimeMs}:${result.stdout ?? ""}`;
  return createHash("sha256").update(payload).digest("hex");
}

// taskId → chains already settled for it. In-memory only (see the mods'
// own "not built yet" note on persistent storage) — good enough to stop a
// double-click or a retried webhook from double-paying within one process
// lifetime; a real deployment should back this with the audit log instead.
const settledTaskChains = new Map<string, Set<string>>();

/**
 * Settle one job/trade completion on several chains in parallel. A failure
 * on one chain doesn't block the others — callers get a receipt per chain
 * that succeeded and an error per chain that didn't. Re-settling the same
 * taskId on a chain it already settled on is rejected rather than paying
 * twice; pass `force: true` in a caller-side retry only after confirming
 * the first attempt actually failed on-chain.
 */
export async function settleOnChains(
  chains: string[],
  params: SettleJobParams,
  opts: { force?: boolean } = {},
): Promise<{ receipts: SettlementReceipt[]; errors: { chain: string; error: string }[] }> {
  const alreadySettled = settledTaskChains.get(params.taskId) ?? new Set<string>();

  const results = await Promise.allSettled(
    chains.map(async (chain) => {
      const adapter = adapters[chain];
      if (!adapter) throw new Error(`Unsupported chain: ${chain}`);
      if (!opts.force && alreadySettled.has(chain)) {
        throw new Error(`taskId ${params.taskId} already settled on ${chain} — pass force to re-settle`);
      }
      const receipt = await adapter.settleJob(params);
      alreadySettled.add(chain);
      return receipt;
    }),
  );

  settledTaskChains.set(params.taskId, alreadySettled);

  const receipts: SettlementReceipt[] = [];
  const errors: { chain: string; error: string }[] = [];

  results.forEach((r, i) => {
    if (r.status === "fulfilled") receipts.push(r.value);
    else errors.push({ chain: chains[i], error: r.reason?.message ?? String(r.reason) });
  });

  return { receipts, errors };
}

export async function getBalance(chain: string, wallet: string): Promise<{ usdc: number }> {
  const adapter = adapters[chain];
  if (!adapter) throw new Error(`Unsupported chain: ${chain}`);
  return adapter.getBalance(wallet);
}

export async function verifyReceipt(chain: string, txSig: string, resultHash: string): Promise<VerifyResult> {
  const adapter = adapters[chain];
  if (!adapter) throw new Error(`Unsupported chain: ${chain}`);
  return adapter.verifyReceipt(txSig, resultHash);
}
