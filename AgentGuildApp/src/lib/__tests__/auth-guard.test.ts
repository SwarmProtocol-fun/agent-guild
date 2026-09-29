import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { requirePlatformAdmin } from "../auth-guard";

// auth-guard reads PLATFORM_ADMIN_WALLETS once at module load, so the env var
// must be set before the import above is evaluated.
vi.hoisted(() => {
  process.env.PLATFORM_ADMIN_WALLETS = "0x723708273e811a07d90d2e81e799b9Ab27F0B549";
});

// Mock the imports that auth-guard pulls in (Firestore, verify, etc.)
vi.mock("@/app/api/v1/verify", () => ({
  verifyAgentRequest: vi.fn(),
  isTimestampFresh: vi.fn(),
}));
vi.mock("@/app/api/webhooks/auth", () => ({
  authenticateAgent: vi.fn(),
}));
vi.mock("@/lib/firestore", () => ({
  getOrganization: vi.fn(),
}));

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  const req = new NextRequest("https://example.com/api/test", {
    headers: new Headers(headers),
  });
  return req;
}

describe("requirePlatformAdmin", () => {
  const ADMIN_ADDRESS = "0x723708273e811a07d90d2e81e799b9Ab27F0B549".toLowerCase();

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("grants access when x-session-role is platform_admin", () => {
    const req = makeRequest({ "x-session-role": "platform_admin" });
    expect(requirePlatformAdmin(req)).toEqual({ ok: true });
  });

  it("grants access when x-wallet-address is listed in PLATFORM_ADMIN_WALLETS", () => {
    const req = makeRequest({
      "x-wallet-address": "0x723708273e811a07d90d2e81e799b9Ab27F0B549",
    });
    expect(requirePlatformAdmin(req)).toEqual({ ok: true });
  });

  it("grants access with case-insensitive wallet address", () => {
    const req = makeRequest({
      "x-wallet-address": ADMIN_ADDRESS.toUpperCase(),
    });
    // The check lowercases the header value
    expect(requirePlatformAdmin(req)).toEqual({ ok: true });
  });

  it("grants access when x-platform-secret matches env secret", () => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "my-secret-123");
    const req = makeRequest({ "x-platform-secret": "my-secret-123" });
    expect(requirePlatformAdmin(req)).toEqual({ ok: true });
  });

  it("grants access via Authorization Bearer token", () => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "my-secret-123");
    const req = makeRequest({ authorization: "Bearer my-secret-123" });
    expect(requirePlatformAdmin(req)).toEqual({ ok: true });
  });

  it("denies access with wrong secret", () => {
    vi.stubEnv("PLATFORM_ADMIN_SECRET", "my-secret-123");
    const req = makeRequest({ "x-platform-secret": "wrong-secret" });
    const result = requirePlatformAdmin(req);
    expect(result.ok).toBe(false);
  });

  it("denies access with no credentials", () => {
    const req = makeRequest();
    const result = requirePlatformAdmin(req);
    expect(result.ok).toBe(false);
  });

  it("denies access for non-admin wallet", () => {
    const req = makeRequest({
      "x-wallet-address": "0x1234567890abcdef1234567890abcdef12345678",
      "x-session-role": "operator",
    });
    const result = requirePlatformAdmin(req);
    expect(result.ok).toBe(false);
  });
});
