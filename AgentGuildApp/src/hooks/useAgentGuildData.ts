/**
 * React hook that polls the Agent Guild Solana program (registry, task
 * board, treasury PDAs) every 30 seconds.
 *
 * Usage:
 *   const { tasks, agents, isLoading, error } = useAgentGuildData();
 */

"use client";

import { useState, useEffect, useCallback, useRef } from "react";

import { toNative } from "@/lib/chains";
import { getAllAgents, getAllTasks, getTreasury } from "@/lib/solana/client";
import {
  TaskStatus,
  type TaskListing,
  type AgentProfile,
  type TreasuryPnL,
} from "@/lib/agent-guild-contracts";

const POLL_INTERVAL = 30_000;

interface AgentGuildData {
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

const STATUS_KEY_TO_ENUM: Record<string, TaskStatus> = {
  open: TaskStatus.Open,
  claimed: TaskStatus.Claimed,
  completed: TaskStatus.Completed,
  expired: TaskStatus.Expired,
  disputed: TaskStatus.Disputed,
  resolved: TaskStatus.Resolved,
};

function parseTaskStatus(status: object): TaskStatus {
  const key = Object.keys(status)[0] ?? "open";
  return STATUS_KEY_TO_ENUM[key] ?? TaskStatus.Open;
}

export function useAgentGuildData(): AgentGuildData {
  const [tasks, setTasks] = useState<TaskListing[]>([]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [totalTasks, setTotalTasks] = useState(0);
  const [totalAgents, setTotalAgents] = useState(0);
  const [treasury, setTreasury] = useState<TreasuryPnL | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const isFetchingRef = useRef(false);

  const fetchData = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const [rawTasks, rawAgents, rawTreasury] = await Promise.all([
        getAllTasks(),
        getAllAgents(),
        getTreasury().catch(() => null),
      ]);

      const parsedTasks: TaskListing[] = rawTasks.map(({ account, publicKey }) => ({
        taskId: account.taskId.toNumber(),
        vault: publicKey.toBase58(),
        title: account.title,
        description: account.description,
        requiredSkills: account.requiredSkills,
        deadline: account.deadline.toNumber(),
        budgetRaw: BigInt(account.budgetLamports.toString()),
        budget: toNative(account.budgetLamports.toNumber(), 0),
        poster: account.poster.toBase58(),
        claimedBy: account.claimedBy ? account.claimedBy.toBase58() : "",
        deliveryHash: account.deliveryHash ? Buffer.from(account.deliveryHash).toString("hex") : "",
        createdAt: account.createdAt.toNumber(),
        status: parseTaskStatus(account.status),
      }));

      const parsedAgents: AgentProfile[] = rawAgents.map(({ account }) => ({
        agentAddress: account.wallet.toBase58(),
        name: account.name,
        skills: account.skills,
        asn: account.asn,
        feeRate: account.feeRateBps,
        creditScore: account.creditScore,
        trustScore: account.trustScore,
        active: account.active,
        registeredAt: account.registeredAt.toNumber(),
      }));

      const parsedTreasury: TreasuryPnL | null = rawTreasury
        ? {
            computeBalance: toNative(rawTreasury.computeBalance.toNumber(), 0),
            growthBalance: toNative(rawTreasury.growthBalance.toNumber(), 0),
            reserveBalance: toNative(rawTreasury.reserveBalance.toNumber(), 0),
            totalRevenue: toNative(
              rawTreasury.computeBalance.add(rawTreasury.growthBalance).add(rawTreasury.reserveBalance).toNumber(),
              0,
            ),
          }
        : null;

      setTasks(parsedTasks);
      setAgents(parsedAgents);
      setTotalTasks(parsedTasks.length);
      setTotalAgents(parsedAgents.length);
      setTreasury(parsedTreasury);
      setError(null);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch Agent Guild data");
    } finally {
      setIsLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { tasks, agents, totalTasks, totalAgents, treasury, isLoading, error, lastRefresh, refetch: fetchData };
}
