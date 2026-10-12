import { describe, it, expect } from "vitest";
import {
  openReservations, reservedUsd, positionLimitWithPendingError, UNBOUND_RESERVATION_MS, type LiveReservation,
} from "../../../../mods/hyperliquid-trading/risk";

const r = (over: Partial<LiveReservation>): LiveReservation => ({ id: "x", coin: "ETH", usd: 50, taskId: null, at: 0, ...over });

describe("live exposure reservations", () => {
  it("a queued order counts until its task ends, however old", () => {
    const entries = [r({ id: "a", taskId: "t-open", at: 0 }), r({ id: "b", taskId: "t-done", at: 0 })];
    const open = openReservations(entries, 10 * UNBOUND_RESERVATION_MS, (t) => t === "t-open");
    expect(open.map((e) => e.id)).toEqual(["a"]);
  });

  it("an unbound reservation (crash before queueing) expires", () => {
    const now = 1_000_000;
    const entries = [r({ id: "fresh", at: now - 1000 }), r({ id: "stale", at: now - UNBOUND_RESERVATION_MS })];
    expect(openReservations(entries, now, () => true).map((e) => e.id)).toEqual(["fresh"]);
  });

  it("sums signed USD for one coin only", () => {
    const entries = [r({ usd: 60 }), r({ usd: -20 }), r({ coin: "BTC", usd: 90 })];
    expect(reservedUsd(entries, "ETH")).toBe(40);
    expect(reservedUsd(entries, "SOL")).toBe(0);
  });

  it("names the in-flight amount when it tips an order over the limit", () => {
    expect(positionLimitWithPendingError("ETH", 0, 60, true, 60, 100)).toMatch(/\$120\.00 position, over maxPositionUsd 100 \(counting \$60\.00 of ETH live orders still in flight\)/);
    expect(positionLimitWithPendingError("ETH", 0, 0, true, 120, 100)).not.toMatch(/in flight/);
    expect(positionLimitWithPendingError("ETH", 0, 60, false, 60, 100)).toBeNull();
  });
});
