/**
 * Multi-Chain Registry — Agent Guild Protocol
 *
 * Central config for all supported chains.
 * Import this everywhere instead of hardcoding chain IDs, RPCs, or currency symbols.
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ChainKey = "ethereum" | "avalanche" | "base" | "filecoin" | "sepolia" | "solana" | "baseSepolia" | "tempo" | "hyperliquid";

export interface ChainConfig {
    /** Internal key */
    key: ChainKey;
    /** Human-readable name */
    name: string;
    /** EVM chain ID (0 for non-EVM chains like Solana) */
    chainId: number;
    /** Public RPC endpoint */
    rpc: string;
    /** Native currency */
    nativeCurrency: {
        name: string;
        symbol: string;
        decimals: number;
    };
    /** Block explorer */
    explorer: {
        name: string;
        baseUrl: string;
        txUrl: (hash: string) => string;
        addressUrl: (addr: string) => string;
        contractUrl: (addr: string) => string;
    };
    /** Deployed contract addresses (empty until deployed) */
    contracts: {
        taskBoard?: string;
        agentRegistry?: string;
        brandVault?: string;
        agentTreasury?: string;
        /** Platform treasury address for receiving marketplace payments */
        treasury?: string;
        /** USDC contract address on this chain */
        usdc?: string;
        /** PayStream contract address */
        paymentStream?: string;
        /** Agent wallet contract address */
        agentWallet?: string;
        /** Billing registry contract address */
        billingRegistry?: string;
        /** Agent identity NFT contract address */
        agentIdentityNFT?: string;
    };
    /** Whether this chain is active in the UI */
    enabled: boolean;
    /** Whether this chain supports marketplace payments */
    paymentEnabled: boolean;
    /** Logo path for UI */
    logo: string;
}

// ═══════════════════════════════════════════════════════════════
// Chain Configs
// ═══════════════════════════════════════════════════════════════

export const CHAIN_CONFIGS: Record<string, ChainConfig> = {
    ethereum: {
        key: "ethereum",
        name: "Ethereum",
        chainId: 1,
        rpc: "https://ethereum-rpc.publicnode.com",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        explorer: {
            name: "Etherscan",
            baseUrl: "https://etherscan.io",
            txUrl: (h) => `https://etherscan.io/tx/${h}`,
            addressUrl: (a) => `https://etherscan.io/address/${a}`,
            contractUrl: (a) => `https://etherscan.io/address/${a}`,
        },
        contracts: {
            treasury: process.env.ETHEREUM_TREASURY_ADDRESS || process.env.EVM_TREASURY_ADDRESS,
            usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        },
        enabled: false,
        paymentEnabled: true,
        logo: "/chains/ethereum.svg",
    },

    avalanche: {
        key: "avalanche",
        name: "Avalanche",
        chainId: 43114,
        rpc: "https://api.avax.network/ext/bc/C/rpc",
        nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
        explorer: {
            name: "Snowtrace",
            baseUrl: "https://snowtrace.io",
            txUrl: (h) => `https://snowtrace.io/tx/${h}`,
            addressUrl: (a) => `https://snowtrace.io/address/${a}`,
            contractUrl: (a) => `https://snowtrace.io/address/${a}`,
        },
        contracts: {
            treasury: process.env.AVALANCHE_TREASURY_ADDRESS || process.env.EVM_TREASURY_ADDRESS,
            usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
        },
        enabled: false,
        paymentEnabled: true,
        logo: "/chains/avalanche.svg",
    },

    base: {
        key: "base",
        name: "Base",
        chainId: 8453,
        rpc: "https://mainnet.base.org",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        explorer: {
            name: "BaseScan",
            baseUrl: "https://basescan.org",
            txUrl: (h) => `https://basescan.org/tx/${h}`,
            addressUrl: (a) => `https://basescan.org/address/${a}`,
            contractUrl: (a) => `https://basescan.org/address/${a}`,
        },
        contracts: {
            treasury: process.env.BASE_TREASURY_ADDRESS || process.env.EVM_TREASURY_ADDRESS,
            usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        },
        enabled: true,
        paymentEnabled: true,
        logo: "/chains/base.svg",
    },

    filecoin: {
        key: "filecoin",
        name: "Filecoin",
        chainId: 314,
        rpc: "https://api.node.glif.io/rpc/v1",
        nativeCurrency: { name: "Filecoin", symbol: "FIL", decimals: 18 },
        explorer: {
            name: "Filfox",
            baseUrl: "https://filfox.info/en",
            txUrl: (h) => `https://filfox.info/en/message/${h}`,
            addressUrl: (a) => `https://filfox.info/en/address/${a}`,
            contractUrl: (a) => `https://filfox.info/en/address/${a}`,
        },
        contracts: {},
        enabled: true,
        paymentEnabled: true,
        logo: "/chains/filecoin.svg",
    },

    sepolia: {
        key: "sepolia",
        name: "Ethereum Sepolia",
        chainId: 11155111,
        rpc: "https://ethereum-sepolia-rpc.publicnode.com",
        nativeCurrency: { name: "Sepolia ETH", symbol: "ETH", decimals: 18 },
        explorer: {
            name: "Etherscan Sepolia",
            baseUrl: "https://sepolia.etherscan.io",
            txUrl: (h) => `https://sepolia.etherscan.io/tx/${h}`,
            addressUrl: (a) => `https://sepolia.etherscan.io/address/${a}`,
            contractUrl: (a) => `https://sepolia.etherscan.io/address/${a}`,
        },
        contracts: {
            treasury: process.env.SEPOLIA_TREASURY_ADDRESS || process.env.EVM_TREASURY_ADDRESS,
            usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        },
        enabled: true,
        paymentEnabled: true,
        logo: "/chains/ethereum.svg",
    },

    baseSepolia: {
        key: "baseSepolia",
        name: "Base Sepolia",
        chainId: 84532,
        rpc: "https://sepolia.base.org",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        explorer: {
            name: "BaseScan Sepolia",
            baseUrl: "https://sepolia.basescan.org",
            txUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
            addressUrl: (a) => `https://sepolia.basescan.org/address/${a}`,
            contractUrl: (a) => `https://sepolia.basescan.org/address/${a}`,
        },
        contracts: {
            paymentStream: "0xc3E0869913FCdbeB59934FfC92C74269c428C834",
            agentWallet: "0x8F44610D43Db6775e351F22F43bDF0ba7F8D0CEa",
            billingRegistry: "0x9C34200882C37344A098E0e8B84a533DFB80e552",
            usdc: "0xEf70C6e8D49DC21b96b02854089B26df9BECE227",
        },
        enabled: true,
        paymentEnabled: false, // testnet only
        logo: "/chains/base.svg",
    },

    solana: {
        key: "solana",
        name: "Solana Devnet",
        chainId: 0, // Non-EVM sentinel
        rpc: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
        nativeCurrency: { name: "SOL", symbol: "SOL", decimals: 9 },
        explorer: {
            name: "Solscan",
            baseUrl: "https://solscan.io/?cluster=devnet",
            txUrl: (h) => `https://solscan.io/tx/${h}?cluster=devnet`,
            addressUrl: (a) => `https://solscan.io/account/${a}?cluster=devnet`,
            contractUrl: (a) => `https://solscan.io/account/${a}?cluster=devnet`,
        },
        contracts: {
            // Single Anchor program (solana-program/programs/agent_guild) —
            // registry/task-board/treasury are all PDAs under this one program id.
            taskBoard: process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID || "4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci",
            agentRegistry: process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID || "4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci",
            agentTreasury: process.env.NEXT_PUBLIC_SOLANA_PROGRAM_ID || "4T3UJ83HEwQH3Pb6eQuMnkEYSxyqXv7o6rNARXXKT3ci",
            treasury: process.env.SOLANA_TREASURY_ADDRESS,
        },
        enabled: true,
        paymentEnabled: true,
        logo: "/chains/solana.svg",
    },

    tempo: {
        key: "tempo",
        name: "Tempo Testnet (Moderato)",
        chainId: 42431,
        rpc: process.env.TEMPO_RPC_URL || "https://rpc.moderato.tempo.xyz",
        // Tempo pays gas in USD stablecoins rather than a native token — this
        // field is kept for ChainConfig shape parity, not used for fees.
        nativeCurrency: { name: "Tempo", symbol: "TEMPO", decimals: 18 },
        explorer: {
            name: "Tempo Explorer",
            baseUrl: "https://explore.testnet.tempo.xyz",
            txUrl: (h) => `https://explore.testnet.tempo.xyz/tx/${h}`,
            addressUrl: (a) => `https://explore.testnet.tempo.xyz/address/${a}`,
            contractUrl: (a) => `https://explore.testnet.tempo.xyz/address/${a}`,
        },
        contracts: {
            treasury: process.env.TEMPO_TREASURY_ADDRESS,
            // TIP-20 stablecoin payouts are sent in. The receipt hash rides in
            // the transfer's memo (see settlement/tempo-adapter.ts).
            usdc: process.env.TEMPO_USDC_ADDRESS,
        },
        enabled: true,
        paymentEnabled: true,
        logo: "/chains/tempo.svg",
    },

    hyperliquid: {
        key: "hyperliquid",
        name: "HyperEVM Testnet",
        // Best-known HyperEVM testnet chain id at time of writing (998; mainnet
        // is 999) — confirm against Hyperliquid's current docs before deploying.
        chainId: 998,
        rpc: process.env.HYPERLIQUID_RPC_URL || "https://rpc.hyperliquid-testnet.xyz/evm",
        nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
        explorer: {
            name: "Purrsec",
            baseUrl: "https://testnet.purrsec.com",
            txUrl: (h) => `https://testnet.purrsec.com/tx/${h}`,
            addressUrl: (a) => `https://testnet.purrsec.com/address/${a}`,
            contractUrl: (a) => `https://testnet.purrsec.com/address/${a}`,
        },
        contracts: {
            treasury: process.env.HYPERLIQUID_TREASURY_ADDRESS,
            agentIdentityNFT: process.env.HYPERLIQUID_AGENT_IDENTITY_NFT,
        },
        enabled: true,
        paymentEnabled: false,
        logo: "/chains/hyperliquid.svg",
    },
};

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

/** All enabled chains */
export const ENABLED_CHAINS = Object.values(CHAIN_CONFIGS).filter((c) => c.enabled);

/** Get chain config by EVM chain ID */
export function getChainById(chainId: number): ChainConfig | undefined {
    return ENABLED_CHAINS.find((c) => c.chainId === chainId);
}

/** Get chain config by key */
export function getChain(key: string): ChainConfig | undefined {
    return CHAIN_CONFIGS[key];
}

/** Get native currency symbol for a chain (default: "SOL" for Solana) */
export function getCurrencySymbol(chainId?: number): string {
    if (!chainId) return "SOL";
    return getChainById(chainId)?.nativeCurrency.symbol ?? "SOL";
}

/** Get native currency decimals for a chain */
export function getCurrencyDecimals(chainId?: number): number {
    if (!chainId) return 9; // SOL default (lamports use 9 decimals)
    return getChainById(chainId)?.nativeCurrency.decimals ?? 9;
}

/** Convert raw amount to human-readable using chain-specific decimals */
export function toNative(rawAmount: bigint | number, chainId?: number): number {
    const decimals = getCurrencyDecimals(chainId);
    return Number(rawAmount) / Math.pow(10, decimals);
}

/**
 * Format a human-readable (already-native, not raw/lamports) currency
 * amount for display, sized to the chain's real precision instead of a
 * flat hardcoded value.
 *
 * `maxDecimals`, when given, overrides the chain-derived precision — useful
 * for fiat-style display (2dp) where the value isn't actually a chain's
 * native token. Left unset, precision is `getCurrencyDecimals(chainId)`
 * capped at 4: full on-chain precision (9 for SOL, 18 for ETH) is raw-unit
 * precision, not a useful display width.
 *
 * This is the single source of truth for "how many decimal places" — the
 * three call sites that used to each hardcode their own (useChainCurrency,
 * market-item-card, and previously a flat 2dp everywhere) now share it.
 */
export function formatChainCurrency(amount: number, chainId?: number, maxDecimals?: number): string {
    const decimals = maxDecimals ?? Math.min(getCurrencyDecimals(chainId), 4);
    return amount.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: decimals,
    });
}

/** Get explorer TX link for a chain */
export function getExplorerTxUrl(hash: string, chainId?: number): string {
    if (!chainId) return CHAIN_CONFIGS.solana.explorer.txUrl(hash);
    const chain = getChainById(chainId);
    return chain?.explorer.txUrl(hash) ?? `#`;
}

/** Get explorer contract link for a chain */
export function getExplorerContractUrl(addr: string, chainId?: number): string {
    if (!chainId) return CHAIN_CONFIGS.solana.explorer.contractUrl(addr);
    const chain = getChainById(chainId);
    return chain?.explorer.contractUrl(addr) ?? `#`;
}

/** Get deployed contract addresses for a chain (returns empty object if none) */
export function getContracts(chainId?: number) {
    if (!chainId) return CHAIN_CONFIGS.solana.contracts;
    return getChainById(chainId)?.contracts ?? {};
}

/** Shorten an address: 0x1234...5678 */
export function shortAddress(addr: string): string {
    if (!addr || addr === "0x0000000000000000000000000000000000000000") return "—";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Chains that support marketplace payments */
export const PAYMENT_CHAINS = Object.values(CHAIN_CONFIGS).filter((c) => c.paymentEnabled);

/** USDC contract addresses per chain (6 decimals everywhere) */
export const USDC_CONTRACTS: Record<string, string> = Object.fromEntries(
    Object.entries(CHAIN_CONFIGS)
        .filter(([, c]) => c.contracts.usdc)
        .map(([k, c]) => [k, c.contracts.usdc!]),
);

/** USDC uses 6 decimals on all chains */
export const USDC_DECIMALS = 6;

