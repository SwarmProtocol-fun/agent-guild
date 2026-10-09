import { decodeEventLog, getAbiItem, isAddress, type Hex } from "viem";
import { Abis, Account, Actions, createClient, http, withRelay } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";
import { getChain } from "@/lib/chains";
import type { EvmChainParams } from "@/lib/wallet/types";
import type { SettleJobParams, SettlementAdapter, SettlementReceipt, VerifyResult } from "./types";

/**
 * Tempo-native settlement adapter — unlike EvmSettlementAdapter (used for
 * base/baseSepolia/sepolia), this talks to Tempo's actual protocol surface
 * via viem/tempo instead of treating it as a generic EVM chain:
 *
 *  - The receipt hash rides in a TIP-20 `transferWithMemo` call (a real
 *    on-chain field, emitted in the `TransferWithMemo` event) instead of a
 *    second calldata-only transaction.
 *  - Gas is paid in USDC (`feeToken`) instead of requiring the platform
 *    wallet to hold native TEMPO.
 *  - Optional fee sponsorship (`feePayer`) — either a local sponsor account
 *    (TEMPO_FEE_PAYER_KEY) or Tempo's relay service (TEMPO_FEE_PAYER_URL,
 *    e.g. the public testnet sponsor) — so the platform wallet doesn't need
 *    to hold *any* balance to settle jobs.
 *
 * The Tempo Payouts mod doesn't sign anything here: org owners pay from
 * their own wallets, and the mod only uses the read side (payoutToken,
 * findMemoTransfer) to check those payments landed.
 */

export interface TempoPayoutToken {
  network: string;
  /** What the owner's wallet switches to (or adds) before paying. */
  chain: EvmChainParams;
  /** TIP-20 token payouts are sent in (TEMPO_USDC_ADDRESS). */
  token: string | null;
  tokenSymbol: string | null;
  decimals: number;
  /** The holder's balance of `token`, when one was asked for. */
  balance: number | null;
  /** Env vars that must be set before payouts can be sent. */
  missing: string[];
  error: string | null;
}

/** A TIP-20 TransferWithMemo found on-chain. */
export interface MemoTransfer {
  from: Hex;
  to: Hex;
  amount: bigint;
  memo: Hex;
  txHash: Hex;
  blockNumber: bigint;
}

const LOG_WINDOW = 100_000n;
/** ~60 days of Tempo blocks; older reservations need the tx hash. */
const MAX_LOG_WINDOWS = 100;

const TRANSFER_WITH_MEMO = getAbiItem({ abi: Abis.tip20, name: "TransferWithMemo" });

function decodeMemoLog(log: { data: Hex; topics: [Hex, ...Hex[]] | [] }) {
  try {
    const d = decodeEventLog({ abi: [TRANSFER_WITH_MEMO], data: log.data, topics: log.topics });
    const a = d.args as { from: Hex; to: Hex; amount: bigint; memo: Hex };
    return { from: a.from, to: a.to, amount: a.amount, memo: a.memo };
  } catch {
    return null;
  }
}

function readClient() {
  const chain = getChain("tempo");
  if (!chain) throw new Error("Unknown chain: tempo");
  return createClient({ chain: tempoModerato, transport: http(chain.rpc) });
}

function writeClient(privateKey: Hex, feeToken?: Hex) {
  const chain = getChain("tempo");
  if (!chain) throw new Error("Unknown chain: tempo");

  const feePayerUrl = process.env.TEMPO_FEE_PAYER_URL;
  const transport = feePayerUrl ? withRelay(http(chain.rpc), http(feePayerUrl)) : http(chain.rpc);

  return createClient({
    account: Account.fromSecp256k1(privateKey),
    chain: tempoModerato,
    transport,
    feeToken,
  });
}

function feePayerFor(feePayerUrl: string | undefined): true | undefined {
  return feePayerUrl ? true : undefined;
}

export class TempoSettlementAdapter implements SettlementAdapter {
  async settleJob(p: SettleJobParams): Promise<SettlementReceipt> {
    const chain = getChain("tempo");
    if (!chain) throw new Error("Unknown chain: tempo");
    if (!chain.contracts.usdc) throw new Error("TEMPO_USDC_ADDRESS not configured");

    const privateKey = process.env.PLATFORM_SETTLEMENT_KEY as Hex | undefined;
    if (!privateKey) throw new Error("PLATFORM_SETTLEMENT_KEY not configured");

    const usdc = chain.contracts.usdc as Hex;
    const feeToken = (process.env.TEMPO_FEE_TOKEN as Hex | undefined) ?? usdc;
    const feePayerKey = process.env.TEMPO_FEE_PAYER_KEY as Hex | undefined;
    const feePayerUrl = process.env.TEMPO_FEE_PAYER_URL;

    const client = writeClient(privateKey, feeToken);

    const result = await Actions.token.transferSync(client, {
      to: p.agentWallet as Hex,
      amount: { formatted: p.amountUsdc.toString() },
      token: usdc,
      memo: `0x${p.resultHash}` as Hex,
      feePayer: feePayerKey ? Account.fromSecp256k1(feePayerKey) : feePayerFor(feePayerUrl),
    });

    return {
      chain: "tempo",
      txSig: result.receipt.transactionHash,
      receiptHash: p.resultHash,
      explorerUrl: chain.explorer.txUrl(result.receipt.transactionHash),
      // No AgentRegistry deployed on Tempo yet — same caveat as the EVM
      // adapter's fallback path.
      reputationUpdated: false,
    };
  }

  /**
   * What the payouts panel needs before the org owner pays from their own
   * wallet: the chain to switch to, the token, and (given `holder`) how much
   * of it that wallet has. Never throws — problems come back in `missing`/`error`.
   */
  async payoutToken(holder?: string): Promise<TempoPayoutToken> {
    const chain = getChain("tempo");
    const missing: string[] = [];
    if (!chain?.contracts.usdc) missing.push("TEMPO_USDC_ADDRESS");

    const info: TempoPayoutToken = {
      network: chain?.name ?? "Tempo",
      chain: {
        chainId: tempoModerato.id,
        name: chain?.name ?? tempoModerato.name,
        rpcUrl: chain?.rpc ?? tempoModerato.rpcUrls.default.http[0],
        nativeCurrency: tempoModerato.nativeCurrency,
        explorerUrl: chain?.explorer.baseUrl,
      },
      token: chain?.contracts.usdc ?? null,
      tokenSymbol: null,
      decimals: 6,
      balance: null,
      missing,
      error: null,
    };
    if (!chain?.contracts.usdc) return info;

    const client = readClient();
    const token = chain.contracts.usdc as Hex;
    const [meta, balance] = await Promise.allSettled([
      Actions.token.getMetadata(client, { token }),
      holder && isAddress(holder) ? Actions.token.getBalance(client, { account: holder as Hex, token }) : Promise.resolve(null),
    ]);
    if (meta.status === "fulfilled") {
      info.tokenSymbol = meta.value.symbol;
      info.decimals = meta.value.decimals ?? 6;
    }
    if (balance.status === "fulfilled" && balance.value) info.balance = Number(balance.value.formatted);
    const failed = [meta, balance].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) info.error = (failed.reason as Error)?.message ?? "Tempo RPC unreachable";
    return info;
  }

  async blockNumber(): Promise<bigint> {
    return readClient().getBlockNumber();
  }

  /**
   * Find a TIP-20 transfer of the payout token that carries `memo`, went to
   * `to`, and moved at least `minAmount` base units. Memos aren't unique
   * on-chain — anyone can copy one — so a match on memo alone proves
   * nothing; only a transfer that actually paid the recipient in full counts.
   *
   * With a tx hash, only that transaction is read. Without one, the token's
   * TransferWithMemo logs are searched (memo and recipient are indexed
   * topics) from `fromBlock`, so a payment whose hash the browser lost is
   * still found.
   */
  async findMemoTransfer(p: { memo: Hex; to: string; minAmount: bigint; txHash?: Hex; fromBlock?: bigint }): Promise<MemoTransfer | null> {
    const chain = getChain("tempo");
    if (!chain?.contracts.usdc) throw new Error("TEMPO_USDC_ADDRESS not configured");
    const token = (chain.contracts.usdc as string).toLowerCase();
    const client = readClient();
    const pays = (t: { to: Hex; amount: bigint; memo: Hex }) =>
      t.memo.toLowerCase() === p.memo.toLowerCase() && t.to.toLowerCase() === p.to.toLowerCase() && t.amount >= p.minAmount;

    if (p.txHash) {
      const receipt = await client.getTransactionReceipt({ hash: p.txHash }).catch(() => null);
      if (!receipt || receipt.status !== "success") return null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== token) continue;
        const decoded = decodeMemoLog(log);
        if (decoded && pays(decoded)) return { ...decoded, txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
      }
      return null;
    }

    // The public RPC caps eth_getLogs at 100k blocks (~14h at Tempo's block
    // time), so walk forward from when the payment started, window by window.
    if (p.fromBlock == null) throw new Error("fromBlock is required to search by memo");
    const head = await client.getBlockNumber();
    for (let from = p.fromBlock, windows = 0; from <= head; from += LOG_WINDOW, windows++) {
      if (windows >= MAX_LOG_WINDOWS) throw new Error("Payment started too long ago to search for — pass the transaction hash");
      const to = from + LOG_WINDOW - 1n < head ? from + LOG_WINDOW - 1n : head;
      const logs = await client.getLogs({
        address: token as Hex, event: TRANSFER_WITH_MEMO, args: { to: p.to as Hex, memo: p.memo }, fromBlock: from, toBlock: to,
      });
      for (const log of logs) {
        const t = { from: log.args.from!, to: log.args.to!, amount: log.args.amount!, memo: log.args.memo! };
        if (log.transactionHash && log.blockNumber != null && pays(t)) return { ...t, txHash: log.transactionHash, blockNumber: log.blockNumber };
      }
    }
    return null;
  }

  async getBalance(wallet: string): Promise<{ usdc: number }> {
    const chain = getChain("tempo");
    if (!chain?.contracts.usdc) return { usdc: 0 };
    const balance = await Actions.token.getBalance(readClient(), {
      account: wallet as Hex,
      token: chain.contracts.usdc as Hex,
    });
    return { usdc: Number(balance.formatted) };
  }

  async verifyReceipt(txSig: string, resultHash: string): Promise<VerifyResult> {
    const client = readClient();
    const receipt = await client.getTransactionReceipt({ hash: txSig as Hex }).catch(() => null);
    if (!receipt || receipt.status !== "success") return { found: false, hashVerified: false };

    // A batch payout carries one TransferWithMemo per job — match any of them.
    const memos = receipt.logs
      .map((log) => {
        try {
          return decodeEventLog({ abi: Abis.tip20, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .filter((decoded) => decoded?.eventName === "TransferWithMemo")
      .map((decoded) => (decoded!.args as { memo?: Hex }).memo);

    const hashVerified = memos.includes(`0x${resultHash}`);
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return { found: true, hashVerified, confirmedAt: new Date(Number(block.timestamp) * 1000).toISOString() };
  }
}
