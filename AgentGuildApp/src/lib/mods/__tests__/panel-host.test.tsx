import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { Suspense } from "react";

vi.mock("@/hooks/useAuthAddress", () => ({ useAuthAddress: () => "0xabc" }));
vi.mock("@/lib/mods/generated/manifests", () => ({
  MOD_MANIFESTS: [{
    id: "demo", name: "Demo", version: "1.0.0", agentGuildApi: 1, permissions: [],
    entry: { client: "./client" }, panels: [{ id: "main", title: "Main" }, { id: "ghost", title: "Ghost" }],
  }],
}));
vi.mock("@/lib/mods/generated/client", () => ({
  clientMods: {
    demo: async () => ({
      default: {
        panels: {
          main: ({ modId, address, api }: { modId: string; address: string | null; api: (p: string) => Promise<Response> }) => {
            void api("stats");
            return <div>panel {modId} for {address}</div>;
          },
        },
      },
    }),
  },
}));

import ModPanelPage from "../../../app/(dashboard)/mods/[modId]/[panelId]/page";

// use(params) suspends once even for a resolved promise, so render inside an awaited act().
const renderPanel = async (modId: string, panelId: string) => {
  const params = Promise.resolve({ modId, panelId });
  await act(async () => {
    render(<Suspense fallback="suspended"><ModPanelPage params={params} /></Suspense>);
  });
};

describe("mod panel host", () => {
  it("renders the mod's panel with modId, address and a mod-scoped api()", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await renderPanel("demo", "main");
    expect(await screen.findByText("panel demo for 0xabc")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith("/api/mods/demo/stats", expect.objectContaining({ credentials: "include" }));
  });

  it("explains a panel that's declared but not exported", async () => {
    await renderPanel("demo", "ghost");
    await waitFor(() => expect(screen.getByText(/doesn't export it/)).toBeInTheDocument());
  });

  it("handles unknown panels", async () => {
    await renderPanel("demo", "nope");
    expect(await screen.findByText(/No such mod panel/)).toBeInTheDocument();
  });
});
