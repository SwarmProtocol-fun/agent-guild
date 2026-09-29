/**
 * /api/mods/<modId>/<path…> — mounts each mod's server routes.
 * Signed-in users only, unless the mod declares a route `public: true` — OR
 * a headless agent authenticates itself with its own Ed25519 signature
 * (?agent=<id>&sig=<sig>&ts=<ts>), the same mechanism /api/v1/credit/task-complete
 * and /api/v1/memory/* already trust. For requests with a body, the signed
 * message binds a hash of the exact body sent (matching /v1/memory/*'s
 * convention) so a captured signature+timestamp can't be replayed with a
 * tampered body — load-bearing here since these routes can move money.
 */
import type { NextRequest } from "next/server";
import crypto from "crypto";
import { validateSession } from "@/lib/session";
import { handleModRequest } from "@/lib/mods/runtime";
import { requireAgentAuth } from "@/lib/auth-guard";

type Ctx = { params: Promise<{ modId: string; path: string[] }> };

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

async function dispatch(req: NextRequest, { params }: Ctx) {
  const { modId, path } = await params;
  let session = null;
  try {
    const s = await validateSession();
    if (s) session = { address: s.sub, role: s.role };
  } catch {
    // Session store unavailable → treat as signed out (public routes still work).
  }

  // Read the body once (if any) so it can both be hashed into the signed
  // message and still be readable by the mod's own route handler below —
  // a Request's body stream can only be consumed once.
  let rawBody: string | null = null;
  if (BODY_METHODS.has(req.method)) {
    rawBody = await req.text();
  }
  const forwardedReq = rawBody != null
    ? new Request(req.url, { method: req.method, headers: req.headers, body: rawBody })
    : req;

  let agent = null;
  if (!session) {
    const routePath = `${req.method}:/mods/${modId}/${path.join("/")}`;
    const signedMessagePrefix = rawBody != null
      ? `${routePath}:${crypto.createHash("sha256").update(rawBody).digest("hex")}`
      : routePath;
    const auth = await requireAgentAuth(req, signedMessagePrefix);
    if (auth.ok && auth.agent) {
      agent = { agentId: auth.agent.agentId, orgId: auth.agent.orgId, agentType: auth.agent.agentType };
    }
  }

  return handleModRequest(modId, forwardedReq, path, session, agent);
}

export const GET = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
