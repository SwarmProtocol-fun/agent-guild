/**
 * Swarm Compute — Core Types
 *
 * All interfaces, enums, and constants for the compute module.
 * Every other compute file depends on this.
 */

// ═══════════════════════════════════════════════════════════════
// Enums & Literal Types
// ═══════════════════════════════════════════════════════════════

export type ComputerStatus =
  | "provisioning"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error"
  | "snapshotting";

export type ControllerType = "human" | "agent" | "hybrid";

export type ModelKey = "claude" | "openai" | "gemini" | "generic";

export type SizeKey = "small" | "medium" | "large" | "xl";

export type ProviderKey = "e2b" | "aws" | "gcp" | "azure" | "stub" | "swarm-node";

export type AzureProductType =
  | "vm"              // Virtual Machines (default)
  | "aci"             // Azure Container Instances (serverless containers)
  | "avd"             // Azure Virtual Desktop (managed VDI)
  | "spot"            // Spot VMs (cheaper, interruptible)
  | "batch";          // Azure Batch (parallel workloads)

export type Region = "us-east" | "us-west" | "eu-west" | "ap-southeast";

export type ComputerMode =
  | "blank"
  | "browser"
  | "developer"
  | "openclaw"
  | "trading"
  | "template";

export type OpenClawVariant =
  | "openclaw"
  | "nanobot"
  | "hermes-agent"
  | "picobot"
  | "agent-zero";

export type TransferStatus = "pending" | "completed" | "cancelled";

export type TemplateCategory =
  | "dev"
  | "browser"
  | "research"
  | "trading"
  | "openclaw"
  | "design"
  | "web3"
  | "sales";

export type ActionType =
  | "screenshot"
  | "click"
  | "double_click"
  | "drag"
  | "type"
  | "key"
  | "scroll"
  | "wait"
  | "bash"
  | "exec";

export type ActionStatus = "pending" | "running" | "completed" | "failed" | "timeout";

export type MemoryScopeType = "workspace" | "computer" | "agent" | "user";

export type EmbedMode = "read_only" | "interactive";

export type UsageMetricType =
  | "compute_hours"
  | "storage_gb"
  | "network_gb"
  | "actions"
  | "sessions";

export type FileVisibility = "private" | "workspace" | "public";

export type FileProvenance = "upload" | "export" | "snapshot" | "template";

// ═══════════════════════════════════════════════════════════════
// Constants & Presets
// ═══════════════════════════════════════════════════════════════

export const SIZE_PRESETS: Record<SizeKey, { cpu: number; ram: number; disk: number; label: string }> = {
  small:  { cpu: 2,  ram: 4096,   disk: 20,  label: "Small (2 CPU, 4 GB)" },
  medium: { cpu: 4,  ram: 8192,   disk: 50,  label: "Medium (4 CPU, 8 GB)" },
  large:  { cpu: 8,  ram: 16384,  disk: 100, label: "Large (8 CPU, 16 GB)" },
  xl:     { cpu: 16, ram: 32768,  disk: 200, label: "XL (16 CPU, 32 GB)" },
};

export const MODE_PRESETS: Record<ComputerMode, { label: string; description: string; icon: string; defaultSize: SizeKey }> = {
  blank:     { label: "Blank Ubuntu Desktop",        description: "Clean Ubuntu desktop with no preinstalled tools",     icon: "Monitor",    defaultSize: "small" },
  browser:   { label: "Browser Automation",           description: "Chrome + Playwright + automation tools",              icon: "Globe",      defaultSize: "medium" },
  developer: { label: "Developer Workstation",        description: "VS Code, Node, Python, Docker, Git preinstalled",    icon: "Code",       defaultSize: "medium" },
  openclaw:  { label: "OpenClaw Runtime",             description: "OpenClaw workspace with ML tools and notebooks",     icon: "Brain",      defaultSize: "large" },
  trading:   { label: "Trading & Research",           description: "Python, Jupyter, data APIs, chart tools",            icon: "TrendingUp", defaultSize: "medium" },
  template:  { label: "From Template",                description: "Launch from a saved or marketplace template",        icon: "LayoutGrid", defaultSize: "medium" },
};

export const REGION_LABELS: Record<Region, string> = {
  "us-east":      "US East (Virginia)",
  "us-west":      "US West (Oregon)",
  "eu-west":      "EU West (Ireland)",
  "ap-southeast": "Asia Pacific (Singapore)",
};

export const PROVIDER_LABELS: Record<ProviderKey, { label: string; description: string; comingSoon?: boolean }> = {
  azure: { label: "Microsoft Azure",    description: "Azure cloud platform — multiple compute products available" },
  e2b:   { label: "E2B Desktop",        description: "Managed cloud sandbox — fastest setup, built-in VNC" },
  aws:   { label: "AWS EC2",            description: "Amazon EC2 — widest region coverage, SSM integration", comingSoon: true },
  gcp:   { label: "GCP Compute Engine", description: "Google Compute Engine — strong ML/data tooling", comingSoon: true },
  "swarm-node": { label: "Swarm Node",    description: "Decentralized worker nodes from the Swarm network" },
  stub:  { label: "Development",         description: "Local stub provider for development" },
};

/** Azure product offerings */
export const AZURE_PRODUCTS: Record<AzureProductType, {
  label: string;
  description: string;
  icon: string;
  features: string[];
  pricing: { small: number; medium: number; large: number; xl: number }; // cents/hour
  bestFor: string[];
  limitations?: string[];
}> = {
  vm: {
    label: "Virtual Machines",
    description: "Full VMs with persistent disks, VNC desktop, and complete control",
    icon: "Server",
    features: ["Full Ubuntu desktop", "Persistent storage", "VNC access", "Snapshots supported", "Custom images"],
    pricing: { small: 5, medium: 18, large: 40, xl: 79 },
    bestFor: ["Long-running tasks", "Development environments", "Persistent workloads"],
  },
  aci: {
    label: "Container Instances",
    description: "Serverless containers — fast startup, pay-per-second billing",
    icon: "Box",
    features: ["2-5s startup time", "Per-second billing", "No image limit", "Auto-scale", "Integrated logs"],
    pricing: { small: 3, medium: 10, large: 22, xl: 50 },
    bestFor: ["Short-lived tasks", "Batch jobs", "Event-driven workloads", "CI/CD pipelines"],
    limitations: ["No VNC (container-only)", "No snapshots", "Ephemeral storage"],
  },
  avd: {
    label: "Virtual Desktop",
    description: "Enterprise VDI with Windows/Linux, managed by Azure, multi-session capable",
    icon: "Monitor",
    features: ["Windows 11 or Linux", "Multi-session", "Enterprise AD integration", "FSLogix profiles", "Autoscale"],
    pricing: { small: 12, medium: 25, large: 55, xl: 110 },
    bestFor: ["Enterprise users", "Windows desktop needs", "Regulated industries", "Multi-tenant scenarios"],
  },
  spot: {
    label: "Spot VMs",
    description: "Up to 90% discount on VMs — can be evicted with 30s notice",
    icon: "Zap",
    features: ["90% cost savings", "Same VM SKUs", "Eviction alerts", "Best-effort availability"],
    pricing: { small: 1, medium: 3, large: 6, xl: 12 },
    bestFor: ["Fault-tolerant workloads", "Batch processing", "Dev/test environments", "Interruptible tasks"],
    limitations: ["Can be evicted", "No SLA", "Limited availability"],
  },
  batch: {
    label: "Azure Batch",
    description: "Managed service for parallel/HPC workloads — auto-scaling node pools",
    icon: "Grid3x3",
    features: ["Auto-scaling pools", "Job scheduling", "Task dependencies", "Low-priority VMs", "HPC optimized"],
    pricing: { small: 4, medium: 15, large: 35, xl: 70 },
    bestFor: ["Parallel workloads", "Monte Carlo simulations", "Video rendering", "Scientific computing"],
  },
};

/** Maps Swarm regions to provider-native region identifiers */
export const PROVIDER_REGION_MAP: Record<ProviderKey, Record<Region, string>> = {
  e2b:   { "us-east": "us-east-1", "us-west": "us-west-1", "eu-west": "eu-west-1", "ap-southeast": "ap-southeast-1" },
  aws:   { "us-east": "us-east-1", "us-west": "us-west-2", "eu-west": "eu-west-1", "ap-southeast": "ap-southeast-1" },
  gcp:   { "us-east": "us-east1",  "us-west": "us-west1",  "eu-west": "europe-west1", "ap-southeast": "asia-southeast1" },
  azure: { "us-east": "eastus",    "us-west": "westus2",   "eu-west": "westeurope",   "ap-southeast": "southeastasia" },
  "swarm-node": { "us-east": "network", "us-west": "network", "eu-west": "network", "ap-southeast": "network" },
  stub:  { "us-east": "stub",      "us-west": "stub",      "eu-west": "stub",          "ap-southeast": "stub" },
};

/** Maps Swarm sizes to provider-native instance types */
export const PROVIDER_SIZE_MAP: Record<ProviderKey, Record<SizeKey, string>> = {
  e2b:   { small: "default", medium: "default", large: "default", xl: "default" },
  aws:   { small: "t3.medium", medium: "t3.xlarge", large: "m5.2xlarge", xl: "m5.4xlarge" },
  gcp:   { small: "e2-standard-2", medium: "e2-standard-4", large: "e2-standard-8", xl: "e2-standard-16" },
  azure: { small: "Standard_B2s", medium: "Standard_B4ms", large: "Standard_D8s_v3", xl: "Standard_D16s_v3" },
  "swarm-node": { small: "preset", medium: "preset", large: "preset", xl: "preset" },
  stub:  { small: "stub-small", medium: "stub-medium", large: "stub-large", xl: "stub-xl" },
};

/** Provider-specific base images */
export const PROVIDER_BASE_IMAGES: Record<ProviderKey, string> = {
  e2b:   "desktop",
  aws:   "ami-0c7217cdde317cfec", // Ubuntu 22.04 LTS in us-east-1
  gcp:   "projects/ubuntu-os-cloud/global/images/family/ubuntu-2204-lts",
  azure: "Canonical:0001-com-ubuntu-server-jammy:22_04-lts:latest",
  "swarm-node": "ubuntu:22.04",
  stub:  "ubuntu:22.04",
};

/** Provider-specific hourly cost in cents (raw, before markup) */
export const PROVIDER_HOURLY_COSTS: Record<ProviderKey, Record<SizeKey, number>> = {
  e2b:   { small: 8,   medium: 16,  large: 32,  xl: 64 },
  aws:   { small: 4,   medium: 17,  large: 38,  xl: 77 },
  gcp:   { small: 5,   medium: 19,  large: 40,  xl: 80 },
  azure: { small: 5,   medium: 18,  large: 40,  xl: 79 },
  "swarm-node": { small: 3, medium: 10, large: 20, xl: 40 },
  stub:  { small: 8,   medium: 16,  large: 32,  xl: 64 },
};

export const TEMPLATE_CATEGORY_LABELS: Record<TemplateCategory, string> = {
  dev:      "Development",
  browser:  "Browser Automation",
  research: "Research",
  trading:  "Trading",
  openclaw: "OpenClaw",
  design:   "Design & Content",
  web3:     "Web3",
  sales:    "Sales & Outreach",
};

export const STATUS_COLORS: Record<ComputerStatus, { label: string; color: string; bg: string }> = {
  provisioning: { label: "Provisioning", color: "text-blue-400",   bg: "bg-blue-500/20" },
  starting:     { label: "Starting",     color: "text-amber-400",  bg: "bg-amber-500/20" },
  running:      { label: "Running",      color: "text-emerald-400", bg: "bg-emerald-500/20" },
  stopping:     { label: "Stopping",     color: "text-amber-400",  bg: "bg-amber-500/20" },
  stopped:      { label: "Stopped",      color: "text-gray-400",   bg: "bg-gray-500/20" },
  error:        { label: "Error",        color: "text-red-400",    bg: "bg-red-500/20" },
  snapshotting: { label: "Snapshotting",  color: "text-purple-400", bg: "bg-purple-500/20" },
};

export const MODEL_LABELS: Record<ModelKey, { label: string; description: string }> = {
  claude:  { label: "Claude",  description: "Anthropic Claude — best for complex reasoning and safety" },
  openai:  { label: "OpenAI",  description: "OpenAI GPT — strong general-purpose model" },
  gemini:  { label: "Gemini",  description: "Google Gemini — multimodal with vision" },
  generic: { label: "Generic", description: "Structured action loop — any compatible model" },
};

export const ACTION_TIMEOUTS: Record<ActionType, number> = {
  screenshot:   10_000,
  click:         5_000,
  double_click:  5_000,
  drag:         10_000,
  type:         10_000,
  key:           5_000,
  scroll:        5_000,
  wait:         60_000,
  bash:         120_000,
  exec:         120_000,
};

export const DEFAULT_AUTO_STOP_MINUTES = 30;
export const DEFAULT_RESOLUTION = { width: 1280, height: 720 };

// ═══════════════════════════════════════════════════════════════
// Interfaces — Firestore Documents
// ═══════════════════════════════════════════════════════════════

export interface Workspace {
  id: string;
  orgId: string;
  ownerUserId: string;
  name: string;
  slug: string;
  description: string;
  planTier: string;
  defaultProvider: ProviderKey;
  defaultAutoStopMinutes: number;
  allowedInstanceSizes: SizeKey[];
  staticIpEnabled: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member" | "viewer";
  createdAt: Date | null;
}

export interface Computer {
  id: string;
  workspaceId: string;
  orgId: string;
  name: string;
  status: ComputerStatus;
  provider: ProviderKey;
  providerInstanceId: string | null;
  /** Provider-native instance type (e.g. "t3.xlarge", "e2-standard-4") */
  providerInstanceType: string | null;
  /** Provider-native region (e.g. "us-east-1", "eastus") */
  providerRegion: string | null;
  /** Provider-native base image (AMI, image family, etc.) */
  providerImage: string | null;
  /** Provider-specific metadata (SSM document ARN, VPC ID, etc.) */
  providerMetadata: Record<string, unknown>;
  templateId: string | null;
  sizeKey: SizeKey;
  cpuCores: number;
  ramMb: number;
  diskGb: number;
  resolutionWidth: number;
  resolutionHeight: number;
  region: Region;
  persistenceEnabled: boolean;
  staticIpEnabled: boolean;
  autoStopMinutes: number;
  controllerType: ControllerType;
  modelKey: ModelKey | null;
  /** OpenClaw variant running in this instance (null if not an openclaw instance) */
  openclawVariant: OpenClawVariant | null;
  /** Wallet address of the current owner */
  ownerWallet: string;
  /** Org ID of the current owner */
  ownerOrgId: string;
  /** Whether this instance can be transferred/sold */
  transferable: boolean;
  /** Whether this instance is currently listed on the marketplace */
  listedForSale: boolean;
  /** Asking price in cents (null if not listed) */
  listingPriceCents: number | null;
  /** Public description for the marketplace listing */
  listingDescription: string | null;
  createdByUserId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  lastActiveAt: Date | null;
}

export interface ComputerSnapshot {
  id: string;
  computerId: string;
  providerSnapshotId: string;
  label: string;
  createdAt: Date | null;
}

export interface ComputerSession {
  id: string;
  computerId: string;
  workspaceId: string;
  controllerType: ControllerType;
  userId: string | null;
  modelKey: ModelKey | null;
  startedAt: Date | null;
  endedAt: Date | null;
  totalActions: number;
  totalScreenshots: number;
  recordingUrl: string | null;
  estimatedCostCents: number;
}

export interface ComputerAction {
  id: string;
  sessionId: string;
  computerId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: ActionStatus;
  createdAt: Date | null;
}

export interface ComputeFile {
  id: string;
  workspaceId: string;
  computerId: string | null;
  uploaderUserId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  visibility: FileVisibility;
  provenanceType: FileProvenance;
  createdAt: Date | null;
}

export interface ComputeTemplate {
  id: string;
  workspaceId: string | null;
  creatorUserId: string;
  name: string;
  slug: string;
  description: string;
  category: TemplateCategory;
  baseImage: string;
  installManifest: Record<string, unknown>;
  startupScript: string;
  requiredSecrets: string[];
  recommendedModels: ModelKey[];
  isPublic: boolean;
  paidModReady: boolean;
  futurePriceCents: number | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface MemoryEntry {
  id: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  workspaceId: string | null;
  computerId: string | null;
  agentId: string | null;
  createdByUserId: string | null;
  content: string;
  embeddingRef: string | null;
  tags: string[];
  pinned: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface EmbedToken {
  id: string;
  workspaceId: string;
  computerId: string;
  mode: EmbedMode;
  allowedOrigins: string[];
  expiresAt: Date | null;
  createdByUserId: string;
  createdAt: Date | null;
}

export interface UsageRecord {
  id: string;
  workspaceId: string;
  computerId: string | null;
  metricType: UsageMetricType;
  quantity: number;
  periodStart: Date | null;
  periodEnd: Date | null;
  estimatedCostCents: number;
  createdAt: Date | null;
}

// ═══════════════════════════════════════════════════════════════
// Billing Ledger — Cost vs Revenue Tracking
// ═══════════════════════════════════════════════════════════════

export interface BillingLedgerEntry {
  id: string;
  orgId: string;
  workspaceId: string;
  computerId: string;
  sessionId: string | null;
  provider: string;
  sizeKey: SizeKey;
  region: Region;
  unitType: "compute_hour" | "storage_gb" | "action" | "session";
  quantity: number;
  providerCostCents: number;
  markupPercent: number;
  customerPriceCents: number;
  platformProfitCents: number;
  createdAt: Date | null;
}

export interface PricingSettings {
  id: string;
  defaultMarkupPercent: number;
  sizeOverrides: Partial<Record<SizeKey, number>>;
  regionOverrides: Partial<Record<Region, number>>;
  providerOverrides: Record<string, number>;
  minimumPriceFloorCents: number;
  promoOverride: { percent: number; expiresAt: Date | null } | null;
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

export interface ProfitabilitySummary {
  totalProviderCostCents: number;
  totalCustomerRevenueCents: number;
  totalPlatformProfitCents: number;
  marginPercent: number;
  entriesByProvider: Record<string, { cost: number; revenue: number; profit: number }>;
  entriesBySize: Record<string, { cost: number; revenue: number; profit: number }>;
  entriesByOrg: Record<string, { cost: number; revenue: number; profit: number; orgId: string }>;
  totalEntries: number;
}

// ═══════════════════════════════════════════════════════════════
// Action Envelope — Internal Contract
// ═══════════════════════════════════════════════════════════════

export interface ActionEnvelope {
  actionType: ActionType;
  targetComputerId: string;
  sessionId: string;
  actorType: "user" | "model" | "system";
  actorId: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  idempotencyKey: string;
}

export interface ActionResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════
// Provider Contract
// ═══════════════════════════════════════════════════════════════

export interface InstanceConfig {
  name: string;
  sizeKey: SizeKey;
  cpuCores: number;
  ramMb: number;
  diskGb: number;
  resolutionWidth: number;
  resolutionHeight: number;
  region: Region;
  baseImage: string;
  startupScript?: string;
  persistenceEnabled: boolean;
  /** Provider-native instance type override */
  providerInstanceType?: string;
  /** Provider-native region override */
  providerRegion?: string;
  /** Provider-native image override */
  providerImage?: string;
  /** Context required by the provider for provisioning */
  providerMetadata?: Record<string, unknown>;
}

export interface ProviderResult {
  providerInstanceId: string;
  status: ComputerStatus;
  /** Provider-native instance type actually used */
  providerInstanceType?: string;
  /** Provider-native region actually used */
  providerRegion?: string;
  /** Extra metadata from the provider */
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// Usage Summary
// ═══════════════════════════════════════════════════════════════

export interface UsageSummary {
  totalComputeHours: number;
  totalStorageGb: number;
  totalActions: number;
  totalSessions: number;
  estimatedCostCents: number;
}

// ═══════════════════════════════════════════════════════════════
// Compute Entitlements — Credit Balance & Quotas
// ═══════════════════════════════════════════════════════════════

export interface ComputeEntitlement {
  id: string;
  orgId: string;
  /** Credit balance in cents — gets deducted as usage accrues */
  creditBalanceCents: number;
  /** Monthly compute hour quota (0 = unlimited for paid plans) */
  monthlyHourQuota: number;
  /** Hours used this billing period */
  hoursUsedThisPeriod: number;
  /** Max concurrent running computers */
  maxConcurrentComputers: number;
  /** Allowed instance sizes */
  allowedSizes: SizeKey[];
  /** Plan tier name */
  planTier: "free" | "starter" | "pro" | "enterprise";
  /** Period start date for quota tracking */
  periodStart: Date | null;
  updatedAt: Date | null;
}

export const PLAN_LIMITS: Record<ComputeEntitlement["planTier"], {
  creditsCents: number;
  monthlyHours: number;
  maxConcurrent: number;
  allowedSizes: SizeKey[];
}> = {
  free:       { creditsCents: 0,     monthlyHours: 5,    maxConcurrent: 1, allowedSizes: ["small"] },
  starter:    { creditsCents: 1000,  monthlyHours: 50,   maxConcurrent: 3, allowedSizes: ["small", "medium"] },
  pro:        { creditsCents: 5000,  monthlyHours: 200,  maxConcurrent: 10, allowedSizes: ["small", "medium", "large"] },
  enterprise: { creditsCents: 25000, monthlyHours: 0,    maxConcurrent: 50, allowedSizes: ["small", "medium", "large", "xl"] },
};

// ═══════════════════════════════════════════════════════════════
// OpenClaw Variant Presets
// ═══════════════════════════════════════════════════════════════

export const OPENCLAW_VARIANTS: Record<OpenClawVariant, {
  label: string;
  description: string;
  icon: string;
  baseImage: string;
  defaultSize: SizeKey;
  features: string[];
  repoUrl: string;
  language: string;
  stars: string;
}> = {
  "openclaw": {
    label: "OpenClaw",
    description: "The original open-source AI agent framework with full tool use and memory",
    icon: "Brain",
    baseImage: "openclaw/openclaw:latest",
    defaultSize: "medium",
    features: ["Natural language control", "Tool use & automation", "Persistent memory", "Multi-model support"],
    repoUrl: "https://github.com/openclaw",
    language: "Python",
    stars: "50k+",
  },
  "nanobot": {
    label: "NanoBot",
    description: "The ultra-lightweight OpenClaw — minimal footprint, maximum capability",
    icon: "Zap",
    baseImage: "hkuds/nanobot:latest",
    defaultSize: "small",
    features: ["Ultra-lightweight", "Fast startup", "Low resource usage", "OpenClaw compatible"],
    repoUrl: "https://github.com/HKUDS/nanobot",
    language: "Python",
    stars: "35.5k",
  },
  "hermes-agent": {
    label: "Hermes Agent",
    description: "The agent that grows with you — by NousResearch, built on Hermes models",
    icon: "Sparkles",
    baseImage: "nousresearch/hermes-agent:latest",
    defaultSize: "large",
    features: ["Hermes model native", "Adaptive learning", "Multi-modal", "Research-grade"],
    repoUrl: "https://github.com/NousResearch/hermes-agent",
    language: "Python",
    stars: "10.5k",
  },
  "picobot": {
    label: "PicoBot",
    description: "Lightweight self-hosted bot in a single binary — written in Go, instant deploy",
    icon: "Box",
    baseImage: "louisho5/picobot:latest",
    defaultSize: "small",
    features: ["Single binary", "Go performance", "Self-hosted", "Instant deploy"],
    repoUrl: "https://github.com/louisho5/picobot",
    language: "Go",
    stars: "1.2k",
  },
  "agent-zero": {
    label: "Agent Zero",
    description: "Fully autonomous AI agent framework — self-healing, self-improving",
    icon: "Shield",
    baseImage: "agent0ai/agent-zero:latest",
    defaultSize: "large",
    features: ["Fully autonomous", "Self-healing", "Docker sandboxed", "Knowledge persistence"],
    repoUrl: "https://github.com/agent0ai/agent-zero",
    language: "Python",
    stars: "16.3k",
  },
};

// ═══════════════════════════════════════════════════════════════
// Ownership Transfer
// ═══════════════════════════════════════════════════════════════

export interface ComputerTransfer {
  id: string;
  computerId: string;
  computerName: string;
  openclawVariant: OpenClawVariant | null;
  fromWallet: string;
  fromOrgId: string;
  toWallet: string;
  toOrgId: string;
  priceCents: number;
  platformFeeCents: number;
  status: TransferStatus;
  snapshotId: string | null;
  createdAt: Date | null;
  completedAt: Date | null;
}

/** Platform fee percentage on agent sales */
export const TRANSFER_FEE_PERCENT = 10;
