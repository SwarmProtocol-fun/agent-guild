import { ethers } from "ethers";
import { getChain, type ChainKey } from "@/lib/chains";
import { AGENT_IDENTITY_NFT_ABI } from "@/lib/swarm-contracts";
import type { IdentityAdapter, IdentityMintReceipt, MintIdentityParams } from "./types";

/**
 * One adapter covers every EVM chain with a deployed SwarmAgentIdentityNFT
 * (see contracts/contracts/SwarmAgentIdentityNFT.sol), parameterized by
 * chain key — same shape as settlement/evm-adapter.ts. Currently wired for
 * "hyperliquid"; add another chain by deploying the contract there and
 * setting its `contracts.agentIdentityNFT` in chains.ts.
 */
export class EvmIdentityAdapter implements IdentityAdapter {
  constructor(private chainKey: ChainKey) {}

  private contract(wallet: ethers.Wallet | ethers.JsonRpcProvider) {
    const chain = getChain(this.chainKey);
    if (!chain) throw new Error(`Unknown chain: ${this.chainKey}`);
    if (!chain.contracts.agentIdentityNFT) {
      throw new Error(`No AgentIdentityNFT deployed on ${this.chainKey} yet`);
    }
    return new ethers.Contract(chain.contracts.agentIdentityNFT, AGENT_IDENTITY_NFT_ABI, wallet);
  }

  async mintIdentity(p: MintIdentityParams): Promise<IdentityMintReceipt | null> {
    const chain = getChain(this.chainKey);
    if (!chain) throw new Error(`Unknown chain: ${this.chainKey}`);

    const privateKey = process.env.PLATFORM_SETTLEMENT_KEY;
    if (!privateKey) throw new Error("PLATFORM_SETTLEMENT_KEY not configured");

    const provider = new ethers.JsonRpcProvider(chain.rpc);
    const wallet = new ethers.Wallet(privateKey, provider);
    const nft = this.contract(wallet);

    const alreadyMinted = await nft.hasNFT(p.agentAddress);
    if (alreadyMinted) return null;

    const tx = await nft.mintAgentNFT(
      p.agentAddress,
      p.asn,
      Math.min(Math.max(p.creditScore, 300), 900),
      Math.min(Math.max(p.trustScore, 0), 100),
    );
    const receipt = await tx.wait();

    let tokenId: string | undefined;
    for (const log of receipt.logs) {
      try {
        const parsed = nft.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "AgentNFTMinted") tokenId = parsed.args.tokenId?.toString();
      } catch {
        // skip non-matching logs
      }
    }

    return {
      chain: this.chainKey,
      txSig: receipt.hash,
      tokenId,
      explorerUrl: chain.explorer.txUrl(receipt.hash),
    };
  }

  async hasIdentity(agentAddress: string): Promise<boolean> {
    const chain = getChain(this.chainKey);
    if (!chain) throw new Error(`Unknown chain: ${this.chainKey}`);
    const provider = new ethers.JsonRpcProvider(chain.rpc);
    return this.contract(provider).hasNFT(agentAddress);
  }
}
