import { describe, expect, it } from "vitest";
import {
  checkTrigger, describeTrigger, expiryFrom, isExpired, parseOrderAmount, parsePriceTrigger, parseSlippage, solanaPayUrl, stepPriceWatch,
  type Watch,
} from "../../../../mods/solana-settlement/automation";

const SOL = "So11111111111111111111111111111111111111112";
const resolve = (v: string) => (v === "SOL" ? SOL : v);

describe("price triggers", () => {
  it("parses above/below/trail and rejects nonsense", () => {
    expect(parsePriceTrigger({ mint: "SOL", op: "below", usd: 140 }, resolve)).toEqual({ mint: SOL, op: "below", usd: 140 });
    expect(parsePriceTrigger({ mint: "SOL", op: "trail", trailPct: 8 }, resolve)).toEqual({ mint: SOL, op: "trail", trailPct: 8, peakUsd: null });
    expect(() => parsePriceTrigger({ mint: "SOL", op: "below", usd: -1 }, resolve)).toThrow(/positive/);
    expect(() => parsePriceTrigger({ mint: "SOL", op: "trail", trailPct: 90 }, resolve)).toThrow(/0.5 and 50/);
    expect(() => parsePriceTrigger({ mint: "SOL", op: "sideways" }, resolve)).toThrow(/above, below or trail/);
    expect(() => parsePriceTrigger(null, resolve)).toThrow();
  });

  it("fires above/below at the level and never on a missing price", () => {
    const below = { mint: SOL, op: "below" as const, usd: 100 };
    expect(checkTrigger(below, 101).hit).toBe(false);
    expect(checkTrigger(below, 100).hit).toBe(true);
    expect(checkTrigger(below, null).hit).toBe(false);
    expect(checkTrigger({ mint: SOL, op: "above", usd: 100 }, 100.5).hit).toBe(true);
  });

  it("trailing stop tracks the high and fires on the drop from it", () => {
    let t = { mint: SOL, op: "trail" as const, trailPct: 10, peakUsd: 100 };
    let c = checkTrigger(t, 120);
    expect(c).toMatchObject({ hit: false, changed: true });
    t = c.next as typeof t;
    expect(t.peakUsd).toBe(120);
    c = checkTrigger(t, 109);
    expect(c.hit).toBe(false);
    expect(c.changed).toBe(false);
    expect(checkTrigger(t, 108).hit).toBe(true);
    expect(describeTrigger(t, "SOL")).toMatch(/SOL falls 10% from its high \(high \$120\)/);
  });
});

describe("repeating price watch", () => {
  const base: Extract<Watch, { kind: "price" }> = {
    id: "w", agentId: "a", orgId: "o", status: "active", createdAt: "", expiresAt: "", note: null, repeat: true, fireCount: 0,
    kind: "price", armed: true, trigger: { mint: SOL, op: "above", usd: 100 },
  };

  it("fires once per crossing and re-arms after the condition clears", () => {
    let s = stepPriceWatch(base, 105);
    expect(s.fire).toBe(true);
    s = stepPriceWatch(s.next, 110);
    expect(s.fire).toBe(false);
    s = stepPriceWatch(s.next, 95);
    expect(s).toMatchObject({ fire: false, changed: true });
    expect(s.next.armed).toBe(true);
    expect(stepPriceWatch(s.next, 101).fire).toBe(true);
  });

  it("restarts a trailing watch from the price it fired at", () => {
    const trail = { ...base, trigger: { mint: SOL, op: "trail" as const, trailPct: 10, peakUsd: 200 } };
    const s = stepPriceWatch(trail, 170);
    expect(s.fire).toBe(true);
    expect(s.next.trigger).toMatchObject({ peakUsd: 170 });
  });
});

describe("order inputs", () => {
  it("accepts UI amounts, all and percentages", () => {
    expect(parseOrderAmount("1.5")).toBe("1.5");
    expect(parseOrderAmount("ALL")).toBe("all");
    expect(parseOrderAmount("25%")).toBe("25%");
    expect(() => parseOrderAmount("0")).toThrow();
    expect(() => parseOrderAmount("150%")).toThrow(/0 and 100/);
    expect(() => parseOrderAmount("-1")).toThrow();
    expect(parseSlippage(undefined)).toBeNull();
    expect(() => parseSlippage(5000)).toThrow();
  });

  it("expiry defaults to 7 days and caps at 30", () => {
    const now = Date.parse("2026-10-12T00:00:00Z");
    expect(expiryFrom(undefined, now)).toBe("2026-10-19T00:00:00.000Z");
    expect(() => expiryFrom(31, now)).toThrow(/30/);
    expect(isExpired("2026-10-11T00:00:00Z", now)).toBe(true);
    expect(isExpired("2026-10-13T00:00:00Z", now)).toBe(false);
  });
});

describe("Solana Pay URL", () => {
  it("builds a transfer request with reference and encoded text", () => {
    const url = solanaPayUrl({ recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: "5", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", reference: "REF", label: "Agent Bob", memo: "inv-1" });
    expect(url).toBe("solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM?amount=5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=REF&label=Agent%20Bob&memo=inv-1");
    expect(solanaPayUrl({ recipient: "R", amount: "0.1", mint: null, reference: "X" })).toBe("solana:R?amount=0.1&reference=X");
  });
});
