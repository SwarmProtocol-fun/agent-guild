/**
 * Borrow Panel — borrower-side entry point on the lending marketplace.
 * Pick one of your org's agents, see its eligibility, apply for a loan,
 * accept direct offers, and track its loans.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bot, Loader2, AlertCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { useOrg } from "@/contexts/OrgContext";
import { useSession } from "@/contexts/SessionContext";
import { getAgentsByOrg, type Agent } from "@/lib/firestore";
import { LoanEligibilityCard } from "./loan-eligibility-card";
import { LoanOffersPanel } from "./loan-offers-panel";
import { ActiveLoansPanel } from "./active-loans-panel";

export function BorrowPanel() {
    const { currentOrg } = useOrg();
    const { address: sessionAddress } = useSession();
    const [agents, setAgents] = useState<Agent[]>([]);
    const [agentId, setAgentId] = useState<string>("");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        if (!currentOrg?.id) {
            setAgents([]);
            setLoading(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        getAgentsByOrg(currentOrg.id)
            .then((list) => {
                if (cancelled) return;
                setAgents(list);
                setAgentId((prev) => (list.some((a) => a.id === prev) ? prev : list[0]?.id || ""));
            })
            .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load agents"))
            .finally(() => !cancelled && setLoading(false));
        return () => {
            cancelled = true;
        };
    }, [currentOrg?.id]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    if (!currentOrg) {
        return (
            <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    Select or create an organization to borrow for one of its agents.
                </CardContent>
            </Card>
        );
    }

    if (error) {
        return (
            <div className="p-2 rounded-lg border border-red-500/20 bg-red-500/5 flex items-center gap-2 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
            </div>
        );
    }

    if (agents.length === 0) {
        return (
            <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    Loans are issued to agents. <Link href="/agents" className="text-emerald-500 hover:underline">Register an agent</Link> in {currentOrg.name} to apply.
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                <label htmlFor="borrow-agent" className="text-sm font-medium flex items-center gap-1.5">
                    <Bot className="h-4 w-4 text-emerald-500" /> Borrow as
                </label>
                <select
                    id="borrow-agent"
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm sm:min-w-64"
                >
                    {agents.map((a) => (
                        <option key={a.id} value={a.id}>{a.name || a.id}</option>
                    ))}
                </select>
                <Link href={`/agents/${agentId}/credit`} className="text-xs text-muted-foreground hover:text-foreground hover:underline sm:ml-auto">
                    View credit profile
                </Link>
            </div>

            {agentId && (
                <div key={agentId} className="space-y-4">
                    <LoanEligibilityCard
                        agentId={agentId}
                        orgId={currentOrg.id}
                        onLoanRequested={() => setRefreshKey((k) => k + 1)}
                    />
                    <LoanOffersPanel
                        agentId={agentId}
                        orgId={currentOrg.id}
                        walletAddress={sessionAddress}
                        onAccepted={() => setRefreshKey((k) => k + 1)}
                    />
                    <ActiveLoansPanel agentId={agentId} refreshKey={refreshKey} />
                </div>
            )}
        </div>
    );
}
