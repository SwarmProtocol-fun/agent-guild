/**
 * React hook for write operations against the Agent Guild Solana program.
 * Signs with whatever wallet is connected via `@solana/wallet-adapter-react`
 * (bypassing the app's chain-agnostic wallet facade, same as the old
 * ethers/window.ethereum hook did for EVM — the facade has no
 * signTransaction concept).
 */

"use client";

import { useState, useCallback } from "react";
import { useWallet as useSolanaWalletAdapter } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

import * as agentGuild from "@/lib/solana/client";
import type { SolanaWallet } from "@/lib/solana/client";

const MIN_TASK_BUDGET_SOL = 0.01;

interface WriteState {
  isLoading: boolean;
  error: string | null;
  txHash: string | null;
}

interface AgentGuildWrite {
  claimTask: (taskId: number) => Promise<string | null>;
  submitDelivery: (taskId: number, deliveryHashHex: string) => Promise<string | null>;
  postTask: (
    title: string,
    description: string,
    requiredSkills: string,
    deadlineUnix: number,
    budgetSol: string,
  ) => Promise<string | null>;
  registerAgent: (name: string, skills: string, asn: string, feeRate: number) => Promise<string | null>;
  state: WriteState;
  reset: () => void;
}

function hexToBytes32(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < Math.min(32, Math.floor(clean.length / 2)); i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16) || 0;
  }
  return bytes;
}

export function useAgentGuildWrite(): AgentGuildWrite {
  const solanaWallet = useSolanaWalletAdapter();
  const [state, setState] = useState<WriteState>({ isLoading: false, error: null, txHash: null });

  const reset = useCallback(() => {
    setState({ isLoading: false, error: null, txHash: null });
  }, []);

  const getWallet = useCallback((): SolanaWallet => {
    if (!solanaWallet.publicKey || !solanaWallet.signTransaction) {
      throw new Error("No Solana wallet connected. Please connect your wallet.");
    }
    return {
      publicKey: solanaWallet.publicKey,
      signTransaction: solanaWallet.signTransaction,
      signAllTransactions: solanaWallet.signAllTransactions ?? (async (txs) => txs),
    };
  }, [solanaWallet]);

  const claimTask = useCallback(async (taskId: number): Promise<string | null> => {
    setState({ isLoading: true, error: null, txHash: null });
    try {
      const wallet = getWallet();
      const [task] = agentGuild.taskPda(taskId);
      const sig = await agentGuild.claimTask(wallet, task);
      setState({ isLoading: false, error: null, txHash: sig });
      return sig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to claim task";
      setState({ isLoading: false, error: msg, txHash: null });
      return null;
    }
  }, [getWallet]);

  const submitDelivery = useCallback(async (taskId: number, deliveryHashHex: string): Promise<string | null> => {
    setState({ isLoading: true, error: null, txHash: null });
    try {
      const wallet = getWallet();
      const [task] = agentGuild.taskPda(taskId);
      const sig = await agentGuild.submitDelivery(wallet, task, hexToBytes32(deliveryHashHex));
      setState({ isLoading: false, error: null, txHash: sig });
      return sig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to submit delivery";
      setState({ isLoading: false, error: msg, txHash: null });
      return null;
    }
  }, [getWallet]);

  const postTask = useCallback(async (
    title: string,
    description: string,
    requiredSkills: string,
    deadlineUnix: number,
    budgetSol: string,
  ): Promise<string | null> => {
    setState({ isLoading: true, error: null, txHash: null });
    try {
      if (parseFloat(budgetSol) < MIN_TASK_BUDGET_SOL) {
        throw new Error(`Minimum budget is ${MIN_TASK_BUDGET_SOL} SOL`);
      }
      const wallet = getWallet();
      const budgetLamports = Math.round(parseFloat(budgetSol) * LAMPORTS_PER_SOL);
      const task = await agentGuild.postTask(wallet, {
        title,
        description,
        requiredSkills,
        deadline: deadlineUnix,
        budgetLamports,
      });
      setState({ isLoading: false, error: null, txHash: task.toBase58() });
      return task.toBase58();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to post task";
      setState({ isLoading: false, error: msg, txHash: null });
      return null;
    }
  }, [getWallet]);

  const registerAgent = useCallback(async (
    name: string,
    skills: string,
    asn: string,
    feeRate: number,
  ): Promise<string | null> => {
    setState({ isLoading: true, error: null, txHash: null });
    try {
      const wallet = getWallet();
      const sig = await agentGuild.registerAgent(wallet, { name, skills, asn, feeRateBps: feeRate });
      setState({ isLoading: false, error: null, txHash: sig });
      return sig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to register agent";
      setState({ isLoading: false, error: msg, txHash: null });
      return null;
    }
  }, [getWallet]);

  return { claimTask, submitDelivery, postTask, registerAgent, state, reset };
}
