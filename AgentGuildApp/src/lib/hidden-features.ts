/**
 * Features hidden from the UI until they're fully working and tested.
 * Hidden pages redirect to /dashboard (middleware), drop out of the sidebar,
 * and hidden mods drop out of the marketplace. APIs are left untouched so
 * existing data and agents keep working. Remove an entry here to unhide it.
 */

/** Page route prefixes (whole path segments) that redirect to /dashboard. */
export const HIDDEN_ROUTE_PREFIXES = ["/discover", "/compute", "/mods/opengym", "/market/opengym"];

/** Marketplace / runtime mod ids hidden from the marketplace and sidebar. */
export const HIDDEN_MOD_IDS = new Set<string>(["opengym"]);

/** Sidebar nav item ids hidden from DEFAULT_SECTIONS and the admin section. */
export const HIDDEN_NAV_IDS = new Set<string>([
  "discover",
  "compute-overview",
  "compute-computers",
  "compute-workspaces",
  "admin-compute",
]);

export function isHiddenRoute(pathname: string): boolean {
  return HIDDEN_ROUTE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
