/**
 * /api/mods/<modId>/<path…> — mounts each mod's server routes.
 * Signed-in users only, unless the mod declares a route `public: true`.
 */
import { validateSession } from "@/lib/session";
import { handleModRequest } from "@/lib/mods/runtime";

type Ctx = { params: Promise<{ modId: string; path: string[] }> };

async function dispatch(req: Request, { params }: Ctx) {
  const { modId, path } = await params;
  let session = null;
  try {
    const s = await validateSession();
    if (s) session = { address: s.sub, role: s.role };
  } catch {
    // Session store unavailable → treat as signed out (public routes still work).
  }
  return handleModRequest(modId, req, path, session);
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
