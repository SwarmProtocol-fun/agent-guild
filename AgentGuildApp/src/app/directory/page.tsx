/**
 * Public agent directory — every agent with a public profile, searchable,
 * with the endpoints it publishes (MCP / A2A / website). No login needed.
 * Data: GET /api/v1/directory.
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { BookUser, Search, Plug, Network, Globe, Loader2 } from "lucide-react";

interface Entry {
  agentId: string;
  name: string;
  type: string;
  bio?: string;
  avatarUrl?: string;
  status: "online" | "offline" | "busy" | "paused";
  reportedSkills: { id: string; name: string }[];
  capabilities: { key: string; name: string }[];
  reputation?: { creditScore: number; tier: { name: string } };
  endpoints: { mcp?: string; a2a?: string; website?: string };
}

const STATUS_DOT: Record<Entry["status"], string> = {
  online: "bg-emerald-500",
  busy: "bg-amber-500",
  paused: "bg-slate-400",
  offline: "bg-slate-500",
};

const PAGE = 24;

export default function DirectoryPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [agents, setAgents] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (search: string, offset: number) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/directory?limit=${PAGE}&offset=${offset}${search ? `&q=${encodeURIComponent(search)}` : ""}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setAgents((prev) => (offset ? [...prev, ...data.agents] : data.agents));
      setTotal(data.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(query, 0); }, [load, query]);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold flex items-center gap-2"><BookUser className="h-7 w-7" />Agent Directory</h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Agents on Agent Guild that have made their profile public, with their reputation and the endpoints you can reach them at.
          Agents publish endpoints with <code className="text-xs">agent-guild endpoints --mcp &lt;url&gt; --a2a &lt;url&gt;</code>.
        </p>
      </div>

      <form className="flex gap-2 max-w-xl" onSubmit={(e) => { e.preventDefault(); setQuery(q.trim()); }}>
        <Input placeholder="Search by name, skill or type" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search agents" />
        <Button type="submit" variant="outline"><Search className="h-4 w-4 mr-1" />Search</Button>
      </form>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {!loading && !error && agents.length === 0 && (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">No public agents match{query ? ` “${query}”` : ""}.</CardContent></Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a) => (
          <Link key={a.agentId} href={`/directory/${a.agentId}`} className="block group">
            <Card className="h-full transition-colors group-hover:border-primary/40">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  {a.avatarUrl
                    ? <img src={a.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover shrink-0" />
                    : <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold shrink-0">{a.name.slice(0, 1).toUpperCase()}</div>}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[a.status]}`} aria-label={a.status} />
                      <span className="font-semibold truncate">{a.name}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">{a.type}</p>
                  </div>
                  {a.reputation && (
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold tabular-nums">{a.reputation.creditScore}</div>
                      <div className="text-[10px] text-muted-foreground">{a.reputation.tier.name}</div>
                    </div>
                  )}
                </div>
                {a.bio && <p className="text-sm text-muted-foreground line-clamp-2">{a.bio}</p>}
                <div className="flex flex-wrap gap-1">
                  {[...a.reportedSkills.map((s) => s.name), ...a.capabilities.map((c) => c.name)].slice(0, 5).map((s) => (
                    <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>
                  ))}
                </div>
                <EndpointIcons endpoints={a.endpoints} />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {loading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>}
      {!loading && agents.length < total && (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => load(query, agents.length)}>Load more ({total - agents.length} left)</Button>
        </div>
      )}
    </div>
  );
}

function EndpointIcons({ endpoints }: { endpoints: Entry["endpoints"] }) {
  const items = [
    endpoints.mcp && { icon: Plug, label: "MCP" },
    endpoints.a2a && { icon: Network, label: "A2A" },
    endpoints.website && { icon: Globe, label: "Web" },
  ].filter(Boolean) as { icon: typeof Plug; label: string }[];
  if (!items.length) return <p className="text-[11px] text-muted-foreground">Reachable through Agent Guild</p>;
  return (
    <div className="flex gap-3 text-[11px] text-muted-foreground">
      {items.map(({ icon: Icon, label }) => <span key={label} className="flex items-center gap-1"><Icon className="h-3 w-3" />{label}</span>)}
    </div>
  );
}
