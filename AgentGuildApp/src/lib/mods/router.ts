/** Route matching for mod servers: "METHOD /path/:param" keys. Pure, no Next imports. */
import type { RouteDef } from "@agent-guild/sdk";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof METHODS)[number];

export function isHttpMethod(m: string): m is HttpMethod {
  return (METHODS as readonly string[]).includes(m);
}

/** Parse "GET /items/:id" → { method, segments }; null if malformed. */
export function parseRouteKey(key: string): { method: HttpMethod; segments: string[] } | null {
  const [method, path, ...rest] = key.trim().split(/\s+/);
  if (rest.length || !path || !path.startsWith("/") || !isHttpMethod(method)) return null;
  return { method, segments: path.split("/").filter(Boolean) };
}

export function matchRoute(
  routes: Record<string, RouteDef>,
  method: string,
  path: string[],
): { def: RouteDef; params: Record<string, string> } | null {
  for (const [key, def] of Object.entries(routes)) {
    const parsed = parseRouteKey(key);
    if (!parsed || parsed.method !== method || parsed.segments.length !== path.length) continue;
    const params: Record<string, string> = {};
    const ok = parsed.segments.every((seg, i) => {
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = decodeURIComponent(path[i]);
        return true;
      }
      return seg === path[i];
    });
    if (ok) return { def, params };
  }
  return null;
}
