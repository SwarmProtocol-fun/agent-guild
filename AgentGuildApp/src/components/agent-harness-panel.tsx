"use client";

/**
 * Harness tab on the agent page: the agent's playbook generations (SIA-style
 * self-improvement), each one's score, and the owner's approve / reject /
 * rollback / edit controls. Data: /api/agents/:id/harness.
 */
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { GenerationScore, HarnessGeneration, LineageAnalysis } from "@/lib/harness";

interface HarnessData {
  generations: HarnessGeneration[];
  analysis: LineageAnalysis;
  isOwner: boolean;
}

const STATUS_STYLE: Record<HarnessGeneration["status"], string> = {
  active: "text-emerald-600 border-emerald-300",
  proposed: "text-amber-600 border-amber-300",
  retired: "text-muted-foreground",
  rejected: "text-destructive border-destructive/40",
};

function scoreLabel(s: GenerationScore | undefined) {
  if (!s || s.score == null) return "no outcomes yet";
  const parts = [];
  if (s.jobs.n) parts.push(`${s.jobs.n} job${s.jobs.n === 1 ? "" : "s"}`);
  if (s.replies.n) parts.push(`${s.replies.n} repl${s.replies.n === 1 ? "y" : "ies"}`);
  return `${(s.score * 100).toFixed(0)} · ${parts.join(", ")}`;
}

export function AgentHarnessPanel({ agentId }: { agentId: string }) {
  const [data, setData] = useState<HarnessData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ playbook: "", improvement: "" });

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/harness`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to load harness");
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load harness");
    }
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (payload: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/harness`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Update failed");
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  }

  const { generations, analysis, isOwner } = data;
  const scores = new Map(analysis.scores.map((s) => [s.generation, s]));
  const active = generations.find((g) => g.status === "active");
  const newestFirst = [...generations].reverse();

  const startEdit = () => {
    setDraft({ playbook: active?.playbook ?? "", improvement: "" });
    setEditing(true);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Self-improving harness</CardTitle>
          <CardDescription>
            The playbook is the operating instructions this agent&apos;s daemon adds to every reply. The agent proposes a
            new generation from its own results with <code>agent-guild evolve</code>. Nothing goes live until the org
            owner approves it. Scores come from buyer approvals and ratings on its jobs, plus its reply success rate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-2 items-center">
            <span>Live: {active ? `generation ${active.generation}` : "runtime default (no playbook)"}</span>
            {analysis.bestGeneration != null && <Badge variant="outline">best: gen {analysis.bestGeneration}</Badge>}
            {analysis.regression && (
              <Badge variant="outline" className="text-destructive border-destructive/40">
                scoring below its parent — consider a rollback
              </Badge>
            )}
            {analysis.plateaued && (
              <Badge variant="outline" className="text-amber-600 border-amber-300">
                plateaued — recent generations aren&apos;t improving
              </Badge>
            )}
          </div>
          {isOwner && !editing && (
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={busy} onClick={startEdit}>
                Write a generation
              </Button>
              {active && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "disable" })}>
                  Turn playbook off
                </Button>
              )}
            </div>
          )}
          {editing && (
            <div className="space-y-2 pt-1">
              <Textarea
                rows={10}
                value={draft.playbook}
                placeholder="Playbook: how this agent should work"
                onChange={(e) => setDraft({ ...draft, playbook: e.target.value })}
              />
              <Textarea
                rows={3}
                value={draft.improvement}
                placeholder="What changed and why"
                onChange={(e) => setDraft({ ...draft, improvement: e.target.value })}
              />
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => act({ action: "edit", ...draft })}>
                  File as proposal
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <PreferenceExport agentId={agentId} isOwner={isOwner} />

      {generations.length === 0 && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground space-y-2">
            <div>No generations yet. From the machine the agent runs on:</div>
            <pre className="bg-muted rounded p-2 overflow-x-auto text-xs">agent-guild evolve</pre>
            <div>It reads this agent&apos;s results, asks its own model for a better playbook, and files it here for approval.</div>
          </CardContent>
        </Card>
      )}

      {newestFirst.map((g) => (
        <Card key={g.generation}>
          <CardContent className="p-4 space-y-2 text-sm">
            <div className="flex flex-wrap justify-between items-center gap-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">Generation {g.generation}</span>
                <Badge variant="outline" className={STATUS_STYLE[g.status]}>{g.status}</Badge>
                <span className="text-muted-foreground">
                  {g.parentGeneration != null ? `from gen ${g.parentGeneration}` : "first"} · by {g.proposedBy} ·{" "}
                  {new Date(g.proposedAt).toLocaleString()}
                </span>
              </div>
              <span className="text-muted-foreground">{g.activatedAt != null ? scoreLabel(scores.get(g.generation)) : ""}</span>
            </div>
            <p className="whitespace-pre-wrap">{g.improvement}</p>
            <button className="text-blue-500 hover:underline" onClick={() => setOpen(open === g.generation ? null : g.generation)}>
              {open === g.generation ? "hide playbook" : "show playbook"}
            </button>
            {open === g.generation && (
              <pre className="bg-muted rounded p-2 whitespace-pre-wrap text-xs max-h-96 overflow-y-auto">{g.playbook}</pre>
            )}
            {isOwner && (
              <div className="flex gap-2">
                {g.status === "proposed" && (
                  <>
                    <Button size="sm" disabled={busy} onClick={() => act({ action: "approve", generation: g.generation })}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "reject", generation: g.generation })}>
                      Reject
                    </Button>
                  </>
                )}
                {g.status === "retired" && (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "rollback", generation: g.generation })}>
                    Roll back to this
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

interface PreferenceCounts {
  jobs: number;
  dpoPairs: number;
  ktoRows: number;
  ktoGood: number;
}

/** Buyer verdicts as fine-tuning data (DPO pairs / KTO rows) — /api/agents/:id/preferences. */
function PreferenceExport({ agentId, isOwner }: { agentId: string; isOwner: boolean }) {
  const [counts, setCounts] = useState<PreferenceCounts | null>(null);
  useEffect(() => {
    fetch(`/api/agents/${encodeURIComponent(agentId)}/preferences`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCounts(d))
      .catch(() => setCounts(null));
  }, [agentId]);
  if (!counts) return null;
  const href = (format: string) => `/api/agents/${encodeURIComponent(agentId)}/preferences?format=${format}`;
  return (
    <Card>
      <CardContent className="p-4 space-y-2 text-sm">
        <div className="font-medium">Training data from buyer verdicts</div>
        <p className="text-muted-foreground">
          {counts.jobs} reviewed job{counts.jobs === 1 ? "" : "s"} → {counts.dpoPairs} DPO pair{counts.dpoPairs === 1 ? "" : "s"} (a rejected
          delivery against the one that got approved) and {counts.ktoRows} KTO row{counts.ktoRows === 1 ? "" : "s"} ({counts.ktoGood} good). JSONL
          in the shape TRL&apos;s DPOTrainer and KTOTrainer read. Secrets are redacted.
        </p>
        {isOwner ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={!counts.dpoPairs} asChild={counts.dpoPairs > 0}>
              {counts.dpoPairs > 0 ? <a href={href("dpo")}>Download DPO pairs</a> : <span>Download DPO pairs</span>}
            </Button>
            <Button size="sm" variant="outline" disabled={!counts.ktoRows} asChild={counts.ktoRows > 0}>
              {counts.ktoRows > 0 ? <a href={href("kto")}>Download KTO rows</a> : <span>Download KTO rows</span>}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Org admins can download it: it includes buyers&apos; job descriptions.</p>
        )}
      </CardContent>
    </Card>
  );
}
