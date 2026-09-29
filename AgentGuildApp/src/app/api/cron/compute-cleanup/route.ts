/**
 * POST /api/cron/compute-cleanup
 *
 * Daily cleanup job for the compute platform:
 *
 * 1. Orphan detection — Compare Azure VMs (tagged swarm:managed) to Firestore
 *    computeComputers. Delete Azure VMs that have no matching Firestore record.
 *
 * 2. Stuck instance recovery — Find instances stuck in transitional states
 *    (starting > 10min, stopping > 5min, provisioning > 15min) and mark as error.
 *
 * 3. Auto-stop enforcement — Stop instances that have been idle longer than
 *    their autoStopMinutes threshold.
 *
 * Auth: Platform admin or internal service secret
 * Trigger: Netlify cron (daily) or manual
 */
import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requirePlatformAdmin, requireInternalService } from "@/lib/auth-guard";
import { getComputer, updateComputer, deleteComputer } from "@/lib/compute/firestore";
import { getComputeProvider } from "@/lib/compute/provider";
import type { Computer, ComputerStatus } from "@/lib/compute/types";

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function toDate(val: unknown): Date | null {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === "object" && typeof (val as { toDate?: unknown }).toDate === "function") {
    return (val as { toDate(): Date }).toDate();
  }
  if (typeof val === "number" || typeof val === "string") {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

interface CleanupResults {
  orphansDeleted: number;
  orphanDetails: Array<{ vmName: string; reason: string }>;
  stuckRecovered: number;
  stuckDetails: Array<{ id: string; name: string; status: string; stuckMinutes: number }>;
  autoStopped: number;
  autoStopDetails: Array<{ id: string; name: string; idleMinutes: number }>;
  errors: string[];
}

// ═══════════════════════════════════════════════════════════════
// Azure Orphan Detection
// ═══════════════════════════════════════════════════════════════

async function listAzureSwarmVMs(): Promise<Array<{ name: string; tags: Record<string, string> }>> {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP || "swarm-compute";

  if (!subscriptionId) return [];

  try {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const { DefaultAzureCredential } = await import("@azure/identity");
    const credential = new DefaultAzureCredential();
    const client = new ComputeManagementClient(credential, subscriptionId);

    const vms: Array<{ name: string; tags: Record<string, string> }> = [];
    for await (const vm of client.virtualMachines.list(resourceGroup)) {
      // Only consider VMs tagged as managed by Swarm
      if (vm.tags?.["swarm:managed"] === "true" && vm.name) {
        vms.push({ name: vm.name, tags: vm.tags || {} });
      }
    }
    return vms;
  } catch (err) {
    console.error("[compute-cleanup] Failed to list Azure VMs:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

async function deleteAzureVM(vmName: string): Promise<void> {
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP || "swarm-compute";

  const { ComputeManagementClient } = await import("@azure/arm-compute");
  const { NetworkManagementClient } = await import("@azure/arm-network");
  const { DefaultAzureCredential } = await import("@azure/identity");
  const credential = new DefaultAzureCredential();
  const computeClient = new ComputeManagementClient(credential, subscriptionId);
  const networkClient = new NetworkManagementClient(credential, subscriptionId);

  // Get associated resources from tags before deleting
  let nicName: string | undefined;
  let nsgName: string | undefined;
  let publicIpName: string | undefined;

  try {
    const vm = await computeClient.virtualMachines.get(resourceGroup, vmName);
    nicName = vm.tags?.["swarm:nic"];
    nsgName = vm.tags?.["swarm:nsg"];
    publicIpName = vm.tags?.["swarm:ip"];
  } catch {
    nicName = `${vmName}-nic`;
    nsgName = `${vmName}-nsg`;
    publicIpName = `${vmName}-ip`;
  }

  // Delete VM
  console.log(`[compute-cleanup] Deleting orphan VM: ${vmName}`);
  try {
    await computeClient.virtualMachines.beginDeleteAndWait(resourceGroup, vmName);
  } catch (err) {
    console.warn(`[compute-cleanup] Failed to delete VM ${vmName}:`, err instanceof Error ? err.message : String(err));
  }

  // Cleanup associated networking resources
  if (nicName) {
    try { await networkClient.networkInterfaces.beginDeleteAndWait(resourceGroup, nicName); } catch { /* ignore */ }
  }
  if (nsgName) {
    try { await networkClient.networkSecurityGroups.beginDeleteAndWait(resourceGroup, nsgName); } catch { /* ignore */ }
  }
  if (publicIpName) {
    try { await networkClient.publicIPAddresses.beginDeleteAndWait(resourceGroup, publicIpName); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// Firestore Queries
// ═══════════════════════════════════════════════════════════════

async function getAllComputeComputers(): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const snap = await adminDb().collection("computeComputers").get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
}

// ═══════════════════════════════════════════════════════════════
// Route Handler
// ═══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  // Auth: platform admin or internal service
  const admin = requirePlatformAdmin(req);
  const service = requireInternalService(req);
  if (!admin.ok && !service.ok) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: CleanupResults = {
    orphansDeleted: 0,
    orphanDetails: [],
    stuckRecovered: 0,
    stuckDetails: [],
    autoStopped: 0,
    autoStopDetails: [],
    errors: [],
  };

  const now = Date.now();

  try {
    // ── 1. Orphan Detection ──────────────────────────────
    // Compare Azure VMs to Firestore records
    const [azureVMs, firestoreComputers] = await Promise.all([
      listAzureSwarmVMs(),
      getAllComputeComputers(),
    ]);

    // Build a set of all providerInstanceIds in Firestore
    const knownProviderIds = new Set<string>();
    for (const fc of firestoreComputers) {
      const pid = fc.data.providerInstanceId as string | null;
      if (pid) knownProviderIds.add(pid);
    }

    // Find Azure VMs not tracked in Firestore
    for (const vm of azureVMs) {
      if (!knownProviderIds.has(vm.name)) {
        console.warn(`[compute-cleanup] Orphan detected: Azure VM "${vm.name}" has no Firestore record`);
        try {
          await deleteAzureVM(vm.name);
          results.orphansDeleted++;
          results.orphanDetails.push({ vmName: vm.name, reason: "No matching Firestore record" });
        } catch (err) {
          results.errors.push(`Failed to delete orphan VM ${vm.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Also check for Firestore records pointing to VMs that don't exist in Azure
    const azureVMNames = new Set(azureVMs.map((v) => v.name));
    for (const fc of firestoreComputers) {
      const provider = fc.data.provider as string;
      const pid = fc.data.providerInstanceId as string | null;
      const status = fc.data.status as ComputerStatus;

      if (provider === "azure" && pid && !azureVMNames.has(pid) && status !== "stopped" && status !== "error") {
        console.warn(`[compute-cleanup] Firestore computer "${fc.id}" references missing Azure VM "${pid}"`);
        try {
          await updateComputer(fc.id, {
            status: "error",
            providerMetadata: {
              ...(fc.data.providerMetadata as Record<string, unknown> || {}),
              cleanupError: `Azure VM "${pid}" not found — may have been externally deleted`,
              cleanupAt: new Date().toISOString(),
            },
          });
          results.stuckRecovered++;
          results.stuckDetails.push({
            id: fc.id,
            name: fc.data.name as string,
            status: status,
            stuckMinutes: 0,
          });
        } catch (err) {
          results.errors.push(`Failed to update orphan record ${fc.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ── 2. Stuck Instance Recovery ───────────────────────
    const STUCK_THRESHOLDS: Record<string, number> = {
      starting: 10 * 60 * 1000,      // 10 minutes
      stopping: 5 * 60 * 1000,       // 5 minutes
      provisioning: 15 * 60 * 1000,  // 15 minutes
      snapshotting: 30 * 60 * 1000,  // 30 minutes
    };

    for (const fc of firestoreComputers) {
      const status = fc.data.status as string;
      const threshold = STUCK_THRESHOLDS[status];
      if (!threshold) continue;

      const updatedAt = toDate(fc.data.updatedAt);
      if (!updatedAt) continue;

      const elapsed = now - updatedAt.getTime();
      if (elapsed > threshold) {
        const stuckMinutes = Math.round(elapsed / 60_000);
        console.warn(`[compute-cleanup] Stuck instance: "${fc.id}" in "${status}" for ${stuckMinutes}m`);

        try {
          await updateComputer(fc.id, {
            status: "error",
            providerMetadata: {
              ...(fc.data.providerMetadata as Record<string, unknown> || {}),
              cleanupReason: `Stuck in "${status}" for ${stuckMinutes} minutes`,
              cleanupAt: new Date().toISOString(),
            },
          });
          results.stuckRecovered++;
          results.stuckDetails.push({
            id: fc.id,
            name: fc.data.name as string || "unknown",
            status,
            stuckMinutes,
          });
        } catch (err) {
          results.errors.push(`Failed to recover stuck instance ${fc.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ── 3. Auto-Stop Enforcement ─────────────────────────
    for (const fc of firestoreComputers) {
      if (fc.data.status !== "running") continue;

      const autoStopMinutes = (fc.data.autoStopMinutes as number) || 30;
      if (autoStopMinutes === 0) continue; // 0 = disabled

      const lastActive = toDate(fc.data.lastActiveAt);
      if (!lastActive) continue;

      const idleMs = now - lastActive.getTime();
      const idleMinutes = Math.round(idleMs / 60_000);

      if (idleMs > autoStopMinutes * 60 * 1000) {
        console.log(`[compute-cleanup] Auto-stopping "${fc.id}" — idle for ${idleMinutes}m (limit: ${autoStopMinutes}m)`);

        try {
          const provider = fc.data.provider as string;
          const providerInstanceId = fc.data.providerInstanceId as string | null;

          // Stop the provider instance
          if (providerInstanceId) {
            const computeProvider = getComputeProvider(provider);
            await computeProvider.stopInstance(providerInstanceId);
          }

          await updateComputer(fc.id, {
            status: "stopped",
            providerMetadata: {
              ...(fc.data.providerMetadata as Record<string, unknown> || {}),
              autoStoppedAt: new Date().toISOString(),
              autoStopReason: `Idle for ${idleMinutes} minutes (limit: ${autoStopMinutes})`,
            },
          });

          results.autoStopped++;
          results.autoStopDetails.push({
            id: fc.id,
            name: fc.data.name as string || "unknown",
            idleMinutes,
          });
        } catch (err) {
          results.errors.push(`Failed to auto-stop ${fc.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // ── Summary ──────────────────────────────────────────
    const totalActions = results.orphansDeleted + results.stuckRecovered + results.autoStopped;
    console.log(
      `[compute-cleanup] Complete: ${results.orphansDeleted} orphans deleted, ` +
      `${results.stuckRecovered} stuck recovered, ${results.autoStopped} auto-stopped, ` +
      `${results.errors.length} errors`,
    );

    return Response.json({
      success: true,
      summary: {
        totalActions,
        azureVMsScanned: azureVMs.length,
        firestoreRecordsScanned: firestoreComputers.length,
      },
      ...results,
    });
  } catch (err) {
    console.error("[compute-cleanup] Fatal error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Cleanup failed", partial: results },
      { status: 500 },
    );
  }
}
