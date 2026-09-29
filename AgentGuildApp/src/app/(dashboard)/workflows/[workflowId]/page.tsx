/**
 * Workflow Detail Page — Builder, Runs, and Settings tabs for a single workflow.
 * Handles both existing workflows (/workflows/:id) and new creation (/workflows/new).
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  Loader2,
  Play,
  Settings,
  Layers,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useOrg } from "@/contexts/OrgContext";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import type { Agent } from "@/lib/firestore";
import type { WorkflowDefinition } from "@/lib/workflow/types";
import { SwarmCanvas } from "@/components/swarm-workflow/swarm-canvas";
import { WorkflowRunsTab } from "@/components/swarm-workflow/workflow-runs-tab";

export default function WorkflowDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { currentOrg } = useOrg();
  const workflowId = params.workflowId as string;
  const isNew = workflowId === "new";

  const [workflow, setWorkflow] = useState<WorkflowDefinition | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeTab, setActiveTab] = useState(isNew ? "builder" : "runs");

  // Settings state
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  // Fetch agents
  useEffect(() => {
    if (!currentOrg) return;
    const q = query(collection(db, "agents"), where("orgId", "==", currentOrg.id));
    const unsub = onSnapshot(q, (snap) => {
      setAgents(snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Agent));
    });
    return () => unsub();
  }, [currentOrg]);

  // Fetch workflow definition
  const fetchWorkflow = useCallback(async () => {
    if (isNew || !currentOrg) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/workflows/${workflowId}?orgId=${currentOrg.id}`,
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const wf = data.workflow as WorkflowDefinition;
      setWorkflow(wf);
      setEditName(wf.name);
      setEditDescription(wf.description || "");
      setEditEnabled(wf.enabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workflow");
    } finally {
      setLoading(false);
    }
  }, [workflowId, currentOrg, isNew]);

  useEffect(() => {
    fetchWorkflow();
  }, [fetchWorkflow]);

  const handleSaveSettings = async () => {
    if (!currentOrg || isNew) return;
    setSaving(true);
    try {
      await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: currentOrg.id,
          name: editName,
          description: editDescription,
          enabled: editEnabled,
        }),
      });
      fetchWorkflow();
    } catch (err) {
      console.error("Failed to save settings:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!currentOrg || isNew) return;
    if (!confirm("Delete this workflow? This cannot be undone.")) return;
    try {
      await fetch(`/api/workflows/${workflowId}?orgId=${currentOrg.id}`, {
        method: "DELETE",
      });
      router.push("/workflows");
    } catch (err) {
      console.error("Failed to delete workflow:", err);
    }
  };

  const handleSaved = (newId: string) => {
    if (isNew) {
      router.replace(`/workflows/${newId}`);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-32 text-muted-foreground">
        <p className="text-sm text-red-600 mb-4">{error}</p>
        <Button variant="outline" onClick={() => router.push("/workflows")}>
          <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to Workflows
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push("/workflows")}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-lg font-bold">
              {isNew ? "New Workflow" : workflow?.name || "Workflow"}
            </h1>
            {workflow && (
              <div className="flex items-center gap-2 mt-0.5">
                <Badge variant="outline" className="text-[10px]">
                  v{workflow.version}
                </Badge>
                <Badge
                  variant="outline"
                  className={`text-[10px] ${
                    workflow.enabled
                      ? "bg-emerald-500/10 text-emerald-600 border-emerald-200"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {workflow.enabled ? "Enabled" : "Disabled"}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {workflow.nodes.length} nodes
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="builder">
            <Layers className="h-3.5 w-3.5 mr-1.5" />
            Builder
          </TabsTrigger>
          {!isNew && (
            <TabsTrigger value="runs">
              <Play className="h-3.5 w-3.5 mr-1.5" />
              Runs
            </TabsTrigger>
          )}
          {!isNew && (
            <TabsTrigger value="settings">
              <Settings className="h-3.5 w-3.5 mr-1.5" />
              Settings
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="builder">
          <SwarmCanvas
            agents={agents}
            orgId={currentOrg?.id}
            workflowId={isNew ? undefined : workflowId}
            initialNodes={workflow?.nodes}
            initialEdges={workflow?.edges}
            onSaved={handleSaved}
          />
        </TabsContent>

        {!isNew && (
          <TabsContent value="runs">
            <WorkflowRunsTab
              workflowId={workflowId}
              orgId={currentOrg?.id || ""}
            />
          </TabsContent>
        )}

        {!isNew && (
          <TabsContent value="settings">
            <div className="max-w-lg space-y-6 pt-4">
              {/* Name */}
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Workflow Name
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Description
                </label>
                <textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  rows={3}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
                />
              </div>

              {/* Enabled toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Enabled</p>
                  <p className="text-xs text-muted-foreground">
                    Disabled workflows cannot be triggered
                  </p>
                </div>
                <button
                  onClick={() => setEditEnabled(!editEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    editEnabled ? "bg-emerald-500" : "bg-muted"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      editEnabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3 pt-4 border-t border-border">
                <Button onClick={handleSaveSettings} disabled={saving}>
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                  ) : (
                    <Save className="h-4 w-4 mr-1.5" />
                  )}
                  Save Settings
                </Button>
                <Button
                  variant="outline"
                  className="text-red-600 border-red-200 hover:bg-red-50"
                  onClick={handleDelete}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  Delete Workflow
                </Button>
              </div>
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
