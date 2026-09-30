/**
 * Session — Server-side session management.
 *
 * Auth flow (SIWE via wallet adapter):
 *   1. ConnectButton calls POST /api/auth/payload → generates SIWE login payload
 *   2. User signs the payload in their wallet
 *   3. ConnectButton calls POST /api/auth/verify with { payload, signature }
 *   4. Server verifies via viem SIWE (lib/auth/siwe.ts), creates Firestore session, issues JWT cookie
 *
 * JWT is stored in an httpOnly cookie (`agent_guild_session`).
 * Sessions are persisted in the Firestore `sessions` collection.
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { cookies } from "next/headers";
import { adminDb } from "./firebase-admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { canonicalizeWalletAddress } from "./wallet-address";

// ─── Constants ──────────────────────────────────────────

export const SESSION_COOKIE = "agent_guild_session";
const SESSION_MAX_AGE = 60 * 60 * 24; // 24 hours in seconds

/** Roles in ascending privilege order */
export type UserRole = "operator" | "org_admin" | "platform_admin";

export interface SessionPayload extends JWTPayload {
  /** Wallet address (checksummed) */
  sub: string;
  /** Firestore session document ID */
  sid: string;
  /** Resolved role */
  role: UserRole;
}

export interface SessionRecord {
  walletAddress: string;
  role: UserRole;
  createdAt: unknown;
  expiresAt: Timestamp;
}

// ─── Helpers ────────────────────────────────────────────

function getSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "SESSION_SECRET env var must be set (min 32 chars). Generate one with: openssl rand -hex 32"
    );
  }
  return new TextEncoder().encode(raw);
}

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

// ─── Role resolution ────────────────────────────────────

const PLATFORM_ADMINS = (process.env.PLATFORM_ADMIN_WALLETS || "")
  .split(",")
  .map((a) => canonicalizeWalletAddress(a.trim()))
  .filter(Boolean);

export function resolveRole(
  walletAddress: string,
  ownedOrgIds: string[]
): UserRole {
  if (PLATFORM_ADMINS.includes(canonicalizeWalletAddress(walletAddress))) {
    return "platform_admin";
  }
  if (ownedOrgIds.length > 0) {
    return "org_admin";
  }
  return "operator";
}

// ─── Session CRUD ───────────────────────────────────────

export async function createSession(
  walletAddress: string,
  role: UserRole
): Promise<string> {
  const sessionId = crypto.randomUUID();
  const expiresAt = Timestamp.fromDate(
    new Date(Date.now() + SESSION_MAX_AGE * 1000)
  );

  const record: SessionRecord = {
    walletAddress: canonicalizeWalletAddress(walletAddress),
    role,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt,
  };

  await adminDb().collection("sessions").doc(sessionId).set(record);
  return sessionId;
}

export async function getSessionRecord(
  sessionId: string
): Promise<SessionRecord | null> {
  const ref = adminDb().collection("sessions").doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as SessionRecord;

  // Check expiry
  if (data.expiresAt instanceof Timestamp) {
    if (data.expiresAt.toDate().getTime() < Date.now()) {
      await ref.delete();
      return null;
    }
  }

  return data;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await adminDb().collection("sessions").doc(sessionId).delete();
}

// ─── JWT ────────────────────────────────────────────────

export async function signSessionJWT(
  walletAddress: string,
  sessionId: string,
  role: UserRole
): Promise<string> {
  return new SignJWT({ sid: sessionId, role } as unknown as JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(canonicalizeWalletAddress(walletAddress))
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecret());
}

export async function verifySessionJWT(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

// ─── Cookie helpers ─────────────────────────────────────

export async function setSessionCookie(token: string): Promise<void> {
  const jar = await cookies();
  const isProduction = isProd();

  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
}

export async function getSessionFromCookie(): Promise<SessionPayload | null> {
  const jar = await cookies();
  const cookie = jar.get(SESSION_COOKIE);

  if (!cookie?.value) {
    return null;
  }

  return verifySessionJWT(cookie.value);
}

// ─── Convenience: full session validation ───────────────

/**
 * Validates the current request's session cookie against both
 * the JWT and the Firestore session record.
 * Returns the session payload if valid, null otherwise.
 */
export async function validateSession(): Promise<SessionPayload | null> {
  const payload = await getSessionFromCookie();
  if (!payload) return null;

  // Cross-check against Firestore session (ensures revocation works)
  const record = await getSessionRecord(payload.sid);
  if (!record) return null;

  return payload;
}

/**
 * Require a valid session with minimum role.
 * Returns session payload or throws.
 */
export async function requireSession(
  minimumRole?: UserRole
): Promise<SessionPayload> {
  const session = await validateSession();
  if (!session) {
    throw new SessionError("Not authenticated", 401);
  }

  if (minimumRole && !hasMinimumRole(session.role, minimumRole)) {
    throw new SessionError("Insufficient permissions", 403);
  }

  return session;
}

// ─── Role hierarchy ─────────────────────────────────────

const ROLE_LEVEL: Record<UserRole, number> = {
  operator: 0,
  org_admin: 1,
  platform_admin: 2,
};

export function hasMinimumRole(
  currentRole: UserRole,
  requiredRole: UserRole
): boolean {
  return ROLE_LEVEL[currentRole] >= ROLE_LEVEL[requiredRole];
}

// ─── Error class ────────────────────────────────────────

export class SessionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SessionError";
    this.status = status;
  }
}

