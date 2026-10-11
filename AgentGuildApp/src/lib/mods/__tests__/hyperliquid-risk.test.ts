import { describe, it, expect } from "vitest";
import { positionLimitError, signedNotional } from "../../../../mods/hyperliquid-trading/risk";

describe("positionLimitError — the limit is on the position, not the order", () => {
  it("allows an order that keeps the position within the limit, exactly at it included", () => {
    expect(positionLimitError("ETH", 0, true, 100, 100)).toBeNull();
    expect(positionLimitError("ETH", 40, true, 60, 100)).toBeNull();
    expect(positionLimitError("ETH", -40, false, 60, 100)).toBeNull();
  });

  it("refuses stacking orders past the limit on either side", () => {
    expect(positionLimitError("ETH", 60, true, 60, 100)).toMatch(/\$60\.00 long already open.*\$120\.00 position/);
    expect(positionLimitError("ETH", -60, false, 60, 100)).toMatch(/\$60\.00 short already open/);
  });

  it("nets an order against the opposite side", () => {
    expect(positionLimitError("ETH", -60, true, 80, 100)).toBeNull(); // → $20 long
    expect(positionLimitError("ETH", -60, true, 200, 100)).toMatch(/\$140\.00 position/); // flips past it
  });

  it("always lets an over-limit position shrink", () => {
    expect(positionLimitError("ETH", 150, false, 30, 100)).toBeNull();
    expect(positionLimitError("ETH", 150, true, 1, 100)).not.toBeNull();
  });

  it("leaves 'already open' out when nothing is open", () => {
    expect(positionLimitError("SOL", 0, true, 150, 100)).toBe("$150 SOL order would make a $150.00 position, over maxPositionUsd 100");
  });

  it("signs a position's notional by side", () => {
    expect(signedNotional(0.5, 2000)).toBe(1000);
    expect(signedNotional(-0.5, 2000)).toBe(-1000);
  });
});
