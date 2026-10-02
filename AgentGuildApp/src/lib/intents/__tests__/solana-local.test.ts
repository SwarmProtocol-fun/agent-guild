// @vitest-environment node
/**
 * Real-chain test for Solana intents against a local validator. Skipped
 * unless SOLANA_LOCAL_RPC is set, e.g.:
 *
 *   solana-test-validator --reset --rpc-port 18899 &
 *   SOLANA_LOCAL_RPC=http://127.0.0.1:18899 npx vitest run src/lib/intents/__tests__/solana-local.test.ts
 *
 * Only Firestore and the wallet-key lookup are faked; transaction building,
 * simulation, signing, broadcast and confirmation are real.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const RPC = process.env.SOLANA_LOCAL_RPC;
vi.hoisted(() => {
  if (process.env.SOLANA_LOCAL_RPC) process.env.SOLANA_RPC_URL = process.env.SOLANA_LOCAL_RPC;
});

const data = new Map<string, Record<string, unknown>>();
function ref(c: string, id: string) {
  const k = `${c}/${id}`;
  return {
    id,
    get: async () => ({ exists: data.has(k), data: () => data.get(k) }),
    set: async (d: Record<string, unknown>, o?: { merge?: boolean }) => { data.set(k, o?.merge ? { ...(data.get(k) || {}), ...d } : { ...d }); },
    update: async (d: Record<string, unknown>) => { data.set(k, { ...(data.get(k) || {}), ...d }); },
  };
}
let n = 0;
vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: (c: string) => ({ doc: (id?: string) => ref(c, id ?? `auto${++n}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ get: (r: ReturnType<typeof ref>) => r.get(), set: (r: ReturnType<typeof ref>, d: Record<string, unknown>, o?: { merge?: boolean }) => r.set(d, o) }),
  }),
}));
vi.mock("@/lib/vault/store", () => ({ auditQuietly: vi.fn() }));

const wallet = { keypair: null as unknown };
vi.mock("@/lib/agent-wallets", () => ({
  getAgentWalletKeypair: async () => wallet.keypair,
  getAgentWalletEvmPrivateKey: async () => { throw new Error("not used"); },
}));

describe.skipIf(!RPC)("Solana intents on a local validator", () => {
  let connection: import("@solana/web3.js").Connection;
  let Keypair: typeof import("@solana/web3.js").Keypair;
  let LAMPORTS_PER_SOL: number;
  let submitIntent: typeof import("../execute").submitIntent;
  let saveIntentPolicy: typeof import("../execute").saveIntentPolicy;
  let mint: import("@solana/web3.js").PublicKey;
  const recipient = { publicKey: null as unknown as import("@solana/web3.js").PublicKey };

  beforeAll(async () => {
    const web3 = await import("@solana/web3.js");
    const spl = await import("@solana/spl-token");
    ({ Keypair, LAMPORTS_PER_SOL } = web3);
    connection = new web3.Connection(RPC!, "confirmed");

    const payer = Keypair.generate();
    const sig = await connection.requestAirdrop(payer.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
    wallet.keypair = payer;
    recipient.publicKey = Keypair.generate().publicKey;

    // A local stand-in for USDC: 6 decimals, 100 units minted to the agent wallet.
    mint = await spl.createMint(connection, payer, payer.publicKey, null, 6);
    const ata = await spl.getOrCreateAssociatedTokenAccount(connection, payer, mint, payer.publicKey);
    await spl.mintTo(connection, payer, mint, ata.address, payer, 100_000_000n);
    process.env.SOLANA_USDC_MINT = mint.toBase58();

    ({ submitIntent, saveIntentPolicy } = await import("../execute"));
    data.set("agentWallets/w1", { agentId: "agentA", orgId: "org1", chain: "solana" });
    await saveIntentPolicy("w1", "org1", {
      enabled: true,
      networks: ["solana"],
      allowMainnet: false,
      limits: { native: { maxPerTx: "1", maxPerDay: "1.5" }, usdc: { maxPerTx: "50", maxPerDay: "60" } },
      recipientAllowlist: [],
      contractAllowlist: [],
    }, "0xowner");
  }, 60_000);

  const agent = { agentId: "agentA", orgId: "org1" };

  it("sends SOL and it lands", async () => {
    const r = await submitIntent(agent, "w1", { type: "transfer", network: "solana", asset: "native", to: recipient.publicKey.toBase58(), amount: "0.25", memo: "intent test" });
    expect(r.status).toBe("confirmed");
    expect(await connection.getBalance(recipient.publicKey)).toBe(0.25 * LAMPORTS_PER_SOL);
  }, 60_000);

  it("sends the SPL token, creating the recipient's token account", async () => {
    const spl = await import("@solana/spl-token");
    const r = await submitIntent(agent, "w1", { type: "transfer", network: "solana", asset: "usdc", to: recipient.publicKey.toBase58(), amount: "12.5" });
    expect(r.status).toBe("confirmed");
    const ata = spl.getAssociatedTokenAddressSync(mint, recipient.publicKey, true);
    expect((await spl.getAccount(connection, ata)).amount).toBe(12_500_000n);
  }, 60_000);

  it("refuses over-limit amounts before touching the chain", async () => {
    const before = await connection.getBalance(recipient.publicKey);
    await expect(submitIntent(agent, "w1", { type: "transfer", network: "solana", asset: "native", to: recipient.publicKey.toBase58(), amount: "2" }))
      .rejects.toThrow(/per-transaction limit/);
    expect(await connection.getBalance(recipient.publicKey)).toBe(before);
  });

  it("fails simulation (and refunds the allowance) when the wallet can't pay", async () => {
    const poor = Keypair.generate();
    wallet.keypair = poor;
    await expect(submitIntent(agent, "w1", { type: "transfer", network: "solana", asset: "native", to: recipient.publicKey.toBase58(), amount: "0.5" }))
      .rejects.toThrow(/Simulation failed|insufficient|no record of a prior credit/i);
    const today = new Date().toISOString().slice(0, 10);
    expect(data.get(`intentUsage/w1_solana_native_${today}`)?.units).toBe("250000000"); // only the first 0.25 SOL remains counted
  }, 60_000);
});
