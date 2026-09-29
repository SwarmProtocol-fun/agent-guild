/**
 * React hook for write operations on Hedera Testnet contracts.
 * Uses ethers.js with BrowserProvider (window.ethereum) for signing.
 *
 * IMPORTANT: All write calls use gasLimit: 3_000_000 — Hedera gas estimation fails silently.
 */

"use client";

import { useState, useCallback } from "react";
import { ethers } from "ethers";

import {
  HEDERA_CONTRACTS,
  HEDERA_TASK_BOARD_ABI,
  HEDERA_GAS_LIMIT,
} from "@/lib/swarm-contracts";
import { AGENT_REGISTRY_ABI } from "@/lib/swarm-contracts";

interface WriteState {
  isLoading: boolean;
  error: string | null;
  txHash: string | null;
}

interface SwarmWrite {
  claimTask: (taskId: number) => Promise<string | null>;
  submitDelivery: (taskId: number, deliveryHash: string) => Promise<string | null>;
  postTask: (vaultAddress: string, title: string, description: string, requiredSkills: string, deadlineUnix: number, budgetHbar: string) => Promise<string | null>;
  registerAgent: (name: string, skills: string, asn: string, feeRate: number, agentAddress?: string) => Promise<string | null>;
  state: WriteState;
  reset: () => void;
}

const HEDERA_TESTNET_CHAIN_ID = 296;
const HEDERA_TESTNET_HEX = "0x" + HEDERA_TESTNET_CHAIN_ID.toString(16); // "0x128"

// Read via a local cast instead of augmenting Window: the wallet stack
// (Reown/wagmi) already declares `Window.ethereum` with a different type.
function getInjectedProvider(): ethers.Eip1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: ethers.Eip1193Provider }).ethereum;
}

async function getSigner(): Promise<ethers.Signer> {
  const ethereum = getInjectedProvider();
  if (!ethereum) {
    throw new Error("No wallet detected. Please connect your wallet.");
  }

  const provider = new ethers.BrowserProvider(ethereum);
  const network = await provider.getNetwork();

  if (Number(network.chainId) !== HEDERA_TESTNET_CHAIN_ID) {
    // Try switching to Hedera Testnet
    try {
      await ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: HEDERA_TESTNET_HEX }],
      });
    } catch (switchErr: any) {
      // Chain not added yet — add it
      if (switchErr?.code === 4902) {
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: HEDERA_TESTNET_HEX,
            chainName: "Hedera Testnet",
            nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
            rpcUrls: ["https://testnet.hashio.io/api"],
            blockExplorerUrls: ["https://hashscan.io/testnet"],
          }],
        });
      } else {
        throw new Error("Please switch your wallet to Hedera Testnet (chain 296) to continue.");
      }
    }
    // Re-create provider after network switch
    return new ethers.BrowserProvider(ethereum).getSigner();
  }

  return provider.getSigner();
}

export function useSwarmWrite(): SwarmWrite {
  const [state, setState] = useState<WriteState>({
    isLoading: false,
    error: null,
    txHash: null,
  });

  const reset = useCallback(() => {
    setState({ isLoading: false, error: null, txHash: null });
  }, []);

  const claimTask = useCallback(async (taskId: number): Promise<string | null> => {
    setState({ isLoading: true, error: null, txHash: null });
    try {
      const signer = await getSigner();
      const board = new ethers.Contract(HEDERA_CONTRACTS.TASK_BOARD, HEDERA_TASK_BOARD_ABI, signer);
      const tx = await board.claimTask(taskId, { gasLimit: HEDERA_GAS_LIMIT, type: 0 });
      const receipt = await tx.wait();
      setState({ isLoading: false, error: null, txHash: receipt.hash });
      return receipt.hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to claim task";
      setState({ isLoading: false, error: msg, txHash: null });
      return null;
    }
  }, []);

  const submitDelivery = useCallback(async (taskId: number, deliveryHash: string): Promise<string | null> => {
    setState({ isLoading: true, error: null, txHash: null });
    try {
      const signer = await getSigner();
      const board = new ethers.Contract(HEDERA_CONTRACTS.TASK_BOARD, HEDERA_TASK_BOARD_ABI, signer);
      const tx = await board.submitDelivery(taskId, deliveryHash, { gasLimit: HEDERA_GAS_LIMIT, type: 0 });
      const receipt = await tx.wait();
      setState({ isLoading: false, error: null, txHash: receipt.hash });
      return receipt.hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to submit delivery";
      setState({ isLoading: false, error: msg, txHash: null });
      return null;
    }
  }, []);

  const postTask = useCallback(async (
    vaultAddress: string,
    title: string,
    description: string,
    requiredSkills: string,
    deadlineUnix: number,
    budgetHbar: string,
  ): Promise<string | null> => {
    setState({ isLoading: true, error: null, txHash: null });
    try {
      if (parseFloat(budgetHbar) < 100) {
        throw new Error("Minimum budget is 100 HBAR");
      }
      const signer = await getSigner();
      const board = new ethers.Contract(HEDERA_CONTRACTS.TASK_BOARD, HEDERA_TASK_BOARD_ABI, signer);
      const tx = await board.postTask(
        vaultAddress,
        title,
        description,
        requiredSkills,
        deadlineUnix,
        { value: ethers.parseEther(budgetHbar), gasLimit: HEDERA_GAS_LIMIT, type: 0 },
      );
      const receipt = await tx.wait();
      setState({ isLoading: false, error: null, txHash: receipt.hash });
      return receipt.hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to post task";
      setState({ isLoading: false, error: msg, txHash: null });
      return null;
    }
  }, []);

  const registerAgent = useCallback(async (name: string, skills: string, asn: string, feeRate: number, agentAddress?: string): Promise<string | null> => {
    setState({ isLoading: true, error: null, txHash: null });
    try {
      const signer = await getSigner();
      const registry = new ethers.Contract(HEDERA_CONTRACTS.AGENT_REGISTRY, AGENT_REGISTRY_ABI, signer);

      // Use registerAgentFor if agentAddress is provided, otherwise use registerAgent (which uses msg.sender)
      const tx = agentAddress
        ? await registry.registerAgentFor(agentAddress, name, skills, asn, feeRate, { gasLimit: HEDERA_GAS_LIMIT, type: 0 })
        : await registry.registerAgent(name, skills, asn, feeRate, { gasLimit: HEDERA_GAS_LIMIT, type: 0 });

      const receipt = await tx.wait();
      setState({ isLoading: false, error: null, txHash: receipt.hash });
      return receipt.hash;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to register agent";
      setState({ isLoading: false, error: msg, txHash: null });
      return null;
    }
  }, []);

  return { claimTask, submitDelivery, postTask, registerAgent, state, reset };
}
