/**
 * Credit & Lending merge — the agent credit view renders as a panel (no compute
 * billing), /analytics/credit redirects to /lending?tab=credit, and the sidebar
 * has a single "Credit & Lending" entry.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({ redirect: vi.fn(), org: { currentOrg: { id: "org1" } } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  redirect: m.redirect,
}));
vi.mock("@/contexts/OrgContext", () => ({ useOrg: () => m.org }));
vi.mock("@/contexts/SessionContext", () => ({ useSession: () => ({}) }));
vi.mock("@/contexts/SkinContext", () => ({ useSkin: () => ({}) }));
vi.mock("@/lib/firebase", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: vi.fn(async () => ({
    docs: [
      { id: "a1", data: () => ({ name: "Alpha", type: "worker", status: "online", creditScore: 780, trustScore: 60 }) },
      { id: "a2", data: () => ({ name: "Beta", type: "worker", status: "online", creditScore: 500, trustScore: 40 }) },
    ],
  })),
}));

describe("AgentCreditPanel", () => {
  it("shows agent credit without compute billing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { AgentCreditPanel } = await import("@/components/credit/agent-credit-panel");
    render(<AgentCreditPanel />);
    await waitFor(() => expect(screen.getByText("Tier Distribution")).toBeTruthy());
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);
    expect(screen.getByText("640")).toBeTruthy(); // avg credit
    expect(screen.queryByText(/Compute/i)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("/analytics/credit", () => {
  it("redirects to the Credit tab of /lending", async () => {
    const { default: Page } = await import("@/app/(dashboard)/analytics/credit/page");
    Page();
    expect(m.redirect).toHaveBeenCalledWith("/lending?tab=credit");
  });
});

describe("sidebar", () => {
  it("has one Credit & Lending entry", async () => {
    const { DEFAULT_SECTIONS } = await import("@/components/sidebar");
    const items = DEFAULT_SECTIONS.flatMap((s) => s.items);
    expect(items.find((i) => i.id === "credit")).toBeUndefined();
    expect(items.find((i) => i.id === "lending")).toMatchObject({ href: "/lending", label: "Credit & Lending" });
  });
});
