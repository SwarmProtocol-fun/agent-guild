// @vitest-environment node
/** Hidden-until-tested features: no sidebar entry, no marketplace listing, pages redirect. */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { isHiddenRoute, HIDDEN_NAV_IDS } from "@/lib/hidden-features";

vi.mock("@/lib/session-revocation", () => ({
  isSessionRevoked: async () => false,
  revokeSessionId: async () => {},
}));
// The sidebar's contexts pull in wallet SDKs; only its static nav model is under test.
vi.mock("@/contexts/OrgContext", () => ({ useOrg: () => ({}) }));
vi.mock("@/contexts/SessionContext", () => ({ useSession: () => ({}) }));
vi.mock("@/contexts/SkinContext", () => ({ useSkin: () => ({}) }));

beforeAll(() => {
  process.env.SESSION_SECRET = "x".repeat(32);
});

describe("isHiddenRoute", () => {
  it("matches hidden prefixes on whole path segments", () => {
    for (const p of ["/discover", "/discover/abc", "/compute", "/compute/computers/x", "/mods/opengym/gym", "/market/opengym"]) {
      expect(isHiddenRoute(p), p).toBe(true);
    }
    for (const p of ["/dashboard", "/computers", "/discovery", "/mods/hyperliquid-trading/x", "/market", "/market/opengym-x", "/directory"]) {
      expect(isHiddenRoute(p), p).toBe(false);
    }
  });
});

describe("middleware", () => {
  it("redirects hidden pages to /dashboard but leaves their APIs alone", async () => {
    const { middleware } = await import("../middleware");
    const page = await middleware(new NextRequest("http://localhost/compute/computers"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("http://localhost/dashboard");

    const api = await middleware(new NextRequest("http://localhost/api/compute/computers"));
    expect(api.headers.get("location")).toBeNull();
  });
});

describe("sidebar", () => {
  it("drops hidden nav items and the openGym mod", async () => {
    const { DEFAULT_SECTIONS } = await import("@/components/sidebar");
    const ids = DEFAULT_SECTIONS.flatMap((s) => s.items.map((i) => i.id));
    for (const id of HIDDEN_NAV_IDS) expect(ids).not.toContain(id);
    expect(ids.some((id) => id.includes("opengym"))).toBe(false);
    expect(ids).toContain("agents");
  });
});
