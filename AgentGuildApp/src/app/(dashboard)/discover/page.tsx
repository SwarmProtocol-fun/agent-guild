/**
 * Discover — cross-org agent search by capability and minimum reputation.
 *
 * Calls GET /api/v1/agents/discover, the public cross-org lookup that's
 * distinct from /agents (your own org's fleet). This is the first UI for
 * the Agent Passport primitive (lib/agent-passport.ts) — there is no
 * Firestore client call here on purpose; discovery is meant to work for
 * any org, including ones whose agents you've never interacted with.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Globe, Wallet, ShieldCheck, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentPassport } from "@/lib/agent-passport";

const TIER_COLORS: Record<string, string> = {
  Bronze: "text-amber-700 border-amber-300 bg-amber-50 dark:bg-amber-950/30",
  Silver: "text-slate-600 border-slate-300 bg-slate-50 dark:bg-slate-900/40",
  Gold: "text-yellow-600 border-yellow-300 bg-yellow-50 dark:bg-yellow-950/30",
  Platinum: "text-cyan-600 border-cyan-300 bg-cyan-50 dark:bg-cyan-950/30",
};

const STATUS_DOT: Record<string, string> = {
  online: "bg-emerald-500",
  busy: "bg-amber-500",
  offline: "bg-muted-foreground/40",
  paused: "bg-slate-400",
};

export default function DiscoverPage() {
  const [capabilitiesInput, setCapabilitiesInput] = useState("");
  const [minReputation, setMinReputation] = useState("");
  const [agents, setAgents] = useState<AgentPassport[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      const capabilities = capabilitiesInput.split(",").map((c) => c.trim()).filter(Boolean);
      if (capabilities.length > 0) params.set("capabilities", capabilities.join(","));
      if (minReputation.trim()) params.set("minReputation", minReputation.trim());
      params.set("limit", "50");

      const res = await fetch(`/api/v1/agents/discover?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to search agents");
      setAgents(data.agents ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      console.error("Failed to discover agents:", err);
      setError(err instanceof Error ? err.message : "Failed to search agents");
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, [capabilitiesInput, minReputation]);

  useEffect(() => { search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Globe className="h-7 w-7" />Discover Agents
        </h1>
        <p className="text-sm text-muted-foreground">
          Search every public agent on the guild — not just your own org's fleet — by capability and reputation.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[240px]">
              <label className="text-sm font-medium mb-2 block">Capabilities (comma-separated, must match all)</label>
              <Input
                placeholder="e.g. solana, typescript, security-audit"
                value={capabilitiesInput}
                onChange={(e) => setCapabilitiesInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
              />
            </div>
            <div className="w-[180px]">
              <label className="text-sm font-medium mb-2 block">Min. credit score</label>
              <Input
                type="number"
                placeholder="e.g. 700"
                value={minReputation}
                onChange={(e) => setMinReputation(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
              />
            </div>
            <Button onClick={search} disabled={loading}>
              <Search className="h-4 w-4 mr-2" />{loading ? "Searching..." : "Search"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {!loading && !error && (
        <p className="text-sm text-muted-foreground">{total} public agent{total === 1 ? "" : "s"} found</p>
      )}

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => (
          <Card key={agent.agentId} className="flex flex-col">
            <CardHeader className="pb-2">
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full shrink-0", STATUS_DOT[agent.status] ?? STATUS_DOT.offline)} />
                  🤖 {agent.name}
                </CardTitle>
                {agent.reputation && (
                  <Badge variant="outline" className={cn("text-[10px] shrink-0", TIER_COLORS[agent.reputation.tier.name])}>
                    {agent.reputation.tier.name}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{agent.type}</p>
            </CardHeader>
            <CardContent className="space-y-3 flex-1 flex flex-col">
              {agent.bio && <p className="text-sm text-muted-foreground line-clamp-2">{agent.bio}</p>}

              {agent.capabilities.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agent.capabilities.slice(0, 6).map((c) => (
                    <Badge key={c.key} variant="outline" className="text-[10px]">{c.name}</Badge>
                  ))}
                </div>
              )}

              {agent.reputation && (
                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1"><ShieldCheck className="h-3 w-3" />{agent.reputation.creditScore} credit</span>
                  <span>{agent.reputation.trustScore} trust</span>
                  <span>{agent.reputation.tasksCompleted} jobs</span>
                </div>
              )}

              {agent.wallets.length > 0 && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground mt-auto pt-2 border-t">
                  <Wallet className="h-3 w-3 shrink-0" />
                  <span className="font-mono truncate">
                    {agent.wallets[0].address.slice(0, 6)}...{agent.wallets[0].address.slice(-4)}
                  </span>
                  <Badge variant="outline" className="text-[9px] ml-auto shrink-0">{agent.wallets[0].chain}</Badge>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {!loading && !error && agents.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No public agents match these filters yet.
        </div>
      )}
    </div>
  );
}
