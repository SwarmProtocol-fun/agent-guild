/**
 * Swarm Submission Protocol v1
 *
 * Core protocol for marketplace submissions: publisher profiles, trust tiers,
 * intake validation, security scanning, ranking scores, and pipeline management.
 *
 * Guiding principle: "Anyone can submit. Not everyone gets distribution."
 */

import { adminDb } from "./firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { checkRateLimit } from "./rate-limit-firestore";
import { scanForSecrets, hasCriticalSecrets } from "./secret-scanner";
import type { MarketItemType, PermissionScope } from "./skills";

// ═══════════════════════════════════════════════════════════════
// Publisher Profile
// ═══════════════════════════════════════════════════════════════

const PUBLISHER_COLLECTION = "publisherProfiles";

export interface PublisherProfile {
    id: string;
    walletAddress: string;
    displayName: string;
    tier: 0 | 1 | 2 | 3;
    totalSubmissions: number;
    approvedCount: number;
    rejectedCount: number;
    avgRating: number;
    totalInstalls: number;
    lastSubmissionAt: Date | null;
    cooldownUntil: Date | null;
    banned: boolean;
    banReason?: string;
    bannedAt?: Date | null;
    createdAt: Date | null;
    updatedAt: Date | null;
}

/** Get or create a publisher profile (upsert). */
export async function getOrCreatePublisher(
    wallet: string,
    displayName?: string,
): Promise<PublisherProfile> {
    const ref = adminDb().collection(PUBLISHER_COLLECTION).doc(wallet);
    const snap = await ref.get();

    if (snap.exists) {
        const data = snap.data()!;
        return {
            id: snap.id,
            walletAddress: data.walletAddress,
            displayName: data.displayName || wallet.slice(0, 8) + "...",
            tier: data.tier ?? 0,
            totalSubmissions: data.totalSubmissions ?? 0,
            approvedCount: data.approvedCount ?? 0,
            rejectedCount: data.rejectedCount ?? 0,
            avgRating: data.avgRating ?? 0,
            totalInstalls: data.totalInstalls ?? 0,
            lastSubmissionAt: data.lastSubmissionAt instanceof Timestamp ? data.lastSubmissionAt.toDate() : null,
            cooldownUntil: data.cooldownUntil instanceof Timestamp ? data.cooldownUntil.toDate() : null,
            banned: data.banned ?? false,
            banReason: data.banReason,
            bannedAt: data.bannedAt instanceof Timestamp ? data.bannedAt.toDate() : null,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
            updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt.toDate() : null,
        };
    }

    // Create new profile
    const profile: Omit<PublisherProfile, "id"> = {
        walletAddress: wallet,
        displayName: displayName || wallet.slice(0, 8) + "...",
        tier: 0,
        totalSubmissions: 0,
        approvedCount: 0,
        rejectedCount: 0,
        avgRating: 0,
        totalInstalls: 0,
        lastSubmissionAt: null,
        cooldownUntil: null,
        banned: false,
        createdAt: null,
        updatedAt: null,
    };

    await ref.set({
        ...profile,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
    });

    return { id: wallet, ...profile };
}

/** Recalculate publisher stats from their items and auto-upgrade tier. */
export async function updatePublisherStats(wallet: string): Promise<PublisherProfile> {
    const profile = await getOrCreatePublisher(wallet);

    // Count community items
    const communitySnap = await adminDb()
        .collection("communityMarketItems")
        .where("submittedBy", "==", wallet)
        .get();
    let approved = 0;
    let rejected = 0;
    let total = communitySnap.size;

    communitySnap.forEach((d) => {
        const s = d.data().status;
        if (s === "approved") approved++;
        if (s === "rejected") rejected++;
    });

    // Count agent packages
    const agentSnap = await adminDb()
        .collection("marketplaceAgents")
        .where("authorWallet", "==", wallet)
        .get();
    total += agentSnap.size;
    let totalInstalls = 0;
    let ratingSum = 0;
    let ratingCount = 0;

    agentSnap.forEach((d) => {
        const data = d.data();
        if (data.status === "approved") approved++;
        if (data.status === "rejected") rejected++;
        totalInstalls += data.installCount || 0;
        if (data.avgRating && data.ratingCount) {
            ratingSum += data.avgRating * data.ratingCount;
            ratingCount += data.ratingCount;
        }
    });

    const avgRating = ratingCount > 0 ? ratingSum / ratingCount : 0;
    const newTier = computeTier({ ...profile, approvedCount: approved, avgRating, totalInstalls });

    const ref = adminDb().collection(PUBLISHER_COLLECTION).doc(wallet);
    await ref.update({
        totalSubmissions: total,
        approvedCount: approved,
        rejectedCount: rejected,
        avgRating,
        totalInstalls,
        tier: newTier,
        updatedAt: FieldValue.serverTimestamp(),
    });

    return {
        ...profile,
        totalSubmissions: total,
        approvedCount: approved,
        rejectedCount: rejected,
        avgRating,
        totalInstalls,
        tier: newTier,
    };
}

// ═══════════════════════════════════════════════════════════════
// Trust Tiers
// ═══════════════════════════════════════════════════════════════

export const TIER_QUOTAS: Record<number, { maxPerWeek: number; cooldownMs: number }> = {
    0: { maxPerWeek: 2, cooldownMs: 4 * 60 * 60 * 1000 },    // 4hr
    1: { maxPerWeek: 5, cooldownMs: 4 * 60 * 60 * 1000 },    // 4hr
    2: { maxPerWeek: 20, cooldownMs: 1 * 60 * 60 * 1000 },   // 1hr
    3: { maxPerWeek: 999, cooldownMs: 0 },                     // Unlimited
};

export const TIER_NAMES: Record<number, string> = {
    0: "New Publisher",
    1: "Approved",
    2: "Trusted",
    3: "Strategic Partner",
};

export const TIER_COLORS: Record<number, string> = {
    0: "gray",
    1: "green",
    2: "blue",
    3: "amber",
};

/** Compute trust tier from publisher stats. Tier 3 is manual-only. */
export function computeTier(profile: Pick<PublisherProfile, "tier" | "approvedCount" | "avgRating" | "totalInstalls">): 0 | 1 | 2 | 3 {
    if (profile.tier === 3) return 3; // Manual grant, never auto-downgrade
    if (profile.approvedCount >= 5 && profile.avgRating >= 4.0 && profile.totalInstalls >= 100) return 2;
    if (profile.approvedCount >= 1) return 1;
    return 0;
}

/** Determine the starting pipeline stage based on publisher tier. */
export function getStartingStage(tier: number): SubmissionStage {
    switch (tier) {
        case 3: return "decision";       // Auto-approve
        case 2: return "product_review"; // Skip scan + sandbox
        case 1: return "security_scan";  // Skip sandbox only
        default: return "security_scan"; // Full pipeline
    }
}

/** Pipeline stage progression order. */
export const STAGE_ORDER: SubmissionStage[] = [
    "intake",
    "security_scan",
    "sandbox",
    "product_review",
    "decision",
];

/** Get the next stage after the current one, or null if at end. */
export function getNextStage(current: SubmissionStage): SubmissionStage | null {
    const idx = STAGE_ORDER.indexOf(current);
    if (idx === -1 || idx >= STAGE_ORDER.length - 1) return null;
    return STAGE_ORDER[idx + 1];
}

// ═══════════════════════════════════════════════════════════════
// Submission Pipeline
// ═══════════════════════════════════════════════════════════════

export type SubmissionStage =
    | "intake"
    | "security_scan"
    | "sandbox"
    | "product_review"
    | "decision";

export type SubmissionDecision = "approved" | "rejected" | "changes_requested" | "suspended";

export interface ReviewEntry {
    stage: SubmissionStage;
    result: "passed" | "failed" | "skipped";
    reviewedBy: string;
    reviewedAt: string; // ISO string for Firestore compatibility
    comment?: string;
    findings?: string[];
    /** CIDs of evidence artifacts attached by reviewer (screenshots, logs, etc.) */
    artifactCids?: string[];
}

// ═══════════════════════════════════════════════════════════════
// Intake Validation
// ═══════════════════════════════════════════════════════════════

export interface IntakeResult {
    passed: boolean;
    reasons: string[];
    publisher: PublisherProfile;
}

/** Run intake validation: ban check, cooldown, quota, duplicate detection. */
export async function runIntakeValidation(
    wallet: string,
    itemName: string,
    _itemDescription: string,
    _itemType: MarketItemType,
    displayName?: string,
): Promise<IntakeResult> {
    const reasons: string[] = [];
    const publisher = await getOrCreatePublisher(wallet, displayName);

    // 1. Ban check
    if (publisher.banned) {
        reasons.push(`Publisher banned: ${publisher.banReason || "policy violation"}`);
        return { passed: false, reasons, publisher };
    }

    // 2. Cooldown check
    if (publisher.cooldownUntil && Date.now() < publisher.cooldownUntil.getTime()) {
        const remaining = Math.ceil((publisher.cooldownUntil.getTime() - Date.now()) / 60000);
        reasons.push(`Cooldown active: ${remaining} minutes remaining`);
    }

    // 3. Weekly quota check
    const tierConfig = TIER_QUOTAS[publisher.tier] || TIER_QUOTAS[0];
    const quotaResult = await checkRateLimit(
        `submit:${wallet}`,
        { max: tierConfig.maxPerWeek, windowMs: 7 * 24 * 60 * 60 * 1000 },
    );
    if (!quotaResult.allowed) {
        reasons.push(`Weekly submission quota exceeded (${tierConfig.maxPerWeek}/week for ${TIER_NAMES[publisher.tier]} tier)`);
    }

    // 4. Duplicate name check (exact match, case-insensitive)
    const normalizedName = itemName.toLowerCase().trim().replace(/\s+/g, " ");
    const existingSnap = await adminDb()
        .collection("communityMarketItems")
        .where("status", "==", "approved")
        .get();
    for (const d of existingSnap.docs) {
        const existing = d.data().name as string;
        if (existing && existing.toLowerCase().trim().replace(/\s+/g, " ") === normalizedName) {
            reasons.push(`An item with the name "${existing}" already exists`);
            break;
        }
    }

    return { passed: reasons.length === 0, reasons, publisher };
}

/** Record that a submission was made (update cooldown + timestamp). */
export async function recordSubmission(wallet: string): Promise<void> {
    const publisher = await getOrCreatePublisher(wallet);
    const tierConfig = TIER_QUOTAS[publisher.tier] || TIER_QUOTAS[0];

    const ref = adminDb().collection(PUBLISHER_COLLECTION).doc(wallet);
    await ref.update({
        lastSubmissionAt: FieldValue.serverTimestamp(),
        cooldownUntil: tierConfig.cooldownMs > 0
            ? Timestamp.fromMillis(Date.now() + tierConfig.cooldownMs)
            : null,
        totalSubmissions: (publisher.totalSubmissions || 0) + 1,
        updatedAt: FieldValue.serverTimestamp(),
    });
}

// ═══════════════════════════════════════════════════════════════
// Security Scan
// ═══════════════════════════════════════════════════════════════

export interface SecurityScanResult {
    passed: boolean;
    findings: string[];
    severity: "none" | "low" | "medium" | "high" | "critical";
}

/** Calculate Shannon entropy (bits per character) for a string. */
function shannonEntropy(s: string): number {
    if (s.length === 0) return 0;
    const freq: Record<string, number> = {};
    for (const c of s) freq[c] = (freq[c] || 0) + 1;
    let entropy = 0;
    for (const count of Object.values(freq)) {
        const p = count / s.length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}

// Suspicious TLDs commonly used for phishing/malware
const SUSPICIOUS_TLDS = [".tk", ".ml", ".cf", ".ga", ".gq", ".top", ".buzz", ".loan"];

/** Extended scan options for deeper analysis */
export interface ExtendedScanOptions {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    license?: string;
    sourceUrl?: string;
    demoUrl?: string;
    publisherRejections?: number;
}

/** Run automated security scan on submission content. */
export function runSecurityScan(
    description: string,
    manifest?: { tools?: string[]; workflows?: string[]; agentSkills?: string[] },
    permissions?: PermissionScope[],
    extended?: ExtendedScanOptions,
): SecurityScanResult {
    const findings: string[] = [];
    let maxSeverity: SecurityScanResult["severity"] = "none";

    // 1. Scan description for secrets
    if (hasCriticalSecrets(description)) {
        findings.push("Description contains critical secrets (API keys, private keys)");
        maxSeverity = "critical";
    } else {
        const descScan = scanForSecrets(description);
        if (!descScan.clean) {
            for (const s of descScan.secrets) {
                findings.push(`${s.type} detected in description (${s.severity})`);
                if (severityRank(s.severity) > severityRank(maxSeverity)) {
                    maxSeverity = s.severity;
                }
            }
        }
    }

    // 2. Scan manifest content
    if (manifest) {
        const allText = [
            ...(manifest.tools || []),
            ...(manifest.workflows || []),
            ...(manifest.agentSkills || []),
        ].join("\n");

        if (allText && hasCriticalSecrets(allText)) {
            findings.push("Manifest content contains critical secrets");
            maxSeverity = "critical";
        }
    }

    // 3. Permission audit
    if (permissions && permissions.length > 0) {
        const hasWallet = permissions.includes("wallet_access");
        const hasExternal = permissions.includes("external_api");
        const hasSensitive = permissions.includes("sensitive_data_access");

        if (hasWallet && hasExternal) {
            findings.push("High-risk permission combo: wallet_access + external_api (potential exfiltration vector)");
            if (severityRank("high") > severityRank(maxSeverity)) maxSeverity = "high";
        }
        if (hasSensitive) {
            findings.push("Requests sensitive_data_access — requires manual review");
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }
    }

    // 4. URL validation — suspicious links in description
    const urlMatches = description.match(/https?:\/\/[^\s)">]+/gi) || [];
    for (const url of urlMatches) {
        const lower = url.toLowerCase();
        if (SUSPICIOUS_TLDS.some(tld => lower.includes(tld))) {
            findings.push(`URL with suspicious TLD: ${url.slice(0, 60)}`);
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }
        if (/https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(url)) {
            findings.push(`URL uses IP address instead of domain: ${url.slice(0, 60)}`);
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }
    }
    if (/data:[^;]+;base64,[A-Za-z0-9+/=]+/i.test(description)) {
        findings.push("Data URI detected in description (potential payload injection)");
        if (severityRank("high") > severityRank(maxSeverity)) maxSeverity = "high";
    }

    // 5. Obfuscation detection
    const allTextContent = [
        description,
        ...(manifest?.tools || []),
        ...(manifest?.workflows || []),
        ...(manifest?.agentSkills || []),
    ].join(" ");

    if (/[A-Za-z0-9+/]{50,}={0,2}/.test(allTextContent)) {
        findings.push("Suspicious base64 block detected — may contain obfuscated content");
        if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
    }
    if (/(?:0x)?[0-9a-fA-F]{40,}/.test(allTextContent)) {
        findings.push("Long hex-encoded string detected");
        if (severityRank("low") > severityRank(maxSeverity)) maxSeverity = "low";
    }
    const unicodeEscapes = allTextContent.match(/\\u[0-9a-fA-F]{4}/g);
    if (unicodeEscapes && unicodeEscapes.length > 5) {
        findings.push(`Excessive Unicode escape sequences (${unicodeEscapes.length}) — possible obfuscation`);
        if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
    }

    // 6. Manifest tool/workflow name validation
    if (manifest) {
        const suspiciousPattern = /\b(eval|exec|rm\s|curl\s|wget\s|shell|system|spawn|child_process|require\(|import\(|__proto__|constructor\[|Function\()/i;
        const allNames = [
            ...(manifest.tools || []),
            ...(manifest.workflows || []),
            ...(manifest.agentSkills || []),
        ];
        for (const entry of allNames) {
            if (suspiciousPattern.test(entry)) {
                findings.push(`Suspicious pattern in manifest entry: "${entry.slice(0, 80)}"`);
                if (severityRank("high") > severityRank(maxSeverity)) maxSeverity = "high";
            }
        }
    }

    // 7. Entropy analysis — detect high-entropy strings that may be hardcoded secrets
    const entropyRegex = /[A-Za-z0-9+/=_-]{20,}/g;
    let entropyMatch;
    while ((entropyMatch = entropyRegex.exec(allTextContent)) !== null) {
        const candidate = entropyMatch[0];
        if (candidate.length >= 20 && shannonEntropy(candidate) > 4.5) {
            if (!/^(https?|version|description|community|marketplace|submittedBy|publisherWallet)/i.test(candidate)) {
                findings.push(`High-entropy string detected (${candidate.length} chars, ${shannonEntropy(candidate).toFixed(1)} bits/char) — possible hardcoded secret`);
                if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
                break; // Report only first occurrence
            }
        }
    }

    // 8. Content size heuristic
    if (description.length > 10000) {
        findings.push(`Description is unusually long (${description.length} chars) — potential abuse`);
        if (severityRank("low") > severityRank(maxSeverity)) maxSeverity = "low";
    }

    // 9. Extended checks (if provided)
    if (extended) {
        // Dependency audit
        if (extended.dependencies || extended.devDependencies) {
            const depResult = runDependencyAudit(
                extended.dependencies,
                extended.devDependencies,
                extended.scripts,
            );
            for (const f of depResult.findings) {
                findings.push(f);
                if (severityRank(depResult.severity) > severityRank(maxSeverity)) {
                    maxSeverity = depResult.severity;
                }
            }
        }

        // License check
        if (extended.license !== undefined) {
            const licResult = runLicenseCheck(extended.license);
            for (const f of licResult.findings) {
                findings.push(f);
                if (severityRank(licResult.severity) > severityRank(maxSeverity)) {
                    maxSeverity = licResult.severity;
                }
            }
        }

        // Source URL validation
        if (extended.sourceUrl || extended.demoUrl) {
            const srcResult = runSourceValidation(extended.sourceUrl, extended.demoUrl);
            for (const f of srcResult.findings) {
                findings.push(f);
                if (severityRank(srcResult.severity) > severityRank(maxSeverity)) {
                    maxSeverity = srcResult.severity;
                }
            }
        }

        // Repeat offender check
        if (extended.publisherRejections && extended.publisherRejections > 2) {
            findings.push(`Publisher has ${extended.publisherRejections} prior rejections — elevated risk`);
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }
    }

    return {
        passed: maxSeverity !== "critical",
        findings,
        severity: maxSeverity,
    };
}

function severityRank(s: string): number {
    const ranks: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return ranks[s] ?? 0;
}

// ═══════════════════════════════════════════════════════════════
// Dependency Audit
// ═══════════════════════════════════════════════════════════════

/**
 * Known-malicious or compromised npm packages.
 * These have had confirmed supply chain attacks or were used for malware distribution.
 */
export const MALICIOUS_PACKAGES: string[] = [
    "event-stream",
    "flatmap-stream",
    "ua-parser-js",
    "coa",
    "rc",
    "colors",
    "faker",
    "node-ipc",
    "peacenotwar",
    "es5-ext",
    "lofygang",
    "cryptocoinview",
    "discord-selfbot-v14",
    "discord-lofy",
    "typosquatting-example",
    "@primordials/core",
    "crossenv",
    "cross-env.js",
    "mongose",
    "babelcli",
];

/** Dangerous install scripts that can execute arbitrary code */
const DANGEROUS_SCRIPTS = ["preinstall", "postinstall", "preuninstall", "postuninstall"];

export interface DependencyAuditResult {
    passed: boolean;
    findings: string[];
    severity: SecurityScanResult["severity"];
}

/** Audit dependency metadata for supply chain risks. */
export function runDependencyAudit(
    dependencies?: Record<string, string>,
    devDependencies?: Record<string, string>,
    scripts?: Record<string, string>,
): DependencyAuditResult {
    const findings: string[] = [];
    let maxSeverity: SecurityScanResult["severity"] = "none";

    const allDeps = { ...dependencies, ...devDependencies };
    const depNames = Object.keys(allDeps);

    // 1. Check for known-malicious packages
    for (const name of depNames) {
        if (MALICIOUS_PACKAGES.includes(name.toLowerCase())) {
            findings.push(`Known-malicious package: "${name}" — supply chain attack risk`);
            maxSeverity = "critical";
        }
    }

    // 2. Check for unpinned versions
    for (const [name, version] of Object.entries(allDeps)) {
        if (version === "*" || version === "latest" || version === "") {
            findings.push(`Unpinned dependency: "${name}": "${version}" — use a specific version range`);
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }
    }

    // 3. Check for excessive dependency count
    if (depNames.length > 50) {
        findings.push(`Excessive dependencies (${depNames.length}) — increases attack surface`);
        if (severityRank("low") > severityRank(maxSeverity)) maxSeverity = "low";
    }

    // 4. Check for dangerous install scripts
    if (scripts) {
        for (const scriptName of DANGEROUS_SCRIPTS) {
            if (scripts[scriptName]) {
                const scriptContent = scripts[scriptName];
                findings.push(`Install script "${scriptName}" detected: "${scriptContent.slice(0, 80)}" — supply chain vector`);
                if (severityRank("high") > severityRank(maxSeverity)) maxSeverity = "high";
            }
        }
    }

    // 5. Check for typosquatting patterns (common legitimate packages with slight misspellings)
    const COMMON_TARGETS: Record<string, string[]> = {
        lodash: ["lodas", "lodashs", "l0dash"],
        express: ["expres", "exppress", "expresss"],
        react: ["reacct", "rreact"],
        axios: ["axois", "axxios"],
        webpack: ["webpak", "webpackk"],
    };
    for (const name of depNames) {
        const lower = name.toLowerCase();
        for (const [, typos] of Object.entries(COMMON_TARGETS)) {
            if (typos.includes(lower)) {
                findings.push(`Possible typosquat package: "${name}" — verify package name`);
                if (severityRank("high") > severityRank(maxSeverity)) maxSeverity = "high";
            }
        }
    }

    return {
        passed: maxSeverity !== "critical",
        findings,
        severity: maxSeverity,
    };
}

// ═══════════════════════════════════════════════════════════════
// License Check
// ═══════════════════════════════════════════════════════════════

export interface LicenseCheckResult {
    passed: boolean;
    findings: string[];
    severity: SecurityScanResult["severity"];
}

/** Copyleft licenses that may impose distribution requirements */
const COPYLEFT_LICENSES = [
    "GPL-2.0", "GPL-3.0", "GPL-2.0-only", "GPL-3.0-only",
    "GPL-2.0-or-later", "GPL-3.0-or-later",
    "AGPL-3.0", "AGPL-3.0-only", "AGPL-3.0-or-later",
    "LGPL-2.1", "LGPL-3.0", "LGPL-2.1-only", "LGPL-3.0-only",
    "LGPL-2.1-or-later", "LGPL-3.0-or-later",
    "MPL-2.0", "EUPL-1.2", "OSL-3.0", "CPAL-1.0",
];

/** Check license compatibility with marketplace distribution. */
export function runLicenseCheck(license?: string): LicenseCheckResult {
    const findings: string[] = [];
    let maxSeverity: SecurityScanResult["severity"] = "none";

    if (!license || license.trim() === "") {
        findings.push("No license specified — unclear distribution rights");
        maxSeverity = "low";
    } else if (license.toUpperCase() === "UNLICENSED") {
        findings.push("License is UNLICENSED — author retains all rights, distribution may be restricted");
        maxSeverity = "medium";
    } else {
        const upper = license.toUpperCase();
        for (const copyleft of COPYLEFT_LICENSES) {
            if (upper.includes(copyleft.toUpperCase())) {
                findings.push(`Copyleft license "${license}" — may impose distribution requirements, requires manual review`);
                if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
                break;
            }
        }
    }

    return {
        passed: true,
        findings,
        severity: maxSeverity,
    };
}

// ═══════════════════════════════════════════════════════════════
// Source URL Validation
// ═══════════════════════════════════════════════════════════════

export interface SourceValidationResult {
    passed: boolean;
    findings: string[];
    severity: SecurityScanResult["severity"];
}

/** Validate source and demo URLs for suspicious patterns. */
export function runSourceValidation(
    sourceUrl?: string,
    demoUrl?: string,
): SourceValidationResult {
    const findings: string[] = [];
    let maxSeverity: SecurityScanResult["severity"] = "none";

    for (const [label, url] of [["Source URL", sourceUrl], ["Demo URL", demoUrl]] as const) {
        if (!url) continue;

        // Must be HTTPS
        if (!url.startsWith("https://")) {
            findings.push(`${label} is not HTTPS: ${url.slice(0, 80)}`);
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }

        // Check suspicious TLDs
        const lower = url.toLowerCase();
        if (SUSPICIOUS_TLDS.some((tld) => lower.includes(tld))) {
            findings.push(`${label} uses suspicious TLD: ${url.slice(0, 80)}`);
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }

        // IP address instead of domain
        if (/https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(url)) {
            findings.push(`${label} uses IP address instead of domain: ${url.slice(0, 80)}`);
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }

        // Validate GitHub URL format if it's a GitHub link
        if (lower.includes("github.com")) {
            const ghMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)/);
            if (!ghMatch) {
                findings.push(`${label} has malformed GitHub URL: ${url.slice(0, 80)}`);
                if (severityRank("low") > severityRank(maxSeverity)) maxSeverity = "low";
            }
        }

        // Detect URL shorteners
        const shorteners = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "v.gd", "shorturl.at"];
        if (shorteners.some((s) => lower.includes(s))) {
            findings.push(`${label} uses URL shortener — cannot verify destination: ${url.slice(0, 80)}`);
            if (severityRank("medium") > severityRank(maxSeverity)) maxSeverity = "medium";
        }
    }

    return {
        passed: true, // source validation never reaches "critical"
        findings,
        severity: maxSeverity,
    };
}

// ═══════════════════════════════════════════════════════════════
// Ranking Score
// ═══════════════════════════════════════════════════════════════

/** Compute a normalized ranking score (0-100) for marketplace ordering. */
// Ranking-score math lives in submission-scoring.ts (pure, no server deps)
// so client code can import it directly without pulling this file's
// Firebase Admin SDK dependency into the browser bundle. Re-exported here
// for existing server-side callers.
export { computeRankingScore, computeRankingScoreBreakdown } from "./submission-scoring";
