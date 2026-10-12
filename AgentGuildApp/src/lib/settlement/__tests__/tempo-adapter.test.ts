import { describe, it, expect, vi, beforeEach } from "vitest";

const TOKEN = "0x20c0000000000000000000000000000000000000";
const TO = "0x000000000000000000000000000000000000beef";
const MEMO = `0x${"ab".repeat(32)}`;

const client = { getBlockNumber: vi.fn(), getLogs: vi.fn() };

vi.mock("viem/tempo", async (orig) => ({
  ...(await orig<typeof import("viem/tempo")>()),
  createClient: () => client,
}));
vi.mock("@/lib/chains", () => ({
  getChain: () => ({ name: "Tempo", rpc: "http://rpc.test", contracts: { usdc: TOKEN }, explorer: { txUrl: (h: string) => h } }),
}));

const { TempoSettlementAdapter } = await import("../tempo-adapter");

const behindHead = () =>
  Object.assign(new Error("Invalid parameters were provided to the RPC method."), {
    details: "block range extends beyond current head block: requested 39310290, head 39310289",
  });

const log = { args: { from: "0x1", to: TO, amount: 5_000_000n, memo: MEMO }, transactionHash: "0xtx", blockNumber: 39310290n };

describe("TempoSettlementAdapter.findMemoTransfer", () => {
  beforeEach(() => {
    client.getBlockNumber.mockReset().mockResolvedValue(39310290n);
    client.getLogs.mockReset();
  });

  it("waits for a lagging RPC node instead of failing or shrinking the range", async () => {
    client.getLogs.mockRejectedValueOnce(behindHead()).mockResolvedValueOnce([log]);
    const found = await new TempoSettlementAdapter().findMemoTransfer({
      memo: MEMO as `0x${string}`, to: TO, minAmount: 5_000_000n, fromBlock: 39310000n,
    });
    expect(found?.txHash).toBe("0xtx");
    expect(client.getLogs).toHaveBeenCalledTimes(2);
    // Same range both times — the newest block is still searched.
    expect(client.getLogs.mock.calls[1][0]).toMatchObject({ fromBlock: 39310000n, toBlock: 39310290n });
  });

  it("still surfaces other RPC errors", async () => {
    client.getLogs.mockRejectedValue(new Error("rate limited"));
    await expect(new TempoSettlementAdapter().findMemoTransfer({
      memo: MEMO as `0x${string}`, to: TO, minAmount: 1n, fromBlock: 39310000n,
    })).rejects.toThrow("rate limited");
    expect(client.getLogs).toHaveBeenCalledTimes(1);
  });
});
