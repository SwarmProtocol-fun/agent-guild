/**
 * Firebase Admin — Server-only Firestore/Auth access via a service account.
 *
 * This bypasses Firestore Security Rules entirely (the service account is
 * trusted), so it must NEVER be imported from client-facing code — only
 * from server-side lib modules (session.ts, rate-limit-firestore.ts,
 * platform-analytics.ts) and API routes.
 *
 * Requires FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY env vars (from a
 * service account JSON key — Firebase Console > Project Settings >
 * Service Accounts > Generate new private key). Falls back to throwing a
 * clear error at first use if they're missing, rather than failing silently.
 */
import { getApps, initializeApp, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getAuth, type Auth } from "firebase-admin/auth";

function getAdminApp(): App {
  const existing = getApps().find((a) => a.name === "swarm-admin");
  if (existing) return existing;

  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Env vars store literal "\n" — must be converted to real newlines for PEM parsing.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Firebase Admin SDK not configured: set FIREBASE_CLIENT_EMAIL and " +
      "FIREBASE_PRIVATE_KEY (from a service account key) alongside " +
      "NEXT_PUBLIC_FIREBASE_PROJECT_ID."
    );
  }

  return initializeApp(
    { credential: cert({ projectId, clientEmail, privateKey }) },
    "swarm-admin"
  );
}

let _db: Firestore | null = null;
let _auth: Auth | null = null;

export function adminDb(): Firestore {
  if (!_db) _db = getFirestore(getAdminApp());
  return _db;
}

export function adminAuth(): Auth {
  if (!_auth) _auth = getAuth(getAdminApp());
  return _auth;
}
