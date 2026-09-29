/**
 * Swarm Mod SDK — the public contract between core and mods.
 *
 * Mods import from "@swarm/sdk". Core owns this file; changing it is an
 * API change (bump SWARM_API_VERSION). A mod is a folder in `mods/<id>/`:
 *
 *   swarm.mod.json   manifest (id, permissions, panels, entry files)
 *   server.ts        default export: defineServerMod({ routes, events, setup })
 *   client.tsx       default export: defineClientMod({ panels })
 *
 * Trust model: mods are trusted, in-process code that an operator reviews and
 * installs (like Unity packages / Unreal plugins). Declared permissions gate
 * the host APIs handed to a mod via `ctx`, and a throwing mod never takes
 * down core — but this is NOT a security sandbox against hostile code.
 */
import type { ComponentType } from "react";
import permissions from "./permissions.json";

export const SWARM_API_VERSION = 1;

export type Permission = keyof typeof permissions;
export const PERMISSIONS = Object.keys(permissions) as Permission[];

// ── Manifest (swarm.mod.json) ────────────────────────────────────────────

export interface PanelDecl {
  /** Unique within the mod; becomes the route /mods/<modId>/<id>. */
  id: string;
  title: string;
  /** lucide-react icon name shown in the sidebar (falls back to Puzzle). */
  icon?: string;
}

export interface ModManifest {
  /** kebab-case, must equal the folder name. */
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** SWARM_API_VERSION this mod was written against. */
  swarmApi: number;
  permissions: Permission[];
  /** Paths relative to the mod folder, extension optional. */
  entry: { client?: string; server?: string };
  panels?: PanelDecl[];
}

// ── Events (extend via declaration merging) ──────────────────────────────

/**
 * Core events. Mods can add their own for other mods:
 *
 *   declare module "@swarm/sdk" {
 *     interface SwarmEventMap { "my-mod.thing": { id: string } }
 *   }
 */
export interface SwarmEventMap {
  "auth.login": { address: string; role: string };
}

export type EventName = keyof SwarmEventMap & string;

// ── Server side ──────────────────────────────────────────────────────────

export interface ModLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ModContext {
  modId: string;
  log: ModLogger;
  /** Requires "events:emit". */
  emit<E extends EventName>(event: E, payload: SwarmEventMap[E]): Promise<void>;
}

export interface ModSession {
  address: string;
  role: "operator" | "org_admin" | "platform_admin";
}

/** A headless agent authenticated via its own Ed25519 keypair (see auth-guard.ts's requireAgentAuth) rather than a browser session. */
export interface ModAgentIdentity {
  agentId: string;
  orgId: string;
  agentType: string;
}

export interface RouteContext extends ModContext {
  /** `:name` segments from the route pattern. */
  params: Record<string, string>;
  /** Null unless a signed-in browser session made this request. */
  session: ModSession | null;
  /** Null unless the request carried a valid Ed25519 agent signature (?agent=&sig=&ts=). Routes should trust this over any agentId/orgId in the body. */
  agent: ModAgentIdentity | null;
}

/** Return a Response, or any JSON-serialisable value (sent as 200 JSON). */
export type RouteHandler = (req: Request, ctx: RouteContext) => Response | unknown | Promise<Response | unknown>;

export type RouteDef = RouteHandler | { public?: boolean; handler: RouteHandler };

export interface ServerMod {
  /** "METHOD /path/:param" → handler, mounted at /api/mods/<modId>/… (signed-in users only unless `public`). */
  routes?: Record<string, RouteDef>;
  /** Event subscriptions. Requires "events:subscribe". */
  events?: { [E in EventName]?: (payload: SwarmEventMap[E], ctx: ModContext) => void | Promise<void> };
  /** Runs once when the mod loads. */
  setup?(ctx: ModContext): void | Promise<void>;
}

export function defineServerMod(mod: ServerMod): ServerMod {
  return mod;
}

// ── Client side ──────────────────────────────────────────────────────────

export interface PanelProps {
  modId: string;
  /** Signed-in wallet address. */
  address: string | null;
  /** Helper for calling this mod's own API routes. */
  api: (path: string, init?: RequestInit) => Promise<Response>;
}

export interface ClientMod {
  /** panel id (declared in the manifest) → React component. */
  panels?: Record<string, ComponentType<PanelProps>>;
}

export function defineClientMod(mod: ClientMod): ClientMod {
  return mod;
}
