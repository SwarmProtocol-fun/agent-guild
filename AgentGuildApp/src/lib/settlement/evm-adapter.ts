import { ethers } from "ethers";
import { getChain, type ChainKey } from "@/lib/chains";
import { AGENT_REGISTRY_ABI } from "@/lib/agent-guild-contracts";
import type { SettleJobParams, SettlementAdapter, SettlementReceipt, VerifyResult } from "./types";

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];
const MEMO_PREFIX = "agent-guild:receipt:";

/**
 * One adapter covers every EVM chain in CHAIN_CONFIGS — Base, Sepolia,
 * Tempo, etc. — parameterized by chain key, not duplicated per chain.
 *
 * If the chain has a deployed AgentRegistry (contracts.agentRegistry), we
 * call updateCredit() the same way the platform's on-chain credit updates
 * already do elsewhere. If not (e.g. Tempo, which has no Agent Guild
 * contracts deployed yet), we fall back to a plain transaction carrying the
 * receipt hash as calldata plus a USDC transfer if configured — the EVM
 * equivalent of Solana's memo-instruction receipt commit. No new contract
 * to write or audit for a chain we haven't deployed to.
 */
export class EvmSettlementAdapter implements SettlementAdapter {
  constructor(private chainKey: ChainKey) {}

  async settleJob(p: SettleJobParams): Promise<SettlementReceipt> {
    const chain = getChain(this.chainKey);
    if (!chain) throw new Error(`Unknown chain: ${this.chainKey}`);

    const privateKey = process.env.PLATFORM_SETTLEMENT_KEY;
    if (!privateKey) throw new Error("PLATFORM_SETTLEMENT_KEY not configured");

    const provider = new ethers.JsonRpcProvider(chain.rpc);
    const wallet = new ethers.Wallet(privateKey, provider);

    if (chain.contracts.agentRegistry) {
      const registry = new ethers.Contract(chain.contracts.agentRegistry, AGENT_REGISTRY_ABI, wallet);
      const tx = await registry.updateCredit(p.agentWallet, p.creditScore, p.trustScore);
      const receipt = await tx.wait();
      return {
        chain: this.chainKey,
        txSig: receipt.hash,
        receiptHash: p.resultHash,
        explorerUrl: chain.explorer.txUrl(receipt.hash),
        reputationUpdated: true,
      };
    }

    // No AgentRegistry on this chain yet — pay + commit the receipt hash
    // as calldata in one transaction. `0x` + hex-encoded hash is valid
    // calldata to any address; it doesn't need a contract to receive it.
    let txHash: string;
    const memoData = ethers.hexlify(ethers.toUtf8Bytes(`${MEMO_PREFIX}${p.resultHash}`));

    if (chain.contracts.usdc && p.amountUsdc > 0) {
      const usdc = new ethers.Contract(chain.contracts.usdc, ERC20_ABI, wallet);
      const tx = await usdc.transfer(p.agentWallet, ethers.parseUnits(p.amountUsdc.toString(), 6));
      await tx.wait();
      // Calldata went to the USDC contract for the transfer, so the memo
      // rides a second, cheap self-send rather than fighting transfer()'s ABI.
      const memoTx = await wallet.sendTransaction({ to: wallet.address, value: 0, data: memoData });
      const memoReceipt = await memoTx.wait();
      txHash = memoReceipt!.hash;
    } else {
      const tx = await wallet.sendTransaction({ to: p.agentWallet, value: 0, data: memoData });
      const receipt = await tx.wait();
      txHash = receipt!.hash;
    }

    return {
      chain: this.chainKey,
      txSig: txHash,
      receiptHash: p.resultHash,
      explorerUrl: chain.explorer.txUrl(txHash),
      reputationUpdated: false,
    };
  }

  async getBalance(wallet: string): Promise<{ usdc: number }> {
    const chain = getChain(this.chainKey);
    if (!chain) throw new Error(`Unknown chain: ${this.chainKey}`);
    if (!chain.contracts.usdc) return { usdc: 0 };

    const provider = new ethers.JsonRpcProvider(chain.rpc);
    const usdc = new ethers.Contract(chain.contracts.usdc, ERC20_ABI, provider);
    const raw: bigint = await usdc.balanceOf(wallet);
    return { usdc: Number(ethers.formatUnits(raw, 6)) };
  }

  async verifyReceipt(txSig: string, resultHash: string): Promise<VerifyResult> {
    const chain = getChain(this.chainKey);
    if (!chain) throw new Error(`Unknown chain: ${this.chainKey}`);

    const provider = new ethers.JsonRpcProvider(chain.rpc);
    const receipt = await provider.getTransactionReceipt(txSig);
    if (!receipt || receipt.status !== 1) return { found: false, hashVerified: false };

    // Only the calldata-memo path actually carries the hash on-chain — the
    // AgentRegistry path stores credit/trust score, not a receipt hash, so
    // this can confirm the tx landed but not that this specific hash did.
    const tx = await provider.getTransaction(txSig);
    const decoded = tx?.data && tx.data !== "0x" ? tryDecode(tx.data) : "";
    const hashVerified = decoded === `${MEMO_PREFIX}${resultHash}`;

    const block = await provider.getBlock(receipt.blockNumber);
    return { found: true, hashVerified, confirmedAt: block ? new Date(block.timestamp * 1000).toISOString() : undefined };
  }
}

function tryDecode(data: string): string {
  try {
    return ethers.toUtf8String(data);
  } catch {
    return "";
  }
}
