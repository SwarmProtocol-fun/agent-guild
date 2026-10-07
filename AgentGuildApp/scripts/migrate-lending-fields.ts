/**
 * One-time migration: rename lending's legacy `...Usd` amount fields
 * (principalUsd, availableLiquidityUsd, amountUsd, ...) to their asset-neutral
 * names (principal, availableLiquidity, amount, ...). Field map and merge
 * rules: src/lib/lending/legacy-fields.ts — the same code the app uses to read
 * and self-heal legacy documents, so running this early, late or twice is safe.
 *
 * Each document is migrated in its own transaction (re-read, then rewritten),
 * so it can run while the app is live.
 *
 * Dry run by default; pass --apply to write.
 *
 *   npx tsx --env-file=.env.local scripts/migrate-lending-fields.ts
 *   npx tsx --env-file=.env.local scripts/migrate-lending-fields.ts --apply
 *
 * Needs NEXT_PUBLIC_FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 * — or FIRESTORE_EMULATOR_HOST to run against the emulator.
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { LEGACY_FIELDS, hasLegacyFields, legacyMigrationUpdate, type LegacyCollection } from "../src/lib/lending/legacy-fields";

async function main() {
    const apply = process.argv.includes("--apply");
    const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    const emulator = process.env.FIRESTORE_EMULATOR_HOST;

    if (!projectId || (!emulator && (!clientEmail || !privateKey))) {
        console.error("Missing NEXT_PUBLIC_FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (or FIRESTORE_EMULATOR_HOST)");
        process.exit(1);
    }

    const app = emulator ? initializeApp({ projectId }) : initializeApp({ credential: cert({ projectId, clientEmail: clientEmail!, privateKey: privateKey! }) });
    const db = getFirestore(app);
    console.log(`Project ${projectId}${emulator ? ` (emulator ${emulator})` : ""}${apply ? "" : " — dry run, pass --apply to write"}`);

    let total = 0;
    for (const collection of Object.keys(LEGACY_FIELDS) as LegacyCollection[]) {
        const snap = await db.collection(collection).get();
        const legacy = snap.docs.filter((d) => hasLegacyFields(collection, d.data()));
        console.log(`${collection}: ${legacy.length} of ${snap.size} document(s) have legacy fields`);
        for (const doc of legacy) {
            const preview = legacyMigrationUpdate(collection, doc.data())!;
            const renamed = Object.keys(LEGACY_FIELDS[collection]).filter((k) => k in preview);
            console.log(`  ${doc.id}: ${renamed.map((k) => `${k} → ${LEGACY_FIELDS[collection][k]}`).join(", ")}`);
            if (!apply) continue;
            await db.runTransaction(async (txn) => {
                const fresh = await txn.get(doc.ref);
                const update = legacyMigrationUpdate(collection, fresh.data());
                if (update) txn.update(doc.ref, update);
            });
        }
        total += legacy.length;
    }
    console.log(`${apply ? "Migrated" : "Would migrate"} ${total} document(s).`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
