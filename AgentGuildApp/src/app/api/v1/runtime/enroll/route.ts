/**
 * POST /api/v1/runtime/enroll  { code }
 * Machine side of runtime connection (see lib/vault/runtimes.ts): trade a
 * one-time enrollment code for the runtime credential. Returned once.
 */
import { NextRequest } from "next/server";
import { enrollRuntime } from "@/lib/vault/runtimes";
import { vaultErrorResponse, readJson } from "@/lib/vault/http";
import { rateLimit } from "../../rate-limit";

export async function POST(req: NextRequest) {
  const limited = await rateLimit(`runtime-enroll:${req.headers.get("x-forwarded-for") || "anon"}`);
  if (limited) return limited;
  const body = await readJson(req);
  if (!body?.code) return Response.json({ error: "code is required" }, { status: 400 });
  try {
    return Response.json(await enrollRuntime(String(body.code)));
  } catch (err) {
    return vaultErrorResponse(err, "runtime enroll");
  }
}
