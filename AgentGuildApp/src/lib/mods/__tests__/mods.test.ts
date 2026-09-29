import { describe, it, expect, vi, beforeEach } from "vitest";
import { matchRoute, parseRouteKey } from "../router";
import { validateManifest } from "../../../../scripts/sync-mods.mjs";

describe("router", () => {
  it("parses route keys", () => {
    expect(parseRouteKey("GET /a/:id")).toEqual({ method: "GET", segments: ["a", ":id"] });
    expect(parseRouteKey("FETCH /a")).toBeNull();
    expect(parseRouteKey("GET a")).toBeNull();
  });

  it("matches params, method and length", () => {
    const h = () => 1;
    const routes = { "GET /items/:id": h, "POST /items": h };
    expect(matchRoute(routes, "GET", ["items", "a%20b"])?.params).toEqual({ id: "a b" });
    expect(matchRoute(routes, "POST", ["items"])).not.toBeNull();
    expect(matchRoute(routes, "GET", ["items"])).toBeNull();
    expect(matchRoute(routes, "DELETE", ["items", "1"])).toBeNull();
  });
});

describe("manifest validation", () => {
  const ok = {
    id: "demo", name: "Demo", version: "1.0.0", agentGuildApi: 1, permissions: [],
    entry: { server: "./server" }, panels: [],
  };
  it("accepts a valid manifest", () => expect(validateManifest(ok, "demo", null)).toEqual([]));
  it("rejects id/folder mismatch, bad api, unknown permission", () => {
    const errs = validateManifest({ ...ok, agentGuildApi: 2, permissions: ["root"] }, "other", null).join(" | ");
    expect(errs).toMatch(/must equal folder name/);
    expect(errs).toMatch(/agentGuildApi must be 1/);
    expect(errs).toMatch(/unknown permission "root"/);
  });
  it("requires client entry for panels", () => {
    expect(validateManifest({ ...ok, panels: [{ id: "p", title: "P" }] }, "demo", null).join()).toMatch(/panels require entry.client/);
  });
});

describe("runtime isolation", () => {
  beforeEach(() => { vi.resetModules(); (globalThis as { __agentGuildMods?: unknown }).__agentGuildMods = undefined; });

  async function runtimeWith(mods: Record<string, unknown>, permissions: string[] = ["events:subscribe"]) {
    vi.doMock("../generated/manifests", () => ({
      MOD_MANIFESTS: Object.keys(mods).map((id) => ({ id, name: id, version: "1.0.0", agentGuildApi: 1, permissions, entry: { server: "./server" } })),
    }));
    vi.doMock("../generated/server", () => ({
      serverMods: Object.fromEntries(Object.entries(mods).map(([id, m]) => [id, async () => ({ default: m })])),
    }));
    return import("../runtime");
  }

  it("a throwing event handler doesn't stop other mods", async () => {
    const good = vi.fn();
    const rt = await runtimeWith({
      bad: { events: { "auth.login": () => { throw new Error("boom"); } } },
      good: { events: { "auth.login": good } },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(rt.emitEvent("auth.login", { address: "0x1", role: "operator" })).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledOnce();
  });

  it("ignores subscriptions without the permission", async () => {
    const h = vi.fn();
    const rt = await runtimeWith({ m: { events: { "auth.login": h } } }, []);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await rt.emitEvent("auth.login", { address: "0x1", role: "operator" });
    expect(h).not.toHaveBeenCalled();
  });

  it("requires a session unless the route is public; contains handler errors", async () => {
    const rt = await runtimeWith({
      m: { routes: { "GET /priv": () => ({ ok: 1 }), "GET /pub": { public: true, handler: () => ({ ok: 2 }) }, "GET /boom": () => { throw new Error("x"); } } },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const get = (p: string, s: { address: string; role: "operator" } | null) => rt.handleModRequest("m", new Request("http://x/" + p), [p], s);
    expect((await get("priv", null)).status).toBe(401);
    expect((await get("priv", { address: "0x1", role: "operator" })).status).toBe(200);
    expect(await (await get("pub", null)).json()).toEqual({ ok: 2 });
    expect((await get("boom", { address: "0x1", role: "operator" })).status).toBe(500);
    expect((await get("nope", { address: "0x1", role: "operator" })).status).toBe(404);
  });

  it("a mod whose setup throws reports 503 and doesn't crash", async () => {
    const rt = await runtimeWith({ m: { setup: () => { throw new Error("nope"); }, routes: { "GET /a": () => 1 } } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await rt.handleModRequest("m", new Request("http://x/a"), ["a"], { address: "0x1", role: "operator" })).status).toBe(503);
  });
});
