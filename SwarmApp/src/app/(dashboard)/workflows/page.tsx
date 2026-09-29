"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
// [swarm-core] ClawFlows catalog removed — install swarm-flow mod (types + empty catalog remain)
import { CLAWFLOW_CATEGORIES, TOTAL_FLOWS, type ClawFlow, type ClawFlowCategory } from "@/lib/clawflows";
import { Search, ExternalLink, Clock, Zap, Play, ChevronDown, CheckCircle2, Loader2, Plus, Layers } from "lucide-react";
import { useOrg } from "@/contexts/OrgContext";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { type Agent, createTask } from "@/lib/firestore";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkflowDefinition } from "@/lib/workflow/types";

export default function WorkflowsPage() {
  const router = useRouter();
  const { currentOrg } = useOrg();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [expandedFlows, setExpandedFlows] = useState<Set<string>>(new Set());

  // My Workflows state
  const [myWorkflows, setMyWorkflows] = useState<WorkflowDefinition[]>([]);
  const [loadingMyWorkflows, setLoadingMyWorkflows] = useState(false);

  useEffect(() => {
    if (!currentOrg) return;
    const q = query(collection(db, "agents"), where("orgId", "==", currentOrg.id));
    const unsub = onSnapshot(q, (snap) => {
      setAgents(snap.docs.map(d => ({ id: d.id, ...d.data() } as Agent)));
    });
    return () => unsub();
  }, [currentOrg]);

  const fetchMyWorkflows = useCallback(async () => {
    if (!currentOrg) return;
    setLoadingMyWorkflows(true);
    try {
      const res = await fetch(`/api/workflows?orgId=${currentOrg.id}`);
      if (res.ok) {
        const data = await res.json();
        setMyWorkflows(data.workflows || []);
      }
    } catch (err) {
      console.error("Failed to fetch workflows:", err);
    } finally {
      setLoadingMyWorkflows(false);
    }
  }, [currentOrg]);

  useEffect(() => {
    fetchMyWorkflows();
  }, [fetchMyWorkflows]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q && !activeCategory) return CLAWFLOW_CATEGORIES;

    return CLAWFLOW_CATEGORIES
      .filter((cat) => !activeCategory || cat.id === activeCategory)
      .map((cat) => ({
        ...cat,
        flows: q
          ? cat.flows.filter(
              (f) =>
                f.label.toLowerCase().includes(q) ||
                f.description.toLowerCase().includes(q) ||
                f.slug.includes(q)
            )
          : cat.flows,
      }))
      .filter((cat) => cat.flows.length > 0);
  }, [search, activeCategory]);

  const totalShown = filtered.reduce((n, c) => n + c.flows.length, 0);

  const toggleExpanded = (slug: string) => {
    setExpandedFlows((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Zap className="h-6 w-6 text-amber-400" />
            Workflows
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Build, execute, and monitor agent workflows
          </p>
        </div>
        <Button onClick={() => router.push("/workflows/new")}>
          <Plus className="h-4 w-4 mr-1.5" />
          New Workflow
        </Button>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="my-workflows">
        <TabsList>
          <TabsTrigger value="my-workflows">
            <Layers className="h-3.5 w-3.5 mr-1.5" />
            My Workflows
          </TabsTrigger>
          <TabsTrigger value="templates">
            <Zap className="h-3.5 w-3.5 mr-1.5" />
            Templates ({TOTAL_FLOWS})
          </TabsTrigger>
        </TabsList>

        {/* My Workflows tab */}
        <TabsContent value="my-workflows">
          {loadingMyWorkflows ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : myWorkflows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <Layers className="h-8 w-8 mb-3 opacity-40" />
              <p className="text-sm mb-3">No custom workflows yet</p>
              <Button
                variant="outline"
                onClick={() => router.push("/workflows/new")}
              >
                <Plus className="h-4 w-4 mr-1.5" />
                Create Your First Workflow
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 pt-4">
              {myWorkflows.map((wf) => (
                <div
                  key={wf.id}
                  className="group rounded-xl border border-border bg-card p-4 hover:border-primary/30 hover:bg-primary/[0.02] transition-all cursor-pointer"
                  onClick={() => router.push(`/workflows/${wf.id}`)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                        {wf.name}
                      </h3>
                      {wf.description && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {wf.description}
                        </p>
                      )}
                    </div>
                    <Badge
                      variant="outline"
                      className={`text-[10px] shrink-0 ${
                        wf.enabled
                          ? "bg-emerald-500/10 text-emerald-600 border-emerald-200"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {wf.enabled ? "Active" : "Disabled"}
                    </Badge>
                  </div>
                  <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{wf.nodes.length} nodes</span>
                    <span>v{wf.version}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Templates tab (existing ClawFlows content) */}
        <TabsContent value="templates">
          <div className="space-y-6 pt-4">
            {/* Search */}
            <div className="relative w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search templates..."
                className="w-full rounded-lg border border-border bg-background pl-9 pr-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>

            {/* Category pills */}
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => setActiveCategory(null)}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  !activeCategory
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
              >
                All ({TOTAL_FLOWS})
              </button>
              {CLAWFLOW_CATEGORIES.map((cat) => (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(activeCategory === cat.id ? null : cat.id)}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    activeCategory === cat.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {cat.emoji} {cat.label} ({cat.flows.length})
                </button>
              ))}
            </div>

            {/* Stats bar */}
            <div className="flex items-center gap-3 text-xs text-muted-foreground border-b border-border pb-3">
              <span>{totalShown} template{totalShown !== 1 ? "s" : ""} shown</span>
              {search && (
                <button
                  onClick={() => { setSearch(""); setActiveCategory(null); }}
                  className="text-primary hover:underline"
                >
                  Clear filters
                </button>
              )}
            </div>

            {/* Template list by category */}
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <Search className="h-8 w-8 mb-3 opacity-40" />
                <p className="text-sm">No templates match &ldquo;{search}&rdquo;</p>
              </div>
            ) : (
              <div className="space-y-8">
                {filtered.map((cat) => (
                  <CategorySection
                    key={cat.id}
                    category={cat}
                    expandedFlows={expandedFlows}
                    onToggleExpand={toggleExpanded}
                    agents={agents}
                    orgId={currentOrg?.id}
                  />
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function CategorySection({
  category,
  expandedFlows,
  onToggleExpand,
  agents,
  orgId,
}: {
  category: ClawFlowCategory;
  expandedFlows: Set<string>;
  onToggleExpand: (slug: string) => void;
  agents: Agent[];
  orgId?: string;
}) {
  return (
    <div>
      <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
        <span className="text-lg">{category.emoji}</span>
        {category.label}
        <span className="text-xs text-muted-foreground font-normal">({category.flows.length})</span>
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {category.flows.map((flow) => (
          <FlowCard
            key={flow.slug}
            flow={flow}
            expanded={expandedFlows.has(flow.slug)}
            onToggle={() => onToggleExpand(flow.slug)}
            agents={agents}
            orgId={orgId}
          />
        ))}
      </div>
    </div>
  );
}

function FlowCard({
  flow,
  expanded,
  onToggle,
  agents,
  orgId,
}: {
  flow: ClawFlow;
  expanded: boolean;
  onToggle: () => void;
  agents: Agent[];
  orgId?: string;
}) {
  const isScheduled = flow.schedule && flow.schedule !== "on-demand";
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [isActivating, setIsActivating] = useState(false);
  const [didActivate, setDidActivate] = useState(false);

  const handleActivate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!orgId || !selectedAgentId || isActivating) return;

    setIsActivating(true);
    try {
      await createTask({
        orgId,
        projectId: "default",
        title: `Execute Workflow: ${flow.label}`,
        description: `Please execute the following standard workflow.\n\nWorkflow: ${flow.label} (${flow.slug})\nDescription: ${flow.description}`,
        assigneeAgentId: selectedAgentId,
        status: "todo",
        priority: "high",
        createdAt: new Date(),
      });
      setDidActivate(true);
      setTimeout(() => setDidActivate(false), 3000);
    } catch (err) {
      console.error("Failed to activate workflow:", err);
    } finally {
      setIsActivating(false);
    }
  };

  return (
    <div
      className="group rounded-xl border border-border bg-card p-4 hover:border-primary/30 hover:bg-primary/[0.02] transition-all cursor-pointer"
      onClick={onToggle}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium truncate group-hover:text-primary transition-colors">
            {flow.label}
          </h3>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {flow.description}
          </p>
        </div>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground/50 shrink-0 mt-0.5 transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </div>

      {/* Schedule badge */}
      {flow.schedule && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {isScheduled ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-500">
              <Clock className="h-2.5 w-2.5" />
              {flow.schedule}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-500">
              <Play className="h-2.5 w-2.5" />
              On demand
            </span>
          )}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-3 pt-3 border-t border-border/50 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Workflow ID</span>
            <code className="text-[11px] bg-muted px-1.5 py-0.5 rounded font-mono">{flow.slug}</code>
          </div>

          <div className="pt-2 mt-2 border-t border-border/50" onClick={(e) => e.stopPropagation()}>
            <label className="text-xs font-medium mb-1.5 block">Target Agent</label>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <Select value={selectedAgentId} onValueChange={setSelectedAgentId}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select an agent..." />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map(a => (
                      <SelectItem key={a.id} value={a.id} className="text-xs">
                        {a.name}
                      </SelectItem>
                    ))}
                    {agents.length === 0 && (
                      <SelectItem value="none" disabled className="text-xs">
                        No agents available
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <Button
                size="sm"
                className="h-8 px-3 text-xs w-24 shrink-0 transition-all"
                disabled={!selectedAgentId || isActivating || agents.length === 0 || didActivate}
                onClick={handleActivate}
                variant={didActivate ? "outline" : "default"}
              >
                {isActivating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : didActivate ? (
                  <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" />
                    Assigned
                  </span>
                ) : (
                  "Activate"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
