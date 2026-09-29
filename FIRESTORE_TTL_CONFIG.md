# Firestore TTL (Time-To-Live) Configuration

## Overview

Firestore TTL policies automatically delete old documents to:
- Reduce storage costs
- Comply with data retention policies
- Improve query performance
- Maintain GDPR compliance

TTL policies are configured per-collection and automatically delete documents where a specified timestamp field is older than the TTL period.

---

## Required TTL Policies

### 1. **agentVitals** — CPU/Memory/Disk Metrics
- **Field**: `timestamp` (Firestore Timestamp)
- **TTL**: **7 days**
- **Reason**: System vitals are only useful for recent monitoring. Historical trends can be aggregated separately.

```bash
gcloud firestore fields ttls update timestamp \
  --collection-group=agentVitals \
  --enable-ttl \
  --async
```

**Firebase Console**:
1. Go to Firestore → Indexes → Single Field
2. Find `agentVitals.timestamp` (create if missing)
3. Enable "TTL" → Set to enabled
4. Save changes

---

### 2. **assignmentNotifications** — Task Assignment Alerts
- **Field**: `createdAt` (Firestore Timestamp)
- **TTL**: **30 days**
- **Reason**: Read notifications don't need to be kept forever. Unread critical notifications should be handled within 30 days.

```bash
gcloud firestore fields ttls update createdAt \
  --collection-group=assignmentNotifications \
  --enable-ttl \
  --async
```

**Note**: Consider adding a cleanup Cloud Function to delete read notifications after 7 days:
```typescript
// functions/src/cleanup-notifications.ts
export const cleanupReadNotifications = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async () => {
    const sevenDaysAgo = admin.firestore.Timestamp.fromDate(
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    );

    const batch = db.batch();
    const oldReadNotifications = await db.collection('assignmentNotifications')
      .where('read', '==', true)
      .where('createdAt', '<', sevenDaysAgo)
      .limit(500)
      .get();

    oldReadNotifications.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  });
```

---

### 3. **agentComms** — Activity Feed
- **Field**: `createdAt` (Firestore Timestamp)
- **TTL**: **90 days**
- **Reason**: Activity feed is useful for audit trails, but older entries can be archived or deleted.

```bash
gcloud firestore fields ttls update createdAt \
  --collection-group=agentComms \
  --enable-ttl \
  --async
```

**Alternative**: If you need long-term audit logs, export to BigQuery before deletion:
```bash
# Enable Firestore export to BigQuery
gcloud firestore export gs://your-bucket/firestore-exports/agentComms
```

---

### 4. **sessions** — User Sessions (if not using JWT-only)
- **Field**: `expiresAt` (Firestore Timestamp)
- **TTL**: **Immediate** (delete when `expiresAt` passes)
- **Reason**: Expired sessions should be removed to prevent stale session pollution.

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=sessions \
  --enable-ttl \
  --async
```

**Note**: Agent Guild currently uses JWT-only sessions stored in cookies, so this collection may not exist. Add it if you implement server-side session storage.

---

### 5. **logs** — Application Logs (if persisted to Firestore)
- **Field**: `timestamp` (Firestore Timestamp)
- **TTL**: **30 days**
- **Reason**: Logs older than 30 days should be exported to long-term storage (Cloud Logging, BigQuery).

```bash
gcloud firestore fields ttls update timestamp \
  --collection-group=logs \
  --enable-ttl \
  --async
```

**Recommendation**: Use Cloud Logging instead of Firestore for application logs. Firestore is optimized for transactional data, not log aggregation.

---

## Collections to **NOT** Apply TTL

These collections contain critical business data and should **never** auto-delete:

- ❌ **agents** — Agent profiles and keys
- ❌ **organizations** — Organization metadata
- ❌ **projects** — Project configurations
- ❌ **channels** — Chat channels
- ❌ **messages** — Chat message history (unless explicitly required by policy)
- ❌ **kanbanTasks** — Task tracking (archive instead of delete)
- ❌ **jobs** — Job bounties (archive completed jobs)
- ❌ **taskAssignments** — Assignment history (needed for accountability)
- ❌ **delegations** — Agent hierarchy (needed for org structure)
- ❌ **users** — User profiles
- ❌ **operators** — Human operators
- ❌ **apiKeys** — API key metadata (revoke explicitly, don't auto-delete)

**Archival Strategy**: For completed tasks, jobs, and assignments, add a `status: "archived"` field and move to a separate collection or export to cold storage.

---

## Verification

After enabling TTL policies, verify they're active:

```bash
# List all TTL policies
gcloud firestore fields list --filter="ttlConfig:*"

# Check specific collection
gcloud firestore fields describe timestamp --collection-group=agentVitals
```

**Expected output**:
```yaml
ttlConfig:
  state: ACTIVE
```

---

## TTL Behavior Notes

1. **Deletion is asynchronous** — Documents may persist up to 72 hours after TTL expires
2. **TTL deletes trigger Firestore listeners** — Your app will receive `onSnapshot` delete events
3. **TTL deletes count toward quota** — Budget for delete operations (usually negligible)
4. **TTL requires composite index** — Firebase auto-creates this when you enable TTL
5. **Cannot disable TTL once enabled** — You can only change the TTL field (requires migration)

---

## GDPR Compliance

For GDPR "Right to Erasure", TTL alone is **not sufficient**. You must also implement:

1. **Manual deletion API** — Allow users to request immediate data deletion
2. **User data export** — Provide data download before deletion
3. **Cascade deletes** — Delete user data from all collections (agents, messages, etc.)

Example GDPR deletion endpoint:
```typescript
// /api/gdpr/delete-user-data
export async function POST(req: Request) {
  const { userId } = await req.json();

  // Delete from all collections
  const collections = ['agents', 'messages', 'agentComms', 'assignmentNotifications'];
  for (const coll of collections) {
    const batch = db.batch();
    const docs = await db.collection(coll).where('userId', '==', userId).get();
    docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }

  return Response.json({ deleted: true });
}
```

---

## Monitoring TTL Deletions

Set up a Cloud Function to log TTL deletions for audit trails:

```typescript
// functions/src/ttl-audit.ts
export const logTTLDeletions = functions.firestore
  .document('{collection}/{docId}')
  .onDelete(async (snap, context) => {
    const { collection, docId } = context.params;

    // Check if deletion was from TTL (not manual)
    const data = snap.data();
    if (data.timestamp || data.createdAt) {
      await db.collection('auditLogs').add({
        event: 'ttl_deletion',
        collection,
        docId,
        deletedAt: admin.firestore.FieldValue.serverTimestamp(),
        originalTimestamp: data.timestamp || data.createdAt,
      });
    }
  });
```

---

## Cost Estimation

Firestore TTL deletions are **free** (no per-delete charge), but storage savings can be significant:

**Example**: 10,000 agents sending vitals every 30 seconds
- Documents per day: `10,000 agents × 2,880 readings/day = 28.8M docs/day`
- Storage without TTL: `28.8M × 365 days × 1 KB = 10.5 TB/year`
- Storage with 7-day TTL: `28.8M × 7 days × 1 KB = 201 GB`
- **Savings**: 98% reduction in storage costs

---

## Next Steps

1. ✅ Review collections above and confirm TTL requirements
2. ⚠️ **Backup production data** before enabling TTL (export to Cloud Storage)
3. ✅ Enable TTL policies using `gcloud` commands or Firebase Console
4. ✅ Monitor deletion logs for first 7 days to ensure no unexpected data loss
5. ✅ Update application code to handle TTL delete events (if using `onSnapshot`)
6. ✅ Document TTL policies in team knowledge base

---

## Troubleshooting

**TTL not deleting documents?**
- Check field contains Firestore Timestamp (not Number or Date string)
- Verify TTL policy status: `gcloud firestore fields describe <field> --collection-group=<collection>`
- Wait up to 72 hours for initial cleanup to occur
- Check Firestore usage graph in Firebase Console for deletion activity

**Performance impact?**
- TTL deletions are throttled to avoid overwhelming your database
- No impact on read/write performance
- Deletions happen during low-traffic periods

**Accidentally enabled TTL on wrong field?**
- Contact Firebase support to disable TTL (cannot be done via Console)
- Migrate data to new collection without TTL
- OR: Change app code to write new timestamp field, then enable TTL on new field

---

## References

- [Firestore TTL Documentation](https://firebase.google.com/docs/firestore/ttl)
- [gcloud firestore fields ttls](https://cloud.google.com/sdk/gcloud/reference/firestore/fields/ttls)
- [GDPR Compliance Guide](https://firebase.google.com/support/guides/gdpr)
