# Swarm Mod SDK

Swarm is a workspace (the "editor"); mods are packages you add on top — like Unity packages or Unreal plugins. Core owns a small, versioned contract (`@swarm/sdk`); everything else is a mod.

## Install a mod

Drop the folder into `SwarmApp/mods/` and restart `npm run dev` (or run `npm run mods:sync`). `npm run build` runs the same sync and **fails on any invalid mod**.

> Mods are bundled at build time (Next.js), so installing = add folder + rebuild, not a hot plug at runtime.

## Anatomy

```
mods/my-mod/
  swarm.mod.json   manifest
  server.ts        optional — routes, event handlers, setup
  client.tsx       optional — UI panels
```

```json
{
  "id": "my-mod",                       // kebab-case, must equal the folder name
  "name": "My Mod",
  "version": "1.0.0",
  "swarmApi": 1,                        // SDK version you built against
  "permissions": ["events:subscribe"],
  "entry": { "client": "./client", "server": "./server" },
  "panels": [{ "id": "main", "title": "My Mod", "icon": "Sparkles" }]
}
```

`icon` is a lucide name from the sidebar's icon map (`Link, Coins, Zap, Palette, Brain, Megaphone, Wrench, Plug, Puzzle, Sparkles, Bot, ShieldAlert, Monitor, DollarSign, Diamond, Shield, Database`); anything else falls back to `Puzzle`.

## Extension points

| Point | Where | What it does |
|-------|-------|--------------|
| **Panels** | `client.tsx` → `defineClientMod({ panels })` | Page at `/mods/<id>/<panelId>` + sidebar entry under **Mods**. Gets `{ modId, address, api }`; `api("stats")` calls `/api/mods/<id>/stats`. |
| **Routes** | `server.ts` → `routes` | `"GET /items/:id": (req, ctx) => …` mounted at `/api/mods/<id>/…`. **Signed-in users only** unless `{ public: true, handler }`. Return a `Response` or any JSON value. |
| **Events** | `server.ts` → `events` | Subscribe to core events. Needs `events:subscribe`. Today: `auth.login`. Mods can add events via `SwarmEventMap` declaration merging and emit them with `ctx.emit` (needs `events:emit`). |
| **Setup** | `server.ts` → `setup(ctx)` | Runs once on first load. |

See `SwarmApp/mods/hello-world/` for a working example of each.

## Trust model — read this

Mods are **trusted, in-process code** that an operator reviews before installing, the same as an npm dependency. Declared permissions gate the host APIs a mod receives, and a mod that throws is logged and contained (it can't crash core or other mods, and gets a 500/503 from its own routes). **This is not a sandbox**: a hostile mod can read env vars and the filesystem. Don't install mods you haven't read. A real isolation boundary (workers/iframes, per-mod credentials) is future work.

## Validation

`scripts/sync-mods.mjs` checks: id format and folder match, semver, `swarmApi` equals the current version, known permissions only, entry files exist, panels have unique ids and require a client entry.

## Not built yet

Per-mod persistent storage, agent-skill registration, themes as mods, and third-party wallet adapters via the mod loader (adapters currently register in `src/lib/wallet/adapters`, see `wallet-adapters.md`).

## Relationship to marketplace "mods"

`docs/creating-mods.md` describes *marketplace listings* (behavioral prompt modifiers with a `ModManifest` of tools/workflows). Those are data records for the marketplace; **runtime mods** (this document) are code packages with a `swarm.mod.json`. They will converge — a marketplace listing will point at an installable runtime mod — but are separate today.
