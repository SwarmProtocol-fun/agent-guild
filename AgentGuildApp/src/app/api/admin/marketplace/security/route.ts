/**
 * GET /api/admin/marketplace/security
 * POST /api/admin/marketplace/security
 *
 * Security dashboard: scan stats, flagged items, permission risk overview,
 * and re-scan actions.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { requirePlatformAdmin } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import { runSecurityScan, type ReviewEntry, type ExtendedScanOptions } from "@/lib/submission-protocol";
import type { PermissionScope } from "@/lib/skills";

interface FlaggedItem {
  id: string;
  source: "community" | "agents";
  name: string;
  status: string;
  scanSeverity: string;
  findingsCount: number;
  findings: string[];
  permissionsRequired?: string[];
  submittedBy: string;
  lastScannedAt?: string;
}

interface HighRiskItem {
  id: string;
  source: string;
  name: string;
  permissions: string[];
  riskReason: string;
}

/** GET — Security dashboard stats + flagged items */
export async function GET(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const severityFilter = req.nextUrl.searchParams.get("severity") || "all";

  try {
    const flaggedItems: FlaggedItem[] = [];
    const highRiskItems: HighRiskItem[] = [];
    let totalScansRun = 0;
    let criticalFindings = 0;
    let highFindings = 0;
    let mediumFindings = 0;
    let lowFindings = 0;
    let suspendedForSecurity = 0;

    // Process both collections
    const collections: { name: string; source: "community" | "agents" }[] = [
      { name: "communityMarketItems", source: "community" },
      { name: "marketplaceAgents", source: "agents" },
    ];

    for (const col of collections) {
      const snap = await adminDb().collection(col.name).get();

      for (const d of snap.docs) {
        const data = d.data();
        const reviewHistory: ReviewEntry[] = Array.isArray(data.reviewHistory) ? data.reviewHistory : [];
        const permissions = (data.permissionsRequired || []) as PermissionScope[];

        // Check for security scan in review history
        const scanEntries = reviewHistory.filter((h) => h.stage === "security_scan");
        if (scanEntries.length > 0) totalScansRun++;

        // Build extended scan options from available data
        const extended: ExtendedScanOptions = {};
        if (data.dependencies) extended.dependencies = data.dependencies;
        if (data.devDependencies) extended.devDependencies = data.devDependencies;
        if (data.scripts) extended.scripts = data.scripts;
        if (data.license) extended.license = data.license;
        if (data.sourceUrl) extended.sourceUrl = data.sourceUrl;
        if (data.demoUrl) extended.demoUrl = data.demoUrl;
        if (typeof data.rejectedCount === "number") extended.publisherRejections = data.rejectedCount;

        // Run live security scan (with extended checks)
        const scanResult = runSecurityScan(
          data.description || "",
          data.modManifest,
          permissions,
          Object.keys(extended).length > 0 ? extended : undefined,
        );

        // Count findings by severity
        if (scanResult.severity === "critical") criticalFindings++;
        else if (scanResult.severity === "high") highFindings++;
        else if (scanResult.severity === "medium") mediumFindings++;
        else if (scanResult.severity === "low") lowFindings++;

        // Check if suspended for security reasons
        if (data.status === "suspended" && data.suspendReason?.toLowerCase().includes("security")) {
          suspendedForSecurity++;
        }

        // Add to flagged items if has findings
        if (scanResult.findings.length > 0) {
          if (severityFilter === "all" || scanResult.severity === severityFilter) {
            const lastScan = scanEntries[scanEntries.length - 1];
            flaggedItems.push({
              id: d.id,
              source: col.source,
              name: data.name || data.title || "Untitled",
              status: data.status || "unknown",
              scanSeverity: scanResult.severity,
              findingsCount: scanResult.findings.length,
              findings: scanResult.findings,
              permissionsRequired: permissions,
              submittedBy: data.submittedBy || data.authorWallet || "unknown",
              lastScannedAt: lastScan?.reviewedAt,
            });
          }
        }

        // Check for high-risk permission combos
        const hasWallet = permissions.includes("wallet_access");
        const hasExternal = permissions.includes("external_api");
        const hasSensitive = permissions.includes("sensitive_data_access");

        if ((hasWallet && hasExternal) || hasSensitive) {
          const reasons: string[] = [];
          if (hasWallet && hasExternal) reasons.push("wallet_access + external_api (exfiltration vector)");
          if (hasSensitive) reasons.push("sensitive_data_access (requires manual review)");

          highRiskItems.push({
            id: d.id,
            source: col.source,
            name: data.name || data.title || "Untitled",
            permissions,
            riskReason: reasons.join("; "),
          });
        }
      }
    }

    // Sort flagged items by severity
    const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
    flaggedItems.sort((a, b) => (severityOrder[a.scanSeverity] ?? 4) - (severityOrder[b.scanSeverity] ?? 4));

    return Response.json({
      ok: true,
      stats: {
        totalScansRun,
        criticalFindings,
        highFindings,
        mediumFindings,
        lowFindings,
        suspendedForSecurity,
      },
      flaggedItems,
      highRiskPermissions: highRiskItems,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch security data",
    }, { status: 500 });
  }
}

/** POST — Re-scan action */
export async function POST(req: NextRequest) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const body = await req.json();
  const { action, itemId, collection: colParam } = body as {
    action: "rescan";
    itemId: string;
    collection?: string;
  };

  if (action !== "rescan" || !itemId) {
    return Response.json({ error: "action must be 'rescan' and itemId required" }, { status: 400 });
  }

  const colName = colParam === "agents" ? "marketplaceAgents" : "communityMarketItems";

  try {
    const ref = adminDb().collection(colName).doc(itemId);
    const snap = await ref.get();

    if (!snap.exists) {
      return Response.json({ error: "Item not found" }, { status: 404 });
    }

    const data = snap.data()!;
    const permissions = (data.permissionsRequired || []) as PermissionScope[];

    // Build extended scan options
    const extended: ExtendedScanOptions = {};
    if (data.dependencies) extended.dependencies = data.dependencies;
    if (data.devDependencies) extended.devDependencies = data.devDependencies;
    if (data.scripts) extended.scripts = data.scripts;
    if (data.license) extended.license = data.license;
    if (data.sourceUrl) extended.sourceUrl = data.sourceUrl;
    if (data.demoUrl) extended.demoUrl = data.demoUrl;

    const scanResult = runSecurityScan(
      data.description || "",
      data.modManifest,
      permissions,
      Object.keys(extended).length > 0 ? extended : undefined,
    );

    // Append new ReviewEntry
    const reviewHistory: ReviewEntry[] = Array.isArray(data.reviewHistory) ? data.reviewHistory : [];
    reviewHistory.push({
      stage: "security_scan",
      result: scanResult.passed ? "passed" : "failed",
      reviewedBy: "platform-admin",
      reviewedAt: new Date().toISOString(),
      comment: "Manual re-scan triggered",
      findings: scanResult.findings,
    });

    await ref.update({ reviewHistory });

    await recordAuditEntry({
      action: "security.rescan",
      performedBy: "platform-admin",
      targetType: "submission",
      targetId: itemId,
      metadata: {
        collection: colParam || "community",
        severity: scanResult.severity,
        findingsCount: scanResult.findings.length,
        passed: scanResult.passed,
      },
    }).catch(() => {});

    return Response.json({
      ok: true,
      itemId,
      scan: scanResult,
      reviewEntryAdded: true,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Re-scan failed",
    }, { status: 500 });
  }
}
