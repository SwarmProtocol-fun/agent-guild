/**
 * Agent standing — the anti-sybil side of an agent (lib/agent-standing.ts):
 * whether it's still provisional and what's left to clear, its refundable
 * bond (post / refund-and-retire), and the org owner's proof-of-human status,
 * which sets how many agents the owner may run.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Circle, ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { shortAddress } from "@/lib/chains";
import type { AgentStanding, AgentBond, OwnerQuota } from "@/lib/agent-standing";

interface StandingResponse {
    standing: AgentStanding;
    bond: AgentBond | null;
    retiredAt: number | null;
    bondRequiredUsd: number;
    bondTreasury: string | null;
    ownerWallet: string | null;
    ownerHumanVerified: boolean;
    ownerQuota: OwnerQuota;
}

export function AgentStandingCard({ agentId, orgId, isOwner }: { agentId: string; orgId: string; isOwner: boolean }) {
    const [data, setData] = useState<StandingResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<"bond" | "refund" | "human" | null>(null);
    const [txSig, setTxSig] = useState("");
    const [fromWallet, setFromWallet] = useState("");
    const [confirmRefund, setConfirmRefund] = useState(false);

    const load = useCallback(async () => {
        try {
            const resp = await fetch(`/api/v1/agents/${agentId}/standing?org=${encodeURIComponent(orgId)}`);
            const body = await resp.json();
            if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
            setData(body);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to load standing");
        }
    }, [agentId, orgId]);

    useEffect(() => { load(); }, [load]);

    const post = async (kind: "bond" | "refund" | "human", url: string, payload?: unknown) => {
        setBusy(kind);
        setError(null);
        try {
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload ?? {}),
            });
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(body.error || `HTTP ${resp.status}`);
            if (kind === "human" && !body.verified) {
                setError(body.status === "pending"
                    ? "Proof of Human is still scoring this wallet — check again in a minute."
                    : body.error || `Not verified (${body.verdict ?? "no verdict"}${body.confidence != null ? `, ${Math.round(body.confidence * 100)}%` : ""}). Your current agent limit still applies.`);
            }
            if (kind === "bond") { setTxSig(""); setFromWallet(""); }
            setConfirmRefund(false);
            await load();
        } catch (err) {
            setError(err instanceof Error ? err.message : "Request failed");
        } finally {
            setBusy(null);
        }
    };

    if (!data) {
        return (
            <Card>
                <CardHeader className="pb-3"><CardTitle className="text-base">Standing</CardTitle></CardHeader>
                <CardContent className="text-sm text-muted-foreground">{error ?? "Loading…"}</CardContent>
            </Card>
        );
    }

    const { standing, bond } = data;
    const canPostBond = isOwner && data.bondRequiredUsd > 0 && !data.retiredAt && (!bond || bond.status === "slashed");

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base flex items-center gap-2">
                        {standing.provisional
                            ? <ShieldAlert className="w-4 h-4 text-amber-500" aria-hidden="true" />
                            : <ShieldCheck className="w-4 h-4 text-emerald-500" aria-hidden="true" />}
                        Standing
                    </CardTitle>
                    {data.retiredAt
                        ? <Badge variant="outline">Retired</Badge>
                        : standing.provisional
                            ? <Badge variant="outline" className="border-amber-400 text-amber-600 dark:text-amber-400">Provisional</Badge>
                            : <Badge variant="outline" className="border-emerald-400 text-emerald-600 dark:text-emerald-400">{standing.grandfathered ? "Established" : "Graduated"}</Badge>}
                </div>
                <CardDescription>
                    {standing.provisional
                        ? "New agents are held at the Restricted tier until every item below is met."
                        : "Policy tier follows the agent's credit score."}
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
                {standing.requirements.length > 0 && (
                    <ul className="space-y-1.5">
                        {standing.requirements.map((r) => (
                            <li key={r.key} className="flex items-start gap-2">
                                {r.met
                                    ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-emerald-500" aria-label="Met" />
                                    : <Circle className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" aria-label="Not met" />}
                                <span className={r.met ? "text-muted-foreground" : ""}>{r.label}</span>
                            </li>
                        ))}
                    </ul>
                )}

                {data.bondRequiredUsd > 0 && (
                    <div className="rounded-md border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                            <span className="font-medium">Bond</span>
                            <span className="text-xs text-muted-foreground">
                                {bond ? `${bond.status.replace("_", " ")} · $${bond.amountUsd} from ${shortAddress(bond.postedByWallet)}` : "none"}
                            </span>
                        </div>
                        {canPostBond && (
                            data.bondTreasury ? (
                                <div className="space-y-2">
                                    <p className="text-xs text-muted-foreground">
                                        Send {data.bondRequiredUsd} USDC (Solana) to{" "}
                                        <span className="font-mono break-all">{data.bondTreasury}</span>, then paste the transaction signature.
                                        Refundable when you retire the agent with a clean record.
                                    </p>
                                    <Input placeholder="Sending wallet address" value={fromWallet} onChange={(e) => setFromWallet(e.target.value)} />
                                    <Input placeholder="Transaction signature" value={txSig} onChange={(e) => setTxSig(e.target.value)} />
                                    <Button
                                        size="sm"
                                        disabled={!txSig.trim() || !fromWallet.trim() || busy !== null}
                                        onClick={() => post("bond", `/api/v1/agents/${agentId}/bond`, { orgId, txSig, fromWallet })}
                                    >
                                        {busy === "bond" && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" />}
                                        Verify bond
                                    </Button>
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">Bond posting isn&apos;t configured on this deployment.</p>
                            )
                        )}
                        {isOwner && bond?.status === "posted" && !data.retiredAt && (
                            confirmRefund ? (
                                <div className="space-y-2">
                                    <p className="text-xs text-destructive">
                                        Retiring is permanent: this agent can&apos;t reconnect, and its ASN stops counting toward your limit.
                                    </p>
                                    <div className="flex gap-2">
                                        <Button size="sm" variant="destructive" disabled={busy !== null}
                                            onClick={() => post("refund", `/api/v1/agents/${agentId}/bond/refund`, { orgId })}>
                                            {busy === "refund" && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" />}
                                            Retire &amp; refund bond
                                        </Button>
                                        <Button size="sm" variant="outline" onClick={() => setConfirmRefund(false)}>Cancel</Button>
                                    </div>
                                </div>
                            ) : (
                                <Button size="sm" variant="outline" onClick={() => setConfirmRefund(true)}>Retire agent &amp; refund bond…</Button>
                            )
                        )}
                    </div>
                )}

                <div className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="font-medium">Org owner</span>
                        <span className="text-xs text-muted-foreground">
                            {data.ownerHumanVerified ? "Verified human" : "Not verified"} · up to {data.ownerQuota.maxActiveAgents} agents, {data.ownerQuota.maxNewPerDay}/day
                        </span>
                    </div>
                    {isOwner && !data.ownerHumanVerified && (
                        <Button size="sm" variant="outline" disabled={busy !== null}
                            onClick={() => post("human", "/api/v1/humanity/verify")}>
                            {busy === "human" && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden="true" />}
                            Verify as human to raise the limit
                        </Button>
                    )}
                </div>

                {error && <p className="text-xs text-destructive">{error}</p>}
            </CardContent>
        </Card>
    );
}
