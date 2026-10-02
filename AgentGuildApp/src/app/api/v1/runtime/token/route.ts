/**
 * POST /api/v1/runtime/token
 * Headers: Authorization: Runtime agrt_…, x-runtime-id: <computerId>
 * Returns { token, expiresAt } — a 1-hour agt_ token with the runtime's scopes/bindings.
 */
import { NextRequest } from "next/server";
import { runtimeToken } from "@/lib/vault/runtimes";
import { vaultErrorResponse } from "@/lib/vault/http";
import { rateLimit } from "../../rate-limit";

export async function POST(req: NextRequest) {
  const runtimeId = req.headers.get("x-runtime-id") || "";
  const limited = await rateLimit(`runtime-token:${runtimeId || "anon"}`);
  if (limited) return limited;
  const m = (req.headers.get("authorization") || "").match(/^Runtime\s+(\S+)$/i);
  if (!m || !runtimeId) return Response.json({ error: "Authorization: Runtime <credential> and x-runtime-id are required" }, { status: 401 });
  try {
    return Response.json(await runtimeToken(runtimeId, m[1]));
  } catch (err) {
    return vaultErrorResponse(err, "runtime token");
  }
}
