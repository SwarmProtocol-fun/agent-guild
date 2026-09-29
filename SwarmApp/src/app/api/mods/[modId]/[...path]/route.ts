/**
 * /api/mods/<modId>/<path…> — mounts each mod's server routes.
 * Signed-in users only, unless the mod declares a route `public: true` — OR
 * a headless agent authenticates itself with its own Ed25519 signature
 * (?agent=<id>&sig=<sig>&ts=<ts>, signed over "METHOD:/mods/<modId>/<path>:<ts>"),
 * the same mechanism /api/v1/credit/task-complete already trusts.
 */
import type { NextRequest } from "next/server";
import { validateSession } from "@/lib/session";
import { handleModRequest } from "@/lib/mods/runtime";
import { requireAgentAuth } from "@/lib/auth-guard";

type Ctx = { params: Promise<{ modId: string; path: string[] }> };

async function dispatch(req: NextRequest, { params }: Ctx) {
  const { modId, path } = await params;
  let session = null;
  try {
    const s = await validateSession();
    if (s) session = { address: s.sub, role: s.role };
  } catch {
    // Session store unavailable → treat as signed out (public routes still work).
  }

  let agent = null;
  if (!session) {
    const signedMessagePrefix = `${req.method}:/mods/${modId}/${path.join("/")}`;
    const auth = await requireAgentAuth(req, signedMessagePrefix);
    if (auth.ok && auth.agent) {
      agent = { agentId: auth.agent.agentId, orgId: auth.agent.orgId, agentType: auth.agent.agentType };
    }
  }

  return handleModRequest(modId, req, path, session, agent);
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
