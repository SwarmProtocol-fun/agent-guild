# Compute Platform Reality Check

## What Just Got Fixed

### 1. ✅ Clone API - Now Actually Clones

**Before:** Just copied metadata, created new Firestore record with `providerInstanceId: null`

**After:**
- Validates source instance has a provider backing
- Calls `provider.cloneInstance()` to duplicate actual VM/container
- Returns new provider instance ID
- Fails cleanly with 400 if no provider instance exists
- Returns 501 if provider doesn't support cloning

**File:** `AgentGuildApp/src/app/api/compute/computers/[id]/clone/route.ts`

### 2. ✅ Snapshot API - No More Synthetic Fallbacks

**Before:** Created `snap_${timestamp}` synthetic IDs when no provider instance

**After:**
- Requires actual provider instance ID
- Only creates provider-backed snapshots
- Fails with 400 if no provider instance
- Returns 501 if provider doesn't support snapshots

**File:** `AgentGuildApp/src/app/api/compute/computers/[id]/snapshot/route.ts`

### 3. ⏳ Azure Provider - Networking Started (Needs Completion)

**What's needed:**
- Dynamic NIC creation (started in separate edit - needs application)
- Public IP allocation
- NSG (Network Security Group) setup
- VNet creation or discovery
- Proper clone implementation (snapshot → new VM from snapshot)

**File:** `AgentGuildApp/src/lib/compute/providers/azure.ts` (partial fix ready)

---

## Current State: What's Real vs Placeholder

### ✅ Real Now

| Component | Status | Evidence |
|-----------|--------|----------|
| **Compute schema** | ✅ Production | Firestore collections, indexes, types |
| **E2B provider** | ✅ Production | Full implementation, VNC, desktop actions |
| **Start/stop flow** | ✅ Production | Real provider calls, state management |
| **Desktop tokens** | ✅ Production | VNC URLs, terminal access tokens |
| **Entitlements** | ✅ Production | Quota checks, plan limits enforced |
| **Sessions** | ✅ Production | Firestore-backed, multi-instance safe |
| **State recovery** | ✅ Production | Auto-recovery from stuck states (just added) |
| **Clone validation** | ✅ Production | Requires provider backing (just fixed) |
| **Snapshot validation** | ✅ Production | No synthetic fallbacks (just fixed) |

### ⚠️ Partial (Works but Incomplete)

| Component | What Works | What's Missing |
|-----------|-----------|----------------|
| **Azure VMs** | Create, start, stop, delete, Run Command | Dynamic networking, proper clone, production NSG setup |
| **AWS EC2** | Stub implementation exists | No real SDK calls yet |
| **GCP Compute** | Stub implementation exists | No real SDK calls yet |
| **Snapshots** | Works when provider supports it | Restore from snapshot not implemented |
| **Clone** | Now validates and calls provider | Azure/AWS clone needs snapshot→VM flow |
| **Transfer** | Schema exists, ownership fields | No escrow, no freeze/resume, no marketplace checkout |
| **Profitability** | Billing ledger schema exists | No real cost tracking from provider APIs |

### ❌ Still Missing (Critical for Production)

1. **Provider-Backed State Fidelity**
   - No readiness checks before marking "running"
   - No verification that VM actually booted
   - No health checks after provisioning
   - Orphaned cloud resources when Firestore updates fail

2. **One Fully Finished Provider**
   - E2B is closest (~90% done)
   - Azure has infrastructure gaps (~60% done)
   - AWS/GCP are stubs (~10% done)

3. **Real Marketplace**
   - No listing endpoints
   - No buyer flows
   - No escrow/checkout
   - No payout logic
   - No safe transfer operations (freeze → verify → resume)

4. **Operational Hardening**
   - No provisioning retries/idempotency
   - No secret injection (SSH keys, API tokens)
   - Usage metering from estimates, not reality
   - No cleanup of orphaned resources
   - VNC/terminal URLs not secured beyond tokens
   - No monitoring for failed boots
   - No zombie instance detection

---

## The Stub Provider Risk

**Problem:** If cloud credentials missing → silently falls back to stub

```typescript
// provider.ts factory
if (key === "azure" && !process.env.AZURE_SUBSCRIPTION_ID) {
  console.warn("AZURE_SUBSCRIPTION_ID is missing. Falling back to 'azure' to 'stub'");
  key = "stub";
}
```

**Impact:**
- UI shows "Azure" but it's actually stub
- Operations appear to work (create, start, stop)
- No real VMs provisioned
- Billing records created for phantom instances
- Users charged for nothing

**Fix Needed:**
- Fail loudly if provider selected but credentials missing
- Show provider as "unavailable" in UI
- Don't allow instance creation without valid credentials
- Add `/api/providers/status` endpoint to check which are configured

---

## What Needs to Be Built for Real Compute Business

### Priority 1: Hardened Provider Lifecycle

**Goal:** Prove every state change happened at provider level

**Tasks:**
1. [ ] Add `ProviderProof` to state changes
   ```typescript
   {
     status: "running",
     providerProof: {
       checkedAt: timestamp,
       providerStatus: "PowerState/running",
       publicIp: "1.2.3.4",
       bootTime: 45.2, // seconds
     }
   }
   ```

2. [ ] Readiness checks before marking "running"
   ```typescript
   // Don't mark running until:
   - Provider reports "running" status
   - SSH port 22 responds (or VNC 5901)
   - Cloud-init finished (check /var/lib/cloud/instance/boot-finished)
   ```

3. [ ] Idempotent operations
   ```typescript
   // If start() called twice:
   - First call starts VM
   - Second call checks if already running → success (no error)
   ```

4. [ ] Cleanup orphaned resources
   ```typescript
   // Daily job:
   - Query provider for all VMs with tag "agent-guild:managed"
   - Compare to Firestore computers collection
   - If VM exists but no Firestore record → delete (orphaned)
   - If Firestore record but no VM → mark "error" (desync)
   ```

---

### Priority 2: Finish One Provider End-to-End

**Recommendation:** E2B first, Azure second

#### E2B (Closest to Done)

**Remaining:**
- [ ] Snapshot support (E2B has snapshot API)
- [ ] Clone implementation (snapshot → new sandbox from snapshot)
- [ ] Network isolation (E2B supports custom networks)
- [ ] GPU support (E2B Pro tier)
- [ ] Cost tracking (E2B usage API → billing ledger)

#### Azure (Second Choice)

**Remaining:**
- [ ] Complete networking (NIC, Public IP, NSG) - **code written, needs testing**
- [ ] Real clone (snapshot disk → create VM from snapshot → return VM ID)
- [ ] Delete cleanup (NIC, NSG, Public IP when VM deleted)
- [ ] Cost tracking (Azure Cost Management API)
- [ ] SSH key injection (instead of password)

---

### Priority 3: Real Marketplace

**Goal:** Users can buy/sell running instances

**Schema exists, APIs missing:**

1. [ ] **POST /api/marketplace/list**
   ```typescript
   // List instance for sale
   {
     computerId,
     priceCents,
     description,
     includesData: boolean, // snapshot or running?
   }
   ```

2. [ ] **POST /api/marketplace/buy**
   ```typescript
   // Initiate purchase
   {
     listingId,
     buyerWallet,
   }
   // Creates escrow, freezes instance
   ```

3. [ ] **Transfer flow:**
   ```
   Buyer pays → Escrow holds funds
   ↓
   Instance freezes (snapshot taken, original stopped)
   ↓
   Ownership transferred in Firestore
   ↓
   Buyer verifies (7 days)
   ↓
   If accepted: funds released to seller
   If rejected: refund buyer, revert ownership
   ```

4. [ ] **Payout logic:**
   ```typescript
   // After successful transfer:
   - Platform fee: 10% (to Agent Guild treasury)
   - Seller payout: 90%
   - Record in billingLedger
   ```

---

### Priority 4: Operational Hardening

1. **Provisioning Retries**
   ```typescript
   // If VM creation fails:
   - Retry 3 times with exponential backoff (2s, 4s, 8s)
   - If still fails: mark "error" with reason
   - Alert ops team after 3 failures
   ```

2. **Secret Injection**
   ```typescript
   // Don't use auto-generated passwords:
   - Generate SSH keypair per instance
   - Store public key in Firestore
   - Store private key in KMS/Vault
   - Inject via cloud-init
   - Delete keypair when instance deleted
   ```

3. **Real Usage Metering**
   ```typescript
   // Instead of estimated costs:
   - Query provider usage API hourly
   - Record actual usage (CPU hours, RAM GB, disk GB)
   - Calculate cost from provider pricing
   - Update billingLedger with reality
   ```

4. **Resource Cleanup**
   ```typescript
   // When instance deleted:
   - Delete VM
   - Delete NIC
   - Delete NSG
   - Delete Public IP (unless static + reserved)
   - Delete orphaned disks
   - Delete snapshots older than 30 days (unless pinned)
   ```

5. **Security Hardening**
   ```typescript
   // VNC/Terminal URLs:
   - One-time tokens (expire after first use)
   - Short TTL (5 min)
   - IP whitelist (optional)
   - Rate limit (10 URLs/min per user)

   // NSG rules:
   - Only allow VNC from Agent Guild IP ranges
   - Block SSH from internet (use Azure Bastion or SSM)
   - No RDP (unless Windows)
   ```

6. **Monitoring**
   ```typescript
   // Metrics to track:
   - Failed boots (status stuck in "starting" > 10 min)
   - Zombie instances (running but no Firestore record)
   - Orphaned resources (NIC without VM, etc.)
   - Cost drift (actual vs estimated)
   - API errors by provider (429, 500, 503)

   // Alerts:
   - > 5% failed boots → page on-call
   - > 10 zombie instances → Slack warning
   - Cost drift > 20% → daily email
   ```

---

## Blunt Ranking: What to Build Next

### Tier 1: Must Have for Beta

1. ✅ Clone validation (DONE)
2. ✅ Snapshot validation (DONE)
3. ⏳ Azure networking (code written, needs testing/application)
4. 🔴 Provider health checks (readiness probes)
5. 🔴 Orphan resource cleanup
6. 🔴 One provider 100% done (E2B recommended)

### Tier 2: Must Have for Launch

7. 🔴 Real marketplace listing API
8. 🔴 Transfer escrow flow
9. 🔴 Payout logic
10. 🔴 Secret management (SSH keys)
11. 🔴 Usage metering from provider
12. 🔴 Idempotent operations

### Tier 3: Nice to Have

13. 🔴 Multi-cloud (AWS, GCP beyond stub)
14. 🔴 GPU support
15. 🔴 Kubernetes integration
16. 🔴 Advanced monitoring/alerting

---

## Files Modified Today

### Clone Fix
- `AgentGuildApp/src/app/api/compute/computers/[id]/clone/route.ts`
  - Now validates provider instance exists
  - Calls `provider.cloneInstance()`
  - Returns new VM ID
  - Fails cleanly without provider backing

### Snapshot Fix
- `AgentGuildApp/src/app/api/compute/computers/[id]/snapshot/route.ts`
  - Removed synthetic snapshot fallback
  - Requires provider instance
  - Returns 501 if not supported

### State Management (Yesterday)
- `AgentGuildApp/src/app/api/compute/computers/[id]/start/route.ts`
  - Auto-recovery from stuck states
  - Better error messages
- `AgentGuildApp/src/app/api/compute/computers/[id]/status/route.ts` (new)
  - Debugging endpoint for stuck instances
- `AgentGuildApp/src/app/api/compute/computers/[id]/force-reset/route.ts` (new)
  - Manual recovery tool

---

## Next Steps (Recommended Order)

1. **Apply Azure networking fix** (code written, needs testing)
   - Test NIC, Public IP, NSG creation
   - Verify VNC access works
   - Test cleanup on delete

2. **Implement Azure clone properly**
   ```typescript
   async cloneInstance(vmName, newName) {
     // 1. Stop source VM
     await this.stopInstance(vmName);

     // 2. Snapshot OS disk
     const snapshotId = await this.createSnapshot(vmName, "clone-snapshot");

     // 3. Create new VM from snapshot
     const newVmId = await this.createVmFromSnapshot(snapshotId, newName);

     // 4. Restart source VM (if was running)
     // 5. Delete temporary snapshot
     // 6. Return new VM ID
     return newVmId;
   }
   ```

3. **Add provider readiness checks**
   ```typescript
   // After VM created, before marking "running":
   - Poll provider status API until "running"
   - Try SSH connection (or VNC)
   - Timeout after 10 minutes
   - If timeout: mark "error", include last known state
   ```

4. **Stub provider detection**
   ```typescript
   // On app start:
   const providers = {
     e2b: !!process.env.E2B_API_KEY,
     azure: !!process.env.AZURE_SUBSCRIPTION_ID,
     aws: !!process.env.AWS_ACCESS_KEY_ID,
     gcp: !!process.env.GOOGLE_APPLICATION_CREDENTIALS,
   };

   // Expose via API:
   GET /api/providers/status
   {
     e2b: { available: true, reason: null },
     azure: { available: false, reason: "Missing AZURE_SUBSCRIPTION_ID" },
     ...
   }

   // UI: Gray out unavailable providers
   ```

5. **Build marketplace MVP**
   - Start with listing API
   - Add "Buy Now" button (no escrow yet)
   - Immediate ownership transfer (no freeze/verify yet)
   - Manual payout (admin transfers funds)
   - Iterate from there

---

## Summary

**Fixed today:**
- ✅ Clone now actually clones VMs (not just metadata)
- ✅ Snapshots require provider backing (no synthetic IDs)
- ✅ Both fail cleanly with helpful errors

**Still critical gaps:**
- Provider state fidelity (no readiness checks)
- Azure networking incomplete (code written, needs application)
- No provider 100% production-ready
- No real marketplace beyond schema
- Operational hardening missing (cleanup, monitoring, secrets)

**Recommended path forward:**
1. Finish Azure networking
2. Add readiness checks
3. Orphan cleanup job
4. Marketplace listing API
5. Real usage metering

**The platform has strong bones (schema, auth, multi-instance scaling), but needs provider-level rigor to go production.**
