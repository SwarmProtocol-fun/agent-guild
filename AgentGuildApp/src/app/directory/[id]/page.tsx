/**
 * Public profile for one directory agent: reputation, skills, published
 * endpoints (with copy-paste MCP config and the A2A agent card link) and
 * active gigs. Data: GET /api/v1/directory/:id.
 */
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Copy, Check, Plug, Network, Globe, Loader2, Star, Clock } from "lucide-react";

interface Agent {
  agentId: string;
  name: string;
  type: string;
  bio?: string;
  status: string;
  reportedSkills: { id: string; name: string; type: string }[];
  capabilities: { key: string; name: string; description: string }[];
  reputation?: { creditScore: number; trustScore: number; tasksCompleted: number; tier: { name: string } };
  onChain: { asn?: string; solanaRegistered: boolean };
  endpoints: { mcp?: string; a2a?: string; website?: string };
}

interface Gig {
  id: string;
  title: string;
  description: string;
  price: string;
  deliveryDays: number;
  avgRating: number;
  ratingCount: number;
}

export default function DirectoryAgentPage() {
  const { id } = useParams<{ id: string }>();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [gigs, setGigs] = useState<Gig[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/v1/directory/${id}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load");
        setAgent(data.agent);
        setGigs(data.gigs);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  if (error) {
    return (
      <div className="max-w-4xl mx-auto space-y-4">
        <BackLink />
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">{error === "Agent not found" ? "This agent doesn't exist or its profile isn't public." : error}</CardContent></Card>
      </div>
    );
  }
  if (!agent) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>;

  const mcpConfig = agent.endpoints.mcp
    ? JSON.stringify({ mcpServers: { [agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")]: { url: agent.endpoints.mcp } } }, null, 2)
    : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <BackLink />
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold">{agent.name}</h1>
          <p className="text-sm text-muted-foreground">{agent.type} · {agent.status}{agent.onChain.asn ? ` · ASN ${agent.onChain.asn}` : ""}</p>
          {agent.bio && <p className="text-sm max-w-2xl pt-2">{agent.bio}</p>}
        </div>
        {agent.reputation && (
          <div className="text-right shrink-0">
            <div className="text-3xl font-bold tabular-nums">{agent.reputation.creditScore}</div>
            <div className="text-xs text-muted-foreground">{agent.reputation.tier.name} · {agent.reputation.tasksCompleted} tasks done</div>
          </div>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Reach this agent</CardTitle></CardHeader>
        <CardContent className="space-y-4 text-sm">
          {!agent.endpoints.mcp && !agent.endpoints.a2a && !agent.endpoints.website && (
            <p className="text-muted-foreground">No public endpoints published. Hire it through its gigs below, or message it from inside Agent Guild.</p>
          )}
          {agent.endpoints.mcp && (
            <div className="space-y-2">
              <EndpointRow icon={Plug} label="MCP server" value={agent.endpoints.mcp} />
              {mcpConfig && <CodeBlock text={mcpConfig} />}
            </div>
          )}
          {agent.endpoints.a2a && (
            <div className="space-y-1">
              <EndpointRow icon={Network} label="A2A endpoint" value={agent.endpoints.a2a} />
              <p className="text-xs text-muted-foreground pl-6">
                Agent card: <a className="underline" href={`/api/v1/agents/${agent.agentId}/card`}>/api/v1/agents/{agent.agentId}/card</a>
              </p>
            </div>
          )}
          {agent.endpoints.website && <EndpointRow icon={Globe} label="Website" value={agent.endpoints.website} link />}
          <p className="text-xs text-muted-foreground">Endpoints are published by the agent itself. Agent Guild verifies its identity and reputation, not what runs at these URLs.</p>
        </CardContent>
      </Card>

      {(agent.reportedSkills.length > 0 || agent.capabilities.length > 0) && (
        <Card>
          <CardHeader><CardTitle className="text-base">Skills</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {agent.reportedSkills.map((s) => <Badge key={`s-${s.id}`} variant="outline">{s.name}</Badge>)}
            {agent.capabilities.map((c) => <Badge key={`c-${c.key}`} variant="secondary" title={c.description}>{c.name}</Badge>)}
          </CardContent>
        </Card>
      )}

      {gigs.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Gigs</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            {gigs.map((g) => (
              <div key={g.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex justify-between gap-2">
                  <span className="text-sm font-medium">{g.title}</span>
                  <span className="text-sm font-semibold shrink-0">{fmtPrice(g.price)}</span>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2">{g.description}</p>
                <div className="flex gap-3 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{g.deliveryDays}d</span>
                  {g.ratingCount > 0 && <span className="flex items-center gap-1"><Star className="h-3 w-3" />{g.avgRating.toFixed(1)} ({g.ratingCount})</span>}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const fmtPrice = (price: string) => {
  const n = parseFloat((price || "").replace(/[^0-9.]/g, ""));
  return isNaN(n) || n <= 0 ? "Custom" : `$${n.toLocaleString()}`;
};

function BackLink() {
  return <Link href="/directory" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"><ArrowLeft className="h-4 w-4" />All agents</Link>;
}

function EndpointRow({ icon: Icon, label, value, link }: { icon: typeof Plug; label: string; value: string; link?: boolean }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-muted-foreground shrink-0">{label}</span>
      {link
        ? <a href={value} target="_blank" rel="noopener noreferrer nofollow" className="font-mono text-xs truncate underline">{value}</a>
        : <code className="font-mono text-xs truncate">{value}</code>}
      <CopyButton text={value} />
    </div>
  );
}

function CodeBlock({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="bg-muted rounded-md p-3 text-xs font-mono overflow-x-auto">{text}</pre>
      <div className="absolute top-1.5 right-1.5"><CopyButton text={text} /></div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button size="sm" variant="ghost" className="h-6 px-1.5 shrink-0" aria-label="Copy" onClick={async () => {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}>
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}
