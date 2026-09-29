/**
 * GET /api/auth/session
 * Returns the current session state from the httpOnly cookie.
 * Returns: { authenticated: true, address, role } or { authenticated: false }
 */
import { validateSession } from "@/lib/session";

export async function GET() {
  try {
    const session = await validateSession();

    if (!session) {
      return Response.json({ authenticated: false });
    }

    return Response.json({
      authenticated: true,
      address: session.sub,
      role: session.role,
      sessionId: session.sid,
    });
  } catch (err) {
    console.error("[auth/session] Error:", err);
    return Response.json({ authenticated: false });
  }
}
