/**
 * Tests for the write-time secret redaction added to agent-memory-server.ts
 * (Context Vault PRD, Phase 1 — docs/PRD-Context-Vault.md §4.5).
 *
 * Only `redactBeforePersist` is under test here — it's the one new piece
 * of logic this change adds. The three call sites (updateWorkingMd,
 * appendMemoryMd, appendDailyNote) each do nothing but call it before
 * touching Firestore, so exercising the shared helper covers all three
 * without needing a Firestore Admin SDK mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redactBeforePersist } from "./agent-memory-server";

// Same obfuscation convention as secret-scanner.test.ts, to avoid tripping
// this repo's own secret scanning on the test file itself.
const FAKE_OPENAI = "sk-" + "abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKL";
const FAKE_GITHUB = "ghp_" + "abcdefghijklmnopqrstuvwxyz1234567890";

describe("redactBeforePersist", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    // vi.spyOn on an already-mocked console.warn reuses the same mock
    // instead of resetting it — restore explicitly so call counts don't
    // leak between tests.
    vi.restoreAllMocks();
  });

  it("returns clean content unchanged", () => {
    const clean = "Learned that the deploy target is Railway.";
    expect(redactBeforePersist(clean, "agent_1", "agent_1__memory_md")).toBe(clean);
  });

  it("redacts a secret before it would be persisted", () => {
    const raw = `My key is ${FAKE_OPENAI}`;
    const result = redactBeforePersist(raw, "agent_1", "agent_1__memory_md");
    expect(result).not.toContain(FAKE_OPENAI);
    expect(result).toContain("[REDACTED OpenAI API Key]");
  });

  it("redacts without persisting the raw value in the console log", () => {
    const raw = `Token: ${FAKE_GITHUB}`;
    redactBeforePersist(raw, "agent_1", "agent_1__working_md");

    expect(console.warn).toHaveBeenCalledTimes(1);
    const [, meta] = vi.mocked(console.warn).mock.calls[0];
    expect(JSON.stringify(meta)).not.toContain(FAKE_GITHUB);
    expect(meta).toMatchObject({
      agentId: "agent_1",
      docId: "agent_1__working_md",
      types: ["GitHub Token"],
    });
  });

  it("does not warn when content is clean", () => {
    redactBeforePersist("nothing sensitive here", "agent_1", "agent_1__daily_2026-09-28");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("dedupes repeated secret types in the logged type list", () => {
    const raw = `${FAKE_OPENAI} and again ${FAKE_OPENAI}`;
    redactBeforePersist(raw, "agent_1", "agent_1__memory_md");
    const [, meta] = vi.mocked(console.warn).mock.calls[0];
    expect(meta).toMatchObject({ types: ["OpenAI API Key"] });
  });
});
