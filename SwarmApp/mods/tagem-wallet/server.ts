import { ethers } from "ethers";
import { Connection, PublicKey } from "@solana/web3.js";
import { defineServerMod } from "@swarm/sdk";
import { ENABLED_CHAINS, getChain, type ChainConfig } from "@/lib/chains";
import { getBalance as getSolanaSettlementBalance } from "@/lib/settlement/registry";

const ERC20_ABI = ["function balanceOf(address account) view returns (uint256)"];

// Same devnet-USDC default src/lib/settlement/solana-adapter.ts uses —
// override with SOLANA_USDC_MINT for a different cluster/mint.
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

interface ChainBalance {
  chainKey: string;
  chainId: number;
  name: string;
  logo: string;
  explorerAddressUrl: string;
  native: { symbol: string; decimals: number; balance: string };
  usdc: { balance: string } | null;
  error?: string;
}

interface ActivityEntry {
  chainKey: string;
  chainName: string;
  asset: string;
  to: string;
  amount: string;
  txHash: string;
  explorerTxUrl: string;
  at: string;
}

/**
 * Read-only balance check, no signing key involved — the same public-RPC
 * pattern src/lib/settlement/evm-adapter.ts's getBalance() already uses for
 * the platform's own settlement wallet, applied here to whatever address is
 * signed in.
 */
async function readChainBalance(chain: ChainConfig, address: string): Promise<ChainBalance> {
  const base = {
    chainKey: chain.key,
    chainId: chain.chainId,
    name: chain.name,
    logo: chain.logo,
    explorerAddressUrl: chain.explorer.addressUrl(address),
  };
  try {
    const provider = new ethers.JsonRpcProvider(chain.rpc);
    const nativeRaw = await provider.getBalance(address);
    const native = {
      symbol: chain.nativeCurrency.symbol,
      decimals: chain.nativeCurrency.decimals,
      balance: ethers.formatUnits(nativeRaw, chain.nativeCurrency.decimals),
    };

    let usdc: ChainBalance["usdc"] = null;
    if (chain.contracts.usdc) {
      const token = new ethers.Contract(chain.contracts.usdc, ERC20_ABI, provider);
      const raw: bigint = await token.balanceOf(address);
      usdc = { balance: ethers.formatUnits(raw, 6) };
    }

    return { ...base, native, usdc };
  } catch (err) {
    return {
      ...base,
      native: { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals, balance: "0" },
      usdc: null,
      error: (err as Error).message,
    };
  }
}

// In-memory for now — per-mod persistent storage isn't built yet (see
// docs/mod-sdk.md "Not built yet"). Scoped per signed-in address, capped,
// and reset whenever this server process restarts — same tradeoff the
// solana-settlement mod's `history` array already accepts.
const activityLog = new Map<string, ActivityEntry[]>();

export default defineServerMod({
  setup(ctx) {
    ctx.log.info("tagem-wallet mod loaded");
  },

  routes: {
    /**
     * GET /balances — native + USDC balance across every enabled EVM chain
     * in the registry, for the signed-in wallet. Solana (chainId 0 sentinel
     * in CHAIN_CONFIGS) is a separate namespace/connection — see
     * GET /solana-balance/:pubkey below.
     */
    "GET /balances": async (_req, { session }) => {
      const address = session!.address;
      const evmChains = ENABLED_CHAINS.filter((c) => c.chainId > 0);
      const balances = await Promise.all(evmChains.map((c) => readChainBalance(c, address)));
      return Response.json({ address, balances });
    },

    /**
     * GET /solana-balance/:pubkey — SOL + USDC(-Dev) balance for any Solana
     * address, same "public read, still signed-in" convention the
     * solana-settlement mod's /balance/:wallet already uses. Not tied to
     * the signed-in EVM session identity — Solana and EVM are separate
     * WalletConnect namespaces on the same connection (see
     * src/lib/wallet/solana.ts) — the client passes whichever Solana
     * pubkey it has connected.
     */
    "GET /solana-balance/:pubkey": async (_req, { params }) => {
      const chain = getChain("solana");
      if (!chain) return Response.json({ error: "Solana chain not configured" }, { status: 503 });
      try {
        const pubkey = new PublicKey(params.pubkey);
        const connection = new Connection(chain.rpc, "confirmed");
        const [lamports, { usdc }] = await Promise.all([
          connection.getBalance(pubkey),
          getSolanaSettlementBalance("solana", params.pubkey),
        ]);
        return Response.json({
          sol: lamports / 1_000_000_000,
          usdc,
          usdcMint: process.env.SOLANA_USDC_MINT || DEVNET_USDC_MINT,
          explorerAddressUrl: chain.explorer.addressUrl(params.pubkey),
        });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 502 });
      }
    },

    /** GET /activity — recent sends this mod has recorded for the signed-in wallet. */
    "GET /activity": (_req, { session }) => ({
      activity: activityLog.get(session!.address) ?? [],
    }),

    /**
     * POST /activity — logs a send the client already broadcast itself, via
     * wagmi and the connected wallet (a Tangem card tap approves the actual
     * signature in the Tangem app). This route never signs or submits
     * anything; it only records what already happened, for the panel's
     * activity list. Body: { chainKey, chainName, asset, to, amount, txHash, explorerTxUrl }
     */
    "POST /activity": async (req, { session }) => {
      const body = await req.json();
      const { chainKey, chainName, asset, to, amount, txHash, explorerTxUrl } = body;
      if (!chainKey || !asset || !to || !amount || !txHash) {
        return Response.json(
          { error: "chainKey, asset, to, amount, txHash are required" },
          { status: 400 },
        );
      }
      const address = session!.address;
      const entry: ActivityEntry = {
        chainKey, chainName, asset, to, amount, txHash, explorerTxUrl,
        at: new Date().toISOString(),
      };
      const existing = activityLog.get(address) ?? [];
      existing.unshift(entry);
      if (existing.length > 30) existing.length = 30;
      activityLog.set(address, existing);
      return Response.json({ ok: true });
    },
  },
});
