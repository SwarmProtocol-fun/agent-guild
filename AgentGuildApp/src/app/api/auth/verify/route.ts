/**
 * POST /api/auth/verify
 * Verifies a signed SIWE payload and creates an authenticated session.
 * Body: { payload: LoginPayload, signature: string }
 * Returns: { success: true, session: { address, role } }
 * Sets: httpOnly cookie `agent_guild_session`
 */
import {
  resolveRole,
  createSession,
  signSessionJWT,
  setSessionCookie,
} from "@/lib/session";
import { getOrganizationsByWalletAdmin } from "@/lib/firestore-admin";
import { adminAuth } from "@/lib/firebase-admin";
import { getCachedOrgs, cacheOrgs } from "@/lib/org-cache";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit-firestore";
import { verifySiwePayload, getDomainFromRequest } from "@/lib/auth/siwe";
import { recordLogin } from "@/lib/platform-analytics";
import { emitEvent } from "@/lib/mods/runtime";

export async function POST(req: Request) {
  try {
    // Rate limiting: 10 login attempts per IP per minute
    const clientIp = getClientIp(req);
    const rateLimit = await checkRateLimit(clientIp, {
      max: 10,
      windowMs: 60 * 1000, // 1 minute
    });

    if (!rateLimit.allowed) {
      return Response.json(
        {
          error: "Too many login attempts. Please try again later.",
          retryAfter: Math.ceil((rateLimit.resetTime - Date.now()) / 1000),
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.ceil((rateLimit.resetTime - Date.now()) / 1000)),
            "X-RateLimit-Limit": "10",
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Math.ceil(rateLimit.resetTime / 1000)),
          },
        }
      );
    }

    const body = await req.json();
    const { payload, signature } = body;

    if (!payload) {
      return Response.json(
        { error: "payload is required" },
        { status: 400 }
      );
    }

    if (!signature || typeof signature !== "string") {
      return Response.json(
        { error: "signature is required" },
        { status: 400 }
      );
    }

    // Verify the SIWE signature
    if (process.env.NODE_ENV === "development") {
      console.log("[auth/verify] Payload:", JSON.stringify(payload, null, 2));
      console.log("[auth/verify] Signature:", signature);
    }
    const domain = getDomainFromRequest(req);

    let verifiedPayload;
    try {
      verifiedPayload = await verifySiwePayload({ payload, signature, domain });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[auth/verify] Signature verification failed:", msg);
      return Response.json(
        { error: "Invalid signature. Please try again." },
        { status: 401 }
      );
    }

    if (!verifiedPayload.valid) {
      console.error("[auth/verify] Payload validation failed:", verifiedPayload.valid ? "" : verifiedPayload.error);
      return Response.json(
        { error: "Invalid signature" },
        { status: 401 }
      );
    }

    // Extract address from verified payload
    const address = verifiedPayload.payload.address;

    if (!address) {
      console.error("[auth/verify] No address found in verified payload");
      return Response.json(
        { error: "Invalid payload: no address found" },
        { status: 400 }
      );
    }

    // 1. Determine role based on org ownership
    let orgs;
    try {
      // Check cache first
      orgs = getCachedOrgs(address);
      if (!orgs) {
        // Cache miss - fetch from Firestore
        orgs = await getOrganizationsByWalletAdmin(address);
        // Cache the result
        cacheOrgs(address, orgs);
      }
    } catch (err) {
      console.error("[auth/verify] getOrganizationsByWallet error:", err);
      return Response.json(
        { error: "Failed to load organizations. Please try again." },
        { status: 500 }
      );
    }

    const ownedOrgIds = orgs
      .filter(
        (o) => o.ownerAddress.toLowerCase() === address.toLowerCase()
      )
      .map((o) => o.id);

    const role = resolveRole(address, ownedOrgIds);

    // 2. Create Firestore session + JWT
    let sessionId: string;
    try {
      sessionId = await createSession(address, role);
    } catch (err) {
      console.error("[auth/verify] createSession error:", err);
      return Response.json(
        { error: "Failed to create session. Please try again." },
        { status: 500 }
      );
    }

    let token: string;
    try {
      token = await signSessionJWT(address, sessionId, role);
    } catch (err) {
      console.error("[auth/verify] signSessionJWT error:", err);
      return Response.json(
        { error: "Failed to sign session token. Check SESSION_SECRET." },
        { status: 500 }
      );
    }

    // 3. Set httpOnly cookie
    try {
      await setSessionCookie(token);
    } catch (err) {
      console.error("[auth/verify] setSessionCookie error:", err);
      // Don't fail - cookie might still work
    }

    // 4. Mint a Firebase custom token so the client SDK can establish a real
    // Firebase Auth session (uid = wallet address). Firestore rules key off
    // request.auth for anything the client reads/writes directly — without
    // this, request.auth is always null and rules can't distinguish a
    // verified wallet from an anonymous visitor.
    let firebaseToken: string | undefined;
    try {
      firebaseToken = await adminAuth().createCustomToken(
        address.toLowerCase(),
        { role }
      );
    } catch (err) {
      console.error("[auth/verify] createCustomToken error:", err);
      // Don't fail login over this — the httpOnly session cookie still
      // works for server-side auth. The client just won't get direct
      // Firestore access until this is resolved.
    }

    // 5. Record login for platform analytics (non-blocking)
    recordLogin(address, role, sessionId, req).catch((err) => {
      console.warn("[auth/verify] analytics recordLogin error:", err);
    });

    // 6. Let mods react to the login (non-blocking; mod errors are contained)
    emitEvent("auth.login", { address, role }).catch(() => {});

    return Response.json({
      success: true,
      session: {
        address,
        role,
      },
      firebaseToken,
    });
  } catch (err) {
    console.error("[auth/verify] Unhandled error:", err);
    return Response.json(
      { error: "Authentication failed" },
      { status: 500 }
    );
  }
}
