/**
 * Agent Guild Protocol Contracts — Multi-Chain
 *
 * Contract addresses, ABIs, types, and helpers for interacting
 * with the AgentGuildTaskBoard and AgentGuildAgentRegistry.
 *
 * Chain config is centralized in @/lib/chains.ts.
 * This file re-exports contract-specific helpers.
 */

import {
  getContracts,
  getExplorerTxUrl,
  getExplorerContractUrl,
  shortAddress,
  getCurrencySymbol,
  CHAIN_CONFIGS,
} from "./chains";

// ============================================================
// Default Config — Solana is the PRIMARY chain (see chains.ts).
// This file's ABIs/addresses are for the EVM chains that still run the
// Solidity contracts (Base, Sepolia) — Sepolia is the default since it has
// a real deployment (contracts/deployed-addresses.json).
// ============================================================

export const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
export const DEFAULT_CHAIN_ID = 11155111; // Ethereum Sepolia
export const EXPLORER_BASE = "https://sepolia.etherscan.io";
export const DEFAULT_GAS_LIMIT = 3_000_000;

// ============================================================
// Contract Addresses — Ethereum Sepolia (chain 11155111)
// Fallbacks are the deployed testnet addresses (2026-03-08).
// Override via NEXT_PUBLIC_SEPOLIA_* env vars for other networks.
// ============================================================

export const CONTRACTS = {
  TASK_BOARD: process.env.NEXT_PUBLIC_SEPOLIA_TASK_BOARD || "0xc3E0869913FCdbeB59934FfC92C74269c428C834",
  AGENT_REGISTRY: process.env.NEXT_PUBLIC_SEPOLIA_AGENT_REGISTRY || "0x9C34200882C37344A098E0e8B84a533DFB80e552",
  AGENT_TREASURY: process.env.NEXT_PUBLIC_SEPOLIA_TREASURY || "0xE7e2F81F6CA9a3738B0E8555401CEF986Fbc33Aa",
  // No Sepolia NFT deployment exists yet — override with NEXT_PUBLIC_SEPOLIA_AGENT_NFT once deployed.
  AGENT_IDENTITY_NFT: process.env.NEXT_PUBLIC_SEPOLIA_AGENT_NFT || "",
} as const;

/** Get contracts for a specific chain */
export { getContracts, getCurrencySymbol };

// ============================================================
// ABIs — Canonical (match deployed contracts on Base/Sepolia)
// ============================================================

export const AGENT_REGISTRY_ABI = [
  // Write functions
  "function registerAgent(string name, string skills, string asn, uint256 feeRate) external",
  "function registerAgentFor(address agentAddr, string name, string skills, string asn, uint256 feeRate) external",
  "function updateSkills(string newSkills) external",
  "function updateCredit(address agentAddr, uint16 creditScore, uint8 trustScore) external",
  "function deactivateAgent() external",
  // Read functions
  "function getAgent(address agentAddr) view returns (tuple(address agentAddress, string name, string skills, string asn, uint256 feeRate, uint16 creditScore, uint8 trustScore, bool active, uint256 registeredAt))",
  "function getAgentByASN(string asn) view returns (tuple(address agentAddress, string name, string skills, string asn, uint256 feeRate, uint16 creditScore, uint8 trustScore, bool active, uint256 registeredAt))",
  "function isRegistered(address agentAddr) view returns (bool)",
  "function agentCount() view returns (uint256)",
  "function getAllAgents() view returns (tuple(address agentAddress, string name, string skills, string asn, uint256 feeRate, uint16 creditScore, uint8 trustScore, bool active, uint256 registeredAt)[])",
  // Events
  "event AgentRegistered(address indexed agentAddress, string name, string asn, uint256 timestamp)",
  "event AgentDeactivated(address indexed agentAddress, uint256 timestamp)",
  "event SkillsUpdated(address indexed agentAddress, string newSkills, uint256 timestamp)",
  "event CreditUpdated(address indexed agentAddress, uint16 creditScore, uint8 trustScore, uint256 timestamp)",
];

export const TASK_BOARD_ABI = [
  // Write functions
  "function postTask(address vault, string title, string description, string requiredSkills, uint256 deadline, uint256 budgetLink) external",
  "function claimTask(uint256 taskId) external",
  "function submitDelivery(uint256 taskId, bytes32 deliveryHash) external",
  "function approveDelivery(uint256 taskId) external",
  "function disputeDelivery(uint256 taskId) external",
  // Read functions
  "function getTask(uint256 taskId) view returns (tuple(uint256 taskId, address vault, string title, string description, string requiredSkills, uint256 deadline, uint256 budget, address poster, address claimedBy, bytes32 deliveryHash, uint256 createdAt, uint8 status))",
  "function getAllTasks() view returns (tuple(uint256 taskId, address vault, string title, string description, string requiredSkills, uint256 deadline, uint256 budget, address poster, address claimedBy, bytes32 deliveryHash, uint256 createdAt, uint8 status)[])",
  "function getOpenTasks() view returns (tuple(uint256 taskId, address vault, string title, string description, string requiredSkills, uint256 deadline, uint256 budget, address poster, address claimedBy, bytes32 deliveryHash, uint256 createdAt, uint8 status)[])",
  "function taskCount() view returns (uint256)",
  // Events
  "event TaskPosted(uint256 indexed taskId, address indexed poster, address vault, string title, uint256 budget, uint256 deadline, uint256 timestamp)",
  "event TaskClaimed(uint256 indexed taskId, address indexed agent, uint256 timestamp)",
  "event DeliverySubmitted(uint256 indexed taskId, address indexed agent, bytes32 deliveryHash, uint256 timestamp)",
  "event DeliveryApproved(uint256 indexed taskId, address indexed agent, uint256 payout, uint256 timestamp)",
  "event DeliveryDisputed(uint256 indexed taskId, address indexed poster, uint256 timestamp)",
];

export const TREASURY_ABI = [
  // Write functions
  "function depositRevenue(uint256 amount) external",
  "function withdraw(address to, uint256 amount) external",
  "function setAgentAddress(address _agentAddress) external",
  // Read functions
  "function getPnL() view returns (uint256 totalRevenue, uint256 computeBalance, uint256 growthBalance, uint256 reserveBalance)",
  "function totalRevenue() view returns (uint256)",
  "function computeBalance() view returns (uint256)",
  "function growthBalance() view returns (uint256)",
  "function reserveBalance() view returns (uint256)",
  "function agentAddress() view returns (address)",
  "function linkToken() view returns (address)",
  "function owner() view returns (address)",
  // Events
  "event RevenueDeposited(address indexed from, uint256 amount, uint256 timestamp)",
  "event Withdrawn(address indexed to, uint256 amount, uint256 timestamp)",
];

// Agent Identity NFT ABI — Dynamic NFT for agent reputation
export const AGENT_IDENTITY_NFT_ABI = [
  "function mintAgentNFT(address agent, string asn, uint16 initialCreditScore, uint8 initialTrustScore) external returns (uint256)",
  "function updateReputation(address agent, uint16 newCreditScore, uint8 newTrustScore) external",
  "function batchUpdateReputation(address[] agents, uint16[] creditScores, uint8[] trustScores) external",
  "function getTokenId(address agent) external view returns (uint256)",
  "function getAgentIdentity(uint256 tokenId) external view returns (tuple(string asn, uint16 creditScore, uint8 trustScore, uint256 registeredAt, uint256 lastUpdated))",
  "function hasNFT(address agent) external view returns (bool)",
  "function getReputationTier(uint256 tokenId) external view returns (string)",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
  "event AgentNFTMinted(address indexed agent, uint256 indexed tokenId, string asn, uint256 timestamp)",
  "event ReputationUpdated(uint256 indexed tokenId, uint16 creditScore, uint8 trustScore, uint256 timestamp)",
];

// ============================================================
// Types
// ============================================================

export interface TaskListing {
  taskId: number;
  vault: string;
  title: string;
  description: string;
  requiredSkills: string;
  deadline: number;
  budget: number;
  budgetRaw: bigint;
  poster: string;
  claimedBy: string;
  deliveryHash: string;
  createdAt: number;
  status: TaskStatus;
}

export interface AgentProfile {
  agentAddress: string;
  name: string;
  skills: string;
  asn?: string;
  feeRate: number;
  creditScore?: number;
  trustScore?: number;
  active: boolean;
  registeredAt: number;
}

export interface TreasuryPnL {
  totalRevenue: number;
  computeBalance: number;
  growthBalance: number;
  reserveBalance: number;
}

export enum TaskStatus {
  Open = 0,
  Claimed = 1,
  Completed = 2,
  Expired = 3,
  Disputed = 4,
}

export const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  [TaskStatus.Open]: { label: "Open", color: "text-green-400", bg: "bg-green-500/20" },
  [TaskStatus.Claimed]: { label: "Claimed", color: "text-yellow-400", bg: "bg-yellow-500/20" },
  [TaskStatus.Completed]: { label: "Completed", color: "text-blue-400", bg: "bg-blue-500/20" },
  [TaskStatus.Expired]: { label: "Expired", color: "text-gray-400", bg: "bg-gray-500/20" },
  [TaskStatus.Disputed]: { label: "Disputed", color: "text-red-400", bg: "bg-red-500/20" },
};

// ============================================================
// Helpers (backwards compat — wrap chain-aware functions from chains.ts)
// ============================================================

/** Shorten an address (backwards compat) */
export const shortAddr = shortAddress;

/** HashScan link for a contract (backwards compat) */
export function explorerContract(addr: string): string {
  return getExplorerContractUrl(addr);
}

/** HashScan link for a transaction (backwards compat) */
export function explorerTx(hash: string): string {
  return getExplorerTxUrl(hash);
}

/** Time remaining as human-readable string */
export function timeRemaining(deadline: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = deadline - now;
  if (diff <= 0) return "Expired";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
