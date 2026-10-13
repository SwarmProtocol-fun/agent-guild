/**
 * Networks the Ethereum mod reads from and signs on. Safe to import from
 * client code: only public RPCs live here — keyed RPC URLs are read from
 * env on the server (agent.ts rpcFor) and never sent to a browser.
 */
import { base, baseSepolia, mainnet, sepolia, type Chain } from "viem/chains";

export type EthNetwork = "mainnet" | "sepolia" | "base" | "base-sepolia";

export interface NetworkInfo {
  id: EthNetwork;
  label: string;
  chain: Chain;
  chainId: number;
  testnet: boolean;
  publicRpc: string;
  explorer: string;
  /** Web faucets for testnet ETH. There's no keyless programmatic faucet, so agents get pointed here. */
  faucets: { label: string; url: string }[];
}

export const NETWORKS: Record<EthNetwork, NetworkInfo> = {
  mainnet: {
    id: "mainnet", label: "Ethereum", chain: mainnet, chainId: 1, testnet: false,
    publicRpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io", faucets: [],
  },
  sepolia: {
    id: "sepolia", label: "Sepolia", chain: sepolia, chainId: 11155111, testnet: true,
    publicRpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io",
    faucets: [
      { label: "Google Cloud", url: "https://cloud.google.com/application/web3/faucet/ethereum/sepolia" },
      { label: "Alchemy", url: "https://www.alchemy.com/faucets/ethereum-sepolia" },
    ],
  },
  base: {
    id: "base", label: "Base", chain: base, chainId: 8453, testnet: false,
    publicRpc: "https://mainnet.base.org", explorer: "https://basescan.org", faucets: [],
  },
  "base-sepolia": {
    id: "base-sepolia", label: "Base Sepolia", chain: baseSepolia, chainId: 84532, testnet: true,
    publicRpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org",
    faucets: [
      { label: "Coinbase CDP", url: "https://portal.cdp.coinbase.com/products/faucet" },
      { label: "Alchemy", url: "https://www.alchemy.com/faucets/base-sepolia" },
    ],
  },
};

export const NETWORK_IDS = Object.keys(NETWORKS) as EthNetwork[];
/** Networks an agent's wallet may sign on. Mainnets are read/simulate only. */
export const SIGNING_NETWORKS: EthNetwork[] = ["sepolia", "base-sepolia"];

export function explorerUrl(kind: "tx" | "address", id: string, network: EthNetwork): string {
  return `${NETWORKS[network].explorer}/${kind}/${id}`;
}

/** Tokens checked by holdings on each network (balances read in one multicall). */
export const KNOWN_TOKENS: Record<EthNetwork, { symbol: string; address: `0x${string}` }[]> = {
  mainnet: [
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
    { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" },
    { symbol: "LINK", address: "0x514910771AF9Ca656af840dff83E8264EcF986CA" },
    { symbol: "UNI", address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984" },
    { symbol: "stETH", address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" },
  ],
  sepolia: [
    { symbol: "WETH", address: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14" },
    { symbol: "USDC", address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  ],
  base: [
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  ],
  "base-sepolia": [
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
    { symbol: "USDC", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  ],
};

export type DetectedInput = "tx" | "address" | "ens" | "data";

/** What the command bar was given: a tx hash, an address, an ENS name, or calldata/revert data. */
export function detectInput(raw: string): DetectedInput | null {
  const v = raw.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(v)) return "tx";
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return "address";
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(v)) return "ens";
  if (/^0x[0-9a-fA-F]{8}([0-9a-fA-F]{2})*$/.test(v)) return "data";
  return null;
}
