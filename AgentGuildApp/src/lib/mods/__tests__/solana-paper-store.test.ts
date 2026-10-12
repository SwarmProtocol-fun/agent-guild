import { beforeEach, describe, expect, it, vi } from "vitest";

const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@/lib/firebase-admin", () => {
  const ref = (col: string, id: string) => ({
    id,
    key: `${col}/${id}`,
    get: async () => ({ data: () => rows.get(`${col}/${id}`) }),
    set: async (d: Record<string, unknown>) => { rows.set(`${col}/${id}`, structuredClone(d)); },
  });
  const db = {
    collection: (col: string) => ({
      doc: (id: string) => ref(col, id),
      where: (field: string, _op: string, value: unknown) => {
        const match = () => [...rows.entries()].filter(([k, d]) => k.startsWith(`${col}/`) && d[field] === value).sort(([a], [b]) => a.localeCompare(b));
        return {
          get: async () => ({ docs: match().map(([, d]) => ({ data: () => d })) }),
          orderBy: () => ({ limit: (n: number) => ({ get: async () => ({ docs: match().slice(0, n).map(([, d]) => ({ data: () => d })) }) }) }),
        };
      },
    }),
    runTransaction: async <T,>(fn: (tx: unknown) => Promise<T>) => {
      const writes: Array<() => Promise<void>> = [];
      const out = await fn({
        get: (r: ReturnType<typeof ref>) => r.get(),
        set: (r: ReturnType<typeof ref>, d: Record<string, unknown>) => writes.push(() => r.set(d)),
      });
      for (const w of writes) await w();
      return out;
    },
  };
  return { adminDb: () => db };
});

import { bookPaperTrade, getPaperWallet, listPaperTrades, resetPaperWallet, setPolicy } from "../../../../mods/solana-settlement/paper-store";
import { DEFAULT_POLICY, USDC_MINT } from "../../../../mods/solana-settlement/paper";

const SOL = "So11111111111111111111111111111111111111112";
const fill = (usdc: number) => ({
  inputMint: USDC_MINT, outputMint: SOL, inRaw: BigInt(usdc * 1e6), outRaw: BigInt(Math.round((usdc / 100) * 1e9)),
  inDecimals: 6, outDecimals: 9, usdValue: usdc,
});
const meta = { inSymbol: "USDC", outSymbol: "SOL", inUi: "x", outUi: "y", priceImpactPct: 0, route: ["Orca"], note: "test" };

beforeEach(() => rows.clear());

describe("paper store", () => {
  it("books trades, tracks today's volume and lists newest first", async () => {
    await bookPaperTrade("a1", "o1", fill(100), meta);
    await new Promise((r) => setTimeout(r, 3));
    const { wallet } = await bookPaperTrade("a1", "o1", fill(200), meta);
    expect(wallet.volumeToday).toBe(300);
    expect(wallet.tradeCount).toBe(2);
    const trades = await listPaperTrades("a1", "o1");
    expect(trades.map((t) => t.usdValue)).toEqual([200, 100]);
  });

  it("enforces the owner's daily limit across trades", async () => {
    await setPolicy("a1", "o1", { ...DEFAULT_POLICY, maxDailyVolumeUsd: 250 }, "OWNER");
    await bookPaperTrade("a1", "o1", fill(200), meta);
    await expect(bookPaperTrade("a1", "o1", fill(100), meta)).rejects.toThrow(/daily limit/);
    expect((await getPaperWallet("a1", "o1")).tradeCount).toBe(1);
  });

  it("ignores another org's wallet and policy under the same agent id", async () => {
    await setPolicy("a1", "other", { ...DEFAULT_POLICY, paused: true }, "X");
    await expect(bookPaperTrade("a1", "o1", fill(100), meta)).resolves.toBeTruthy();
    expect((await getPaperWallet("a1", "o1")).orgId).toBe("o1");
  });

  it("reset restores 10k USDC and stamps the reset time", async () => {
    await bookPaperTrade("a1", "o1", fill(2000), meta);
    await expect(bookPaperTrade("a1", "o1", fill(5000), meta)).rejects.toThrow(/per-trade limit/);
    const w = await resetPaperWallet("a1", "o1");
    expect(w.holdings[USDC_MINT].raw).toBe("10000000000");
    expect(w.resetAt).toBeTruthy();
  });
});
