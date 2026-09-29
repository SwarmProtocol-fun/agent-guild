/**
 * Mod runtime (server) — loads mods lazily, gives each a permission-gated
 * context, dispatches HTTP routes and core events.
 *
 * Isolation rule: a mod that throws (in setup, an event handler, or a route)
 * is logged and contained; it never breaks core or other mods.
 */
import type {
  EventName, ModAgentIdentity, ModContext, ModManifest, ModSession, RouteContext, ServerMod, SwarmEventMap,
} from "@swarm/sdk";
import { MOD_MANIFESTS } from "./generated/manifests";
import { serverMods } from "./generated/server";
import { matchRoute } from "./router";

interface LoadedMod {
  manifest: ModManifest;
  mod: ServerMod | null;
  ctx: ModContext;
  error?: string;
}

// Survive dev-server HMR so setup() doesn't re-run and subscriptions don't double up.
const g = globalThis as unknown as { __swarmMods?: Map<string, Promise<LoadedMod>> };
const cache = (g.__swarmMods ??= new Map());

export function listManifests(): ModManifest[] {
  return MOD_MANIFESTS;
}

function makeLogger(modId: string) {
  const tag = `[mod:${modId}]`;
  return {
    info: (...a: unknown[]) => console.log(tag, ...a),
    warn: (...a: unknown[]) => console.warn(tag, ...a),
    error: (...a: unknown[]) => console.error(tag, ...a),
  };
}

function makeContext(manifest: ModManifest): ModContext {
  return {
    modId: manifest.id,
    log: makeLogger(manifest.id),
    async emit(event, payload) {
      if (!manifest.permissions.includes("events:emit")) {
        throw new Error(`Mod "${manifest.id}" lacks the "events:emit" permission`);
      }
      await emitEvent(event, payload);
    },
  };
}

export function loadMod(modId: string): Promise<LoadedMod | null> {
  const manifest = MOD_MANIFESTS.find((m) => m.id === modId);
  if (!manifest) return Promise.resolve(null);
  let p = cache.get(modId);
  if (!p) {
    p = (async (): Promise<LoadedMod> => {
      const ctx = makeContext(manifest);
      const loader = serverMods[modId];
      if (!loader) return { manifest, mod: null, ctx }; // client-only mod
      try {
        const mod = (await loader()).default;
        await mod.setup?.(ctx);
        return { manifest, mod, ctx };
      } catch (err) {
        ctx.log.error("failed to load:", err);
        return { manifest, mod: null, ctx, error: err instanceof Error ? err.message : String(err) };
      }
    })();
    cache.set(modId, p);
  }
  return p;
}

/** Deliver a core/mod event to every subscribed mod. Never throws. */
export async function emitEvent<E extends EventName>(event: E, payload: SwarmEventMap[E]): Promise<void> {
  await Promise.all(
    MOD_MANIFESTS.filter((m) => m.entry.server).map(async (manifest) => {
      const loaded = await loadMod(manifest.id);
      const handler = loaded?.mod?.events?.[event] as
        | ((p: SwarmEventMap[E], c: ModContext) => void | Promise<void>)
        | undefined;
      if (!loaded || !handler) return;
      if (!manifest.permissions.includes("events:subscribe")) {
        loaded.ctx.log.warn(`subscribes to "${event}" but lacks "events:subscribe" — ignored`);
        return;
      }
      try {
        await handler(payload, loaded.ctx);
      } catch (err) {
        loaded.ctx.log.error(`handler for "${event}" threw:`, err);
      }
    }),
  );
}

/**
 * Dispatch /api/mods/<modId>/<path…>.
 *
 * A request is authenticated either by a browser `session`, or by `agent` —
 * a per-agent Ed25519 signature verified via auth-guard.ts's
 * requireAgentAuth (the same mechanism /api/v1/credit/task-complete and
 * /api/v1/work-mode already trust for headless callers). Unlike a shared
 * service secret, a compromised agent key only compromises that one agent.
 */
export async function handleModRequest(
  modId: string,
  req: Request,
  path: string[],
  session: ModSession | null,
  agent: ModAgentIdentity | null = null,
): Promise<Response> {
  const loaded = await loadMod(modId);
  if (!loaded) return Response.json({ error: "Mod not found" }, { status: 404 });
  if (!loaded.mod) {
    return Response.json({ error: loaded.error ? "Mod failed to load" : "Mod has no server" }, { status: 503 });
  }

  const match = matchRoute(loaded.mod.routes ?? {}, req.method, path);
  if (!match) return Response.json({ error: "Not found" }, { status: 404 });

  const isPublic = typeof match.def !== "function" && match.def.public === true;
  if (!isPublic && !session && !agent) return Response.json({ error: "Authentication required" }, { status: 401 });

  const handler = typeof match.def === "function" ? match.def : match.def.handler;
  const ctx: RouteContext = { ...loaded.ctx, params: match.params, session, agent };
  try {
    const result = await handler(req, ctx);
    return result instanceof Response ? result : Response.json(result ?? null);
  } catch (err) {
    ctx.log.error(`${req.method} /${path.join("/")} threw:`, err);
    return Response.json({ error: "Mod error" }, { status: 500 });
  }
}
