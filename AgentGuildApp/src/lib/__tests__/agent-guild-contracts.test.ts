import { describe, it, expect } from "vitest";
import {
  shortAddr,
  timeRemaining,
  TaskStatus,
  STATUS_CONFIG,
  TASK_BOARD_ABI,
  AGENT_REGISTRY_ABI,
} from "../agent-guild-contracts";

describe("shortAddr", () => {
  it("shortens a standard Ethereum address", () => {
    expect(shortAddr("0x1234567890abcdef1234567890abcdef12345678")).toBe(
      "0x1234...5678"
    );
  });

  it("returns dash for zero address", () => {
    expect(shortAddr("0x0000000000000000000000000000000000000000")).toBe("—");
  });

  it("returns dash for empty string", () => {
    expect(shortAddr("")).toBe("—");
  });
});

describe("timeRemaining", () => {
  it('returns "Expired" for past deadlines', () => {
    const past = Math.floor(Date.now() / 1000) - 100;
    expect(timeRemaining(past)).toBe("Expired");
  });

  it("returns minutes for short durations", () => {
    const future = Math.floor(Date.now() / 1000) + 300; // 5 min
    const result = timeRemaining(future);
    expect(result).toMatch(/\d+m$/);
  });

  it("returns hours and minutes for medium durations", () => {
    const future = Math.floor(Date.now() / 1000) + 7200; // 2 hours
    const result = timeRemaining(future);
    expect(result).toMatch(/\d+h \d+m$/);
  });

  it("returns days and hours for long durations", () => {
    const future = Math.floor(Date.now() / 1000) + 172800; // 2 days
    const result = timeRemaining(future);
    expect(result).toMatch(/\d+d \d+h$/);
  });
});

describe("TaskStatus", () => {
  it("has all expected statuses", () => {
    expect(TaskStatus.Open).toBe(0);
    expect(TaskStatus.Claimed).toBe(1);
    expect(TaskStatus.Completed).toBe(2);
    expect(TaskStatus.Expired).toBe(3);
    expect(TaskStatus.Disputed).toBe(4);
    expect(TaskStatus.Resolved).toBe(5);
  });

  it("STATUS_CONFIG covers all statuses", () => {
    for (const status of [0, 1, 2, 3, 4, 5]) {
      expect(STATUS_CONFIG[status as TaskStatus]).toBeDefined();
      expect(STATUS_CONFIG[status as TaskStatus].label).toBeTruthy();
    }
  });
});

describe("ABI consistency", () => {
  it("primary AGENT_REGISTRY_ABI has registerAgent with asn param", () => {
    const registerFn = AGENT_REGISTRY_ABI.find((s: string) =>
      s.includes("function registerAgent(")
    );
    expect(registerFn).toBeDefined();
    expect(registerFn).toContain("string asn");
  });

  it("TASK_BOARD_ABI has postTask function", () => {
    const postFn = TASK_BOARD_ABI.find((s: string) =>
      s.includes("function postTask(")
    );
    expect(postFn).toBeDefined();
  });

  it("primary AGENT_REGISTRY_ABI has getAgentByASN", () => {
    const fn = AGENT_REGISTRY_ABI.find((s: string) =>
      s.includes("function getAgentByASN(")
    );
    expect(fn).toBeDefined();
  });
});
