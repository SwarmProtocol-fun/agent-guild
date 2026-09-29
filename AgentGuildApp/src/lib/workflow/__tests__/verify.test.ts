import { describe, it, expect } from "vitest";
import { checkAndRecordNonce, isTimestampFresh } from "@/app/api/v1/verify";

describe("isTimestampFresh", () => {
  it("accepts a timestamp within the window", () => {
    expect(isTimestampFresh(Date.now())).toBe(true);
    expect(isTimestampFresh(Date.now() - 60_000)).toBe(true); // 1 min ago
  });

  it("rejects a stale timestamp", () => {
    expect(isTimestampFresh(Date.now() - 3 * 60_000)).toBe(false); // 3 min ago
  });

  it("rejects a future timestamp beyond window", () => {
    expect(isTimestampFresh(Date.now() + 3 * 60_000)).toBe(false);
  });

  it("accepts a custom window", () => {
    expect(isTimestampFresh(Date.now() - 4 * 60_000, 5 * 60_000)).toBe(true);
    expect(isTimestampFresh(Date.now() - 6 * 60_000, 5 * 60_000)).toBe(false);
  });
});

describe("checkAndRecordNonce", () => {
  it("accepts a new nonce", () => {
    const sig = "unique-sig-" + Math.random();
    expect(checkAndRecordNonce(sig)).toBe(true);
  });

  it("rejects a replayed nonce", () => {
    const sig = "replay-test-sig-" + Math.random();
    expect(checkAndRecordNonce(sig)).toBe(true);
    expect(checkAndRecordNonce(sig)).toBe(false); // replay
  });

  it("accepts different signatures", () => {
    expect(checkAndRecordNonce("sig-a-" + Math.random())).toBe(true);
    expect(checkAndRecordNonce("sig-b-" + Math.random())).toBe(true);
    expect(checkAndRecordNonce("sig-c-" + Math.random())).toBe(true);
  });
});
