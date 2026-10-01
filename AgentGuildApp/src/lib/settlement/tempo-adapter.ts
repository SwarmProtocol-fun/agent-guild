import { decodeEventLog, type Hex } from "viem";
import { Abis, Account, Actions, createClient, http, withRelay } from "viem/tempo";
import { tempoModerato } from "viem/tempo/chains";
import { getChain } from "@/lib/chains";
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
 */

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
   * Settle several jobs to the same wallet in ONE atomic Tempo transaction —
   * real support for this, via the `calls` array on a Tempo transaction,
   * not N sequential transactions. Every transfer either all lands or all
   * reverts together.
   */
  async settleBatch(
    agentWallet: string,
    items: { resultHash: string; amountUsdc: number }[],
  ): Promise<{ txSig: string; explorerUrl: string }> {
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

    const calls = items.map((item) =>
      Actions.token.transfer.call({
        to: agentWallet as Hex,
        amount: BigInt(Math.round(item.amountUsdc * 1_000_000)), // USDC, 6 decimals
        token: usdc,
        memo: `0x${item.resultHash}` as Hex,
      }),
    );

    const receipt = await client.sendTransactionSync({
      calls,
      feeToken,
      feePayer: feePayerKey ? Account.fromSecp256k1(feePayerKey) : feePayerFor(feePayerUrl),
    });

    return { txSig: receipt.transactionHash, explorerUrl: chain.explorer.txUrl(receipt.transactionHash) };
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

    const memo = receipt.logs
      .map((log) => {
        try {
          return decodeEventLog({ abi: Abis.tip20, data: log.data, topics: log.topics });
        } catch {
          return null;
        }
      })
      .find((decoded) => decoded?.eventName === "TransferWithMemo")?.args as { memo?: Hex } | undefined;

    const hashVerified = memo?.memo === `0x${resultHash}`;
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return { found: true, hashVerified, confirmedAt: new Date(Number(block.timestamp) * 1000).toISOString() };
  }
}
