// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ─── in-memory Firestore ───────────────────────────────────────
const data = new Map<string, Record<string, unknown>>(); // "collection/id" → doc
const key = (c: string, id: string) => `${c}/${id}`;
let autoId = 0;
function ref(c: string, id: string) {
  return {
    id,
    get: async () => ({ exists: data.has(key(c, id)), data: () => data.get(key(c, id)) }),
    set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => { data.set(key(c, id), o?.merge ? { ...(data.get(key(c, id)) || {}), ...d } : { ...d }); },
    update: async (d: Record<string, unknown>) => { data.set(key(c, id), { ...(data.get(key(c, id)) || {}), ...d }); },
  };
}
vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: (c: string) => ({ doc: (id?: string) => ref(c, id ?? `auto${++autoId}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ get: (r: ReturnType<typeof ref>) => r.get(), set: (r: ReturnType<typeof ref>, d: Record<string, unknown>, o?: { merge?: boolean }) => r.set(d, o) }),
  }),
}));
vi.mock("@/lib/vault/store", () => ({ auditQuietly: vi.fn() }));
vi.mock("@/lib/agent-wallets", () => ({
  getAgentWalletEvmPrivateKey: async () => "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  getAgentWalletKeypair: async () => { throw new Error("not used"); },
}));
vi.mock("@/lib/solana/lending-verify", () => ({ usdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" }));

const chainState = { simulateError: null as Error | null, sendError: null as Error | null, receipt: new Promise<{ status: string }>(() => {}), sent: [] as Record<string, unknown>[] };
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      call: async () => { if (chainState.simulateError) throw chainState.simulateError; return {}; },
      estimateGas: async () => 21000n,
      waitForTransactionReceipt: () => chainState.receipt,
    }),
    createWalletClient: () => ({
      sendTransaction: async (tx: Record<string, unknown>) => {
        if (chainState.sendError) throw chainState.sendError;
        chainState.sent.push(tx);
        return "0xabc";
      },
    }),
  };
});

import { checkIntent, toBaseUnits, fromBaseUnits, validatePolicy, isTestnet, type IntentPolicy } from "../policy";
import { submitIntent, saveIntentPolicy, IntentError } from "../execute";

const RECIPIENT = "0x1111111111111111111111111111111111111111";
const policy = (over: Partial<IntentPolicy> = {}): IntentPolicy => ({
  enabled: true,
  networks: ["sepolia"],
  allowMainnet: false,
  limits: { native: { maxPerTx: "0.1", maxPerDay: "0.25" }, usdc: { maxPerTx: "10", maxPerDay: "20" } },
  recipientAllowlist: [],
  contractAllowlist: [],
  ...over,
});
const none = () => 0n;

describe("amounts", () => {
  it("converts exactly, with no float rounding", () => {
    expect(toBaseUnits("1.5", 6)).toBe(1_500_000n);
    expect(toBaseUnits("0.1", 18)).toBe(100_000_000_000_000_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
    expect(fromBaseUnits(1_500_000n, 6)).toBe("1.5");
  });
  it.each(["-1", "1e5", "1.0000001", "abc", "", "1,5"])("rejects %s", (v) => expect(toBaseUnits(v, 6)).toBeNull());
});

describe("intent policy checks", () => {
  const transfer = (over: Record<string, unknown> = {}) => ({ type: "transfer", network: "sepolia", asset: "native", to: RECIPIENT, amount: "0.05", ...over });

  it("accepts an in-policy transfer", () => {
    const r = checkIntent(transfer(), "evm", policy(), none);
    expect(r.ok && r.value.units).toBe(50_000_000_000_000_000n);
  });

  it.each([
    [{ enabled: false }, transfer(), /turned off/],
    [{}, transfer({ amount: "0.2" }), /per-transaction limit/],
    [{}, transfer({ network: "base" }), /isn't allowed/],
    [{ networks: ["base"] }, transfer({ network: "base" }), /mainnet signing is disabled/],
    [{ recipientAllowlist: ["0x2222222222222222222222222222222222222222"] }, transfer(), /allowlist/],
    [{ limits: { usdc: { maxPerTx: "10", maxPerDay: "20" } } }, transfer(), /aren't allowed/],
    [{}, transfer({ to: "not-an-address" }), /valid address/],
    [{}, transfer({ amount: "0" }), /positive/],
    [{}, { type: "evm_call", network: "sepolia", to: RECIPIENT, data: "0x" }, /contract allowlist/],
    [{}, { type: "swap", network: "sepolia" }, /type must be/],
  ])("rejects %#", (over, intent, msg) => {
    const r = checkIntent(intent, "evm", policy(over as Partial<IntentPolicy>), none);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(msg);
  });

  it("counts today's spend against the daily limit", () => {
    const spent = (asset: string) => (asset === "native" ? toBaseUnits("0.2", 18)! : 0n);
    const r = checkIntent(transfer({ amount: "0.06" }), "evm", policy(), spent);
    expect(!r.ok && r.error).toMatch(/daily limit/);
  });

  it("won't sign across chain families", () => {
    expect(checkIntent(transfer(), "solana", policy(), none).ok).toBe(false);
  });

  it("needs both the policy and the server to allow mainnet", () => {
    const p = policy({ networks: ["base"], allowMainnet: true });
    delete process.env.INTENTS_ALLOW_MAINNET;
    expect(checkIntent(transfer({ network: "base" }), "evm", p, none).ok).toBe(false);
    process.env.INTENTS_ALLOW_MAINNET = "1";
    expect(checkIntent(transfer({ network: "base" }), "evm", p, none).ok).toBe(true);
    delete process.env.INTENTS_ALLOW_MAINNET;
  });

  it("classifies networks", () => {
    expect(isTestnet("sepolia")).toBe(true);
    expect(isTestnet("ethereum")).toBe(false);
    expect(isTestnet("base")).toBe(false);
  });

  it("validates policies", () => {
    expect(validatePolicy({ networks: ["nope"] }).ok).toBe(false);
    expect(validatePolicy({ networks: ["sepolia"], limits: { native: { maxPerTx: "1", maxPerDay: "0.5" } } }).ok).toBe(false);
    expect(validatePolicy({ networks: ["sepolia"], contractAllowlist: ["xyz"] }).ok).toBe(false);
    const ok = validatePolicy({ networks: ["sepolia"], recipientAllowlist: "0xAbCdEf0000000000000000000000000000000001" });
    expect(ok.ok && ok.value.recipientAllowlist).toEqual(["0xabcdef0000000000000000000000000000000001"]);
  });
});

describe("submitIntent accounting", () => {
  const agent = { agentId: "agentA", orgId: "org1" };
  const usage = () => data.get(`intentUsage/w1_sepolia_native_${new Date().toISOString().slice(0, 10)}`)?.units;

  beforeEach(async () => {
    data.clear();
    chainState.simulateError = null;
    chainState.sendError = null;
    chainState.receipt = new Promise(() => {}); // never confirms unless a test says so
    chainState.sent = [];
    data.set("agentWallets/w1", { agentId: "agentA", orgId: "org1", chain: "evm" });
    await saveIntentPolicy("w1", "org1", policy(), "0xowner");
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => vi.useRealTimers());

  const submit = (amount: string) => submitIntent(agent, "w1", { type: "transfer", network: "sepolia", asset: "native", to: RECIPIENT, amount });

  it("signs, reports confirmation, and keeps the allowance spent", async () => {
    chainState.receipt = Promise.resolve({ status: "success" });
    const r = await submit("0.1");
    expect(r).toMatchObject({ status: "confirmed", txHash: "0xabc" });
    expect(chainState.sent[0]).toMatchObject({ to: RECIPIENT, value: 100_000_000_000_000_000n });
    expect(usage()).toBe("100000000000000000");
  });

  it("refunds the allowance when simulation fails (nothing broadcast)", async () => {
    chainState.simulateError = new Error("insufficient funds");
    await expect(submit("0.1")).rejects.toThrow(/Simulation failed/);
    expect(usage()).toBe("0");
    expect(chainState.sent).toHaveLength(0);
  });

  it("keeps the allowance spent once broadcast, even if confirmation never comes", async () => {
    const p = submit("0.1");
    await vi.advanceTimersByTimeAsync(46_000);
    expect((await p).status).toBe("submitted");
    expect(usage()).toBe("100000000000000000");
  });

  it("enforces the daily cap across intents", async () => {
    chainState.receipt = Promise.resolve({ status: "success" });
    await submit("0.1");
    await submit("0.1");
    await expect(submit("0.1")).rejects.toThrow(/daily limit/);
    expect(chainState.sent).toHaveLength(2);
  });

  it("rejects another agent's wallet", async () => {
    await expect(submitIntent({ agentId: "agentB", orgId: "org1" }, "w1", { type: "transfer" })).rejects.toBeInstanceOf(IntentError);
  });
});
