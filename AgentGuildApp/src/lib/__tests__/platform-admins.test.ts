import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi } from "vitest";

describe("isPlatformAdmin", () => {
  it("matches listed EVM (any case) and Solana wallets", async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_PLATFORM_ADMIN_WALLETS =
      "0xF35c7725406E572a5F9E743A4f75B1d81d2F3D5A,Pip4XQcGH5j5j5RA3BJHftBJ8xy5SsWjKXLDnQg4ENV";
    const { isPlatformAdmin } = await import("../platform-admins");
    expect(isPlatformAdmin("0xf35c7725406e572a5f9e743a4f75b1d81d2f3d5a")).toBe(true);
    expect(isPlatformAdmin("0xF35c7725406E572a5F9E743A4f75B1d81d2F3D5A")).toBe(true);
    expect(isPlatformAdmin("Pip4XQcGH5j5j5RA3BJHftBJ8xy5SsWjKXLDnQg4ENV")).toBe(true);
    expect(isPlatformAdmin("0x0000000000000000000000000000000000000001")).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
  });

  it("reads NEXT_PUBLIC_ env as a literal access so Next inlines it client-side", () => {
    // A `typeof process` guard makes the bundler use the process polyfill and
    // skip inlining, which left the browser admin list empty in production.
    const src = readFileSync(join(__dirname, "../platform-admins.ts"), "utf8");
    expect(src).not.toMatch(/typeof process !==/);
    expect(src).toMatch(/process\.env\.NEXT_PUBLIC_PLATFORM_ADMIN_WALLETS/);
  });
});
