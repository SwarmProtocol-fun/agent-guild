/**
 * The middleware is the only thing allowed to set the session headers route
 * handlers trust (x-wallet-address, x-session-role, …). It used to skip every
 * path containing a "." before stripping them, so /api/memory/x/daily/2026.10.05
 * reached the handler with a client-forged x-session-role: platform_admin.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { NextRequest } from "next/server";

beforeAll(() => {
  process.env.SESSION_SECRET = "x".repeat(32);
});

const FORGED = {
  "x-wallet-address": "0xattacker",
  "x-session-role": "platform_admin",
  "x-session-address": "0xattacker",
  "x-session-id": "forged",
};

/** Headers the route handler will receive, per Next's middleware override protocol. */
function forwardedHeaders(res: Response): Record<string, string | null> | null {
  const override = res.headers.get("x-middleware-override-headers");
  if (override === null) return null; // raw client headers pass through untouched
  const out: Record<string, string | null> = {};
  for (const name of override.split(",").filter(Boolean)) {
    out[name] = res.headers.get(`x-middleware-request-${name}`);
  }
  return out;
}

async function run(path: string) {
  const { middleware } = await import("../middleware");
  return middleware(new NextRequest(`https://agent-guild.com${path}`, { method: "GET", headers: FORGED }));
}

describe("middleware session-header sanitizing", () => {
  it.each([
    "/api/memory/agent123/daily/2026.10.05",
    "/api/admin/credit-policy/org/x.y",
    "/api/v1/credit",
  ])("strips forged session headers on %s", async (path) => {
    const fwd = forwardedHeaders(await run(path));
    expect(fwd).not.toBeNull();
    for (const h of Object.keys(FORGED)) expect(fwd![h] ?? null).toBeNull();
  });

  it("strips forged session headers on static asset paths too", async () => {
    const fwd = forwardedHeaders(await run("/robots.txt"));
    expect(fwd).not.toBeNull();
    for (const h of Object.keys(FORGED)) expect(fwd![h] ?? null).toBeNull();
  });
});
