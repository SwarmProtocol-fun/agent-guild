/** Doctor — System health diagnostics across Infrastructure, Agents, and Security categories. */
"use client";

import { useState, useCallback, useEffect } from "react";
import {
    Stethoscope, CheckCircle, AlertTriangle, XCircle, RefreshCw, Loader2,
    Database, Wifi, Users, Clock, Shield, Server,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useAuthAddress } from "@/hooks/useAuthAddress";
import { useOrg } from "@/contexts/OrgContext";
import { db } from "@/lib/firebase";
import { collection, getDocs, query, limit } from "firebase/firestore";
import { getAgentsByOrg } from "@/lib/firestore";
import { getGateways } from "@/lib/gateways";
import { getCronJobs } from "@/lib/cron";
import { getLatestVitals } from "@/lib/vitals";
import { DiagnosticCard } from "@/components/diagnostic-card";
import type { DiagnosticRun } from "@/lib/diagnostics";

// ═══════════════════════════════════════════════════════════════
// Health Check Types
// ═══════════════════════════════════════════════════════════════

type CheckStatus = "healthy" | "warning" | "critical" | "unchecked";

interface HealthCheck {
    id: string;
    category: string;
    title: string;
    detail: string;
    status: CheckStatus;
    icon: typeof Database;
    fixAction?: string;
}

const STATUS_CONFIG: Record<CheckStatus, { label: string; color: string; icon: typeof CheckCircle; bg: string }> = {
    healthy: { label: "Healthy", color: "text-emerald-400", icon: CheckCircle, bg: "bg-emerald-500/10" },
    warning: { label: "Warning", color: "text-amber-400", icon: AlertTriangle, bg: "bg-amber-500/10" },
    critical: { label: "Critical", color: "text-red-400", icon: XCircle, bg: "bg-red-500/10" },
    unchecked: { label: "Pending", color: "text-zinc-400", icon: Clock, bg: "bg-zinc-500/10" },
};

// ═══════════════════════════════════════════════════════════════
// Real Diagnostics
// ═══════════════════════════════════════════════════════════════

async function checkFirebase(): Promise<HealthCheck> {
    const base: HealthCheck = {
        id: "firebase", category: "Infrastructure", title: "Firebase Connection",
        detail: "", status: "unchecked", icon: Database,
    };
    try {
        const q = query(collection(db, "organizations"), limit(1));
        const snap = await getDocs(q);
        base.status = "healthy";
        base.detail = `Firestore reachable — test query returned ${snap.size} doc(s)`;
    } catch (err: unknown) {
        base.status = "critical";
        base.detail = `Firestore unreachable: ${err instanceof Error ? err.message : "Unknown error"}`;
        base.fixAction = "Check Firebase config and network connectivity";
    }
    return base;
}

async function checkAgents(orgId: string | null): Promise<HealthCheck> {
    const base: HealthCheck = {
        id: "agents", category: "Agents", title: "Agent Fleet Status",
        detail: "", status: "unchecked", icon: Users,
    };
    if (!orgId) {
        base.status = "warning";
        base.detail = "No organization selected — cannot check agents";
        return base;
    }
    try {
        const agents = await getAgentsByOrg(orgId);
        const total = agents.length;
        if (total === 0) {
            base.status = "warning";
            base.detail = "No agents registered for this organization";
            return base;
        }
        const online = agents.filter(a => a.status === "online").length;
        const busy = agents.filter(a => a.status === "busy").length;
        const offline = agents.filter(a => a.status === "offline").length;
        if (online + busy === total) {
            base.status = "healthy";
            base.detail = `All ${total} agent(s) active (${online} online, ${busy} busy)`;
        } else if (offline === total) {
            base.status = "critical";
            base.detail = `All ${total} agent(s) are offline`;
            base.fixAction = "Check agent processes and network connectivity";
        } else {
            base.status = "warning";
            base.detail = `${online + busy}/${total} agents active (${offline} offline)`;
        }
    } catch (err: unknown) {
        base.status = "critical";
        base.detail = `Failed to query agents: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
    return base;
}

async function checkGatewayHealth(orgId: string | null): Promise<HealthCheck> {
    const base: HealthCheck = {
        id: "gateway", category: "Infrastructure", title: "Gateway Reachability",
        detail: "", status: "unchecked", icon: Wifi,
    };
    if (!orgId) {
        base.status = "warning";
        base.detail = "No organization selected — cannot check gateways";
        return base;
    }
    try {
        const gateways = await getGateways(orgId);
        if (gateways.length === 0) {
            base.status = "healthy";
            base.detail = "No gateways configured (none required)";
            return base;
        }
        const STALE_MS = 5 * 60 * 1000;
        const now = Date.now();
        const connected = gateways.filter(g => g.status === "connected").length;
        const errored = gateways.filter(g => g.status === "error").length;
        const stale = gateways.filter(g => !g.lastPing || (now - g.lastPing.getTime()) > STALE_MS).length;
        if (connected === gateways.length && stale === 0) {
            base.status = "healthy";
            base.detail = `All ${gateways.length} gateway(s) connected with recent pings`;
        } else if (errored === gateways.length) {
            base.status = "critical";
            base.detail = `All ${gateways.length} gateway(s) in error state`;
            base.fixAction = "Check gateway endpoints and API keys";
        } else {
            base.status = "warning";
            const parts: string[] = [];
            if (connected > 0) parts.push(`${connected} connected`);
            if (errored > 0) parts.push(`${errored} errored`);
            if (stale > 0) parts.push(`${stale} stale ping`);
            base.detail = `${gateways.length} gateway(s): ${parts.join(", ")}`;
        }
    } catch (err: unknown) {
        base.status = "critical";
        base.detail = `Failed to query gateways: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
    return base;
}

async function checkVitals(orgId: string | null): Promise<HealthCheck> {
    const base: HealthCheck = {
        id: "vitals", category: "Infrastructure", title: "System Vitals",
        detail: "", status: "unchecked", icon: Server,
    };
    if (!orgId) {
        base.status = "warning";
        base.detail = "No organization selected — cannot check vitals";
        return base;
    }
    try {
        const vitals = await getLatestVitals(orgId);
        if (!vitals) {
            base.status = "warning";
            base.detail = "No vitals data reported yet";
            return base;
        }
        const STALE_MS = 10 * 60 * 1000;
        const isStale = !vitals.timestamp || (Date.now() - vitals.timestamp.getTime()) > STALE_MS;
        const cpu = vitals.cpu.usage;
        const mem = vitals.memory.percent;
        const disk = vitals.disk.percent;
        const detailStr = `CPU ${cpu.toFixed(0)}%, Memory ${mem.toFixed(0)}%, Disk ${disk.toFixed(0)}%`;
        if (isStale) {
            base.status = "warning";
            base.detail = `Stale data — ${detailStr} (last: ${vitals.timestamp ? vitals.timestamp.toLocaleTimeString() : "unknown"})`;
        } else if (cpu >= 85 || mem >= 85 || disk >= 85) {
            base.status = "critical";
            base.detail = `High resource usage — ${detailStr}`;
            base.fixAction = "Investigate high resource consumption";
        } else if (cpu >= 70 || mem >= 70 || disk >= 70) {
            base.status = "warning";
            base.detail = `Elevated usage — ${detailStr}`;
        } else {
            base.status = "healthy";
            base.detail = `All within limits — ${detailStr}`;
        }
    } catch (err: unknown) {
        base.status = "critical";
        base.detail = `Failed to query vitals: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
    return base;
}

async function checkAuth(walletAddress: string | undefined): Promise<HealthCheck> {
    const base: HealthCheck = {
        id: "auth", category: "Security", title: "Authentication",
        detail: "", status: "unchecked", icon: Shield,
    };
    if (walletAddress) {
        base.status = "healthy";
        base.detail = `Wallet connected: ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
    } else {
        base.status = "critical";
        base.detail = "No wallet connected — authentication unavailable";
        base.fixAction = "Connect your wallet to authenticate";
    }
    return base;
}

async function checkCronJobs(orgId: string | null): Promise<HealthCheck> {
    const base: HealthCheck = {
        id: "cron", category: "Operations", title: "Scheduled Jobs",
        detail: "", status: "unchecked", icon: Clock,
    };
    if (!orgId) {
        base.status = "warning";
        base.detail = "No organization selected — cannot check cron jobs";
        return base;
    }
    try {
        const jobs = await getCronJobs(orgId);
        const enabled = jobs.filter(j => j.enabled);
        if (enabled.length === 0) {
            base.status = "healthy";
            base.detail = jobs.length === 0
                ? "No cron jobs configured"
                : `${jobs.length} job(s) configured, all disabled`;
            return base;
        }
        const now = new Date();
        const failed = enabled.filter(j => j.lastRun && !j.lastRun.success);
        const overdue = enabled.filter(j => j.nextRun && j.nextRun < now);
        if (failed.length === 0 && overdue.length === 0) {
            base.status = "healthy";
            base.detail = `${enabled.length} active job(s) — all passing, none overdue`;
        } else if (failed.length === enabled.length) {
            base.status = "critical";
            base.detail = `All ${enabled.length} active job(s) have failed last runs`;
            base.fixAction = "Review cron job configurations and agent assignments";
        } else {
            base.status = "warning";
            const parts: string[] = [];
            if (failed.length > 0) parts.push(`${failed.length} failed last run`);
            if (overdue.length > 0) parts.push(`${overdue.length} overdue`);
            base.detail = `${enabled.length} active job(s): ${parts.join(", ")}`;
        }
    } catch (err: unknown) {
        base.status = "critical";
        base.detail = `Failed to query cron jobs: ${err instanceof Error ? err.message : "Unknown error"}`;
    }
    return base;
}

async function runDiagnostics(orgId: string | null, walletAddress: string | undefined): Promise<HealthCheck[]> {
    const fallbackIds = ["firebase", "agents", "gateway", "vitals", "auth", "cron"];
    const fallbackTitles = ["Firebase Connection", "Agent Fleet Status", "Gateway Reachability", "System Vitals", "Authentication", "Scheduled Jobs"];
    const fallbackCategories = ["Infrastructure", "Agents", "Infrastructure", "Infrastructure", "Security", "Operations"];
    const fallbackIcons = [Database, Users, Wifi, Server, Shield, Clock];

    const results = await Promise.allSettled([
        checkFirebase(),
        checkAgents(orgId),
        checkGatewayHealth(orgId),
        checkVitals(orgId),
        checkAuth(walletAddress),
        checkCronJobs(orgId),
    ]);

    return results.map((result, i) => {
        if (result.status === "fulfilled") return result.value;
        return {
            id: fallbackIds[i], category: fallbackCategories[i], title: fallbackTitles[i],
            detail: `Unexpected error: ${result.reason}`, status: "critical" as CheckStatus, icon: fallbackIcons[i],
        };
    });
}

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export default function DoctorPage() {
    const authAddress = useAuthAddress();
    const { currentOrg } = useOrg();
    const [checks, setChecks] = useState<HealthCheck[]>([]);
    const [running, setRunning] = useState(false);
    const [lastRun, setLastRun] = useState<Date | null>(null);

    // Diagnostics state
    const [diagnosticRuns, setDiagnosticRuns] = useState<DiagnosticRun[]>([]);
    const [runningDiagnostics, setRunningDiagnostics] = useState(false);

    const runChecks = useCallback(async () => {
        setRunning(true);
        try {
            const results = await runDiagnostics(currentOrg?.id ?? null, authAddress ?? undefined);
            setChecks(results);
            setLastRun(new Date());
        } catch {
            setChecks([]);
        } finally {
            setRunning(false);
        }
    }, [currentOrg?.id, authAddress]);

    const runDiagnosticChecks = useCallback(async () => {
        if (!currentOrg?.id) return;
        setRunningDiagnostics(true);
        try {
            const res = await fetch("/api/diagnostics/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ orgId: currentOrg.id }),
            });
            const data = await res.json();
            if (data.ok && data.runs) {
                setDiagnosticRuns(data.runs);
            }
        } catch (err) {
            console.error("Failed to run diagnostics:", err);
        } finally {
            setRunningDiagnostics(false);
        }
    }, [currentOrg?.id]);

    // Auto-run on mount
    useEffect(() => {
        runChecks();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Auto-refresh every 60s after first run. Skip ticks while the tab is in
    // the background — no point re-running the full diagnostic sweep for a
    // page nobody is looking at.
    useEffect(() => {
        if (checks.length === 0) return;
        const interval = setInterval(() => {
            if (document.visibilityState === "visible") runChecks();
        }, 60_000);
        return () => clearInterval(interval);
    }, [runChecks, checks.length]);

    const healthy = checks.filter(c => c.status === "healthy").length;
    const warnings = checks.filter(c => c.status === "warning").length;
    const critical = checks.filter(c => c.status === "critical").length;

    // Group by category
    const categories = new Map<string, HealthCheck[]>();
    for (const check of checks) {
        const arr = categories.get(check.category) || [];
        arr.push(check);
        categories.set(check.category, arr);
    }

    if (!authAddress) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-muted-foreground">
                <Stethoscope className="h-12 w-12 opacity-30" />
                <p>Connect your wallet to run diagnostics</p>
            </div>
        );
    }

    return (
        <div className="max-w-[900px] mx-auto px-4 py-8">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                        <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
                            <Stethoscope className="h-6 w-6 text-cyan-500" />
                        </div>
                        System Health
                    </h1>
                    <p className="text-sm text-muted-foreground mt-2">
                        Run diagnostics and check system status
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {lastRun && (
                        <span className="text-[10px] text-muted-foreground">
                            Last checked {lastRun.toLocaleTimeString()} · refreshes every 60s
                        </span>
                    )}
                    <Button
                        onClick={runChecks}
                        disabled={running}
                        size="sm"
                        className="gap-1.5 bg-cyan-500 hover:bg-cyan-600 text-white"
                    >
                        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                        {running ? "Running..." : "Run Diagnostics"}
                    </Button>
                </div>
            </div>

            {checks.length === 0 ? (
                <Card className="p-12 bg-card/80 border-border text-center">
                    <Stethoscope className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
                    <h3 className="text-sm font-semibold mb-1">No diagnostics run yet</h3>
                    <p className="text-xs text-muted-foreground mb-4">Click &quot;Run Diagnostics&quot; to check your system health</p>
                </Card>
            ) : (
                <>
                    {/* Summary */}
                    <div className="grid grid-cols-3 gap-3 mb-6">
                        <Card className="p-3 bg-card/80 border-border text-center">
                            <div className="text-2xl font-bold text-emerald-400">{healthy}</div>
                            <div className="text-[10px] text-muted-foreground uppercase">Healthy</div>
                        </Card>
                        <Card className="p-3 bg-card/80 border-border text-center">
                            <div className="text-2xl font-bold text-amber-400">{warnings}</div>
                            <div className="text-[10px] text-muted-foreground uppercase">Warnings</div>
                        </Card>
                        <Card className="p-3 bg-card/80 border-border text-center">
                            <div className="text-2xl font-bold text-red-400">{critical}</div>
                            <div className="text-[10px] text-muted-foreground uppercase">Critical</div>
                        </Card>
                    </div>

                    {/* Check results by category */}
                    {Array.from(categories.entries()).map(([category, items]) => (
                        <div key={category} className="mb-4">
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{category}</h3>
                            <div className="space-y-1.5">
                                {items.map((check) => {
                                    const cfg = STATUS_CONFIG[check.status];
                                    const StatusIcon = cfg.icon;
                                    const CheckIcon = check.icon;
                                    return (
                                        <Card key={check.id} className="p-3 bg-card/80 border-border">
                                            <div className="flex items-center gap-3">
                                                <div className={`p-1.5 rounded-lg ${cfg.bg}`}>
                                                    <CheckIcon className={`h-4 w-4 ${cfg.color}`} />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium">{check.title}</p>
                                                    <p className="text-[10px] text-muted-foreground">{check.detail}</p>
                                                </div>
                                                <Badge variant="outline" className={`text-[9px] gap-1 ${cfg.color}`}>
                                                    <StatusIcon className="h-2.5 w-2.5" />
                                                    {cfg.label}
                                                </Badge>
                                            </div>
                                        </Card>
                                    );
                                })}
                            </div>
                        </div>
                    ))}

                    {/* Advanced Diagnostics with Auto-Fix */}
                    <div className="mt-8 pt-6 border-t border-border">
                        <div className="flex items-center justify-between mb-4">
                            <div>
                                <h2 className="text-lg font-semibold">Advanced Diagnostics</h2>
                                <p className="text-xs text-muted-foreground">Deep system analysis with one-click auto-fix</p>
                            </div>
                            <Button
                                onClick={runDiagnosticChecks}
                                disabled={runningDiagnostics || !currentOrg}
                                size="sm"
                                variant="outline"
                                className="gap-1.5"
                            >
                                {runningDiagnostics ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                {runningDiagnostics ? "Scanning..." : "Run Deep Scan"}
                            </Button>
                        </div>

                        {diagnosticRuns.length === 0 ? (
                            <Card className="p-8 bg-card/80 border-border text-center">
                                <AlertTriangle className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                                <h3 className="text-sm font-semibold mb-1">No deep diagnostics run yet</h3>
                                <p className="text-xs text-muted-foreground">Click &quot;Run Deep Scan&quot; to check for stale agents, budget overruns, orphaned tasks, and more</p>
                            </Card>
                        ) : (
                            <div className="space-y-3">
                                {diagnosticRuns.flatMap((run) =>
                                    run.issues.map((issue) => (
                                        <DiagnosticCard
                                            key={`${run.checkType}-${issue.targetId}`}
                                            issue={issue}
                                        />
                                    ))
                                )}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
