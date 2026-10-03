/**
 * Market — Types + Registry
 *
 * Browse, install, and manage agent mods, plugins, and skills.
 * Items are stored in Firestore per-org, with a static registry
 * of available items from the marketplace.
 */

import { hashModEntry, verifyModIntegrity } from "./mod-integrity";
import {
    collection,
    doc,
    addDoc,
    updateDoc,
    deleteDoc,
    getDoc,
    getDocs,
    query,
    where,
    serverTimestamp,
    Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** Inline — extracted from token-gate mod */
export interface TokenGateConfig {
    contractAddress: string;
    chainId: number;
    minBalance?: string;
    tokenType?: "ERC20" | "ERC721" | "ERC1155";
}

export type MarketItemType = "mod" | "plugin" | "skill" | "skin" | "agent" | "compute";
export type MarketItemSource = "verified" | "community";
export type PricingModel = "free" | "subscription" | "purchase" | "rental" | "hire";
export type SubscriptionPlan = "monthly" | "yearly" | "lifetime";

export interface PricingTier {
    plan: SubscriptionPlan;
    price: number;
    currency: string; // "USD" | "SOL"
}

export interface MarketPricing {
    model: PricingModel;
    tiers?: PricingTier[];
}

// ── Mod Manifest types (reusable for all vendor mods) ──

export interface ModTool {
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    status: "active" | "coming_soon";
    usageExample?: string;
}

export interface ModWorkflow {
    id: string;
    name: string;
    description: string;
    icon: string;
    tags: string[];
    steps: string[];
    estimatedTime?: string;
}

export interface ModExample {
    id: string;
    name: string;
    description: string;
    icon: string;
    tags: string[];
    codeSnippet?: string;
    language?: string;
}

export interface ModAgentSkill {
    id: string;
    name: string;
    description: string;
    type: "skill";
    invocation: string;
    exampleInput?: string;
    exampleOutput?: string;
}

export interface ModManifest {
    tools: ModTool[];
    workflows: ModWorkflow[];
    examples: ModExample[];
    agentSkills: ModAgentSkill[];
}

export interface Skill {
    id: string;
    name: string;
    description: string;
    type: MarketItemType;
    source: MarketItemSource;
    category: string;
    icon: string;
    version: string;
    author: string;
    /** What env vars / API keys this skill needs */
    requiredKeys?: string[];
    /** Tags for search */
    tags: string[];
    /** Pricing model */
    pricing: MarketPricing;
    /** Is this installed for the org? */
    installed?: boolean;
    /** Is it enabled? */
    enabled?: boolean;
    /** Install date */
    installedAt?: Date | null;
    /** Dependency mod IDs that must be installed first */
    requires?: string[];
    /** If present, this item adds a sidebar tab when installed */
    sidebarConfig?: {
        sectionId: string;
        label: string;
        href: string;
        iconName: string;
        /** If set, render as child under this mod's sidebar entry instead of top-level */
        parentModId?: string;
    };
    /** Mod manifest — tools, workflows, examples, agent skills */
    modManifest?: ModManifest;
    /** Optional token gate — hold tokens/NFTs to access instead of paying */
    tokenGate?: TokenGateConfig;
}

export interface SkillBundle {
    id: string;
    name: string;
    description: string;
    icon: string;
    skillIds: string[];
}

/** An item the org has acquired/owns in their inventory */
export interface OwnedItem {
    id: string;             // Firestore doc ID
    orgId: string;
    skillId: string;        // reference to marketplace item
    enabled: boolean;
    config?: Record<string, string>;  // API keys, settings
    installedAt: Date | null;
    installedBy: string;
}

/** @deprecated Use OwnedItem instead */
export type InstalledSkill = OwnedItem;

/** A skill/plugin installed on a specific agent */
export interface AgentSkill {
    id: string;             // Firestore doc ID
    agentId: string;
    skillId: string;        // reference to marketplace item
    orgId: string;
    installedAt: Date | null;
    installedBy: string;
}

// ═══════════════════════════════════════════════════════════════
// Mod Registry — Vendor Package + Capability Types
// ═══════════════════════════════════════════════════════════════

export type ModCategory = "official" | "community" | "partner";
export type ModStatus = "draft" | "review" | "approved" | "disabled";
export type InstallScope = "org" | "project" | "agent";

export type PermissionScope =
    | "read"
    | "write"
    | "execute"
    | "external_api"
    | "wallet_access"
    | "webhook_access"
    | "cross_chain_message"
    | "sensitive_data_access";

export type CapabilityType = "plugin" | "skill" | "workflow" | "example" | "panel" | "policy";

/** Top-level vendor package */
export interface VendorMod {
    id: string;
    slug: string;
    vendor: string;
    name: string;
    version: string;
    category: ModCategory;
    description: string;
    iconUrl?: string;
    icon?: string;
    installedScopes: InstallScope[];
    capabilities: string[];
    status: ModStatus;
    legacySkillId?: string;
    sidebarConfig?: {
        sectionId: string;
        label: string;
        href: string;
        iconName: string;
    };
    pricing?: MarketPricing;
    requiredKeys?: string[];
    tags?: string[];
}

/** Every installable unit exposed by a mod */
export interface Capability {
    id: string;
    modId: string;
    type: CapabilityType;
    key: string;
    name: string;
    description: string;
    configSchema?: unknown;
    permissionScopes: PermissionScope[];
}

/** Tracks per-org mod installation */
export interface ModInstallation {
    id: string;
    modId: string;
    orgId: string;
    enabled: boolean;
    enabledCapabilities: string[];
    config: Record<string, unknown>;
    installedBy: string;
    installedAt: Date | null;
    /** SHA-256 of the mod's registry entry at install time (see mod-integrity.ts). */
    contentHash?: string;
}

/** Resolved capability for an agent (merged from all sources) */
export interface ResolvedCapability {
    key: string;
    name: string;
    description: string;
    type: CapabilityType;
    modId: string;
    modName: string;
    permissionScopes: PermissionScope[];
}

// ═══════════════════════════════════════════════════════════════
// Agent Package Standard (SAP) — Agent Guild Agent Package
// ═══════════════════════════════════════════════════════════════

export type AgentCategory =
    | "trading" | "research" | "customer-support" | "governance"
    | "security" | "compliance" | "creative" | "engineering"
    | "analytics" | "operations" | "general"
    | "core-development" | "language-specialists" | "infrastructure"
    | "quality-security" | "data-ai" | "developer-experience"
    | "specialized-domains" | "business-product" | "meta-orchestration"
    | "research-analysis";

export type AgentListingStatus = "draft" | "review" | "approved" | "rejected" | "disabled";
export type AgentDistribution = "config" | "rental" | "hire";
export type RentalModel = "monthly" | "usage" | "performance";

/** Pricing for agent marketplace — supports sale + rental + hire */
export interface AgentPricing {
    configPurchase?: number;
    rentalMonthly?: number;
    rentalUsage?: number;
    rentalPerformance?: number;
    hirePerTask?: number;
    currency: "USD" | "SOL";
}

/** Identity config — who the agent is (identity.json) */
export interface AgentIdentityConfig {
    agentType: string;
    persona: string;
    personality?: string[];
    rules?: string[];
    systemPrompt?: string;
}

/** Workflow definition (workflow/) */
export interface AgentWorkflowDef {
    id: string;
    name: string;
    description: string;
    trigger: "manual" | "scheduled" | "event";
    steps: string[];
    cronExpression?: string;
}

/** Policy/risk config (policies/) */
export interface AgentPolicyConfig {
    riskLevel: "low" | "medium" | "high";
    requiresApproval?: boolean;
    approvalGates?: string[];
    maxConcurrentTasks?: number;
    spendingCapUsd?: number;
    taskLimit?: number;
    allowedChains?: number[];
    allowedContracts?: string[];
}

/** Memory config (memory/) */
export interface AgentMemoryConfig {
    longTermMemory: boolean;
    conversationHistory: boolean;
    vectorStore?: boolean;
}

/** The Agent Guild Agent Package — full publishable agent definition */
export interface AgentPackage {
    id: string;
    slug: string;
    name: string;
    version: string;
    description: string;
    longDescription?: string;
    author: string;
    authorWallet: string;
    icon: string;
    category: AgentCategory;
    tags: string[];
    distributions: AgentDistribution[];
    pricing: AgentPricing;
    identity: AgentIdentityConfig;
    requiredSkills: string[];
    requiredMods?: string[];
    requiredKeys?: string[];
    workflows?: AgentWorkflowDef[];
    policy?: AgentPolicyConfig;
    memory?: AgentMemoryConfig;
    /** Full SOUL personality template — applied when user installs this persona */
    soulTemplate?: import("./soul").SOULConfig;
    status: AgentListingStatus;
    source: MarketItemSource;
    publishedAt?: Date | null;
    updatedAt?: Date | null;
    installCount: number;
    rentalCount: number;
    hireCount: number;
    avgRating: number;
    ratingCount: number;
    ain?: string;
    trustScore?: number;
    creditScore?: number;
    fraudRisk?: "low" | "medium" | "high";
    jobsCompleted?: number;
    creatorRevShare: number;
}

/** Tracks a marketplace agent installation */
export interface AgentInstall {
    id: string;
    packageId: string;
    packageSlug: string;
    orgId: string;
    agentId: string;
    version: string;
    distribution: AgentDistribution;
    installedBy: string;
    installedAt: Date | null;
    onChainTxHash?: string;
    onChainRegistered: boolean;
    ain?: string;
    status: "active" | "stopped" | "uninstalled";
    rentalModel?: RentalModel;
    spendingCap?: number;
    taskLimit?: number;
    allowedChains?: number[];
}

/** A user review/rating */
export interface AgentRating {
    id: string;
    packageId: string;
    orgId: string;
    reviewerWallet: string;
    rating: number;
    review?: string;
    createdAt: Date | null;
}

/** Creator profile for the marketplace */
export interface CreatorProfile {
    id: string;
    walletAddress: string;
    displayName: string;
    bio?: string;
    avatarUrl?: string;
    website?: string;
    twitter?: string;
    publishedCount: number;
    totalInstalls: number;
    totalRentals: number;
    totalRevenue: number;
    revShareRate: number;
    createdAt: Date | null;
}

export const AGENT_CATEGORIES = [
    "All", "Analytics", "Business & Product", "Compliance", "Core Development",
    "Creative", "Customer Support", "Data & AI", "Developer Experience",
    "Engineering", "General", "Governance", "Infrastructure",
    "Language Specialists", "Meta & Orchestration", "Operations",
    "Quality & Security", "Research", "Research & Analysis",
    "Security", "Specialized Domains", "Trading",
];

export const COMPUTE_CATEGORIES = [
    "GPU Node", "CPU Node", "Storage", "Bandwidth", "Cluster"
];

// ═══════════════════════════════════════════════════════════════
// Marketplace Registry (static — would come from API in prod)
// ═══════════════════════════════════════════════════════════════

export const SKILL_REGISTRY: Skill[] = [
    // ── Mods ── (free, first-party — panels live in mods/<id>/, gated by
    // ownership here so orgs start with none and add them from the market)
    // Paid third-party mods load dynamically from the mod gateway registry —
    // see: loadRemoteModRegistry() below.
    {
        id: "hyperliquid-trading",
        name: "Hyperliquid Trading",
        description: "Lets an agent deploy its settled earnings by placing trades on Hyperliquid, via a GatewayAgent-executed order with a verifiable fill receipt. Adds leverage/SL-TP risk controls, limit orders, trade history, DCA/grid/signal/sniper strategies, TradingView-style webhooks, and a volume-based referral program.",
        type: "mod",
        source: "verified",
        category: "Trading",
        icon: "⚡",
        version: "1.2.0",
        author: "Agent Guild",
        tags: ["hyperliquid", "trading", "defi", "perps"],
        pricing: { model: "free" },
        sidebarConfig: { sectionId: "modifications", label: "Hyperliquid Trading", href: "/mods/hyperliquid-trading/trading", iconName: "Zap" },
        modManifest: {
            tools: [],
            workflows: [],
            examples: [],
            agentSkills: [
                { id: "hyperliquid-trade", name: "Place Trade", description: "Place a buy/sell order on Hyperliquid.", type: "skill", invocation: "POST /trade" },
                { id: "hyperliquid-close", name: "Close Position", description: "Close an open Hyperliquid position.", type: "skill", invocation: "POST /close" },
                { id: "hyperliquid-configure-risk", name: "Configure Risk", description: "Set leverage, position, and daily-loss limits for an agent's trades.", type: "skill", invocation: "POST /risk-config" },
                { id: "hyperliquid-run-strategy", name: "Run Strategy", description: "Create and run an automated DCA, grid, signal, or sniper (new-listing / price-break) trading strategy.", type: "skill", invocation: "POST /strategy" },
                { id: "hyperliquid-webhook", name: "Manage Webhook", description: "Issue or revoke a webhook token that lets an external alert source (e.g. TradingView) fire a signal strategy.", type: "skill", invocation: "POST /strategy/:id/webhook-token" },
            ],
        },
    },
    {
        id: "solana-settlement",
        name: "Solana",
        description: "Upgrades your agents into Solana developers. They can debug the chain (decode failed transactions and program errors, inspect accounts and programs, read Anchor IDLs, derive PDAs), build and simulate transactions from plain JSON, act on devnet with their own wallet (airdrop, send, create tokens), and write Anchor programs — build, test and deploy in a sandbox. Also settles completed jobs in USDC on Solana with an on-chain receipt. Includes a dev-tools panel for you.",
        type: "mod",
        source: "verified",
        category: "Developer",
        icon: "◎",
        version: "2.0.0",
        author: "Agent Guild",
        tags: ["solana", "developer-tools", "anchor", "agents", "devnet", "settlement", "usdc"],
        pricing: { model: "free" },
        sidebarConfig: { sectionId: "modifications", label: "Solana", href: "/mods/solana-settlement/solana", iconName: "Wrench" },
        modManifest: {
            tools: [],
            workflows: [],
            examples: [],
            // Capability keys — mods/solana-settlement/agent.ts CAP must match.
            agentSkills: [
                { id: "solana-dev-inspect", name: "Read & Debug Chain", description: "Inspect transactions and accounts, decode program errors, read Anchor IDLs, derive PDAs, query priority fees and rent.", type: "skill", invocation: "GET /dev/tx/:signature" },
                { id: "solana-dev-simulate", name: "Build & Simulate Transactions", description: "Build transactions from Anchor IDLs or raw instructions and simulate them for logs, compute units and decoded errors.", type: "skill", invocation: "POST /dev/simulate" },
                { id: "solana-dev-devnet", name: "Act on Devnet", description: "Sign and send devnet transactions with the agent's own dev wallet: airdrop, send, create tokens.", type: "skill", invocation: "POST /dev/send" },
                { id: "solana-dev-anchor", name: "Write Anchor Programs", description: "Build, test and deploy Anchor programs in a sandboxed GatewayAgent container.", type: "skill", invocation: "POST /dev/anchor" },
                // Kept as "solana-settlement": existing installs were granted this key, and POST /settle checks it.
                { id: "solana-settlement", name: "Settle Jobs", description: "Settle a completed job in USDC with an on-chain receipt hash.", type: "skill", invocation: "POST /settle" },
            ],
        },
    },
    {
        id: "tempo-settlement",
        name: "Tempo Settlement",
        description: "Settles completed agent jobs on Tempo using Tempo's native protocol — receipt hash carried in a real TIP-20 transfer memo, gas payable in any stablecoin, optional fee sponsorship, and atomic multi-job batch settlement in one transaction. Also exposes a Machine Payments Protocol (HTTP 402) paid endpoint, plus micropayment metering, void/dispute, stats, CSV export, and fee estimates.",
        type: "mod",
        source: "verified",
        category: "Settlement",
        icon: "⚡",
        version: "1.3.0",
        author: "Agent Guild",
        tags: ["tempo", "settlement", "stablecoin", "payments"],
        pricing: { model: "free" },
        sidebarConfig: { sectionId: "modifications", label: "Tempo Settlement", href: "/mods/tempo-settlement/settlements", iconName: "Zap" },
    },
    {
        id: "tagem-wallet",
        name: "Tangem Wallet",
        description: "Multi-chain balance dashboard, send, and receive for a Tangem hardware wallet connected via WalletConnect. Signing happens on the card itself — this mod never holds a key.",
        type: "mod",
        source: "verified",
        category: "Wallet",
        icon: "💳",
        version: "1.0.0",
        author: "Agent Guild",
        tags: ["wallet", "tangem", "hardware-wallet", "multi-chain"],
        pricing: { model: "free" },
        sidebarConfig: { sectionId: "modifications", label: "Tangem Wallet", href: "/mods/tagem-wallet/wallet", iconName: "DollarSign" },
    },
    {
        id: "dimos-bench",
        name: "dimOS Benchmarks",
        description: "Benchmarks agents on dimOS (dimensionalOS) robot eval suites — recordings, MuJoCo/Habitat sims, or a live robot. Agents submit signed eval runs; a per-suite leaderboard ranks them, and generation lineages track a harness improving run after run, with a feedback-context endpoint and a plateau signal for self-improvement loops.",
        type: "mod",
        source: "verified",
        category: "Analytics",
        icon: "🤖",
        version: "0.2.0",
        author: "Agent Guild",
        tags: ["dimos", "robotics", "benchmarks", "evals", "leaderboard"],
        pricing: { model: "free" },
        sidebarConfig: { sectionId: "modifications", label: "dimOS Benchmarks", href: "/mods/dimos-bench/leaderboard", iconName: "Bot" },
        modManifest: {
            tools: [],
            workflows: [],
            examples: [],
            agentSkills: [
                { id: "dimos-submit-run", name: "Submit Eval Run", description: "File a dimOS eval run (optionally as the next generation of a lineage).", type: "skill", invocation: "POST /runs" },
                { id: "dimos-run-feedback", name: "Get Run Feedback", description: "Failed/errored cases plus earlier improvement notes, for a feedback agent.", type: "skill", invocation: "GET /runs/:runId/feedback" },
                { id: "dimos-lineage", name: "Check Lineage", description: "Score per generation and a plateau / continue-or-stop signal.", type: "skill", invocation: "GET /lineages/:lineageId" },
            ],
        },
    },

    // ── Plugins ── (free, included in core)
    {
        id: "github-tools",
        name: "GitHub Integration",
        description: "Interact with GitHub repos — create issues, PRs, read code, manage workflows.",
        type: "plugin",
        source: "verified",
        category: "Developer",
        icon: "🐙",
        version: "1.3.0",
        author: "Agent Guild Core",
        requiredKeys: ["GITHUB_TOKEN"],
        tags: ["github", "git", "code", "pr", "issues"],
        pricing: { model: "free" },
    },
    {
        id: "slack-notify",
        name: "Slack Notifications",
        description: "Send notifications and messages to Slack channels and users.",
        type: "plugin",
        source: "verified",
        category: "Communication",
        icon: "💬",
        version: "1.0.0",
        author: "Agent Guild Core",
        requiredKeys: ["SLACK_BOT_TOKEN"],
        tags: ["slack", "notifications", "messaging"],
        pricing: { model: "free" },
    },
    {
        id: "email-sender",
        name: "Email Sender",
        description: "Compose and send emails via SMTP or SendGrid. Supports templates and attachments.",
        type: "plugin",
        source: "verified",
        category: "Communication",
        icon: "📧",
        version: "1.0.0",
        author: "Agent Guild Core",
        requiredKeys: ["SENDGRID_API_KEY"],
        tags: ["email", "smtp", "sendgrid", "notifications"],
        pricing: { model: "free" },
    },
    {
        id: "calendar-sync",
        name: "Calendar Sync",
        description: "Read and create calendar events. Integrates with Google Calendar and Outlook.",
        type: "plugin",
        source: "verified",
        category: "Productivity",
        icon: "📅",
        version: "1.0.0",
        author: "Agent Guild Core",
        requiredKeys: ["GOOGLE_CALENDAR_KEY"],
        tags: ["calendar", "events", "scheduling"],
        pricing: { model: "free" },
    },
    {
        id: "blockchain-tools",
        name: "Blockchain Tools",
        description: "Interact with EVM chains — read balances, send transactions, query contracts.",
        type: "plugin",
        source: "verified",
        category: "Web3",
        icon: "⛓️",
        version: "1.0.0",
        author: "Agent Guild Core",
        tags: ["blockchain", "web3", "ethereum", "transactions"],
        pricing: { model: "free" },
    },

    // ── Skills ──
    {
        id: "web-search",
        name: "Web Search",
        description: "Search the web for real-time information. Uses Tavily or SerpAPI for comprehensive results.",
        type: "skill",
        source: "verified",
        category: "Research",
        icon: "🔍",
        version: "1.2.0",
        author: "Agent Guild Core",
        requiredKeys: ["TAVILY_API_KEY"],
        tags: ["search", "research", "web", "news"],
        pricing: { model: "free" },
    },
    {
        id: "code-interpreter",
        name: "Code Interpreter",
        description: "Execute Python and JavaScript code in a sandboxed environment. Great for data analysis, math, and scripting.",
        type: "skill",
        source: "verified",
        category: "Developer",
        icon: "💻",
        version: "2.0.1",
        author: "Agent Guild Core",
        tags: ["code", "python", "javascript", "analysis"],
        pricing: { model: "free" },
    },
    {
        id: "file-manager",
        name: "File Manager",
        description: "Read, write, and manage files. Supports text files, CSVs, JSON, and more.",
        type: "skill",
        source: "verified",
        category: "Developer",
        icon: "📁",
        version: "1.1.0",
        author: "Agent Guild Core",
        tags: ["files", "filesystem", "csv", "json"],
        pricing: { model: "free" },
    },
    {
        id: "image-gen",
        name: "Image Generator",
        description: "Generate images from text prompts using DALL-E 3 or Stable Diffusion.",
        type: "skill",
        source: "verified",
        category: "Creative",
        icon: "🎨",
        version: "1.0.0",
        author: "Agent Guild Core",
        requiredKeys: ["OPENAI_API_KEY"],
        tags: ["image", "art", "generation", "dalle"],
        pricing: { model: "free" },
    },
    {
        id: "pdf-reader",
        name: "PDF Reader",
        description: "Extract text, tables, and metadata from PDF documents.",
        type: "skill",
        source: "verified",
        category: "Research",
        icon: "📄",
        version: "1.1.0",
        author: "Agent Guild Core",
        tags: ["pdf", "documents", "text", "extraction"],
        pricing: { model: "free" },
    },
    {
        id: "data-viz",
        name: "Data Visualization",
        description: "Create charts, graphs, and dashboards from data using Chart.js and D3.",
        type: "skill",
        source: "verified",
        category: "Analytics",
        icon: "📊",
        version: "1.0.0",
        author: "Agent Guild Core",
        tags: ["charts", "graphs", "data", "visualization"],
        pricing: { model: "free" },
    },
    {
        id: "memory-store",
        name: "Long-Term Memory",
        description: "Persistent memory for agents. Store and retrieve facts, context, and conversation history across sessions.",
        type: "skill",
        source: "verified",
        category: "Core",
        icon: "🧠",
        version: "1.0.0",
        author: "Agent Guild Core",
        tags: ["memory", "storage", "context", "persistence"],
        pricing: { model: "free" },
    },


];

/**
 * Load remote mod services from the gateway registry and merge
 * them with the static SKILL_REGISTRY. Returns Skill entries
 * for remote mods that aren't already in the static registry.
 */
// [agent-guild-core] mod-gateway extracted — remote mod registry disabled
export async function loadRemoteModRegistry(): Promise<Skill[]> {
    return [];
}

export const SKILL_BUNDLES: SkillBundle[] = [
    {
        id: "developer-bundle",
        name: "Developer Toolkit",
        description: "Essential tools for development workflows — code execution, GitHub, file management.",
        icon: "🛠️",
        skillIds: ["code-interpreter", "file-manager", "github-tools"],
    },
    {
        id: "research-bundle",
        name: "Research Suite",
        description: "Research and analysis tools — web search, PDF reader, data visualization.",
        icon: "🔬",
        skillIds: ["web-search", "pdf-reader", "data-viz"],
    },
    {
        id: "comms-bundle",
        name: "Communications Pack",
        description: "Keep your team informed — Slack notifications, email, and calendar sync.",
        icon: "📡",
        skillIds: ["slack-notify", "email-sender", "calendar-sync"],
    },
];

// ═══════════════════════════════════════════════════════════════
// Categories (per type)
// ═══════════════════════════════════════════════════════════════

export const SKILL_CATEGORIES = [
    "All",
    ...Array.from(new Set(SKILL_REGISTRY.map((s) => s.category))).sort(),
];

function categoriesForType(type: MarketItemType): string[] {
    return [
        "All",
        ...Array.from(new Set(SKILL_REGISTRY.filter((s) => s.type === type).map((s) => s.category))).sort(),
    ];
}

export const MOD_CATEGORIES = categoriesForType("mod");
export const PLUGIN_CATEGORIES = categoriesForType("plugin");
export const SKILL_ONLY_CATEGORIES = categoriesForType("skill");
export const SKIN_CATEGORIES = categoriesForType("skin");
export const AGENT_ITEM_CATEGORIES = AGENT_CATEGORIES;

// ═══════════════════════════════════════════════════════════════
// Mod + Capability Registries (derived from SKILL_REGISTRY)
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a semver string into [major, minor, patch].
 * Returns [0,0,0] for invalid input.
 */
function parseSemver(v: string): [number, number, number] {
    const parts = v.replace(/^v/, "").split(".").map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/**
 * Check whether an installed version is compatible with a registry version.
 * Uses semver major-version compatibility: same major = compatible.
 */
export function isVersionCompatible(installed: string, registry: string): boolean {
    const [iMajor] = parseSemver(installed);
    const [rMajor] = parseSemver(registry);
    return iMajor === rMajor;
}

/**
 * Check whether a subscription is currently active (not expired).
 */
export function isSubscriptionActive(sub: { status: string; endDate: Date | null }): boolean {
    if (sub.status !== "active") return false;
    if (!sub.endDate) return true; // lifetime
    return sub.endDate.getTime() > Date.now();
}

function inferPermissions(desc: string, id: string): PermissionScope[] {
    const scopes: PermissionScope[] = ["execute"];
    const text = `${desc} ${id}`.toLowerCase();
    if (text.includes("chain") || text.includes("ccip") || text.includes("propagate"))
        scopes.push("cross_chain_message");
    if (text.includes("wallet") || text.includes("transaction") || text.includes("attestation"))
        scopes.push("wallet_access");
    if (text.includes("api") || text.includes("oracle") || text.includes("fetch") || text.includes("search"))
        scopes.push("external_api", "read");
    if (text.includes("publish") || text.includes("write") || text.includes("create") || text.includes("send"))
        scopes.push("write");
    if (text.includes("read") || text.includes("extract") || text.includes("query"))
        scopes.push("read");
    return [...new Set(scopes)];
}

export const MOD_REGISTRY: VendorMod[] = [];
export const CAPABILITY_REGISTRY: Capability[] = [];

for (const skill of SKILL_REGISTRY) {
    const mod: VendorMod = {
        id: `mod-${skill.id}`,
        slug: skill.id,
        vendor: skill.author,
        name: skill.name,
        version: skill.version,
        category: skill.source === "verified" ? "official" : "community",
        description: skill.description,
        icon: skill.icon,
        installedScopes: ["org"],
        capabilities: [],
        status: "approved",
        legacySkillId: skill.id,
        sidebarConfig: skill.sidebarConfig,
        pricing: skill.pricing,
        requiredKeys: skill.requiredKeys,
        tags: skill.tags,
    };

    if (skill.modManifest) {
        for (const agentSkill of skill.modManifest.agentSkills) {
            const cap: Capability = {
                id: agentSkill.id,
                modId: mod.id,
                type: "skill",
                key: agentSkill.id,
                name: agentSkill.name,
                description: agentSkill.description,
                permissionScopes: inferPermissions(agentSkill.description, agentSkill.id),
            };
            CAPABILITY_REGISTRY.push(cap);
            mod.capabilities.push(cap.id);
        }
        for (const workflow of skill.modManifest.workflows) {
            const cap: Capability = {
                id: `${skill.id}.workflow.${workflow.id}`,
                modId: mod.id,
                type: "workflow",
                key: `${skill.id}.workflow.${workflow.id}`,
                name: workflow.name,
                description: workflow.description,
                permissionScopes: inferPermissions(workflow.description, workflow.id),
            };
            CAPABILITY_REGISTRY.push(cap);
            mod.capabilities.push(cap.id);
        }
    } else {
        const cap: Capability = {
            id: skill.id,
            modId: mod.id,
            type: skill.type === "plugin" ? "plugin" : "skill",
            key: skill.id,
            name: skill.name,
            description: skill.description,
            permissionScopes: inferPermissions(skill.description, skill.id),
        };
        CAPABILITY_REGISTRY.push(cap);
        mod.capabilities.push(cap.id);
    }

    MOD_REGISTRY.push(mod);
}

// ── Derived capabilities ──
//
// Two capability sources that need no install doc: the agent-wallet
// capability (held by any agent with an identity address or a custodial
// wallet), and reported skills whose id names a free registry capability.
// Both resolvers below (client and firestore-admin) call these so the
// dashboard and the API cannot drift.

export const AGENT_WALLET_CAPABILITY: Capability = {
    id: "agent-wallet",
    modId: "agent-wallet",
    type: "skill",
    key: "agent-wallet",
    name: "Agent Wallet",
    description: "Read the agent's identity and custodial wallets and their balances.",
    permissionScopes: ["read"],
};
CAPABILITY_REGISTRY.push(AGENT_WALLET_CAPABILITY);

/**
 * Capability ids an agent holds without an install: agent-wallet when it
 * has a wallet, plus each reported skill that matches a registry id. A
 * reported skill never unlocks a paid mod's capability (that would skip
 * the subscription check above) and never claims agent-wallet itself.
 */
export function derivedCapabilityIds(input: {
    hasWallet: boolean;
    reportedSkills?: { id: string }[];
}): string[] {
    const ids: string[] = [];
    if (input.hasWallet) ids.push(AGENT_WALLET_CAPABILITY.id);
    for (const skill of input.reportedSkills ?? []) {
        if (skill.id === AGENT_WALLET_CAPABILITY.id) continue;
        const cap = CAPABILITY_REGISTRY.find((c) => c.id === skill.id);
        if (!cap) continue;
        const mod = MOD_REGISTRY.find((m) => m.id === cap.modId);
        const model = mod?.pricing?.model;
        if (model && model !== "free") continue;
        ids.push(cap.id);
    }
    return ids;
}

/** Shapes a registry capability for a resolver's output. */
export function toResolvedCapability(cap: Capability): ResolvedCapability {
    const mod = MOD_REGISTRY.find((m) => m.id === cap.modId);
    return {
        key: cap.key,
        name: cap.name,
        description: cap.description,
        type: cap.type,
        modId: cap.modId,
        modName: mod?.name ?? (cap.id === AGENT_WALLET_CAPABILITY.id ? AGENT_WALLET_CAPABILITY.name : "Unknown"),
        permissionScopes: cap.permissionScopes,
    };
}

/** Get all capabilities for a specific mod */
export function getModCapabilities(modId: string): Capability[] {
    return CAPABILITY_REGISTRY.filter((c) => c.modId === modId);
}

/** Look up a mod by slug */
export function getModBySlug(slug: string): VendorMod | undefined {
    return MOD_REGISTRY.find((m) => m.slug === slug);
}

/** Look up a mod by its registry ID */
export function getModById(modId: string): VendorMod | undefined {
    return MOD_REGISTRY.find((m) => m.id === modId);
}

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD — Org Inventory (items the org owns)
// ═══════════════════════════════════════════════════════════════

const INVENTORY_COLLECTION = "installedSkills"; // keeping collection name for backward compat

/** Add an item to the org's inventory */
export async function acquireItem(
    orgId: string,
    skillId: string,
    acquiredBy: string,
): Promise<string> {
    const ref = await addDoc(collection(db, INVENTORY_COLLECTION), {
        orgId,
        skillId,
        enabled: true,
        config: {},
        installedAt: serverTimestamp(),
        installedBy: acquiredBy,
    });
    return ref.id;
}

/** Remove an item from the org's inventory */
export async function removeFromInventory(docId: string): Promise<void> {
    await deleteDoc(doc(db, INVENTORY_COLLECTION, docId));
}

/** Toggle an inventory item on/off */
export async function toggleInventoryItem(docId: string, enabled: boolean): Promise<void> {
    await updateDoc(doc(db, INVENTORY_COLLECTION, docId), { enabled });
}

/** Get all owned items for an org (inventory) */
export async function getOwnedItems(orgId: string): Promise<OwnedItem[]> {
    const q = query(
        collection(db, INVENTORY_COLLECTION),
        where("orgId", "==", orgId),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            orgId: data.orgId,
            skillId: data.skillId,
            enabled: data.enabled ?? true,
            config: data.config,
            installedAt: data.installedAt instanceof Timestamp ? data.installedAt.toDate() : null,
            installedBy: data.installedBy,
        };
    });
}

/** Acquire an entire bundle into org inventory */
export async function acquireBundle(
    orgId: string,
    bundleId: string,
    acquiredBy: string,
    alreadyOwned: string[],
): Promise<void> {
    const bundle = SKILL_BUNDLES.find((b) => b.id === bundleId);
    if (!bundle) throw new Error("Bundle not found");
    for (const skillId of bundle.skillIds) {
        if (!alreadyOwned.includes(skillId)) {
            await acquireItem(orgId, skillId, acquiredBy);
        }
    }
}

// Backward-compat aliases
/** @deprecated Use acquireItem */
export const installSkill = acquireItem;
/** @deprecated Use removeFromInventory */
export const uninstallSkill = removeFromInventory;
/** @deprecated Use toggleInventoryItem */
export const toggleSkill = toggleInventoryItem;
/** @deprecated Use getOwnedItems */
export const getInstalledSkills = getOwnedItems;
/** @deprecated Use acquireBundle */
export const installBundle = acquireBundle;

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD — Agent-Level Skills (per agent)
// ═══════════════════════════════════════════════════════════════

const AGENT_SKILLS_COLLECTION = "agentSkills";

/** Install a skill/plugin on a specific agent */
export async function installSkillOnAgent(
    agentId: string,
    skillId: string,
    orgId: string,
    installedBy: string,
): Promise<string> {
    const ref = await addDoc(collection(db, AGENT_SKILLS_COLLECTION), {
        agentId,
        skillId,
        orgId,
        installedAt: serverTimestamp(),
        installedBy,
    });
    return ref.id;
}

/** Remove a skill/plugin from a specific agent */
export async function removeSkillFromAgent(docId: string): Promise<void> {
    await deleteDoc(doc(db, AGENT_SKILLS_COLLECTION, docId));
}

/** Get all skills installed on a specific agent */
export async function getAgentSkills(agentId: string): Promise<AgentSkill[]> {
    const q = query(
        collection(db, AGENT_SKILLS_COLLECTION),
        where("agentId", "==", agentId),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            agentId: data.agentId,
            skillId: data.skillId,
            orgId: data.orgId,
            installedAt: data.installedAt instanceof Timestamp ? data.installedAt.toDate() : null,
            installedBy: data.installedBy,
        };
    });
}

// ═══════════════════════════════════════════════════════════════
// Community Submissions
// ═══════════════════════════════════════════════════════════════

const COMMUNITY_COLLECTION = "communityMarketItems";

export interface CommunityMarketItem {
    id: string;
    name: string;
    description: string;
    longDescription?: string;
    type: MarketItemType;
    category: string;
    icon: string;
    version: string;
    tags: string[];
    requiredKeys?: string[];
    pricing: MarketPricing;
    submittedBy: string;
    submittedByName?: string;
    submittedAt: Date | null;
    status: "pending" | "approved" | "rejected" | "changes_requested" | "suspended";
    /** Skin theme config (type === "skin") */
    skinConfig?: {
        colors?: Record<string, string>;
        features?: string[];
    };
    /** Compute Node spec (type === "compute") */
    computeConfig?: {
        vCpu?: number;
        ramGb?: number;
        gpu?: string;
        region?: string;
    };
    /** Simplified mod manifest entries (type === "mod") */
    modManifest?: {
        tools?: string[];
        workflows?: string[];
        agentSkills?: string[];
    };
    // ── Submission Protocol v1 fields ──
    /** "concept" (PRD/idea) or "build" (working code) */
    submissionType?: "concept" | "build";
    /** Submission track */
    submissionTrack?: "prd_only" | "open_repo" | "private_repo" | "managed_partner";
    /** Current pipeline stage */
    stage?: import("./submission-protocol").SubmissionStage;
    /** Audit trail of review decisions */
    reviewHistory?: import("./submission-protocol").ReviewEntry[];
    /** Appeal comment if re-submitting after rejection */
    appealComment?: string;
    appealedAt?: Date | null;
    /** Post-approval visibility */
    publicationStatus?: "live" | "unlisted" | "suspended";
    /** GitHub repo URL (open_repo track) */
    repoUrl?: string;
    /** Demo URL */
    demoUrl?: string;
    /** Screenshot URLs */
    screenshotUrls?: string[];
    /** Declared permission scopes */
    permissionsRequired?: PermissionScope[];
    /** Doc ID of item being updated (version bump) */
    updateOf?: string;
    /** Previous version string (for updates) */
    previousVersion?: string;
    /** Number of user reports */
    reportCount?: number;
    /** Last install or update date */
    lastActiveAt?: Date | null;
    /** Number of installs */
    installCount?: number;
    /** Average user rating */
    avgRating?: number;
    /** Number of ratings received */
    ratingCount?: number;
    /** Whether this item is currently featured */
    featured?: boolean;
    /** When the item was featured */
    featuredAt?: Date | null;
}

// ═══════════════════════════════════════════════════════════════
// Subscriptions
// ═══════════════════════════════════════════════════════════════

const SUBSCRIPTION_COLLECTION = "marketSubscriptions";

export interface MarketSubscription {
    id: string;
    orgId: string;
    itemId: string;        // community item doc ID
    plan: SubscriptionPlan;
    status: "active" | "expired" | "cancelled";
    subscribedBy: string;  // wallet address
    startDate: Date | null;
    endDate: Date | null;   // null = lifetime
}

/** Subscribe an org to a market item */
export async function subscribeToItem(
    orgId: string,
    itemId: string,
    plan: SubscriptionPlan,
    subscribedBy: string,
): Promise<string> {
    // Calculate end date based on plan
    const now = new Date();
    let endDate: Date | null = null;
    if (plan === "monthly") {
        endDate = new Date(now);
        endDate.setMonth(endDate.getMonth() + 1);
    } else if (plan === "yearly") {
        endDate = new Date(now);
        endDate.setFullYear(endDate.getFullYear() + 1);
    }
    // lifetime = null endDate (never expires)

    const ref = await addDoc(collection(db, SUBSCRIPTION_COLLECTION), {
        orgId,
        itemId,
        plan,
        status: "active",
        subscribedBy,
        startDate: serverTimestamp(),
        endDate: endDate ? Timestamp.fromDate(endDate) : null,
    });
    return ref.id;
}

/** Cancel a subscription */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
    await updateDoc(doc(db, SUBSCRIPTION_COLLECTION, subscriptionId), {
        status: "cancelled",
    });
}

/** Get all active subscriptions for an org */
export async function getOrgSubscriptions(orgId: string): Promise<MarketSubscription[]> {
    const q = query(
        collection(db, SUBSCRIPTION_COLLECTION),
        where("orgId", "==", orgId),
        where("status", "==", "active"),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            orgId: data.orgId,
            itemId: data.itemId,
            plan: data.plan,
            status: data.status,
            subscribedBy: data.subscribedBy,
            startDate: data.startDate instanceof Timestamp ? data.startDate.toDate() : null,
            endDate: data.endDate instanceof Timestamp ? data.endDate.toDate() : null,
        };
    });
}

/** Submit a new community market item */
export async function submitMarketItem(
    data: Omit<CommunityMarketItem, "id" | "submittedAt" | "status">,
    overrides?: { status?: CommunityMarketItem["status"]; stage?: CommunityMarketItem["stage"] },
): Promise<string> {
    const ref = await addDoc(collection(db, COMMUNITY_COLLECTION), {
        ...data,
        pricing: data.pricing ?? { model: "free" },
        status: overrides?.status ?? "pending",
        stage: overrides?.stage ?? data.stage ?? "intake",
        publicationStatus: "live",
        reportCount: 0,
        submittedAt: serverTimestamp(),
        lastActiveAt: serverTimestamp(),
    });
    return ref.id;
}

/** Get all approved community items */
export async function getCommunityItems(): Promise<CommunityMarketItem[]> {
    const q = query(
        collection(db, COMMUNITY_COLLECTION),
        where("status", "==", "approved"),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            pricing: data.pricing ?? { model: "free" },
            submittedAt: data.submittedAt instanceof Timestamp ? data.submittedAt.toDate() : null,
            featuredAt: data.featuredAt instanceof Timestamp ? data.featuredAt.toDate() : null,
            lastActiveAt: data.lastActiveAt instanceof Timestamp ? data.lastActiveAt.toDate() : null,
        } as CommunityMarketItem;
    });
}

/** Get submissions by a specific user */
export async function getUserSubmissions(walletAddress: string): Promise<CommunityMarketItem[]> {
    const q = query(
        collection(db, COMMUNITY_COLLECTION),
        where("submittedBy", "==", walletAddress),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            pricing: data.pricing ?? { model: "free" },
            submittedAt: data.submittedAt instanceof Timestamp ? data.submittedAt.toDate() : null,
        } as CommunityMarketItem;
    });
}

/** Delete a community submission */
export async function deleteCommunityItem(docId: string): Promise<void> {
    await deleteDoc(doc(db, COMMUNITY_COLLECTION, docId));
}

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD — Mod Installations
// ═══════════════════════════════════════════════════════════════

const MOD_INSTALL_COLLECTION = "modInstallations";

/** Install a mod for an org (with duplicate & subscription guards) */
export async function installMod(
    modId: string,
    orgId: string,
    installedBy: string,
    enabledCapabilities?: string[],
): Promise<string> {
    const mod = MOD_REGISTRY.find((m) => m.id === modId);
    if (!mod) throw new Error(`Mod not found: ${modId}`);

    // Guard: prevent duplicate installs for same org
    const existing = await getDocs(
        query(
            collection(db, MOD_INSTALL_COLLECTION),
            where("modId", "==", modId),
            where("orgId", "==", orgId),
        ),
    );
    if (!existing.empty) {
        throw new Error(`Mod ${modId} is already installed for org ${orgId}`);
    }

    // Guard: if mod requires a paid subscription, verify it
    if (mod.pricing?.model === "subscription") {
        const subs = await getOrgSubscriptions(orgId);
        const activeSub = subs.find(
            (s) => s.itemId === mod.legacySkillId || s.itemId === modId,
        );
        if (!activeSub) {
            throw new Error(`Active subscription required for mod ${modId}`);
        }
    }

    // Validate requested capabilities exist on this mod
    if (enabledCapabilities) {
        const validCaps = new Set(mod.capabilities);
        const invalid = enabledCapabilities.filter((c) => !validCaps.has(c));
        if (invalid.length > 0) {
            throw new Error(`Invalid capabilities for mod ${modId}: ${invalid.join(", ")}`);
        }
    }

    const ref = await addDoc(collection(db, MOD_INSTALL_COLLECTION), {
        modId,
        orgId,
        enabled: true,
        enabledCapabilities: enabledCapabilities ?? mod.capabilities,
        config: {},
        installedBy,
        installedAt: serverTimestamp(),
        installedVersion: mod.version,
        // Pins what was actually installed — verifyModInstallationIntegrity
        // re-hashes the current registry entry against this to detect a mod
        // changing (e.g. a new capability/permission) after an org already
        // approved it, without re-prompting them to re-approve.
        contentHash: await hashModEntry(mod),
    });

    // Backward compat: also write to legacy inventory
    if (mod.legacySkillId) {
        await acquireItem(orgId, mod.legacySkillId, installedBy);
    }

    return ref.id;
}

/** Uninstall a mod from an org */
export async function uninstallMod(installationId: string): Promise<void> {
    const snap = await getDoc(doc(db, MOD_INSTALL_COLLECTION, installationId));
    if (!snap.exists()) return;
    const data = snap.data();

    await deleteDoc(doc(db, MOD_INSTALL_COLLECTION, installationId));

    // Backward compat: also remove from legacy inventory
    const mod = MOD_REGISTRY.find((m) => m.id === data.modId);
    if (mod?.legacySkillId) {
        const legacyItems = await getOwnedItems(data.orgId);
        const legacyItem = legacyItems.find((i) => i.skillId === mod.legacySkillId);
        if (legacyItem) await removeFromInventory(legacyItem.id);
    }
}

/** Get all mod installations for an org */
export async function getModInstallations(orgId: string): Promise<ModInstallation[]> {
    const q = query(
        collection(db, MOD_INSTALL_COLLECTION),
        where("orgId", "==", orgId),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
        const data = d.data();
        return {
            id: d.id,
            modId: data.modId,
            orgId: data.orgId,
            enabled: data.enabled ?? true,
            enabledCapabilities: data.enabledCapabilities ?? [],
            config: data.config ?? {},
            installedBy: data.installedBy,
            installedAt: data.installedAt instanceof Timestamp ? data.installedAt.toDate() : null,
            contentHash: data.contentHash,
        };
    });
}

/**
 * Re-hashes a mod's current MOD_REGISTRY entry and compares it to the hash
 * recorded when an org installed it (see installMod). A mismatch means the
 * mod's capabilities/manifest changed since that org last approved it —
 * surfacing that is more useful here than silently trusting it, since
 * nothing currently re-prompts an org to re-approve a changed mod.
 * Installations predating this field (no contentHash) can't be checked.
 */
export async function verifyModInstallationIntegrity(
    installation: ModInstallation,
): Promise<{ ok: boolean; reason?: string }> {
    const mod = MOD_REGISTRY.find((m) => m.id === installation.modId);
    if (!mod) return { ok: false, reason: "Mod no longer exists in the registry" };
    if (!installation.contentHash) return { ok: true, reason: "No recorded hash to verify against (installed before integrity tracking)" };

    const matches = await verifyModIntegrity(mod, undefined, installation.contentHash);
    return matches ? { ok: true } : { ok: false, reason: "Mod content has changed since this org installed it" };
}

/** Toggle a mod installation on/off */
export async function toggleModInstallation(installationId: string, enabled: boolean): Promise<void> {
    await updateDoc(doc(db, MOD_INSTALL_COLLECTION, installationId), { enabled });
}

/** Enable/disable a specific capability within a mod installation */
export async function toggleModCapability(
    installationId: string,
    capabilityId: string,
    enabled: boolean,
): Promise<void> {
    const snap = await getDoc(doc(db, MOD_INSTALL_COLLECTION, installationId));
    if (!snap.exists()) return;
    const data = snap.data();
    let caps: string[] = data.enabledCapabilities ?? [];

    if (enabled && !caps.includes(capabilityId)) {
        caps = [...caps, capabilityId];
    } else if (!enabled) {
        caps = caps.filter((c) => c !== capabilityId);
    }

    await updateDoc(doc(db, MOD_INSTALL_COLLECTION, installationId), {
        enabledCapabilities: caps,
    });
}

// ═══════════════════════════════════════════════════════════════
// Capability Resolver — What can this agent actually use?
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve all capabilities available to a specific agent.
 * Merges: org mod installations + legacy agent skill assignments.
 */
export async function getAgentCapabilities(
    agentId: string,
    orgId: string,
): Promise<ResolvedCapability[]> {
    const [installations, agentAssignments, subscriptions, agentDoc] = await Promise.all([
        getModInstallations(orgId),
        getAgentSkills(agentId),
        getOrgSubscriptions(orgId),
        getDoc(doc(db, "agents", agentId))
            .then((d) => d.data() as { solanaAddress?: string; reportedSkills?: { id: string }[] } | undefined)
            .catch(() => undefined),
    ]);

    const enabledInstalls = installations.filter((i) => i.enabled);
    const assignedSkillIds = new Set(agentAssignments.map((a) => a.skillId));

    // Exclude mods whose paid subscriptions have expired
    const expiredModIds = new Set<string>();
    for (const install of enabledInstalls) {
        const mod = MOD_REGISTRY.find((m) => m.id === install.modId);
        if (mod?.pricing?.model === "subscription") {
            const sub = subscriptions.find(
                (s) => s.itemId === install.modId || s.itemId === mod.legacySkillId,
            );
            if (!sub || !isSubscriptionActive(sub)) {
                expiredModIds.add(install.modId);
            }
        }
    }

    // Collect enabled capability IDs, skipping expired subscription mods
    const capabilityIds = new Set<string>();
    for (const install of enabledInstalls) {
        if (expiredModIds.has(install.modId)) continue;
        for (const capId of install.enabledCapabilities) {
            capabilityIds.add(capId);
        }
    }

    // Also include legacy agent-level assignments
    for (const skillId of assignedSkillIds) {
        capabilityIds.add(skillId);
    }

    // Wallet + reported skills. The client can't read agentWallets (key
    // material — no client rule), so only the identity address counts here;
    // firestore-admin's resolver also counts custodial wallets.
    for (const capId of derivedCapabilityIds({
        hasWallet: !!agentDoc?.solanaAddress,
        reportedSkills: agentDoc?.reportedSkills,
    })) {
        capabilityIds.add(capId);
    }

    // Resolve each ID against the capability registry
    const resolved: ResolvedCapability[] = [];
    for (const capId of capabilityIds) {
        const cap = CAPABILITY_REGISTRY.find((c) => c.id === capId);
        if (cap) resolved.push(toResolvedCapability(cap));
    }

    return resolved;
}

/**
 * Enforce that an agent has a specific capability before allowing an action.
 * Returns the resolved capability if granted, throws if not.
 */
export async function enforceCapability(
    agentId: string,
    orgId: string,
    requiredCapabilityKey: string,
    requiredScope?: PermissionScope,
): Promise<ResolvedCapability> {
    const capabilities = await getAgentCapabilities(agentId, orgId);
    const match = capabilities.find((c) => c.key === requiredCapabilityKey);

    if (!match) {
        throw new Error(
            `Agent ${agentId} does not have capability "${requiredCapabilityKey}". ` +
            `Install the required mod or assign the capability to this agent.`,
        );
    }

    if (requiredScope && !match.permissionScopes.includes(requiredScope)) {
        throw new Error(
            `Capability "${requiredCapabilityKey}" does not grant "${requiredScope}" permission for agent ${agentId}.`,
        );
    }

    return match;
}

/**
 * Check whether an agent has a capability (non-throwing variant).
 */
export async function hasCapability(
    agentId: string,
    orgId: string,
    capabilityKey: string,
): Promise<boolean> {
    const capabilities = await getAgentCapabilities(agentId, orgId);
    return capabilities.some((c) => c.key === capabilityKey);
}

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD — Agent Marketplace
// ═══════════════════════════════════════════════════════════════

const MARKETPLACE_AGENTS_COLLECTION = "marketplaceAgents";
const AGENT_INSTALLS_COLLECTION = "agentInstalls";
const AGENT_RATINGS_COLLECTION = "agentRatings";

/** Publish an agent package to the marketplace */
export async function publishAgentPackage(
    pkg: Omit<AgentPackage, "id" | "publishedAt" | "updatedAt" | "installCount" | "rentalCount" | "hireCount" | "avgRating" | "ratingCount" | "status">,
): Promise<string> {
    const ref = await addDoc(collection(db, MARKETPLACE_AGENTS_COLLECTION), {
        ...pkg,
        status: "review",
        installCount: 0,
        rentalCount: 0,
        hireCount: 0,
        avgRating: 0,
        ratingCount: 0,
        publishedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    return ref.id;
}

/** Get all approved marketplace agents */
export async function getMarketplaceAgents(): Promise<AgentPackage[]> {
    const q = query(
        collection(db, MARKETPLACE_AGENTS_COLLECTION),
        where("status", "==", "approved"),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            publishedAt: data.publishedAt instanceof Timestamp ? data.publishedAt.toDate() : null,
            updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
        } as AgentPackage;
    });
}

/** Get packages published by a specific creator */
export async function getCreatorPackages(walletAddress: string): Promise<AgentPackage[]> {
    const q = query(
        collection(db, MARKETPLACE_AGENTS_COLLECTION),
        where("authorWallet", "==", walletAddress),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
    } as AgentPackage));
}

/** Install/rent/hire a marketplace agent — tracks the acquisition */
export async function installMarketplaceAgent(
    packageId: string,
    orgId: string,
    agentId: string,
    distribution: AgentDistribution,
    installedBy: string,
    ain?: string,
    rentalModel?: RentalModel,
    spendingCap?: number,
    taskLimit?: number,
    allowedChains?: number[],
): Promise<string> {
    const ref = await addDoc(collection(db, AGENT_INSTALLS_COLLECTION), {
        packageId,
        packageSlug: packageId,
        orgId,
        agentId,
        version: "1.0.0",
        distribution,
        installedBy,
        installedAt: serverTimestamp(),
        onChainRegistered: false,
        ain: ain ?? null,
        status: "active",
        ...(rentalModel ? { rentalModel } : {}),
        ...(spendingCap ? { spendingCap } : {}),
        ...(taskLimit ? { taskLimit } : {}),
        ...(allowedChains ? { allowedChains } : {}),
    });
    return ref.id;
}

/** Get all agent installs for an org */
export async function getAgentInstalls(orgId: string): Promise<AgentInstall[]> {
    const q = query(
        collection(db, AGENT_INSTALLS_COLLECTION),
        where("orgId", "==", orgId),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            installedAt: data.installedAt instanceof Timestamp ? data.installedAt.toDate() : null,
        } as AgentInstall;
    });
}

/** Update on-chain registration status */
export async function updateAgentInstallOnChain(
    installId: string,
    txHash: string,
    ain?: string,
): Promise<void> {
    await updateDoc(doc(db, AGENT_INSTALLS_COLLECTION, installId), {
        onChainRegistered: true,
        onChainTxHash: txHash,
        ...(ain ? { ain } : {}),
    });
}

/** Uninstall a marketplace agent (soft-delete) */
export async function uninstallMarketplaceAgent(installId: string): Promise<void> {
    await updateDoc(doc(db, AGENT_INSTALLS_COLLECTION, installId), {
        status: "uninstalled",
    });
}

/** Submit a rating for a marketplace agent */
export async function submitAgentRating(
    packageId: string,
    orgId: string,
    reviewerWallet: string,
    rating: number,
    review?: string,
): Promise<string> {
    const ref = await addDoc(collection(db, AGENT_RATINGS_COLLECTION), {
        packageId,
        orgId,
        reviewerWallet,
        rating: Math.max(1, Math.min(5, rating)),
        review: review?.slice(0, 500) || null,
        createdAt: serverTimestamp(),
    });
    await recalcAgentRating(packageId);
    return ref.id;
}

/** Get ratings for a marketplace agent */
export async function getAgentRatings(packageId: string): Promise<AgentRating[]> {
    const q = query(
        collection(db, AGENT_RATINGS_COLLECTION),
        where("packageId", "==", packageId),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
        } as AgentRating;
    });
}

/** Recalculate avgRating and ratingCount on an agent package */
export async function recalcAgentRating(packageId: string): Promise<void> {
    const ratings = await getAgentRatings(packageId);
    const count = ratings.length;
    const avg = count > 0 ? ratings.reduce((s, r) => s + r.rating, 0) / count : 0;
    await updateDoc(doc(db, MARKETPLACE_AGENTS_COLLECTION, packageId), {
        avgRating: Math.round(avg * 10) / 10,
        ratingCount: count,
    });
}

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD — Community Item Ratings
// ═══════════════════════════════════════════════════════════════

const COMMUNITY_RATINGS_COLLECTION = "communityItemRatings";

export interface CommunityItemRating {
    id: string;
    itemId: string;
    orgId: string;
    reviewerWallet: string;
    rating: number;
    review?: string | null;
    createdAt: Date | null;
}

/** Submit a rating for a community marketplace item */
export async function submitCommunityItemRating(
    itemId: string,
    orgId: string,
    reviewerWallet: string,
    rating: number,
    review?: string,
): Promise<string> {
    const ref = await addDoc(collection(db, COMMUNITY_RATINGS_COLLECTION), {
        itemId,
        orgId,
        reviewerWallet,
        rating: Math.max(1, Math.min(5, rating)),
        review: review?.slice(0, 500) || null,
        createdAt: serverTimestamp(),
    });
    await recalcCommunityItemRating(itemId);
    return ref.id;
}

/** Get ratings for a community marketplace item */
export async function getCommunityItemRatings(itemId: string): Promise<CommunityItemRating[]> {
    const q = query(
        collection(db, COMMUNITY_RATINGS_COLLECTION),
        where("itemId", "==", itemId),
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
        } as CommunityItemRating;
    });
}

/** Recalculate avgRating and ratingCount on a community item */
async function recalcCommunityItemRating(itemId: string): Promise<void> {
    const ratings = await getCommunityItemRatings(itemId);
    const count = ratings.length;
    const avg = count > 0 ? ratings.reduce((s, r) => s + r.rating, 0) / count : 0;
    await updateDoc(doc(db, COMMUNITY_COLLECTION, itemId), {
        avgRating: Math.round(avg * 10) / 10,
        ratingCount: count,
    });
}

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD — Featured Items
// ═══════════════════════════════════════════════════════════════

/** Get all currently featured marketplace items (both community + agents) */
export async function getFeaturedItems(): Promise<{
    communityItems: CommunityMarketItem[];
    agents: AgentPackage[];
}> {
    const [communitySnap, agentSnap] = await Promise.all([
        getDocs(query(collection(db, COMMUNITY_COLLECTION), where("featured", "==", true))),
        getDocs(query(collection(db, MARKETPLACE_AGENTS_COLLECTION), where("featured", "==", true))),
    ]);
    const communityItems = communitySnap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            pricing: data.pricing ?? { model: "free" },
            submittedAt: data.submittedAt instanceof Timestamp ? data.submittedAt.toDate() : null,
            featuredAt: data.featuredAt instanceof Timestamp ? data.featuredAt.toDate() : null,
        } as CommunityMarketItem;
    });
    const agents = agentSnap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id,
            ...data,
            publishedAt: data.publishedAt instanceof Timestamp ? data.publishedAt.toDate() : null,
            updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
        } as AgentPackage;
    });
    return { communityItems, agents };
}
