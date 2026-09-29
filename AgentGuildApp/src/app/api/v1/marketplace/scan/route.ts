/**
 * POST /api/v1/marketplace/scan
 *
 * Public pre-scan endpoint: lets publishers test their submission
 * against the security pipeline before actually submitting.
 * Returns findings without creating any Firestore records.
 *
 * Rate-limited: 10 scans/hour per wallet.
 */

import { NextRequest } from "next/server";
import {
    runSecurityScan,
    runDependencyAudit,
    runLicenseCheck,
    runSourceValidation,
    type SecurityScanResult,
    type ExtendedScanOptions,
} from "@/lib/submission-protocol";
import { checkRateLimit } from "@/lib/rate-limit-firestore";
import type { PermissionScope } from "@/lib/skills";

interface ScanRequest {
    description: string;
    permissions?: PermissionScope[];
    manifest?: { tools?: string[]; workflows?: string[]; agentSkills?: string[] };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    license?: string;
    sourceUrl?: string;
    demoUrl?: string;
}

export async function POST(req: NextRequest) {
    // Auth: wallet or agent header
    const wallet =
        req.headers.get("x-wallet-address")?.toLowerCase() ||
        req.headers.get("x-agent-id")?.toLowerCase();

    if (!wallet) {
        return Response.json(
            { error: "Authentication required (wallet or agent header)" },
            { status: 401 },
        );
    }

    // Rate limit: 10 scans per hour
    const rateCheck = await checkRateLimit(`prescan:${wallet}`, {
        max: 10,
        windowMs: 60 * 60 * 1000,
    });
    if (!rateCheck.allowed) {
        return Response.json(
            { error: "Rate limit exceeded — max 10 pre-scans per hour", remaining: rateCheck.remaining },
            { status: 429 },
        );
    }

    const body = (await req.json()) as ScanRequest;

    if (!body.description || typeof body.description !== "string") {
        return Response.json(
            { error: "description (string) is required" },
            { status: 400 },
        );
    }

    // Run the full security scan with extended options
    const extended: ExtendedScanOptions = {};
    if (body.dependencies) extended.dependencies = body.dependencies;
    if (body.devDependencies) extended.devDependencies = body.devDependencies;
    if (body.scripts) extended.scripts = body.scripts;
    if (body.license) extended.license = body.license;
    if (body.sourceUrl) extended.sourceUrl = body.sourceUrl;
    if (body.demoUrl) extended.demoUrl = body.demoUrl;

    const securityResult = runSecurityScan(
        body.description,
        body.manifest,
        body.permissions,
        Object.keys(extended).length > 0 ? extended : undefined,
    );

    // Also run standalone checks for detailed breakdown
    const depResult = (body.dependencies || body.devDependencies)
        ? runDependencyAudit(body.dependencies, body.devDependencies, body.scripts)
        : null;

    const licenseResult = body.license !== undefined
        ? runLicenseCheck(body.license)
        : null;

    const sourceResult = (body.sourceUrl || body.demoUrl)
        ? runSourceValidation(body.sourceUrl, body.demoUrl)
        : null;

    return Response.json({
        ok: true,
        scan: {
            passed: securityResult.passed,
            severity: securityResult.severity,
            totalFindings: securityResult.findings.length,
            findings: securityResult.findings,
        },
        breakdown: {
            dependencies: depResult ? {
                passed: depResult.passed,
                severity: depResult.severity,
                findings: depResult.findings,
            } : null,
            license: licenseResult ? {
                passed: licenseResult.passed,
                severity: licenseResult.severity,
                findings: licenseResult.findings,
            } : null,
            source: sourceResult ? {
                passed: sourceResult.passed,
                severity: sourceResult.severity,
                findings: sourceResult.findings,
            } : null,
        },
        rateLimit: {
            remaining: rateCheck.remaining,
        },
    });
}
