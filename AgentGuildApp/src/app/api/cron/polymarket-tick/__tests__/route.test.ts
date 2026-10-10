import { describe, it, expect, vi } from "vitest";

const runPolymarketTick = vi.fn(async () => ({ bots: 3, entered: 1, asked: 0, settled: 1, filled: 2, errors: 0 }));
vi.mock("../../../../../../mods/polymarket-trading/server", () => ({ runPolymarketTick }));
vi.mock("@/lib/auth-guard", () => ({
  requirePlatformAdmin: vi.fn(() => ({ ok: false })),
  requireInternalService: vi.fn((req: Request) => ({ ok: req.headers.get("x-service-secret") === "s3cret" })),
}));

const { POST } = await import("../route");

describe("POST /api/cron/polymarket-tick", () => {
  it("refuses callers without the service secret", async () => {
    const res = await POST(new Request("http://x/api/cron/polymarket-tick", { method: "POST" }) as never);
    expect(res.status).toBe(403);
    expect(runPolymarketTick).not.toHaveBeenCalled();
  });

  it("runs the tick (fills, settlement, bots) for the scheduler", async () => {
    const res = await POST(new Request("http://x/api/cron/polymarket-tick", { method: "POST", headers: { "x-service-secret": "s3cret" } }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ settled: 1, filled: 2 });
  });
});
