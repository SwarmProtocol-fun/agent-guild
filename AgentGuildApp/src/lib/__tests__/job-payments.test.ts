// @vitest-environment node
/** Paying an agent for an approved job: Base USDC, Solana USDC, off-platform — and every guard around them. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeAbiParameters, encodeEventTopics, erc20Abi } from "viem";

const BASE_USDC = "0xEf70C6e8D49DC21b96b02854089B26df9BECE227"; // chains.ts baseSepolia usdc
const OWNER = "0x1111111111111111111111111111111111111111";
const AGENT_EVM = "0x2222222222222222222222222222222222222222";
const STRANGER = "0x3333333333333333333333333333333333333333";
const AGENT_SOL = "So11111111111111111111111111111111111111112";

// ── In-memory Firestore ──────────────────────────────────────────────────
const store = new Map<string, Record<string, unknown>>();
const key = (c: string, id: string) => `${c}/${id}`;
function docRef(c: string, id: string) {
  const k = key(c, id);
  return {
    k,
    get: async () => ({ exists: store.has(k), data: () => store.get(k) }),
    create: async (d: Record<string, unknown>) => { if (store.has(k)) throw Object.assign(new Error("exists"), { code: 6 }); store.set(k, d); },
  };
}
const fakeDb = {
  collection: (c: string) => ({ doc: (id: string) => docRef(c, id) }),
  runTransaction: async (fn: (t: unknown) => Promise<void>) => {
    const writes: (() => void)[] = [];
    const txn = {
      get: async (ref: ReturnType<typeof docRef>) => ref.get(),
      create: (ref: ReturnType<typeof docRef>, d: Record<string, unknown>) => {
        if (store.has(ref.k)) throw new Error(`already exists: ${ref.k}`);
        writes.push(() => store.set(ref.k, d));
      },
      update: (ref: ReturnType<typeof docRef>, d: Record<string, unknown>) => writes.push(() => store.set(ref.k, { ...store.get(ref.k), ...d })),
    };
    await fn(txn);
    writes.forEach((w) => w());
  },
};
vi.mock("@/lib/firebase-admin", () => ({ adminDb: () => fakeDb }));

// ── Collaborators ────────────────────────────────────────────────────────
const state = {
  events: [] as unknown[][],
  tempo: null as null | { status: string },
  solanaClaim: false,
  solanaVerify: [] as unknown[],
  receipt: null as null | Record<string, unknown>,
  latest: BigInt(1000),
};
vi.mock("@/lib/firestore-admin", () => ({
  getAgent: async (id: string) => (id === "agent1" ? { id, name: "Ada", orgId: "org1", solanaAddress: AGENT_SOL } : null),
  getOrganization: async (id: string) => ({ id, ownerAddress: OWNER }),
}));
vi.mock("@/lib/agent-wallets", () => ({
  listAgentWallets: async () => [
    { id: "w1", chain: "evm", publicKey: AGENT_EVM, orgId: "org1", label: "Hyperliquid trading" },
    { id: "w2", chain: "evm", publicKey: STRANGER, orgId: "otherOrg" },
  ],
}));
vi.mock("@/lib/job-audit", () => ({
  recordJobEvent: async (...a: unknown[]) => { state.events.push(a); },
  userActor: (w: string) => ({ type: "user", id: w }),
}));
vi.mock("@/lib/mods/tempo-payouts-store", () => ({ getPayout: async () => state.tempo }));
vi.mock("@/lib/mods/solana-settlement-store", () => ({ hasSolanaSettlementClaim: async () => state.solanaClaim }));
vi.mock("@/lib/solana/lending-verify", () => ({
  lendingCluster: () => "devnet",
  usdcMintAddress: () => "MintDev",
  explorerTxUrl: (s: string) => `https://solscan.io/tx/${s}`,
  verifyUsdcTransfer: async (input: { txSig: string; expectedAmount: number }) => { state.solanaVerify.push(input); return { txSig: input.txSig, received: input.expectedAmount }; },
  claimUsdcTransferInTxn: (txn: { create: (r: unknown, d: unknown) => void }, input: { txSig: string; refId: string }) =>
    txn.create(docRef("lendingOnChainTxs", input.txSig), { refId: input.refId }),
}));
vi.mock("viem", async () => {
  const real = await vi.importActual<typeof import("viem")>("viem");
  return {
    ...real,
    createPublicClient: () => ({
      getTransactionReceipt: async () => { if (!state.receipt) throw new Error("not found"); return state.receipt; },
      getBlockNumber: async () => state.latest,
    }),
  };
});
vi.mock("@/lib/auth-guard", () => ({
  getWalletAddress: (req: NextRequest) => req.headers.get("x-wallet-address"),
  requireOrgMember: async (req: NextRequest, orgId: string) =>
    orgId === "org1" && req.headers.get("x-wallet-address") ? { ok: true } : { ok: false, status: 403, error: "no" },
}));
vi.mock("@/lib/jobs-admin", () => ({
  getJob: async (id: string) => { const d = store.get(key("jobs", id)); return d ? { id, ...d } : null; },
}));

import { isPayable } from "@/lib/job-payouts";
import { agentPayoutWallets, markJobPaidOffPlatform, payJobOnChain, unpayableReason } from "@/lib/job-payments";
import { POST as payRoute } from "@/app/api/jobs/[jobId]/payment/route";
import type { Job } from "@/lib/firestore";

const actor = { type: "user" as const, id: OWNER };

function seedJob(id: string, extra: Partial<Job> = {}): Job {
  const job = {
    orgId: "org1", title: "Write docs", status: "completed", reviewStatus: "approved", reward: "$50",
    takenByAgentId: "agent1", postedByAddress: OWNER, createdAt: 0, ...extra,
  } as Omit<Job, "id">;
  store.set(key("jobs", id), job as Record<string, unknown>);
  return { id, ...job } as Job;
}

function usdcTransfer(from: string, to: string, value: bigint, address = BASE_USDC) {
  return {
    address,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: from as `0x${string}`, to: to as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}
const receipt = (logs: unknown[], status = "success") => ({ status, blockNumber: BigInt(900), logs });
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;

beforeEach(() => {
  store.clear();
  Object.assign(state, { events: [], tempo: null, solanaClaim: false, solanaVerify: [], receipt: null, latest: BigInt(1000) });
  delete process.env.JOB_PAYOUT_EVM_CHAIN;
});

describe("which jobs can be paid", () => {
  it("only approved, unpaid jobs that no settlement mod has touched", async () => {
    expect(await unpayableReason(seedJob("j1"))).toBeNull();
    expect(await unpayableReason(seedJob("j2", { reviewStatus: "pending" }))).toMatch(/Approve/);
    expect(await unpayableReason(seedJob("j3", { escrow: {} as Job["escrow"] }))).toMatch(/escrow/);
    state.tempo = { status: "paid" };
    expect(await unpayableReason(seedJob("j4"))).toMatch(/Tempo/);
    state.tempo = null;
    state.solanaClaim = true;
    expect(await unpayableReason(seedJob("j5"))).toMatch(/Solana settlement/);
  });

  it("a paid job is no longer payable by the settlement mods either", () => {
    expect(isPayable(seedJob("j1", { payment: { method: "offplatform", amountUsdc: 5, paidBy: OWNER, paidAt: 1 } }))).toBe(false);
  });

  it("pays into the agent's existing wallets in this org — never makes a new one", async () => {
    const w = await agentPayoutWallets({ id: "agent1", name: "Ada", solanaAddress: AGENT_SOL } as never, "org1");
    expect(w.evm.map((x) => x.address)).toEqual([AGENT_EVM]);
    expect(w.solana.map((x) => x.address)).toEqual([AGENT_SOL]);
  });
});

describe("off-platform", () => {
  it("records the payment once, on the job, its own doc and the audit trail", async () => {
    const job = seedJob("j1");
    const p = await markJobPaidOffPlatform(job, { channel: "paypal", reference: "PP-123", amountUsdc: 50 }, actor);
    expect(p).toMatchObject({ method: "offplatform", channel: "paypal", reference: "PP-123", amountUsdc: 50 });
    expect(store.get("jobs/j1")?.payment).toMatchObject({ channel: "paypal" });
    expect(store.get("jobPayments/j1")).toMatchObject({ jobId: "j1", agentId: "agent1" });
    expect(state.events[0][1]).toBe("paid");

    const again = { id: "j1", ...store.get("jobs/j1") } as Job;
    await expect(markJobPaidOffPlatform(again, { channel: "bank", amountUsdc: 50 }, actor)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects unknown channels and bad amounts", async () => {
    const job = seedJob("j1");
    await expect(markJobPaidOffPlatform(job, { channel: "venmo-ish", amountUsdc: 5 }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(markJobPaidOffPlatform(job, { channel: "bank", amountUsdc: -1 }, actor)).rejects.toMatchObject({ status: 400 });
    await expect(markJobPaidOffPlatform(job, { channel: "bank", amountUsdc: 1.0000001 }, actor)).rejects.toMatchObject({ status: 400 });
  });
});

describe("USDC on Base", () => {
  const pay = (job: Job, over: Record<string, unknown> = {}) =>
    payJobOnChain(job, { method: "base-usdc", txSig: HASH_A, from: OWNER, to: AGENT_EVM, amountUsdc: 50, ...over } as never, actor);

  it("records a confirmed transfer from the payer to the agent's wallet and claims the tx", async () => {
    state.receipt = receipt([usdcTransfer(OWNER, AGENT_EVM, BigInt(50_000_000))]);
    const p = await pay(seedJob("j1"));
    expect(p).toMatchObject({ method: "base-usdc", amountUsdc: 50, txSig: HASH_A, to: AGENT_EVM, from: OWNER });
    expect(p.explorerUrl).toContain(HASH_A);
    expect(store.get(`lendingOnChainTxs/${HASH_A}`)).toMatchObject({ purpose: "job-payout", refId: "j1" });
  });

  it("won't count the same transaction for a second job", async () => {
    state.receipt = receipt([usdcTransfer(OWNER, AGENT_EVM, BigInt(50_000_000))]);
    await pay(seedJob("j1"));
    await expect(pay(seedJob("j2"))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already been used/) });
  });

  it("checks recipient, sender, token, amount, status and confirmations", async () => {
    state.receipt = receipt([usdcTransfer(OWNER, AGENT_EVM, BigInt(50_000_000))]);
    await expect(pay(seedJob("j1"), { to: STRANGER })).rejects.toMatchObject({ status: 400 }); // other org's wallet

    state.receipt = receipt([usdcTransfer(STRANGER, AGENT_EVM, BigInt(50_000_000))]);
    await expect(pay(seedJob("j1"))).rejects.toMatchObject({ status: 422 });

    state.receipt = receipt([usdcTransfer(OWNER, AGENT_EVM, BigInt(50_000_000), "0x9999999999999999999999999999999999999999")]);
    await expect(pay(seedJob("j1"))).rejects.toMatchObject({ status: 422 });

    state.receipt = receipt([usdcTransfer(OWNER, AGENT_EVM, BigInt(49_000_000))]);
    await expect(pay(seedJob("j1"))).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/sent 49/) });

    state.receipt = receipt([usdcTransfer(OWNER, AGENT_EVM, BigInt(50_000_000))], "reverted");
    await expect(pay(seedJob("j1"))).rejects.toMatchObject({ status: 422 });

    state.receipt = receipt([usdcTransfer(OWNER, AGENT_EVM, BigInt(50_000_000))]);
    state.latest = BigInt(905);
    await expect(pay(seedJob("j1"))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/confirmations/) });

    expect(store.get("jobs/j1")?.payment).toBeUndefined();
  });

  it("sums several transfers in one tx", async () => {
    state.receipt = receipt([usdcTransfer(OWNER, AGENT_EVM, BigInt(20_000_000)), usdcTransfer(OWNER, AGENT_EVM, BigInt(30_000_000))]);
    expect((await pay(seedJob("j1"))).amountUsdc).toBe(50);
  });
});

describe("USDC on Solana", () => {
  it("verifies against the agent's Solana wallet and claims the signature", async () => {
    const p = await payJobOnChain(seedJob("j1"), { method: "solana-usdc", txSig: "SigX", from: "PayerSol", to: AGENT_SOL, amountUsdc: 50 }, actor);
    expect(state.solanaVerify[0]).toMatchObject({ txSig: "SigX", expectedFromWallet: "PayerSol", expectedToWallet: AGENT_SOL, expectedAmount: 50 });
    expect(p).toMatchObject({ method: "solana-usdc", amountUsdc: 50, explorerUrl: "https://solscan.io/tx/SigX" });
    expect(store.get("lendingOnChainTxs/SigX")).toMatchObject({ refId: "j1" });
  });

  it("refuses a recipient that isn't the agent's", async () => {
    await expect(
      payJobOnChain(seedJob("j1"), { method: "solana-usdc", txSig: "SigX", from: "PayerSol", to: "SomeoneElse", amountUsdc: 50 }, actor),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("POST /api/jobs/:jobId/payment", () => {
  const call = (wallet: string, body: unknown) =>
    payRoute(
      new NextRequest("https://agent-guild.com/api/jobs/j1/payment", {
        method: "POST",
        headers: { "content-type": "application/json", "x-wallet-address": wallet },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ jobId: "j1" }) },
    );

  it("lets the owner/poster pay, not any other member", async () => {
    seedJob("j1", { postedByAddress: "0xposter" });
    expect((await call("0xmember", { method: "offplatform", channel: "cash", amountUsdc: 50 })).status).toBe(403);
    const res = await call("0xposter", { method: "offplatform", channel: "cash", amountUsdc: 50 });
    expect(res.status).toBe(200);
    expect((await call(OWNER, { method: "offplatform", channel: "cash", amountUsdc: 50 })).status).toBe(409);
  });

  it("rejects unknown methods", async () => {
    seedJob("j1");
    expect((await call(OWNER, { method: "tempo" })).status).toBe(400);
  });
});
