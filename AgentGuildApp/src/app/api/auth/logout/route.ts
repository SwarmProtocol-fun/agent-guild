/**
 * POST /api/auth/logout
 * Destroys the current session (Firestore record + cookie).
 * Returns: { success: true }
 */
import {
  getSessionFromCookie,
  deleteSession,
  clearSessionCookie,
} from "@/lib/session";
import { recordLogout } from "@/lib/platform-analytics";

export async function POST() {
  try {
    const session = await getSessionFromCookie();

    if (session) {
      await recordLogout(session.sid).catch((err) => {
        console.warn("[auth/logout] analytics recordLogout error:", err);
      });
      await deleteSession(session.sid);
    }

    await clearSessionCookie();

    return Response.json({ success: true });
  } catch {
    // Even if something fails, clear the cookie
    await clearSessionCookie();
    return Response.json({ success: true });
  }
}
