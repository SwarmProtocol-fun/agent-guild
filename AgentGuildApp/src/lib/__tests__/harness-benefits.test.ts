import { describe, expect, it } from "vitest";
import { getTier } from "../credit-policy";
import {
  buildHarnessBenefits,
  resolveBenefitPolicy,
  type HarnessBenefitInput,
} from "../harness-benefits";

const PAYOUT = "GXuDkGjF1jYKTrARUmrDuMP9SDVb6WtfmcmrorgZnF4";

function input(over: Partial<HarnessBenefitInput> = {}): HarnessBenefitInput {
  const resolved = resolveBenefitPolicy(over.creditScore ?? 680);
  return {
    creditScore: resolved.creditScore,
    policy: resolved.policy,
    adjustments: resolved.adjustments,
    openJobs: [],
    activeTasks: 0,
    wallets: [],
    capabilities: [],
    bindings: [],
    playbookGeneration: null,
    pendingGeneration: null,
    ...over,
    policy: over.policy ?? resolved.policy,
    adjustments: over.adjustments ?? resolved.adjustments,
    creditScore: over.creditScore ?? resolved.creditScore,
  };
}

function byId(result: ReturnType<typeof buildHarnessBenefits>, id: string) {
  const found = result.benefits.find((b) => b.id === id);
  if (!found) throw new Error(`missing benefit ${id}`);
  return found;
}

describe("harness benefits", () => {
  it("tells a standard agent which job it can claim and what the next tier pays", () => {
    const result = buildHarnessBenefits(input({
      openJobs: [
        { id: "job-1", title: "Write the receipt test", reward: "$100", priority: "medium" },
        { id: "job-2", title: "Too big", reward: "2000", priority: "medium" },
      ],
      wallets: [{ chain: "solana", publicKey: PAYOUT, payout: true }],
      capabilities: ["agent-wallet", "hyperliquid-trade"],
      bindings: ["stripe-api"],
      playbookGeneration: 2,
    }));

    const work = byId(result, "paid-work");
    expect(work.state).toBe("live");
    expect(work.command).toBe("agent-guild claim job-1");
    expect(work.detail).toContain("Write the receipt test");
    expect(work.detail).toContain("$100");
    expect(work.detail).toContain("1 other open job is outside this tier");
    expect(work.detail).not.toContain("Too big");

    expect(byId(result, "payout").detail).toContain(PAYOUT);
    expect(byId(result, "tools").detail).toContain("hyperliquid-trade");
    expect(byId(result, "tools").detail).not.toContain("agent-wallet");
    expect(byId(result, "bindings").command).toBe("agent-guild bindings");

    const credit = byId(result, "credit");
    expect(credit.detail).toContain("Standard");
    expect(credit.detail).toContain("$5,000");
    expect(credit.detail).toContain("Trusted");
    expect(result.policy).toMatchObject({ tier: "standard", spendingCapUsd: 5000, pointsToNext: 70 });

    expect(byId(result, "improve").command).toBe("agent-guild evolve");
    expect(byId(result, "improve").detail).toContain("Generation 2");
    expect(result.benefits.map((b) => b.id)).toEqual([
      "paid-work", "payout", "credit", "lending", "tools", "bindings", "memory", "vault", "identity", "improve", "peers",
    ]);
  });

  it("locks paid work when the only job is over this tier", () => {
    const work = byId(buildHarnessBenefits(input({
      openJobs: [{ id: "big", title: "Audit the program", reward: "2000", priority: "high" }],
    })), "paid-work");
    expect(work.state).toBe("locked");
    expect(work.command).toBe("");
    expect(work.detail).toMatch(/\$1,000|1000/);
  });

  it("locks paid work at the concurrent cap", () => {
    const work = byId(buildHarnessBenefits(input({
      activeTasks: 5,
      openJobs: [{ id: "job-1", title: "Small job", reward: "50", priority: "low" }],
    })), "paid-work");
    expect(work.state).toBe("locked");
    expect(work.detail).toContain("5/5");
  });

  it("uses apply for an applications-mode job", () => {
    const work = byId(buildHarnessBenefits(input({
      openJobs: [{ id: "bid-1", title: "Design the card", reward: "80", priority: "low", hiringMode: "applications" }],
    })), "paid-work");
    expect(work.command).toBe('agent-guild apply bid-1 --message "<why you>"');
  });

  it("locks payout when there is no address, and keeps the board open when there is no job", () => {
    const result = buildHarnessBenefits(input());
    expect(byId(result, "payout").state).toBe("locked");
    expect(byId(result, "paid-work").state).toBe("live");
    expect(byId(result, "paid-work").detail).toContain("No open jobs");
    expect(byId(result, "tools").state).toBe("locked");
    expect(byId(result, "bindings").state).toBe("locked");
  });

  it("does not call a high unverified score Prime", () => {
    const resolved = resolveBenefitPolicy(880);
    expect(resolved.policy.name).toBe("standard");
    const credit = byId(buildHarnessBenefits(input({
      creditScore: resolved.creditScore,
      policy: resolved.policy,
      adjustments: resolved.adjustments,
    })), "credit");
    expect(credit.detail).toContain("Standard");
    expect(credit.detail).toMatch(/cap is holding you/i);
    expect(credit.detail).not.toContain("Prime tier");
  });

  it("names a waiting proposal and does not tell the agent to evolve over it", () => {
    const improve = byId(buildHarnessBenefits(input({ playbookGeneration: 1, pendingGeneration: 4 })), "improve");
    expect(improve.command).toBe("agent-guild harness show");
    expect(improve.detail).toContain("Generation 4");
    expect(improve.detail).not.toContain("agent-guild evolve");
  });

  it("keeps the prompt brief bounded and free of key material", () => {
    const result = buildHarnessBenefits(input({
      wallets: [{ chain: "solana", publicKey: PAYOUT, payout: true }],
      capabilities: ["hyperliquid-trade"],
    }));
    expect(result.benefitBrief.length).toBeLessThanOrEqual(2000);
    for (const b of result.benefits) expect(result.benefitBrief).toContain(b.title);
    expect(JSON.stringify(result)).not.toMatch(/private|encryptedSecret|BEGIN/);
    expect(getTier("prime").spendingCapUsd).toBe(50000);
  });
});
