import { EvmIdentityAdapter } from "./evm-adapter";
import { SolanaIdentityAdapter } from "./solana-adapter";
import type { IdentityAdapter, IdentityMintReceipt, MintIdentityParams } from "./types";

export type { MintIdentityParams, IdentityMintReceipt };

const adapters: Record<string, IdentityAdapter> = {
  solana: new SolanaIdentityAdapter(),
  hyperliquid: new EvmIdentityAdapter("hyperliquid"),
};

export function supportedIdentityChains(): string[] {
  return Object.keys(adapters);
}

/**
 * Mints an agent's ASN identity NFT on several chains at once — "birth" on
 * whichever chain(s) the caller chose (see register/route.ts). A failure on
 * one chain doesn't block the others; callers get a receipt per chain that
 * succeeded and an error per chain that didn't. An adapter returning null
 * (already minted there) is silently skipped, not treated as a failure.
 */
export async function mintIdentityOnChains(
  chains: string[],
  params: MintIdentityParams,
): Promise<{ receipts: IdentityMintReceipt[]; errors: { chain: string; error: string }[] }> {
  const results = await Promise.allSettled(
    chains.map(async (chain) => {
      const adapter = adapters[chain];
      if (!adapter) throw new Error(`Unsupported identity chain: ${chain}`);
      return adapter.mintIdentity(params);
    }),
  );

  const receipts: IdentityMintReceipt[] = [];
  const errors: { chain: string; error: string }[] = [];

  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      if (r.value) receipts.push(r.value);
    } else {
      errors.push({ chain: chains[i], error: r.reason?.message ?? String(r.reason) });
    }
  });

  return { receipts, errors };
}
