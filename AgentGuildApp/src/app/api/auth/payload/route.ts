/**
 * POST /api/auth/payload
 * Issues a SIWE (EIP-4361) login payload for the given wallet address.
 * Body: { address: string, chainId?: number }
 * Returns: { payload, message } — the client signs `message` and posts
 * { payload, signature } to /api/auth/verify.
 *
 * The domain is read from the request Host header so it matches the
 * actual site the user is visiting (localhost, preview deploys, prod).
 */
import { generateSiwePayload, getDomainFromRequest, getOriginFromRequest } from "@/lib/auth/siwe";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const address = body.address?.trim();

    if (!address || typeof address !== "string") {
      return Response.json({ error: "address is required" }, { status: 400 });
    }

    const domain = getDomainFromRequest(req);
    const result = generateSiwePayload({
      address,
      chainId: body.chainId ? Number(body.chainId) : undefined,
      domain,
      uri: getOriginFromRequest(req, domain),
    });

    return Response.json(result);
  } catch (err) {
    console.error("[auth/payload] Error:", err);
    return Response.json({ error: "Failed to generate login payload" }, { status: 500 });
  }
}
