import { describe, it, expect, beforeEach } from "vitest";
import { StubComputeProvider } from "../provider";
import type { ActionEnvelope } from "../types";

describe("StubComputeProvider", () => {
  let provider: StubComputeProvider;

  beforeEach(() => {
    provider = new StubComputeProvider();
  });

  it("has name 'stub'", () => {
    expect(provider.name).toBe("stub");
  });

  // ── createInstance ──

  it("createInstance returns a unique providerInstanceId", async () => {
    const a = await provider.createInstance({
      name: "test-a",
      sizeKey: "small",
      cpuCores: 2,
      ramMb: 4096,
      diskGb: 20,
      resolutionWidth: 1024,
      resolutionHeight: 768,
      region: "us-east",
      baseImage: "ubuntu:22.04",
      persistenceEnabled: false,
    });
    const b = await provider.createInstance({
      name: "test-b",
      sizeKey: "medium",
      cpuCores: 4,
      ramMb: 8192,
      diskGb: 50,
      resolutionWidth: 1920,
      resolutionHeight: 1080,
      region: "us-west",
      baseImage: "ubuntu:22.04",
      persistenceEnabled: true,
    });

    expect(a.providerInstanceId).toBeTruthy();
    expect(b.providerInstanceId).toBeTruthy();
    expect(a.providerInstanceId).not.toBe(b.providerInstanceId);
  });

  // ── Lifecycle methods (no-ops) ──

  it("startInstance resolves without error", async () => {
    await expect(provider.startInstance("fake-id")).resolves.toBeUndefined();
  });

  it("stopInstance resolves without error", async () => {
    await expect(provider.stopInstance("fake-id")).resolves.toBeUndefined();
  });

  it("restartInstance resolves without error", async () => {
    await expect(provider.restartInstance("fake-id")).resolves.toBeUndefined();
  });

  it("deleteInstance resolves without error", async () => {
    await expect(provider.deleteInstance("fake-id")).resolves.toBeUndefined();
  });

  // ── takeScreenshot ──

  it("takeScreenshot returns a placeholder URL", async () => {
    const result = await provider.takeScreenshot("fake-id");
    expect(result.url).toBeTruthy();
    expect(typeof result.url).toBe("string");
  });

  // ── executeAction ──

  it("executeAction returns success for any action type", async () => {
    const envelope: ActionEnvelope = {
      actionType: "click",
      targetComputerId: "comp-1",
      sessionId: "sess-1",
      actorType: "user",
      actorId: "user-1",
      payload: { x: 100, y: 200 },
      timeoutMs: 5000,
      idempotencyKey: "key-1",
    };

    const result = await provider.executeAction("fake-id", envelope);
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.data?.stub).toBe(true);
  });

  it("executeAction returns the action type in data", async () => {
    const envelope: ActionEnvelope = {
      actionType: "bash",
      targetComputerId: "comp-1",
      sessionId: "sess-1",
      actorType: "model",
      actorId: "claude",
      payload: { command: "ls -la" },
      timeoutMs: 10000,
      idempotencyKey: "key-2",
    };

    const result = await provider.executeAction("fake-id", envelope);
    expect(result.data?.actionType).toBe("bash");
  });

  // ── VNC / Terminal URLs ──

  it("getVncUrl returns empty string in stub mode", async () => {
    const url = await provider.getVncUrl("fake-id");
    expect(url).toBe("");
  });

  it("getTerminalUrl returns empty string in stub mode", async () => {
    const url = await provider.getTerminalUrl("fake-id");
    expect(url).toBe("");
  });

  // ── Snapshot / Clone ──

  it("createSnapshot returns a unique ID", async () => {
    const a = await provider.createSnapshot("fake-id", "snap-1");
    const b = await provider.createSnapshot("fake-id", "snap-2");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("cloneInstance returns a unique ID", async () => {
    const id = await provider.cloneInstance("fake-id", "clone-name");
    expect(id).toBeTruthy();
    expect(id).toContain("stub-");
  });
});
