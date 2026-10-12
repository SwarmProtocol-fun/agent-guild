import { describe, expect, it, vi } from "vitest";

// The server module pulls in Firestore and the model driver; GET /agent/tools touches neither.
vi.mock("@/lib/assignments", () => ({}));
vi.mock("@/lib/firestore-admin", () => ({}));
vi.mock("../../../../mods/dimos-bench/store", () => ({}));
vi.mock("../../../../mods/dimos-bench/trainer", () => ({ canDrive: () => false, DRIVER_MODEL: "x" }));

const mod = (await import("../../../../mods/dimos-bench/server")).default;

type Tool = { name: string; method: string; path: string; input_schema: { required?: string[] } };
type Handler = (req: Request, ctx: unknown) => Response | Promise<Response>;

function route(key: string): { handler: Handler; public?: boolean } {
  const def = mod.routes![key] as Handler | { handler: Handler; public?: boolean };
  return typeof def === "function" ? { handler: def } : def;
}

async function tools(): Promise<Tool[]> {
  const ctx = { modId: "dimos-bench", log: { info() {}, warn() {}, error() {} }, emit: async () => {}, params: {}, session: null, agent: null };
  const res = await route("GET /agent/tools").handler(new Request("http://x/"), ctx);
  return (await res.json()).tools;
}

describe("dimos-bench GET /agent/tools", () => {
  it("is public, so guild_mod_tools works before any agent auth", () => {
    expect(route("GET /agent/tools").public).toBe(true);
  });

  it("lists the DimSim drive tools", async () => {
    const names = (await tools()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["dimos_sim_observe", "dimos_sim_act", "dimos_sim_lesson"]));
  });

  it("every tool points at a route the mod serves", async () => {
    for (const t of await tools()) {
      const key = `${t.method} /${t.path.replace(/\{(\w+)\}/g, ":$1")}`;
      expect(mod.routes, `${t.name} → ${key}`).toHaveProperty([key]);
    }
  });

  it("act requires the episode and the seq it answers", async () => {
    const act = (await tools()).find((t) => t.name === "dimos_sim_act")!;
    expect(act.input_schema.required).toEqual(["episodeId", "seq"]);
  });
});
