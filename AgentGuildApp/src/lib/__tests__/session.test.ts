import { describe, it, expect } from "vitest";
import { resolveRole, hasMinimumRole } from "../session";

describe("resolveRole", () => {
  it("returns platform_admin for a wallet in PLATFORM_ADMIN_WALLETS", () => {
    // resolveRole checks against the PLATFORM_ADMIN_WALLETS env var.
    // Without it set, no wallet is admin — falls through to org check.
    const role = resolveRole("0xabc123", []);
    expect(role).toBe("operator");
  });

  it("returns org_admin when wallet owns at least one org", () => {
    const role = resolveRole("0xabc123", ["org-1"]);
    expect(role).toBe("org_admin");
  });

  it("returns org_admin when wallet owns multiple orgs", () => {
    const role = resolveRole("0xabc123", ["org-1", "org-2"]);
    expect(role).toBe("org_admin");
  });

  it("returns operator when wallet owns no orgs", () => {
    const role = resolveRole("0xabc123", []);
    expect(role).toBe("operator");
  });

  it("is case-insensitive for wallet address comparison", () => {
    const lower = resolveRole("0xabc123", ["org-1"]);
    const upper = resolveRole("0xABC123", ["org-1"]);
    expect(lower).toBe(upper);
  });
});

describe("hasMinimumRole", () => {
  it("platform_admin >= platform_admin", () => {
    expect(hasMinimumRole("platform_admin", "platform_admin")).toBe(true);
  });

  it("platform_admin >= org_admin", () => {
    expect(hasMinimumRole("platform_admin", "org_admin")).toBe(true);
  });

  it("platform_admin >= operator", () => {
    expect(hasMinimumRole("platform_admin", "operator")).toBe(true);
  });

  it("org_admin >= org_admin", () => {
    expect(hasMinimumRole("org_admin", "org_admin")).toBe(true);
  });

  it("org_admin >= operator", () => {
    expect(hasMinimumRole("org_admin", "operator")).toBe(true);
  });

  it("org_admin < platform_admin", () => {
    expect(hasMinimumRole("org_admin", "platform_admin")).toBe(false);
  });

  it("operator >= operator", () => {
    expect(hasMinimumRole("operator", "operator")).toBe(true);
  });

  it("operator < org_admin", () => {
    expect(hasMinimumRole("operator", "org_admin")).toBe(false);
  });

  it("operator < platform_admin", () => {
    expect(hasMinimumRole("operator", "platform_admin")).toBe(false);
  });
});
