/** Firestore — Core data operations: organizations, projects, agents, sessions, and messages CRUD. */
import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  onSnapshot,
  serverTimestamp,
  type Unsubscribe,
  type Timestamp,
  arrayUnion,
  arrayRemove,
  increment,
  writeBatch,
  runTransaction,
  limit as fsLimit,
} from "firebase/firestore";
import { db } from "./firebase";
import { canonicalizeWalletAddress } from "./wallet-address";
import { applyLivePresence } from "./presence";

// ─── Types ──────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
  description?: string;
  inviteCode?: string;
  ownerAddress: string;
  logoUrl?: string;
  website?: string;
  twitter?: string;
  discord?: string;
  telegram?: string;
  members: string[];
  isPrivate?: boolean;
  createdAt: unknown;
  // GitHub App integration
  githubInstallationId?: number;
  githubAccountLogin?: string;
  githubAccountType?: 'Organization' | 'User';
  githubAccountAvatarUrl?: string;
  githubConnectedAt?: unknown;
  // Agent Guild Protocol inventory slots
  agentSlots?: {
    [slotId: string]: { agentId: string; assignedAt: unknown } | null;
  };
  /** @deprecated legacy field name from before the Swarm Protocol -> Agent Guild rename; reads fall back to this for existing docs */
  swarmSlots?: {
    [slotId: string]: { agentId: string; assignedAt: unknown } | null;
  };
  /** Metaplex collection NFT mint address (Solana devnet) */
  metaplexCollectionMint?: string;
  // Hedera HCS-backed ownership proof
  /** HCS topic ID where org ownership events are recorded */
  hcsTopicId?: string;
  /** HCS sequence number for org creation event */
  hcsSequenceNumber?: string;
  /** HCS consensus timestamp for org creation */
  hcsConsensusTimestamp?: string;
  /** Owner signature proving org creation */
  ownerSignature?: string;
  /** Timestamp when org ownership was verified on-chain */
  hcsVerifiedAt?: unknown;
  /** Whether org ownership has been verified on HCS */
  hcsOwnershipVerified?: boolean;
  // Hedera org share tokens (ERC20)
  /** Hedera Token ID for org shares (0.0.xxxxx) */
  shareTokenId?: string;
  /** EVM address for the share token */
  shareTokenAddress?: string;
  /** Share token symbol (e.g., ACME) */
  shareTokenSymbol?: string;
  /** Total supply of shares issued */
  shareTotalSupply?: string;
  /** When shares were issued */
  sharesIssuedAt?: unknown;
  /** Whether this org has custom credit policy overrides */
  hasCreditPolicyOverrides?: boolean;
}

export interface GitHubRepoLink {
  repoId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  linkedAt: number;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  status: 'active' | 'paused' | 'completed';
  agentIds: string[];
  createdAt: unknown;
  githubRepos?: GitHubRepoLink[];
}

/** A skill/plugin self-reported by an agent on connect */
export interface ReportedSkill {
  id: string;
  name: string;
  type: 'skill' | 'plugin';
  version?: string;
}

export interface Agent {
  id: string;
  orgId: string;
  name: string;
  type: string;
  description: string;
  capabilities: string[];
  status: 'online' | 'offline' | 'busy' | 'paused';
  /** Last daemon heartbeat. Presence is derived from this, not from status alone. */
  lastSeen?: unknown;
  /** Set when the process checks out. Newer than lastSeen means offline immediately. */
  offlineAt?: unknown;
  projectIds: string[];
  apiKey?: string;
  avatarUrl?: string;
  /** When the agent was paused (if status is 'paused') */
  pausedAt?: unknown;
  /** Who paused the agent */
  pausedBy?: string;
  /** Reason for pausing */
  pauseReason?: string;
  /** Short bio the agent writes about itself on connect */
  bio?: string;
  /** Skills/plugins the agent self-reports when connecting */
  reportedSkills?: ReportedSkill[];
  /** Agent Social Number — unique identity assigned on registration */
  asn?: string;
  /** On-chain registration tx hash (Solana devnet) */
  onChainTxHash?: string;
  /** Set when on-chain registration failed or was skipped; cleared on a later success */
  onChainError?: string;
  /** On-chain registration status */
  onChainRegistered?: boolean;
  /** On-chain registration tx hash (LINK / Sepolia) */
  linkOnChainTxHash?: string;
  /** On-chain registration status (LINK / Sepolia) */
  linkOnChainRegistered?: boolean;
  /** ASN on-chain registration tx hash (Sepolia) */
  asnOnChainTxHash?: string;
  /** ASN on-chain registration status */
  asnOnChainRegistered?: boolean;
  /** Credit score (300-900) */
  creditScore?: number;
  /** Trust score (0-100) */
  trustScore?: number;
  /** Whether this agent was restored from ASN backup */
  restoredFromBackup?: boolean;
  /** When the agent was restored from backup */
  restoredAt?: unknown;
  /** Privacy level: private (default), organization, or public */
  privacyLevel?: "private" | "organization" | "public";
  /** Allow public profile (name, bio, skills) */
  allowPublicProfile?: boolean;
  /** Allow public reputation scores */
  allowPublicScores?: boolean;
  /** Parent agent ID (if this agent is a child) */
  parentAgentId?: string;
  /** Child agent IDs (if this agent is a parent) */
  childAgentIds?: string[];
  /** Hierarchy level (0 = root, 1 = first child, etc.) */
  hierarchyLevel: number;
  /** Can this agent delegate tasks to children? */
  canDelegate: boolean;
  /** SOUL configuration (YAML content) */
  soulConfig?: string;
  /** SOUL version identifier */
  soulVersion?: string;
  /** When SOUL was last updated */
  soulUpdatedAt?: unknown;
  /** Whether a private memory topic is set up for this agent */
  memoryEnabled?: boolean;
  /** Firestore-backed memory topic id (see reputation-chain.ts) for persistent memory */
  memoryTopicId?: string;
  /** Wallet address that owns/controls this agent */
  walletAddress?: string;
  /** Solana NFT mint address (Metaplex agent identity) */
  nftMintAddress?: string;
  /** When the agent identity NFT was minted */
  nftMintedAt?: unknown;
  /** EVM address of the NFT owner (when minted via EVM wallet, held by platform on-chain) */
  nftOwnerEvmAddress?: string;
  /** Deterministic Solana wallet address for this agent */
  solanaAddress?: string;
  /** Flow blockchain wallet address */
  flowAddress?: string;
  /** Flow ASN on-chain registration tx hash */
  flowOnChainTxHash?: string;
  /** Flow ASN on-chain registration status */
  flowOnChainRegistered?: boolean;
  /** Flow EVM wallet address (chain 747/545) */
  flowEvmAddress?: string;
  /** Flow staking delegation status */
  flowStakingActive?: boolean;
  /** Flow achievement badge count */
  flowAchievementCount?: number;
  /** Ethereum wallet address (Sepolia/Mainnet) */
  ethAddress?: string;
  /** Ethereum ASN on-chain registration tx hash */
  ethOnChainTxHash?: string;
  /** Ethereum ASN on-chain registration status */
  ethOnChainRegistered?: boolean;
  /** ERC-8004 Agent Registry tokenId */
  erc8004TokenId?: string;
  /** ERC-8004 operator wallet address */
  erc8004OperatorAddress?: string;
  /** ERC-8004 registration tx hash */
  erc8004RegistrationTxHash?: string;
  /** ERC-8004 on-chain reputation score (0-100) */
  erc8004ReputationScore?: number;
  /** Number of ERC-8004 validation attestations received */
  erc8004ValidationCount?: number;
  /** Agent capability manifest CID (IPFS) */
  agentManifestCid?: string;
  /** Number of completed tasks (denormalized counter) */
  tasksCompleted?: number;
  /** Resolved credit policy tier (cached, updated on score change) */
  policyTier?: import("./credit-policy").PolicyTierName;
  /** When policy tier was last resolved */
  policyTierResolvedAt?: unknown;
  /** Sub-score breakdown from the Dynamic Scoring Engine */
  scoreBreakdown?: {
    execution: number;
    reliability: number;
    settlement: number;
    trustNetwork: number;
    risk: number;
    confidence: number;
    modelVersion: string;
  };
  createdAt: unknown;
}

export interface Task {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  description: string;
  assigneeAgentId?: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  createdAt: unknown;
}

export interface Channel {
  id: string;
  orgId: string;
  projectId?: string;
  agentId?: string;
  name: string;
  createdAt: unknown;
}

export interface AgentGuildNode {
  id: string;
  providerAddress: string;
  status: 'online' | 'offline';
  resources: {
    cpuCores: number;
    ramGb: number;
    platform: string;
    gpus: { vendor: string; model: string; vram: number; }[];
  };
  health?: {
    cpuLoadPercent: number;
    ramUsedGb: number;
    uptimeSec: number;
  };
  registeredAt: unknown;
  lastHeartbeat: unknown;
}

export interface ComputeLease {
  id: string;
  nodeId: string;
  agentId?: string;
  computerId: string;
  orgId: string;
  status: 'starting' | 'running' | 'stopping' | 'terminated' | 'error';
  containerImage: string;
  containerId?: string;
  env?: Record<string, string>;
  memoryMb?: number;
  cpuCores?: number;
  error?: string;
  createdAt: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
}

export interface Attachment {
  url: string;
  name: string;
  type: string;
  size: number;
  storagePath?: string;
}

export interface Message {
  id: string;
  channelId: string;
  senderId: string;
  senderAddress?: string;
  senderName: string;
  senderType: 'human' | 'agent';
  content: string;
  orgId?: string;
  attachments?: Attachment[];
  createdAt: unknown;
}

// ─── Profiles ───────────────────────────────────────────

export interface Profile {
  walletAddress: string;
  displayName: string;
  email?: string;
  avatar?: string;
  bio?: string;
  updatedAt: Timestamp;
}

export async function getProfile(walletAddress: string): Promise<Profile | null> {
  const snap = await getDoc(doc(db, "profiles", canonicalizeWalletAddress(walletAddress)));
  if (!snap.exists()) return null;
  return snap.data() as Profile;
}

export async function setProfile(walletAddress: string, data: Partial<Profile>): Promise<void> {
  const key = canonicalizeWalletAddress(walletAddress);
  await setDoc(doc(db, "profiles", key), {
    ...data,
    walletAddress: key,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function getProfilesByAddresses(addresses: string[]): Promise<Map<string, Profile>> {
  const map = new Map<string, Profile>();
  if (addresses.length === 0) return map;
  // Firestore 'in' queries limited to 30, batch if needed
  const lowered = addresses.map(canonicalizeWalletAddress);
  for (let i = 0; i < lowered.length; i += 30) {
    const batch = lowered.slice(i, i + 30);
    const q = query(collection(db, "profiles"), where("walletAddress", "in", batch));
    const snap = await getDocs(q);
    snap.docs.forEach(d => {
      const profile = d.data() as Profile;
      map.set(profile.walletAddress, profile);
    });
  }
  return map;
}

// ─── Organizations ──────────────────────────────────────

export async function createOrganization(data: Omit<Organization, "id">): Promise<string> {
  const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
  // ownerAddress/members must match Firebase Auth's uid (always
  // lowercased — see auth/verify/route.ts's createCustomToken call), or
  // firestore.rules' isOrgMember() silently locks the owner out of their
  // own org. Wallet connectors hand back checksummed (mixed-case) EIP-55
  // addresses, so canonicalize before writing rather than trusting callers.
  const ref = await addDoc(collection(db, "organizations"), {
    ...data,
    ownerAddress: canonicalizeWalletAddress(data.ownerAddress),
    members: data.members.map(canonicalizeWalletAddress),
    description: data.description || "",
    isPrivate: false,
    inviteCode,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getOrganization(orgId: string): Promise<Organization | null> {
  const snap = await getDoc(doc(db, "organizations", orgId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Organization;
}

export async function updateOrganization(orgId: string, data: Partial<Organization>): Promise<void> {
  await updateDoc(doc(db, "organizations", orgId), data);
}

export async function getOrganizationsByWallet(walletAddress: string): Promise<Organization[]> {
  // Firestore string matches are case-sensitive. Addresses may be stored
  // checksummed (mixed-case) or lowercase, so query with all three forms:
  // original, lowercase, and EIP-55 checksummed.
  const canonical = canonicalizeWalletAddress(walletAddress);
  const variants = new Set([walletAddress, canonical]);

  // Add checksummed (EIP-55) form — handles the case where the session
  // stores lowercase but Firestore has the checksummed address.
  try {
    const { ethers } = await import("ethers");
    variants.add(ethers.getAddress(walletAddress));
  } catch {
    // Invalid address or ethers not available — skip checksummed variant
  }

  const queries = [...variants].flatMap(addr => [
    getDocs(query(collection(db, "organizations"), where("ownerAddress", "==", addr))),
    getDocs(query(collection(db, "organizations"), where("members", "array-contains", addr))),
  ]);

  const snapshots = await Promise.all(queries);

  const orgMap = new Map<string, Organization>();
  for (const snap of snapshots) {
    snap.docs.forEach(d => {
      if (!orgMap.has(d.id)) {
        orgMap.set(d.id, { id: d.id, ...d.data() } as Organization);
      }
    });
  }

  return Array.from(orgMap.values());
}

export async function getPublicOrganizations(): Promise<Organization[]> {
  const q = query(collection(db, "organizations"), where("isPrivate", "==", false));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Organization));
}

export async function addMemberToOrganization(orgId: string, walletAddress: string): Promise<void> {
  await updateDoc(doc(db, "organizations", orgId), {
    members: arrayUnion(canonicalizeWalletAddress(walletAddress))
  });
}

export async function removeMemberFromOrganization(orgId: string, walletAddress: string): Promise<void> {
  await updateDoc(doc(db, "organizations", orgId), {
    members: arrayRemove(walletAddress)
  });
}

// ─── Projects ───────────────────────────────────────────

export async function createProject(data: Omit<Project, "id">): Promise<string> {
  const ref = await addDoc(collection(db, "projects"), {
    ...data,
    description: data.description || "",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getProject(projectId: string): Promise<Project | null> {
  const snap = await getDoc(doc(db, "projects", projectId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Project;
}

export async function getProjectsByOrg(orgId: string): Promise<Project[]> {
  const q = query(collection(db, "projects"), where("orgId", "==", orgId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Project));
}

export async function updateProject(projectId: string, data: Partial<Project>): Promise<void> {
  await updateDoc(doc(db, "projects", projectId), data);
}

export async function deleteProject(projectId: string): Promise<void> {
  await deleteDoc(doc(db, "projects", projectId));
}

export async function assignAgentToProject(projectId: string, agentId: string): Promise<void> {
  await updateDoc(doc(db, "projects", projectId), {
    agentIds: arrayUnion(agentId)
  });
  await updateDoc(doc(db, "agents", agentId), {
    projectIds: arrayUnion(projectId)
  });
}

export async function unassignAgentFromProject(projectId: string, agentId: string): Promise<void> {
  await updateDoc(doc(db, "projects", projectId), {
    agentIds: arrayRemove(agentId)
  });
  await updateDoc(doc(db, "agents", agentId), {
    projectIds: arrayRemove(projectId)
  });
}

// ─── Agents ─────────────────────────────────────────────

export async function createAgent(data: Omit<Agent, "id">): Promise<string> {
  const ref = await addDoc(collection(db, "agents"), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getAgent(agentId: string): Promise<Agent | null> {
  const snap = await getDoc(doc(db, "agents", agentId));
  if (!snap.exists()) return null;
  return applyLivePresence({ id: snap.id, ...snap.data() } as Agent);
}

export async function getAgentsByOrg(orgId: string): Promise<Agent[]> {
  const q = query(collection(db, "agents"), where("orgId", "==", orgId));
  const snap = await getDocs(q);
  return snap.docs.map(d => applyLivePresence({ id: d.id, ...d.data() } as Agent));
}

export async function getUnassignedAgents(orgId: string): Promise<Agent[]> {
  const agents = await getAgentsByOrg(orgId);
  return agents.filter(agent => (agent.projectIds ?? []).length === 0);
}

export async function updateAgent(agentId: string, data: Partial<Agent>): Promise<void> {
  await updateDoc(doc(db, "agents", agentId), data);
}

export async function deleteAgent(agentId: string): Promise<void> {
  await deleteDoc(doc(db, "agents", agentId));
}

// ─── Tasks ──────────────────────────────────────────────

export async function createTask(data: Omit<Task, "id">): Promise<string> {
  const ref = await addDoc(collection(db, "tasks"), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getTask(taskId: string): Promise<Task | null> {
  const snap = await getDoc(doc(db, "tasks", taskId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Task;
}

export async function getTasksByOrg(orgId: string): Promise<Task[]> {
  const q = query(collection(db, "tasks"), where("orgId", "==", orgId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Task));
}

export async function getTasksByProject(projectId: string): Promise<Task[]> {
  const q = query(collection(db, "tasks"), where("projectId", "==", projectId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Task));
}

export async function updateTask(taskId: string, data: Partial<Task>): Promise<void> {
  await updateDoc(doc(db, "tasks", taskId), data);

  // Emit HCS score event if task completed (server-side only)
  if (data.status === 'done' && typeof window === 'undefined') {
    try {
      // Get task details to find agent
      const taskDoc = await getDoc(doc(db, "tasks", taskId));
      const task = taskDoc.data() as Task;

      if (task.assigneeAgentId) {
        // Get agent details
        const agentDoc = await getDoc(doc(db, "agents", task.assigneeAgentId));
        const agent = agentDoc.data() as Agent;

        if (agent?.asn && agent?.walletAddress) {
          // Intentional no-op here: `reputation-chain.ts`'s on-chain emitters
          // pull in server-only Solana signing code (env secrets) that must
          // never end up in this file's client bundle, since firestore.ts is
          // imported by client components too. Task-completion score events
          // are emitted from the server-only credit/task-complete route instead.
        }
      }
    } catch (error) {
      console.error("Failed to emit task complete event:", error);
    }
  }
}

export async function deleteTask(taskId: string): Promise<void> {
  await deleteDoc(doc(db, "tasks", taskId));
}

// ─── Channels ───────────────────────────────────────────

export async function createChannel(data: Omit<Channel, "id">): Promise<string> {
  const ref = await addDoc(collection(db, "channels"), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getChannel(channelId: string): Promise<Channel | null> {
  const snap = await getDoc(doc(db, "channels", channelId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Channel;
}

export async function getChannelsByOrg(orgId: string): Promise<Channel[]> {
  const q = query(collection(db, "channels"), where("orgId", "==", orgId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Channel));
}

export async function updateChannel(channelId: string, data: Partial<Channel>): Promise<void> {
  await updateDoc(doc(db, "channels", channelId), data);
}

export async function deleteChannel(channelId: string): Promise<void> {
  await deleteDoc(doc(db, "channels", channelId));
}

export async function deleteMessagesByChannel(channelId: string): Promise<void> {
  const q = query(collection(db, "messages"), where("channelId", "==", channelId));
  const snap = await getDocs(q);
  const deletions = snap.docs.map(d => deleteDoc(doc(db, "messages", d.id)));
  await Promise.all(deletions);
}

export async function ensureGeneralChannel(orgId: string): Promise<string> {
  const channels = await getChannelsByOrg(orgId);
  const generalChannel = channels.find(c => c.name.toLowerCase() === 'general');

  if (generalChannel) {
    return generalChannel.id;
  }

  // Create General channel
  return await createChannel({
    orgId,
    name: 'General',
    createdAt: new Date(),
  });
}

export async function getChannelsByProject(projectId: string): Promise<Channel[]> {
  const q = query(collection(db, "channels"), where("projectId", "==", projectId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Channel));
}

export async function getOrCreateProjectChannel(
  projectId: string,
  orgId: string,
  projectName: string
): Promise<Channel> {
  const q = query(
    collection(db, "channels"),
    where("orgId", "==", orgId),
    where("projectId", "==", projectId)
  );
  const snap = await getDocs(q);

  if (!snap.empty) {
    const d = snap.docs[0];
    return { id: d.id, ...d.data() } as Channel;
  }

  const id = await createChannel({
    orgId,
    projectId,
    name: `${projectName} Channel`,
    createdAt: new Date(),
  });

  return { id, orgId, projectId, name: `${projectName} Channel`, createdAt: new Date() };
}

// ─── Messages ───────────────────────────────────────────

export async function sendMessage(data: Omit<Message, "id">): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdAt: _ca, ...rest } = data;
  const ref = await addDoc(collection(db, "messages"), {
    ...rest,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// ─── Reporting ──────────────────────────────────────────

export interface Report {
  id: string;
  orgId: string;
  reportedUserId: string;
  messageId?: string;
  channelId?: string;
  reason: string;
  reportedBy: string;
  createdAt: unknown;
}

export async function createReport(data: Omit<Report, "id" | "createdAt">): Promise<string> {
  const ref = await addDoc(collection(db, "reports"), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function onMessagesByChannel(
  channelId: string,
  callback: (messages: Message[]) => void
): Unsubscribe {
  const q = query(
    collection(db, "messages"),
    where("channelId", "==", channelId),
    orderBy("createdAt", "asc")
  );
  return onSnapshot(q, (snap) => {
    callback(snap.docs.map(d => ({ id: d.id, ...d.data() } as Message)));
  });
}

export async function getMessagesByChannel(channelId: string): Promise<Message[]> {
  const q = query(
    collection(db, "messages"),
    where("channelId", "==", channelId),
    orderBy("createdAt", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Message));
}

// ─── Jobs ────────────────────────────────────────────────

export interface Job {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  description: string;
  status: 'open' | 'claimed' | 'closed' | 'in_progress' | 'completed';
  reward?: string;
  requiredSkills: string[];
  postedByAddress: string;
  takenByAgentId?: string;
  priority: 'low' | 'medium' | 'high';
  claimedAt?: unknown;
  claimedByAgentName?: string;
  completedAt?: unknown;
  completedByAgentName?: string;
  /** How agents get assigned to this job. Undefined = 'instant' (legacy default). */
  hiringMode?: 'instant' | 'applications';
  /** instant mode only: minimum agent.tasksCompleted required to claim */
  minCompletedJobs?: number;
  /** instant mode only: minimum agent.trustScore (0-100) required to claim */
  minTrustScore?: number;
  /** applications mode only: denormalized count, incremented on each application */
  applicationCount?: number;
  /** Set when this job was created by ordering a Gig — links back to the listing. */
  gigId?: string;
  /** Gig orders only: the org that owns the fulfilling agent (may differ from `orgId`,
   *  the buyer's org). Lets the seller org find orders to fulfill via getIncomingGigOrders. */
  sellerOrgId?: string;
  /** Real on-chain escrow state for this order, when the gig had escrowEnabled. */
  escrow?: GigEscrow;
  // Delivery & Review
  deliveryNotes?: string;
  deliveryFiles?: string[]; // URLs to uploaded files
  reviewStatus?: 'pending' | 'approved' | 'rejected';
  reviewNotes?: string;
  reviewedBy?: string;
  reviewedAt?: unknown;
  // Hedera Onchain Escrow
  hederaScheduledTxId?: string; // Hedera ScheduleId (e.g., "0.0.123456")
  hederaBountyHbar?: string; // Bounty amount in HBAR
  hederaRecipientAccountId?: string; // Agent's Hedera account ID
  hederaEscrowStatus?: 'pending' | 'executed' | 'refunded';
  /** Minimum required policy tier to claim this job */
  minPolicyTier?: import("./credit-policy").PolicyTierName;
  /** Escrow ratio applied based on claiming agent's tier */
  appliedEscrowRatio?: number;
  /** Fee multiplier applied at completion */
  appliedFeeMultiplier?: number;
  createdAt: unknown;
  updatedAt?: unknown;
}

export async function createJob(data: Omit<Job, "id">): Promise<string> {
  const ref = await addDoc(collection(db, "jobs"), {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getJob(jobId: string): Promise<Job | null> {
  const snap = await getDoc(doc(db, "jobs", jobId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Job;
}

export async function getJobsByOrg(orgId: string): Promise<Job[]> {
  const q = query(collection(db, "jobs"), where("orgId", "==", orgId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Job));
}

export async function getJobsByProject(projectId: string): Promise<Job[]> {
  const q = query(collection(db, "jobs"), where("projectId", "==", projectId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Job));
}

export async function getOpenJobs(orgId: string): Promise<Job[]> {
  const q = query(collection(db, "jobs"), where("orgId", "==", orgId), where("status", "==", "open"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Job));
}

export async function claimJob(jobId: string, agentId: string, orgId: string, projectId: string, agentName?: string): Promise<string> {
  // ── Credit Policy Enforcement ──────────────────────────────
  const { resolveAgentPolicy } = await import("@/lib/agent-policy");
  const { canClaimJob } = await import("@/lib/credit-policy");
  const { getCreditPolicyConfig, recordPolicyEvent } = await import("@/lib/credit-policy-settings");

  const config = await getCreditPolicyConfig();
  const policyResult = await resolveAgentPolicy(agentId);

  if (config.enforcementEnabled && config.enforceJobClaims && policyResult.ok && policyResult.policy) {
    // Load job to check eligibility
    const jobSnap = await getDoc(doc(db, "jobs", jobId));
    if (!jobSnap.exists()) throw new Error("Job not found");
    const jobCheck = { id: jobSnap.id, ...jobSnap.data() } as Job;

    // Count active tasks for concurrent limit check
    const activeQ = query(
      collection(db, "tasks"),
      where("assigneeAgentId", "==", agentId),
      where("status", "in", ["todo", "in_progress"]),
    );
    const activeSnap = await getDocs(activeQ);
    const activeCount = activeSnap.size;

    const eligibility = canClaimJob(policyResult.policy, {
      reward: jobCheck.reward,
      priority: jobCheck.priority,
      minPolicyTier: jobCheck.minPolicyTier,
    }, activeCount);

    if (!eligibility.allowed) {
      await recordPolicyEvent({
        agentId,
        orgId,
        action: "job_claim_blocked",
        tier: policyResult.tier!,
        details: { jobId, reason: eligibility.reason, activeCount },
      });
      throw new Error(`Policy violation: ${eligibility.reason}`);
    }

    // If manual review required, create approval instead of direct claim
    if (policyResult.policy.requiresManualReview) {
      const { createApproval } = await import("@/lib/approvals");
      await createApproval({
        orgId,
        type: "job_dispatch",
        title: `Job claim requires review: ${jobCheck.title}`,
        description: `Agent ${agentId} (tier: ${policyResult.policy.label}) requesting to claim job ${jobId}`,
        requestedBy: agentId,
        payload: { jobId, agentId, tier: policyResult.tier },
        priority: "medium",
      });
      await recordPolicyEvent({
        agentId,
        orgId,
        action: "manual_review_required",
        tier: policyResult.tier!,
        details: { jobId },
      });
      throw new Error("Job claim requires manual approval for your current policy tier");
    }

    await recordPolicyEvent({
      agentId,
      orgId,
      action: "job_claim_allowed",
      tier: policyResult.tier!,
      details: { jobId, activeCount },
    });
  }

  // ── Original claim logic ───────────────────────────────────
  await updateDoc(doc(db, "jobs", jobId), {
    status: "in_progress",
    takenByAgentId: agentId,
    updatedAt: serverTimestamp(),
    ...(agentName ? { claimedAt: serverTimestamp(), claimedByAgentName: agentName } : {}),
  });
  // Auto-create a task for the claiming agent
  const job = await getDoc(doc(db, "jobs", jobId));
  const jobData = job.data();
  const taskId = await createTask({
    orgId,
    projectId,
    title: jobData?.title || "Job task",
    description: `From job: ${jobData?.description || ""}`,
    assigneeAgentId: agentId,
    status: "todo",
    priority: jobData?.priority || "medium",
    createdAt: new Date(),
  });
  return taskId;
}

export async function closeJob(jobId: string): Promise<void> {
  await updateDoc(doc(db, "jobs", jobId), {
    status: "completed",
    updatedAt: serverTimestamp(),
  });
}

export async function updateJob(jobId: string, data: Partial<Job>): Promise<void> {
  await updateDoc(doc(db, "jobs", jobId), { ...data, updatedAt: serverTimestamp() });
}

export async function submitJobDelivery(jobId: string, data: {
  deliveryNotes: string;
  deliveryFiles?: string[];
  completedByAgentName: string;
}): Promise<void> {
  await updateDoc(doc(db, "jobs", jobId), {
    status: "completed",
    deliveryNotes: data.deliveryNotes,
    deliveryFiles: data.deliveryFiles ?? [],
    completedByAgentName: data.completedByAgentName,
    completedAt: serverTimestamp(),
    reviewStatus: "pending",
    updatedAt: serverTimestamp(),
  });
}

export async function deleteJob(jobId: string): Promise<void> {
  await deleteDoc(doc(db, "jobs", jobId));
}

// ─── Job Comments ────────────────────────────────────────

export interface JobComment {
  id: string;
  jobId: string;
  orgId: string;
  authorAddress: string;
  authorName?: string;
  body: string;
  createdAt: unknown;
}

export async function getJobComments(jobId: string): Promise<JobComment[]> {
  const q = query(collection(db, "jobComments"), where("jobId", "==", jobId), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as JobComment));
}

export async function addJobComment(data: Omit<JobComment, "id" | "createdAt">): Promise<string> {
  const ref = await addDoc(collection(db, "jobComments"), {
    ...data,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// ─── Job Applications (quotes) ──────────────────────────

export interface JobApplication {
  id: string;
  jobId: string;
  orgId: string;
  agentId: string;
  agentName: string;
  /** Proposed price, free text like Job.reward (e.g. "250") */
  quote?: string;
  message?: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: unknown;
  /** Set each time the applicant revises their quote/pitch via updateJobApplication(). */
  updatedAt?: unknown;
}

export async function getJobApplications(jobId: string): Promise<JobApplication[]> {
  const q = query(collection(db, "jobApplications"), where("jobId", "==", jobId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as JobApplication));
}

export async function applyToJob(data: Omit<JobApplication, "id" | "status" | "createdAt">): Promise<string> {
  const ref = await addDoc(collection(db, "jobApplications"), {
    ...data,
    status: "pending",
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, "jobs", data.jobId), { applicationCount: increment(1) });
  return ref.id;
}

/**
 * Revise a pending application's quote/pitch — the counter-offer step: a
 * bidder adjusts price after seeing the field is competitive, without
 * withdrawing and re-applying (which would lose their place/timestamp).
 * Only valid while the application is still "pending" — once hired or
 * rejected, the quote is part of the historical record.
 */
export async function updateJobApplication(
  applicationId: string,
  data: Partial<Pick<JobApplication, "quote" | "message">>,
): Promise<void> {
  await updateDoc(doc(db, "jobApplications", applicationId), { ...data, updatedAt: serverTimestamp() });
}

/** Accept one application, reject the rest, and assign the job to the hired agent. */
export async function hireApplicant(jobId: string, application: JobApplication, orgId: string, projectId: string): Promise<void> {
  // Routes through claimJob so hiring respects credit-policy enforcement and
  // auto-creates the agent's task, same as every other job-assignment path.
  await claimJob(jobId, application.agentId, orgId, projectId, application.agentName);

  const others = (await getJobApplications(jobId)).filter(a => a.id !== application.id && a.status === "pending");
  const batch = writeBatch(db);
  batch.update(doc(db, "jobApplications", application.id), { status: "accepted" });
  for (const other of others) {
    batch.update(doc(db, "jobApplications", other.id), { status: "rejected" });
  }
  await batch.commit();
}

/** An agent's completed & approved job history — used to render their portfolio. */
export async function getCompletedJobsByAgent(agentId: string): Promise<Job[]> {
  const q = query(collection(db, "jobs"), where("takenByAgentId", "==", agentId), where("status", "==", "completed"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Job));
}

/** Jobs assigned to any agent belonging to `sellerOrgId` via a gig order — the
 *  seller org's "orders to fulfill" view. Jobs posted the normal way (not via
 *  a gig) never set sellerOrgId, so they're excluded. */
export async function getIncomingGigOrders(sellerOrgId: string): Promise<Job[]> {
  const q = query(collection(db, "jobs"), where("sellerOrgId", "==", sellerOrgId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Job));
}

// ─── Gigs (Fiverr-style service listings) ───────────────
//
// A Gig is a seller agent's standing offer to do a kind of work for a fixed
// starting price. Ordering one skips the open/claim/application cycle
// entirely: orderGig() creates the Job already `in_progress` and assigned to
// the seller agent, then the existing deliver → review pipeline (above)
// takes over unchanged. Gigs are cross-org by design — the buyer's org and
// the seller agent's org are usually different, which is the whole point of
// a marketplace rather than an internal job board.

export interface Gig {
  id: string;
  agentId: string;
  agentOrgId: string;
  agentName: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  /** Starting price, free text like Job.reward (e.g. "150") */
  price: string;
  deliveryDays: number;
  status: 'active' | 'paused';
  orderCount: number;
  avgRating?: number;
  ratingCount?: number;
  /** Real on-chain SOL escrow for orders — requires the seller agent to have a solanaAddress on file. */
  escrowEnabled?: boolean;
  /** Authoritative on-chain price when escrowEnabled; `price` above stays the display string. */
  priceLamports?: number;
  /** Seller agent's Solana address at the time the gig was listed (escrowEnabled only). */
  sellerSolanaAddress?: string;
  createdAt: unknown;
  updatedAt?: unknown;
}

export async function createGig(data: Omit<Gig, "id" | "orderCount" | "avgRating" | "ratingCount" | "createdAt" | "updatedAt">): Promise<string> {
  const ref = await addDoc(collection(db, "gigs"), {
    ...data,
    orderCount: 0,
    avgRating: 0,
    ratingCount: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getGig(gigId: string): Promise<Gig | null> {
  const snap = await getDoc(doc(db, "gigs", gigId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Gig;
}

/** Browse listing — all active gigs across every org. */
export async function getActiveGigs(): Promise<Gig[]> {
  const q = query(collection(db, "gigs"), where("status", "==", "active"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Gig));
}

/** Seller-side management view — every gig owned by an org, any status. */
export async function getGigsByOrg(agentOrgId: string): Promise<Gig[]> {
  const q = query(collection(db, "gigs"), where("agentOrgId", "==", agentOrgId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Gig));
}

export async function getGigsByAgent(agentId: string): Promise<Gig[]> {
  const q = query(collection(db, "gigs"), where("agentId", "==", agentId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as Gig));
}

export async function setGigStatus(gigId: string, status: Gig["status"]): Promise<void> {
  await updateDoc(doc(db, "gigs", gigId), { status, updatedAt: serverTimestamp() });
}

export async function updateGig(gigId: string, data: Partial<Pick<Gig, "title" | "description" | "category" | "tags" | "price" | "deliveryDays">>): Promise<void> {
  await updateDoc(doc(db, "gigs", gigId), { ...data, updatedAt: serverTimestamp() });
}

/**
 * On-chain escrow state for a gig order, backed by the agent_guild Solana
 * program's Task account (postTask/claimTask/submitDelivery/approveDelivery/
 * disputeDelivery/resolveDispute — see src/lib/solana/client.ts). Only the
 * second half of the price is actually escrowed on-chain; the first half is
 * a direct wallet transfer recorded here for the receipt trail only.
 *
 * Signing happens client-side (dashboard, wallet-adapter) or in the seller
 * agent's own CLI (which holds the only copy of its private key) — this
 * module only ever records the resulting transaction signatures.
 */
export interface GigEscrow {
  /** Numeric on-chain task id (seed for the Task PDA) */
  taskId: number;
  taskPda: string;
  posterSolanaAddress: string;
  claimantSolanaAddress: string;
  totalLamports: number;
  upfrontLamports: number;
  escrowLamports: number;
  /** Direct wallet-to-wallet transfer for the upfront half — not on-chain escrow. */
  upfrontTransferTxSig: string;
  /** postTask() — funds `escrowLamports` into the Task PDA. */
  fundTxSig: string;
  /** claimTask() — signed by the agent's own key, recorded after the fact. */
  claimTxSig?: string;
  /** submitDelivery() — signed by the agent's own key. */
  deliveryTxSig?: string;
  /** approveDelivery() — signed by the buyer, releases escrowLamports to the agent. */
  releaseTxSig?: string;
  /** disputeDelivery() — signed by the buyer (poster). */
  disputeTxSig?: string;
  /** resolveDispute() — signed by the program's authority (platform admin). */
  resolveTxSig?: string;
  resolvedAgentBps?: number;
  status: 'funded' | 'claimed' | 'delivered' | 'released' | 'disputed' | 'resolved';
}

/** Place an order on a gig: creates the Job already in_progress & assigned to
 *  the seller agent (no open/claim/application step — the buyer chose this
 *  seller directly, same as hireApplicant() skips straight to assignment).
 *  `escrow` is populated only for escrowEnabled gigs, after the buyer has
 *  already signed the upfront transfer + postTask() transactions client-side. */
export async function orderGig(
  gigId: string,
  buyer: { orgId: string; address: string },
  requirements?: string,
  escrow?: Omit<GigEscrow, "status">
): Promise<string> {
  const gig = await getGig(gigId);
  if (!gig) throw new Error("Gig not found");
  if (gig.status !== "active") throw new Error("This gig is not currently active");

  const jobRef = await addDoc(collection(db, "jobs"), {
    orgId: buyer.orgId,
    projectId: "",
    title: gig.title,
    description: requirements?.trim() || gig.description,
    status: "in_progress",
    reward: gig.price,
    requiredSkills: gig.tags,
    postedByAddress: buyer.address,
    takenByAgentId: gig.agentId,
    priority: "medium",
    claimedAt: serverTimestamp(),
    claimedByAgentName: gig.agentName,
    hiringMode: "instant",
    gigId: gig.id,
    sellerOrgId: gig.agentOrgId,
    ...(escrow ? { escrow: { ...escrow, status: "funded" as const } } : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await updateDoc(doc(db, "gigs", gigId), { orderCount: increment(1) });

  return jobRef.id;
}

/** Merges a partial GigEscrow update into a job's existing escrow record. */
async function updateJobEscrow(jobId: string, patch: Partial<GigEscrow>): Promise<void> {
  const job = await getJob(jobId);
  if (!job?.escrow) throw new Error("Job has no escrow record");
  await updateDoc(doc(db, "jobs", jobId), {
    escrow: { ...job.escrow, ...patch },
    updatedAt: serverTimestamp(),
  });
}

/** Records a successful on-chain claimTask() — called by the seller agent's own CLI after it signs. */
export async function recordEscrowClaimed(jobId: string, claimTxSig: string): Promise<void> {
  await updateJobEscrow(jobId, { claimTxSig, status: "claimed" });
}

/** Records a successful on-chain submitDelivery() — called alongside submitJobDelivery(). */
export async function recordEscrowDelivered(jobId: string, deliveryTxSig: string): Promise<void> {
  await updateJobEscrow(jobId, { deliveryTxSig, status: "delivered" });
}

/** Records a successful on-chain approveDelivery() — called alongside the buyer's approval. */
export async function recordEscrowReleased(jobId: string, releaseTxSig: string): Promise<void> {
  await updateJobEscrow(jobId, { releaseTxSig, status: "released" });
}

/** Records a successful on-chain disputeDelivery() — called alongside filing the record-only dispute. */
export async function recordEscrowDisputed(jobId: string, disputeTxSig: string): Promise<void> {
  await updateJobEscrow(jobId, { disputeTxSig, status: "disputed" });
}

/** Records a successful on-chain resolveDispute() — called by a platform admin. */
export async function recordEscrowResolved(jobId: string, resolveTxSig: string, resolvedAgentBps: number): Promise<void> {
  await updateJobEscrow(jobId, { resolveTxSig, resolvedAgentBps, status: "resolved" });
}

// ─── Gig Reviews ─────────────────────────────────────────

export interface GigReview {
  id: string;
  gigId: string;
  jobId: string;
  orgId: string; // buyer org
  authorAddress: string;
  rating: number; // 1-5
  review?: string;
  createdAt: unknown;
}

/** One review per completed order. */
export async function getGigReviewByJob(jobId: string): Promise<GigReview | null> {
  const q = query(collection(db, "gigReviews"), where("jobId", "==", jobId), fsLimit(1));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as GigReview;
}

export async function getGigReviews(gigId: string): Promise<GigReview[]> {
  const q = query(collection(db, "gigReviews"), where("gigId", "==", gigId), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as GigReview));
}

/** Adds a review and atomically rolls it into the gig's avgRating/ratingCount. */
export async function addGigReview(data: Omit<GigReview, "id" | "createdAt">): Promise<string> {
  const existing = await getGigReviewByJob(data.jobId);
  if (existing) throw new Error("This order has already been reviewed");

  const reviewRef = doc(collection(db, "gigReviews"));
  const gigRef = doc(db, "gigs", data.gigId);

  await runTransaction(db, async (tx) => {
    const gigSnap = await tx.get(gigRef);
    if (!gigSnap.exists()) throw new Error("Gig not found");
    const gigData = gigSnap.data() as Gig;
    const prevCount = gigData.ratingCount ?? 0;
    const prevAvg = gigData.avgRating ?? 0;
    const nextCount = prevCount + 1;
    const nextAvg = (prevAvg * prevCount + data.rating) / nextCount;

    tx.set(reviewRef, { ...data, createdAt: serverTimestamp() });
    tx.update(gigRef, { avgRating: nextAvg, ratingCount: nextCount });
  });

  return reviewRef.id;
}

// ─── Agent Communications ───────────────────────────────

export interface AgentComm {
  id: string;
  orgId: string;
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  type: 'message' | 'status' | 'handoff' | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: unknown;
}

export async function sendAgentComm(data: Omit<AgentComm, "id">): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdAt: _ca, ...rest } = data;
  const ref = await addDoc(collection(db, "agentComms"), {
    ...rest,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function onAgentCommsByOrg(
  orgId: string,
  callback: (comms: AgentComm[]) => void
): Unsubscribe {
  const q = query(
    collection(db, "agentComms"),
    where("orgId", "==", orgId)
  );
  return onSnapshot(q, (snap) => {
    const comms = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as AgentComm))
      .sort((a, b) => {
        const aTime = a.createdAt && typeof a.createdAt === 'object' && 'seconds' in a.createdAt
          ? (a.createdAt as { seconds: number }).seconds
          : 0;
        const bTime = b.createdAt && typeof b.createdAt === 'object' && 'seconds' in b.createdAt
          ? (b.createdAt as { seconds: number }).seconds
          : 0;
        return bTime - aTime;
      });
    callback(comms);
  });
}

// ─── Statistics & Analytics ─────────────────────────────

export async function getOrgStats(orgId: string) {
  const [projects, agents, tasks, jobs] = await Promise.all([
    getProjectsByOrg(orgId),
    getAgentsByOrg(orgId),
    getTasksByOrg(orgId),
    getJobsByOrg(orgId),
  ]);

  return {
    projectCount: projects.length,
    agentCount: agents.length,
    taskCount: tasks.length,
    completedTasks: tasks.filter(t => t.status === 'done').length,
    activeTasks: tasks.filter(t => t.status === 'in_progress').length,
    todoTasks: tasks.filter(t => t.status === 'todo').length,
    jobCount: jobs.length,
    openJobs: jobs.filter(j => j.status === 'open').length,
    claimedJobs: jobs.filter(j => j.status === 'claimed').length,
    closedJobs: jobs.filter(j => j.status === 'closed').length,
  };
}

// ─── GitHub Events ──────────────────────────────────────

export interface GitHubEvent {
  id: string;
  orgId: string;
  projectId?: string;
  eventType: string;
  action?: string;
  repoFullName: string;
  title: string;
  actor: string;
  actorAvatarUrl?: string;
  payload: Record<string, unknown>;
  githubUrl?: string;
  createdAt: unknown;
}

export async function createGitHubEvent(data: Omit<GitHubEvent, "id">): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdAt: _ca, ...rest } = data;
  const ref = await addDoc(collection(db, "githubEvents"), {
    ...rest,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function onGitHubEventsByOrg(
  orgId: string,
  callback: (events: GitHubEvent[]) => void,
  limitCount = 50
): Unsubscribe {
  const q = query(
    collection(db, "githubEvents"),
    where("orgId", "==", orgId),
    orderBy("createdAt", "desc"),
  );
  return onSnapshot(q, (snap) => {
    const events = snap.docs
      .slice(0, limitCount)
      .map(d => ({ id: d.id, ...d.data() } as GitHubEvent));
    callback(events);
  });
}

export function onGitHubEventsByProject(
  projectId: string,
  callback: (events: GitHubEvent[]) => void,
  limitCount = 50
): Unsubscribe {
  const q = query(
    collection(db, "githubEvents"),
    where("projectId", "==", projectId),
    orderBy("createdAt", "desc"),
  );
  return onSnapshot(q, (snap) => {
    const events = snap.docs
      .slice(0, limitCount)
      .map(d => ({ id: d.id, ...d.data() } as GitHubEvent));
    callback(events);
  });
}

// ─── Agent Group Chat ───────────────────────────────────

const AGENT_GROUP_CHAT_NAME = "Agent Hub";

/** Ensure the org-wide agent group chat channel exists (deduplicates if race created extras) */
export async function ensureAgentGroupChat(orgId: string): Promise<Channel> {
  // Targeted query just for Agent Hub channels to minimize race window
  const q = query(
    collection(db, "channels"),
    where("orgId", "==", orgId),
    where("name", "==", AGENT_GROUP_CHAT_NAME),
  );
  const snap = await getDocs(q);

  if (!snap.empty) {
    const primary = snap.docs[0];
    // Clean up any duplicates created by race conditions
    if (snap.docs.length > 1) {
      const extras = snap.docs.slice(1);
      await Promise.all(extras.map(d => deleteDoc(doc(db, "channels", d.id))));
    }
    return { id: primary.id, ...primary.data() } as Channel;
  }

  const id = await createChannel({
    orgId,
    name: AGENT_GROUP_CHAT_NAME,
    createdAt: new Date(),
  });

  return { id, orgId, name: AGENT_GROUP_CHAT_NAME, createdAt: new Date() };
}

/** Ensure a private DM channel exists for an agent (deduplicates if race created extras) */
export async function ensureAgentPrivateChannel(
  agentId: string,
  orgId: string,
  agentName: string,
): Promise<Channel> {
  const q = query(
    collection(db, "channels"),
    where("orgId", "==", orgId),
    where("agentId", "==", agentId),
  );
  const snap = await getDocs(q);

  if (!snap.empty) {
    const primary = snap.docs[0];
    if (snap.docs.length > 1) {
      const extras = snap.docs.slice(1);
      await Promise.all(extras.map(d => deleteDoc(doc(db, "channels", d.id))));
    }
    return { id: primary.id, ...primary.data() } as Channel;
  }

  const id = await createChannel({
    orgId,
    agentId,
    name: agentName,
    createdAt: new Date(),
  });

  return { id, orgId, agentId, name: agentName, createdAt: new Date() };
}

/** Agent check-in: posts a status message to the agent group chat, stores reported skills/bio, and logs an AgentComm */
export async function agentCheckIn(
  agent: Agent,
  orgId: string,
  reportedSkills?: ReportedSkill[],
  bio?: string,
): Promise<void> {
  const hub = await ensureAgentGroupChat(orgId);

  // Store reported skills and bio on the agent document if provided
  const updates: Record<string, unknown> = {};
  if (reportedSkills && reportedSkills.length > 0) updates.reportedSkills = reportedSkills;
  if (bio) updates.bio = bio;
  if (Object.keys(updates).length > 0) {
    await updateAgent(agent.id, updates as Partial<Agent>);
  }

  // Build skill summary for the check-in message
  const skillNames = (reportedSkills ?? agent.reportedSkills ?? []).map(s => s.name);
  const skillSuffix = skillNames.length > 0
    ? ` | Skills: ${skillNames.join(", ")}`
    : "";

  // Post to group chat channel
  await sendMessage({
    channelId: hub.id,
    senderId: agent.id,
    senderName: agent.name,
    senderType: "agent",
    content: `🟢 **${agent.name}** (${agent.type}) is now online and listening.${skillSuffix}`,
    orgId,
    createdAt: new Date(),
  });

  // Also log to agent comms feed
  await sendAgentComm({
    orgId,
    fromAgentId: agent.id,
    fromAgentName: agent.name,
    toAgentId: "group",
    toAgentName: AGENT_GROUP_CHAT_NAME,
    type: "status",
    content: `${agent.name} checked in — online and ready`,
    metadata: {
      event: "check_in",
      agentType: agent.type,
      reportedSkills: reportedSkills ?? agent.reportedSkills ?? [],
    },
    createdAt: new Date(),
  });
}

/** Agent check-out: posts a disconnect message to the group chat */
export async function agentCheckOut(
  agent: Agent,
  orgId: string,
): Promise<void> {
  const hub = await ensureAgentGroupChat(orgId);

  await sendMessage({
    channelId: hub.id,
    senderId: agent.id,
    senderName: agent.name,
    senderType: "agent",
    content: `🔴 **${agent.name}** went offline.`,
    orgId,
    createdAt: new Date(),
  });
}

// ─── Platform Data (full org visibility for agents) ─────

/** Get a complete snapshot of platform data for an org — agents, tasks, jobs, projects, channels */
export async function getPlatformSnapshot(orgId: string) {
  const [agents, projects, tasks, jobs, channels] = await Promise.all([
    getAgentsByOrg(orgId),
    getProjectsByOrg(orgId),
    getTasksByOrg(orgId),
    getJobsByOrg(orgId),
    getChannelsByOrg(orgId),
  ]);

  return {
    agents: agents.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      status: a.status,
      capabilities: a.capabilities,
      projectIds: a.projectIds,
      reportedSkills: a.reportedSkills ?? [],
      bio: a.bio ?? "",
    })),
    projects: projects.map(p => ({
      id: p.id,
      name: p.name,
      status: p.status,
      agentIds: p.agentIds,
    })),
    tasks: tasks.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      assigneeAgentId: t.assigneeAgentId,
      projectId: t.projectId,
    })),
    jobs: jobs.map(j => ({
      id: j.id,
      title: j.title,
      status: j.status,
      priority: j.priority,
      takenByAgentId: j.takenByAgentId,
      reward: j.reward,
      requiredSkills: j.requiredSkills,
    })),
    channels: channels.map(c => ({
      id: c.id,
      name: c.name,
      projectId: c.projectId,
    })),
    timestamp: Date.now(),
  };
}

// ─── Agent Guild Node & Leases ────────────────────────────────────────

export async function getAgentGuildNodes(): Promise<AgentGuildNode[]> {
  const q = query(collection(db, "nodes"), orderBy("lastHeartbeat", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }) as AgentGuildNode);
}

export async function getAgentGuildNode(id: string): Promise<AgentGuildNode | null> {
  const snap = await getDoc(doc(db, "nodes", id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as AgentGuildNode;
}

export async function createLease(data: Omit<ComputeLease, "id" | "createdAt" | "status">): Promise<string> {
  const ref = await addDoc(collection(db, "leases"), {
    ...data,
    status: "starting",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateLease(id: string, data: Partial<ComputeLease>): Promise<void> {
  await updateDoc(doc(db, "leases", id), data);
}

export async function getLeases(orgId: string): Promise<ComputeLease[]> {
  const q = query(
    collection(db, "leases"),
    where("orgId", "==", orgId),
    orderBy("createdAt", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }) as ComputeLease);
}

export function onLeaseChange(id: string, callback: (lease: ComputeLease | null) => void): Unsubscribe {
  return onSnapshot(doc(db, "leases", id), (snap) => {
    if (snap.exists()) callback({ id: snap.id, ...snap.data() } as ComputeLease);
    else callback(null);
  });
}