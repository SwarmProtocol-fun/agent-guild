/**
 * Platform Analytics — Session tracking and user profile aggregation.
 *
 * Tracks every login/logout to Firestore for admin visibility:
 *  - platformSessions: individual login records with duration
 *  - userProfiles: aggregated per-wallet stats (sessions, time, last seen)
 *
 * Privacy: IP addresses are SHA-256 hashed before storage. No raw IPs ever persist.
 *
 * Server-only (Firebase Admin SDK) — bypasses Firestore rules, so this must
 * never be imported into client-facing code.
 */

import { adminDb } from "./firebase-admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";

// ── Types ──

export type UserRole = "operator" | "org_admin" | "platform_admin";

export interface PlatformSession {
  id: string;
  walletAddress: string;
  role: UserRole;
  loginAt: Date | null;
  logoutAt?: Date | null;
  durationMs?: number;
  userAgent?: string;
  ipHash?: string;
  referrer?: string;
  sessionId: string;
}

export interface UserProfile {
  walletAddress: string;
  email?: string;
  firstSeen: Date | null;
  lastSeen: Date | null;
  totalSessions: number;
  totalTimeMs: number;
  role: UserRole;
  orgsOwned: number;
  lastUserAgent?: string;
}

export interface OverviewMetrics {
  activeNow: number;
  dau: number;
  wau: number;
  mau: number;
  sessionsToday: number;
  avgSessionMs: number;
  newUsersThisWeek: number;
  totalUsers: number;
  dailySessions: { date: string; count: number }[];
}

// ── Collections ──

const SESSIONS_COL = "platformSessions";
const PROFILES_COL = "userProfiles";

// ── Helpers ──

async function hashIp(ip: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(ip + "swarm-analytics-salt");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseUserAgent(ua: string | null): string {
  if (!ua) return "unknown";
  // Extract a brief summary: browser + OS
  if (ua.length > 200) return ua.slice(0, 200);
  return ua;
}

function toDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Timestamp) return val.toDate();
  if (val instanceof Date) return val;
  if (typeof val === "object" && val !== null && "seconds" in val) {
    return new Date((val as { seconds: number }).seconds * 1000);
  }
  return null;
}

// ── Record Login ──

export async function recordLogin(
  walletAddress: string,
  role: UserRole,
  sessionId: string,
  req: Request,
): Promise<string> {
  const db = adminDb();
  const wallet = walletAddress.toLowerCase();
  const now = Timestamp.now();

  // Extract request metadata
  const ua = req.headers.get("user-agent");
  const referrer = req.headers.get("referer") || req.headers.get("referrer") || undefined;
  const forwarded = req.headers.get("x-forwarded-for");
  const realIp = req.headers.get("x-real-ip");
  const rawIp = forwarded?.split(",")[0].trim() || realIp || "unknown";
  const ipHash = await hashIp(rawIp);

  // Create session record
  const sessionRef = db.collection(SESSIONS_COL).doc();
  await sessionRef.set({
    walletAddress: wallet,
    role,
    loginAt: now,
    userAgent: parseUserAgent(ua),
    ipHash,
    referrer: referrer?.slice(0, 500),
    sessionId,
  });

  // Upsert user profile
  const profileRef = db.collection(PROFILES_COL).doc(wallet);
  const profileSnap = await profileRef.get();

  if (profileSnap.exists) {
    await profileRef.update({
      lastSeen: now,
      totalSessions: FieldValue.increment(1),
      role,
      lastUserAgent: parseUserAgent(ua),
    });
  } else {
    await profileRef.set({
      walletAddress: wallet,
      firstSeen: now,
      lastSeen: now,
      totalSessions: 1,
      totalTimeMs: 0,
      role,
      orgsOwned: 0,
      lastUserAgent: parseUserAgent(ua),
    });
  }

  // Sync email from user's profile (profiles collection) into analytics profile
  try {
    const userProfileDoc = await db.collection("profiles").doc(wallet).get();
    if (userProfileDoc.exists) {
      const userData = userProfileDoc.data();
      if (userData?.email) {
        await profileRef.update({ email: userData.email });
      }
    }
  } catch {
    // non-critical — email sync is best-effort
  }

  return sessionRef.id;
}

// ── Record Logout ──

export async function recordLogout(sessionId: string): Promise<void> {
  const db = adminDb();
  // Find the platformSession by sessionId field
  const snap = await db
    .collection(SESSIONS_COL)
    .where("sessionId", "==", sessionId)
    .limit(1)
    .get();
  if (snap.empty) return;

  const sessionDoc = snap.docs[0];
  const data = sessionDoc.data();
  const loginAt = toDate(data.loginAt);
  const now = new Date();
  const durationMs = loginAt ? now.getTime() - loginAt.getTime() : 0;

  await sessionDoc.ref.update({
    logoutAt: Timestamp.now(),
    durationMs,
  });

  // Update user profile total time
  if (data.walletAddress && durationMs > 0) {
    await db
      .collection(PROFILES_COL)
      .doc(data.walletAddress)
      .update({ totalTimeMs: FieldValue.increment(durationMs) })
      .catch(() => {}); // non-critical
  }
}

// ── Query: Recent Sessions ──

export async function getRecentSessions(opts: {
  max?: number;
  wallet?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<PlatformSession[]> {
  let q: FirebaseFirestore.Query = adminDb().collection(SESSIONS_COL);

  if (opts.wallet) {
    q = q.where("walletAddress", "==", opts.wallet.toLowerCase());
  }
  if (opts.dateFrom) {
    const from = new Date(opts.dateFrom);
    q = q.where("loginAt", ">=", Timestamp.fromDate(from));
  }
  if (opts.dateTo) {
    const to = new Date(opts.dateTo);
    to.setHours(23, 59, 59, 999);
    q = q.where("loginAt", "<=", Timestamp.fromDate(to));
  }

  q = q.orderBy("loginAt", "desc").limit(opts.max || 50);

  const snap = await q.get();

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      id: d.id,
      walletAddress: data.walletAddress,
      role: data.role,
      loginAt: toDate(data.loginAt),
      logoutAt: toDate(data.logoutAt),
      durationMs: data.durationMs,
      userAgent: data.userAgent,
      ipHash: data.ipHash,
      referrer: data.referrer,
      sessionId: data.sessionId,
    } as PlatformSession;
  });
}

// ── Query: User Profiles ──

export async function getUserProfiles(opts: {
  max?: number;
  sortBy?: "lastSeen" | "totalSessions" | "totalTimeMs";
  search?: string;
}): Promise<UserProfile[]> {
  const sortField = opts.sortBy || "lastSeen";
  const snap = await adminDb()
    .collection(PROFILES_COL)
    .orderBy(sortField, "desc")
    .limit(opts.max || 50)
    .get();

  let profiles = snap.docs.map((d) => {
    const data = d.data();
    return {
      walletAddress: data.walletAddress,
      email: data.email,
      firstSeen: toDate(data.firstSeen),
      lastSeen: toDate(data.lastSeen),
      totalSessions: data.totalSessions || 0,
      totalTimeMs: data.totalTimeMs || 0,
      role: data.role || "operator",
      orgsOwned: data.orgsOwned || 0,
      lastUserAgent: data.lastUserAgent,
    } as UserProfile;
  });

  if (opts.search) {
    const s = opts.search.toLowerCase();
    profiles = profiles.filter((p) =>
      p.walletAddress.includes(s) || (p.email && p.email.toLowerCase().includes(s)),
    );
  }

  return profiles;
}

// ── Query: Analytics Overview ──

export async function getAnalyticsOverview(): Promise<OverviewMetrics> {
  const db = adminDb();
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Fetch sessions from last 30 days for all metrics
  const snap = await db
    .collection(SESSIONS_COL)
    .where("loginAt", ">=", Timestamp.fromDate(monthAgo))
    .orderBy("loginAt", "desc")
    .get();

  const sessions = snap.docs.map((d) => {
    const data = d.data();
    return {
      walletAddress: data.walletAddress as string,
      loginAt: toDate(data.loginAt),
      logoutAt: toDate(data.logoutAt),
      durationMs: (data.durationMs as number) || 0,
    };
  });

  // DAU: unique wallets logged in today
  const todayWallets = new Set<string>();
  const weekWallets = new Set<string>();
  const monthWallets = new Set<string>();
  let sessionsToday = 0;
  let totalDuration = 0;
  let durationCount = 0;
  let activeNow = 0;

  // Daily sessions for chart (last 30 days)
  const dailyMap = new Map<string, number>();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dailyMap.set(d.toISOString().split("T")[0], 0);
  }

  for (const s of sessions) {
    if (!s.loginAt) continue;
    const loginDate = s.loginAt.toISOString().split("T")[0];
    monthWallets.add(s.walletAddress);

    if (s.loginAt >= weekAgo) weekWallets.add(s.walletAddress);
    if (s.loginAt >= todayStart) {
      todayWallets.add(s.walletAddress);
      sessionsToday++;
    }

    if (s.durationMs > 0) {
      totalDuration += s.durationMs;
      durationCount++;
    }

    // Active now: logged in within 24h and no logout
    if (!s.logoutAt && s.loginAt >= new Date(now.getTime() - 24 * 60 * 60 * 1000)) {
      activeNow++;
    }

    // Daily chart
    if (dailyMap.has(loginDate)) {
      dailyMap.set(loginDate, (dailyMap.get(loginDate) || 0) + 1);
    }
  }

  // New users this week
  const newUsersSnap = await db
    .collection(PROFILES_COL)
    .where("firstSeen", ">=", Timestamp.fromDate(weekAgo))
    .get();

  // Total users
  const totalUsersSnap = await db.collection(PROFILES_COL).get();

  const dailySessions = Array.from(dailyMap.entries()).map(([date, count]) => ({
    date: date.slice(5), // MM-DD format
    count,
  }));

  return {
    activeNow,
    dau: todayWallets.size,
    wau: weekWallets.size,
    mau: monthWallets.size,
    sessionsToday,
    avgSessionMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
    newUsersThisWeek: newUsersSnap.size,
    totalUsers: totalUsersSnap.size,
    dailySessions,
  };
}
