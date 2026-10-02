#!/usr/bin/env node
/**
 * One-time migration: move organizations.inviteCode into the server-only
 * orgInvites/{CODE} collection, then delete the field from the org doc.
 *
 * Org docs are readable by every signed-in wallet, so until this runs anyone
 * can read any org's code and join it. New orgs no longer get the field, and
 * legacy codes migrate lazily when used — this clears the rest in one pass.
 *
 * Dry run by default; pass --apply to write.
 *
 *   node --env-file=.env.local scripts/migrate-org-invite-codes.mjs
 *   node --env-file=.env.local scripts/migrate-org-invite-codes.mjs --apply
 *
 * Needs NEXT_PUBLIC_FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY.
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const apply = process.argv.includes("--apply");
const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

if (!projectId || !clientEmail || !privateKey) {
  console.error("Missing NEXT_PUBLIC_FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY");
  process.exit(1);
}

const db = getFirestore(initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) }));

const snap = await db.collection("organizations").where("inviteCode", "!=", null).get();
console.log(`${snap.size} org(s) still carry an inviteCode${apply ? "" : " (dry run — pass --apply to migrate)"}`);

let moved = 0;
let conflicts = 0;
for (const org of snap.docs) {
  const code = String(org.data().inviteCode || "").toUpperCase();
  const inviteRef = db.collection("orgInvites").doc(code);
  const existing = code ? await inviteRef.get() : null;

  if (!code || (existing?.exists && existing.data()?.orgId !== org.id)) {
    // Empty, or the code already belongs to another org — drop it; members
    // get a fresh code from the dashboard on next view.
    conflicts++;
    console.log(`  ${org.id}: dropping ${code ? `conflicting code ${code}` : "empty code"}`);
    if (apply) await org.ref.update({ inviteCode: FieldValue.delete() });
    continue;
  }

  console.log(`  ${org.id}: ${code}`);
  if (apply) {
    const batch = db.batch();
    batch.set(inviteRef, { orgId: org.id, createdAt: FieldValue.serverTimestamp(), migrated: true });
    batch.update(org.ref, { inviteCode: FieldValue.delete() });
    await batch.commit();
  }
  moved++;
}

console.log(`${apply ? "Migrated" : "Would migrate"} ${moved}, ${apply ? "dropped" : "would drop"} ${conflicts}.`);
