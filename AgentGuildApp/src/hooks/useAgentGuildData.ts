/**
 * React hook that polls the SwarmTaskBoard + AgentRegistry
 * on Hedera Testnet every 12 seconds.
 *
 * Usage:
 *   const { tasks, agents, isLoading, error } = useSwarmData();
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import {
  HEDERA_CONTRACTS,
  HEDERA_TASK_BOARD_ABI,
  HEDERA_TREASURY_ABI,
  toHbar,
  type TaskListing,
  type AgentProfile,
  type TreasuryPnL,
} from "@/lib/swarm-contracts";
import { AGENT_REGISTRY_ABI } from "@/lib/swarm-contracts";

// Hedera Testnet RPC URL
const HEDERA_RPC_URL = "https://testnet.hashio.io/api";
const POLL_INTERVAL = 30_000; // 30s — individual fetches can take 10-20s

interface SwarmData {
  tasks: TaskListing[];
  agents: AgentProfile[];
  totalTasks: number;
  totalAgents: number;
  treasury: TreasuryPnL | null;
  isLoading: boolean;
  error: string | null;
  lastRefresh: Date | null;
  refetch: () => Promise<void>;
}

export function useSwarmData(): SwarmData {
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [totalTasks, setTotalTasks] = useState(0);
  const [totalAgents, setTotalAgents] = useState(0);
  const [treasury, setTreasury] = useState<TreasuryPnL | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const providerRef = useRef<ethers.JsonRpcProvider | null>(null);
  const isFetchingRef = useRef(false);

  const getProvider = useCallback(() => {
    if (!providerRef.current) {
      providerRef.current = new ethers.JsonRpcProvider(HEDERA_RPC_URL);
    }
    return providerRef.current;
  }, []);

  const fetchData = useCallback(async () => {
    // Prevent concurrent fetches — batch fallback can take 10-20s
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const provider = getProvider();
      const board = new ethers.Contract(HEDERA_CONTRACTS.TASK_BOARD, HEDERA_TASK_BOARD_ABI, provider);
      const registry = new ethers.Contract(HEDERA_CONTRACTS.AGENT_REGISTRY, AGENT_REGISTRY_ABI, provider);
      const treasuryContract = new ethers.Contract(HEDERA_CONTRACTS.AGENT_TREASURY, HEDERA_TREASURY_ABI, provider);

      // Fetch counts + bulk calls in parallel; bulk calls may revert if too large
      const [rawTasksBulk, rawAgents, taskCount, agentCount, rawPnL] = await Promise.all([
        board.getAllTasks().catch(() => null),
        registry.getAllAgents().catch(() => []),
        board.taskCount().catch(() => BigInt(0)),
        registry.agentCount().catch(() => BigInt(0)),
        treasuryContract.getPnL().catch(() => null),
      ]);

      // If getAllTasks() reverted (too many tasks for RPC), fetch individually in batches
      let rawTasks: unknown[] = rawTasksBulk ?? [];
      if (!rawTasksBulk && Number(taskCount) > 0) {
        const count = Number(taskCount);
        const BATCH = 20;
        const results: unknown[] = [];
        for (let i = 0; i < count; i += BATCH) {
          const batch = Array.from(
            { length: Math.min(BATCH, count - i) },
            (_, j) => board.getTask(i + j).catch(() => null)
          );
          const batchResults = await Promise.all(batch);
          for (const r of batchResults) {
            if (r) results.push(r);
          }
        }
        rawTasks = results;
      }

      // Tuple: (taskId, vault, title, description, requiredSkills, deadline, budget, poster, claimedBy, deliveryHash, createdAt, status)
      const parsedTasks: TaskListing[] = (rawTasks as unknown[]).map((t: unknown) => {
        const a = t as [bigint, string, string, string, string, bigint, bigint, string, string, string, bigint, number];
        return {
          taskId: Number(a[0]),
          vault: a[1],
          title: a[2],
          description: a[3],
          requiredSkills: a[4],
          deadline: Number(a[5]),
          budgetRaw: BigInt(a[6]),
          budget: toHbar(a[6]),
          poster: a[7],
          claimedBy: a[8],
          deliveryHash: a[9],
          createdAt: Number(a[10]),
          status: Number(a[11]),
        };
      });

      // Tuple: (agentAddress, name, skills, asn, feeRate, creditScore, trustScore, active, registeredAt)
      const parsedAgents: AgentProfile[] = (rawAgents as unknown[]).map((a: unknown) => {
        const r = a as [string, string, string, string, bigint, number, number, boolean, bigint];
        return {
          agentAddress: r[0],
          name: r[1],
          skills: r[2],
          asn: r[3],
          feeRate: Number(r[4]),
          creditScore: Number(r[5]),
          trustScore: Number(r[6]),
          active: Boolean(r[7]),
          registeredAt: Number(r[8]),
        };
      });

      // Treasury PnL
      let parsedTreasury: TreasuryPnL | null = null;
      if (rawPnL) {
        parsedTreasury = {
          totalRevenue: toHbar(rawPnL[0]),
          computeBalance: toHbar(rawPnL[1]),
          growthBalance: toHbar(rawPnL[2]),
          reserveBalance: toHbar(rawPnL[3]),
        };
      }

      setTasks(parsedTasks);
      setAgents(parsedAgents);
      setTotalTasks(Number(taskCount));
      setTotalAgents(Number(agentCount));
      setTreasury(parsedTreasury);
      setError(null);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch Swarm data");
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, [getProvider]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { tasks, agents, totalTasks, totalAgents, treasury, isLoading, error, lastRefresh, refetch: fetchData };
}
