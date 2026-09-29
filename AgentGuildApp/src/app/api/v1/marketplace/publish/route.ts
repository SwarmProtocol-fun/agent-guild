/**
 * POST /api/v1/marketplace/publish
 *
 * Unified publish endpoint for all marketplace item types.
 * Integrates Agent Guild Submission Protocol v1: intake validation, security scanning,
 * trust-tier-aware pipeline routing, and cooldown enforcement.
 *
 * Auth: x-wallet-address header (wallet-based) or platform admin secret (auto-approves).
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requirePlatformAdmin } from "@/lib/auth-guard";
import { enforceCreditPolicy } from "@/lib/credit-enforcement";
import { adminDb } from "@/lib/firebase-admin";
import type {
    MarketItemType,
    MarketPricing,
    AgentDistribution,
    PermissionScope,
} from "@/lib/skills";
import { submitMarketItem, publishAgentPackage } from "@/lib/firestore-admin";
import {
    runIntakeValidation,
    runSecurityScan,
    recordSubmission,
    getStartingStage,
    type ReviewEntry,
} from "@/lib/submission-protocol";
import { getMarketplaceSettings } from "@/lib/marketplace-settings";

const VALID_TYPES: MarketItemType[] = ["mod", "plugin", "skill", "skin", "agent", "compute"];
const VALID_TRACKS = ["prd_only", "open_repo", "private_repo", "managed_partner"] as const;

export async function POST(req: NextRequest) {
    // Auth — wallet or platform admin
    const wallet = getWalletAddress(req);
    const admin = requirePlatformAdmin(req);
    if (!wallet && !admin.ok) {
        return Response.json(
            { error: "Authentication required. Provide x-wallet-address header or platform admin secret." },
            { status: 401 },
        );
    }
    const publisherWallet = wallet || "platform-admin";

    // Parse body
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    // Validate required fields
    const name = (body.name as string)?.trim().slice(0, 100);
    const type = body.type as string;
    const category = (body.category as string)?.trim().slice(0, 50);
    const icon = (body.icon as string)?.trim().slice(0, 10);
    const description = (body.description as string)?.trim().slice(0, 2000);

    if (!name || !type || !category || !icon || !description) {
        return Response.json(
            { error: "Required fields: name, type, category, icon, description" },
            { status: 400 },
        );
    }

    if (!VALID_TYPES.includes(type as MarketItemType)) {
        return Response.json(
            { error: `Invalid type. Must be one of: ${VALID_TYPES.join(", ")}` },
            { status: 400 },
        );
    }

    const version = ((body.version as string) || "1.0.0").trim().slice(0, 20);
    const tags = Array.isArray(body.tags)
        ? (body.tags as string[]).map(t => String(t).trim().slice(0, 50)).filter(Boolean).slice(0, 20)
        : [];
    const requiredKeys = Array.isArray(body.requiredKeys)
        ? (body.requiredKeys as string[]).map(k => String(k).trim()).filter(Boolean)
        : undefined;
    const publisherName = ((body.publisherName as string) || publisherWallet.slice(0, 8) + "...").trim();

    // ── Credit Policy Enforcement ──
    // Platform admins bypass credit checks
    if (!admin.ok && wallet) {
        try {
            const agentSnap = await adminDb().collection("agents").where("walletAddress", "==", wallet).get();
            if (!agentSnap.empty) {
                const agentId = agentSnap.docs[0].id;
                const enforcement = await enforceCreditPolicy(agentId, "publish_marketplace");
                if (!enforcement.allowed) {
                    return Response.json({
                        error: "Credit policy violation",
                        reason: enforcement.reason,
                        currentScore: enforcement.currentScore,
                        requiredScore: enforcement.requiredScore,
                        currentBand: enforcement.currentBand,
                    }, { status: 403 });
                }
            }
        } catch (err) {
            // Fail-open: log warning but don't block publishing
            console.warn("[marketplace/publish] Credit enforcement check failed (fail-open):", err);
        }
    }

    // ── Submission Protocol v1: Intake Validation ──
    // Platform admins bypass intake checks
    if (!admin.ok) {
        const intake = await runIntakeValidation(publisherWallet, name, description, type as MarketItemType, publisherName);
        if (!intake.passed) {
            return Response.json(
                { error: "Intake validation failed", reasons: intake.reasons },
                { status: 429 },
            );
        }
    }

    // ── Submission Protocol v1: Security Scan ──
    const modManifest = body.modManifest as { tools?: string[]; workflows?: string[]; agentSkills?: string[] } | undefined;
    const permissionsRequired = Array.isArray(body.permissionsRequired)
        ? (body.permissionsRequired as string[]).filter(p =>
            ["read", "write", "execute", "external_api", "wallet_access", "webhook_access", "cross_chain_message", "sensitive_data_access"].includes(p),
        ) as PermissionScope[]
        : undefined;

    const secScan = runSecurityScan(description, modManifest, permissionsRequired);
    if (!secScan.passed) {
        return Response.json(
            { error: "Security scan failed — critical issues detected", findings: secScan.findings },
            { status: 400 },
        );
    }

    // ── Settings enforcement ──
    const settings = await getMarketplaceSettings();

    if (!admin.ok) {
        // Blocked keywords check
        if (settings.blockedKeywords.length > 0) {
            const lowerName = name.toLowerCase();
            const lowerDesc = description.toLowerCase();
            const matched = settings.blockedKeywords.find(
                (kw) => lowerName.includes(kw.toLowerCase()) || lowerDesc.includes(kw.toLowerCase()),
            );
            if (matched) {
                return Response.json(
                    { error: `Submission contains a blocked keyword: "${matched}"` },
                    { status: 400 },
                );
            }
        }

        // Require demo URL
        const demoUrlRaw = (body.demoUrl as string)?.trim();
        if (settings.requireDemoUrl && !demoUrlRaw) {
            return Response.json(
                { error: "A demo URL is required for submissions" },
                { status: 400 },
            );
        }

        // Require screenshots
        const screenshotUrls = Array.isArray(body.screenshotUrls) ? body.screenshotUrls : [];
        if (settings.requireScreenshots && screenshotUrls.length === 0) {
            return Response.json(
                { error: "At least one screenshot is required for submissions" },
                { status: 400 },
            );
        }

        // Allowed categories enforcement
        if (settings.allowedCategories.length > 0 && !settings.allowedCategories.includes(category)) {
            return Response.json(
                { error: `Category "${category}" is not allowed. Allowed: ${settings.allowedCategories.join(", ")}` },
                { status: 400 },
            );
        }
    }

    // ── Submission Protocol v1: Parse new fields ──
    const submissionType = body.submissionType === "concept" ? "concept" as const : "build" as const;
    const rawTrack = body.submissionTrack as string | undefined;
    const submissionTrack = rawTrack && VALID_TRACKS.includes(rawTrack as typeof VALID_TRACKS[number])
        ? rawTrack as typeof VALID_TRACKS[number]
        : undefined;
    const repoUrl = (body.repoUrl as string)?.trim().slice(0, 500) || undefined;
    const demoUrl = (body.demoUrl as string)?.trim().slice(0, 500) || undefined;
    const updateOf = (body.updateOf as string)?.trim() || undefined;

    // Build initial review history entry
    const intakeEntry: ReviewEntry = {
        stage: "intake",
        result: "passed",
        reviewedBy: "system",
        reviewedAt: new Date().toISOString(),
        findings: secScan.findings.length > 0 ? secScan.findings : undefined,
    };

    try {
        let id: string;
        let status: string;
        let stage: string;

        if (type === "agent") {
            // Agent/Persona publishing — uses publishAgentPackage()
            const identity = body.identity as Record<string, unknown> | undefined;
            const agentPricing = body.agentPricing as Record<string, unknown> | undefined;
            const distributions = Array.isArray(body.distributions)
                ? (body.distributions as string[]).filter(d => ["config", "rental", "hire"].includes(d)) as AgentDistribution[]
                : ["config" as AgentDistribution];

            id = await publishAgentPackage({
                slug: name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""),
                name,
                version,
                description,
                longDescription: (body.longDescription as string)?.trim().slice(0, 5000) || undefined,
                author: publisherName,
                authorWallet: publisherWallet,
                icon,
                category: category.toLowerCase().replace(/\s+/g, "-") as "general",
                tags,
                distributions,
                pricing: {
                    configPurchase: agentPricing?.configPurchase as number | undefined,
                    rentalMonthly: agentPricing?.rentalMonthly as number | undefined,
                    rentalUsage: agentPricing?.rentalUsage as number | undefined,
                    rentalPerformance: agentPricing?.rentalPerformance as number | undefined,
                    hirePerTask: agentPricing?.hirePerTask as number | undefined,
                    currency: ((agentPricing?.currency as string) === "HBAR" ? "HBAR" : "USD"),
                },
                identity: {
                    agentType: (identity?.agentType as string) || "General",
                    persona: (identity?.persona as string) || description,
                    personality: Array.isArray(identity?.personality) ? identity.personality as string[] : undefined,
                    rules: Array.isArray(identity?.rules) ? identity.rules as string[] : undefined,
                    systemPrompt: (identity?.systemPrompt as string) || undefined,
                },
                requiredSkills: Array.isArray(body.requiredSkills) ? body.requiredSkills as string[] : [],
                requiredMods: Array.isArray(body.requiredMods) ? body.requiredMods as string[] : undefined,
                requiredKeys,
                soulTemplate: body.soulTemplate as import("@/lib/soul").SOULConfig | undefined,
                workflows: Array.isArray(body.workflows) ? body.workflows as [] : undefined,
                policy: body.policy as undefined,
                memory: body.memory as undefined,
                source: admin.ok ? "verified" : "community",
                creatorRevShare: 0.85,
            });
            status = "review";
            stage = admin.ok ? "decision" : "security_scan";
        } else {
            // Standard item — mod, plugin, skill, skin
            const pricing: MarketPricing = (body.pricing as MarketPricing) || { model: "free" as const };

            // Determine starting stage based on publisher tier (admin = auto-approve)
            // Intake validation already looked up the publisher tier; use it with settings threshold
            const publisherTier = 0; // Default; intake enriches this during validation
            const effectiveStage = getStartingStage(publisherTier >= settings.autoApproveForTier ? 3 : publisherTier);
            const startStage = admin.ok ? "decision" : effectiveStage;
            const itemStatus = admin.ok ? "approved" : (startStage === "decision" ? "approved" : "pending");

            id = await submitMarketItem({
                name,
                type: type as MarketItemType,
                category,
                icon,
                description,
                longDescription: (body.longDescription as string)?.trim().slice(0, 5000) || undefined,
                version,
                tags,
                requiredKeys,
                pricing,
                submittedBy: publisherWallet,
                submittedByName: publisherName,
                skinConfig: body.skinConfig as { colors?: Record<string, string>; features?: string[] } | undefined,
                computeConfig: body.computeConfig as { vCpu?: number; ramGb?: number; gpu?: string; region?: string; } | undefined,
                modManifest,
                submissionType,
                submissionTrack,
                stage: startStage,
                reviewHistory: [intakeEntry],
                repoUrl,
                demoUrl,
                permissionsRequired,
                updateOf,
            }, { status: itemStatus, stage: startStage });
            status = itemStatus;
            stage = startStage;
        }

        // Record submission for cooldown + quota tracking (skip for admins)
        if (!admin.ok) {
            await recordSubmission(publisherWallet);
        }

        return Response.json({
            published: true,
            id,
            type,
            status,
            stage,
            name,
            securityFindings: secScan.findings.length > 0 ? secScan.findings : undefined,
        });
    } catch (err) {
        return Response.json(
            { error: err instanceof Error ? err.message : "Failed to publish" },
            { status: 500 },
        );
    }
}
