"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Play, Square, RotateCcw, Copy, Camera, ChevronLeft, Trash2, AlertCircle } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { Computer, ComputerSession, ComputerAction, ActionType } from "@/lib/compute/types";
import {
  SIZE_PRESETS,
  REGION_LABELS,
  MODEL_LABELS,
  DEFAULT_AUTO_STOP_MINUTES,
} from "@/lib/compute/types";
import { estimateHourlyCost, estimateMonthlyCost } from "@/lib/compute/pricing";
const trackComputeEvent = (..._args: unknown[]) => {}; // posthog removed
import { StatusBadge } from "@/components/compute/status-badge";
import { DesktopViewer } from "@/components/compute/desktop-viewer";
import { TerminalViewer } from "@/components/compute/terminal-viewer";
import { ActionPanel } from "@/components/compute/action-panel";
import { FileBrowser } from "@/components/compute/file-browser";
import { MemoryEditor } from "@/components/compute/memory-editor";
import { SessionTimeline } from "@/components/compute/session-timeline";

export default function ComputerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [computer, setComputer] = useState<Computer | null>(null);
  const [sessions, setSessions] = useState<ComputerSession[]>([]);
  const [actionHistory, setActionHistory] = useState<ComputerAction[]>([]);
  const [vncUrl, setVncUrl] = useState("");
  const [terminalUrl, setTerminalUrl] = useState("");
  const [activeSession, setActiveSession] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Settings state
  const [settingsName, setSettingsName] = useState("");
  const [settingsAutoStop, setSettingsAutoStop] = useState(DEFAULT_AUTO_STOP_MINUTES);
  const [settingsPersistence, setSettingsPersistence] = useState(true);
  const [settingsController, setSettingsController] = useState<string>("human");
  const [settingsModel, setSettingsModel] = useState<string>("");

  const fetchComputer = async () => {
    try {
      const res = await fetch(`/api/compute/computers/${id}`);
      const data = await res.json();
      if (data.ok) {
        setComputer(data.computer);
        setSettingsName(data.computer.name);
        setSettingsAutoStop(data.computer.autoStopMinutes);
        setSettingsPersistence(data.computer.persistenceEnabled);
        setSettingsController(data.computer.controllerType);
        setSettingsModel(data.computer.modelKey || "");
      } else {
        setError(data.error || "Failed to load computer");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load computer");
    }
  };

  const fetchSessions = async () => {
    try {
      const res = await fetch(`/api/compute/sessions?computerId=${id}`);
      const data = await res.json();
      if (data.ok) {
        setSessions(data.sessions || []);
        const active = (data.sessions || []).find((s: ComputerSession) => !s.endedAt);
        if (active) setActiveSession(active.id);
      }
    } catch {
      // Sessions are non-critical, silently skip
    }
  };

  useEffect(() => {
    Promise.all([fetchComputer(), fetchSessions()])
      .finally(() => setLoading(false));
  }, [id]);

  // Fetch live URLs when running
  useEffect(() => {
    if (computer?.status !== "running") return;
    Promise.all([
      fetch(`/api/compute/computers/${id}/vnc-token`).then((r) => r.json()),
      fetch(`/api/compute/computers/${id}/terminal-token`).then((r) => r.json()),
    ]).then(([vData, tData]) => {
      if (vData.ok) setVncUrl(vData.url);
      if (tData.ok) setTerminalUrl(tData.url);
    });
  }, [computer?.status, id]);

  // Poll for status updates when computer is in a transitional state.
  // Skip ticks while the tab is in the background — a provisioning/stopping
  // transition left unattended shouldn't keep polling every 3s until it ends.
  useEffect(() => {
    if (!computer) return;
    const transitional = ["provisioning", "starting", "stopping", "snapshotting"];
    if (!transitional.includes(computer.status)) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") fetchComputer();
    }, 3000);
    return () => clearInterval(interval);
  }, [computer?.status]);

  const handleLifecycle = async (action: "start" | "stop" | "restart") => {
    trackComputeEvent(`computer_${action}`, { computerId: id, sizeKey: computer?.sizeKey });
    try {
      const res = await fetch(`/api/compute/computers/${id}/${action}`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        if (res.status === 409) {
          // Computer is already in transitional state - not an error, just inform user
          setError(`Computer is already ${computer?.status}. Please wait for the current operation to complete.`);
          setTimeout(() => setError(""), 5000); // Clear after 5s
        } else {
          setError(data.error || `Failed to ${action} computer`);
        }
        return;
      }

      setError(""); // Clear any previous errors
      await fetchComputer();
      if (action === "start") await fetchSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} computer`);
    }
  };

  const handleAction = async (actionType: ActionType, payload: Record<string, unknown>) => {
    if (!activeSession) return;
    const res = await fetch(`/api/compute/computers/${id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionType, payload, sessionId: activeSession }),
    });
    const data = await res.json();
    if (data.ok) {
      setActionHistory((prev) => [
        {
          id: data.actionId,
          sessionId: activeSession,
          computerId: id,
          actionType,
          payload,
          result: data.result || null,
          status: data.result?.success ? "completed" : "failed",
          createdAt: new Date(),
        },
        ...prev,
      ]);
    }
  };

  const handleClone = async () => {
    const res = await fetch(`/api/compute/computers/${id}/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (data.ok) router.push(`/compute/computers/${data.id}`);
  };

  const handleSnapshot = async () => {
    await fetch(`/api/compute/computers/${id}/snapshot`, { method: "POST" });
    await fetchComputer();
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    await fetch(`/api/compute/computers/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: settingsName,
        autoStopMinutes: settingsAutoStop,
        persistenceEnabled: settingsPersistence,
        controllerType: settingsController,
        modelKey: settingsModel || null,
      }),
    });
    await fetchComputer();
    setSaving(false);
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this computer? This action cannot be undone.")) return;
    const res = await fetch(`/api/compute/computers/${id}`, { method: "DELETE" });
    if (res.ok) router.push("/compute/computers");
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !computer) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-red-400">{error || "Computer not found"}</p>
        <div className="flex gap-2 mt-2">
          <button onClick={() => { setError(""); setLoading(true); fetchComputer().finally(() => setLoading(false)); }} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">Retry</button>
          <Link href="/compute/computers" className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">Back to Computers</Link>
        </div>
      </div>
    );
  }

  const preset = SIZE_PRESETS[computer.sizeKey];
  const costPerHour = estimateHourlyCost(computer.sizeKey);

  // Metrics from sessions
  const totalActions = sessions.reduce((sum, s) => sum + s.totalActions, 0);
  const totalScreenshots = sessions.reduce((sum, s) => sum + s.totalScreenshots, 0);
  const totalCostCents = sessions.reduce((sum, s) => sum + s.estimatedCostCents, 0);
  const totalHours = sessions.reduce((sum, s) => {
    if (!s.startedAt) return sum;
    const start = new Date(s.startedAt).getTime();
    if (isNaN(start)) return sum;
    const end = s.endedAt ? new Date(s.endedAt).getTime() : Date.now();
    return sum + (end - start) / 3600000;
  }, 0);

  return (
    <div className="space-y-6 p-6">
      {/* Error Banner */}
      {error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm text-amber-400 font-medium">Operation Status</p>
            <p className="text-xs text-muted-foreground mt-0.5">{error}</p>
          </div>
          <button
            onClick={() => setError("")}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Link href="/compute/computers" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2">
            <ChevronLeft className="h-3 w-3" />
            Computers
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{computer.name}</h1>
            <StatusBadge status={computer.status} />
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {preset.label} · {REGION_LABELS[computer.region]} · {computer.controllerType}
          </p>
        </div>
        <div className="flex gap-2">
          {(computer.status === "stopped" || computer.status === "error") && (
            <button onClick={() => handleLifecycle("start")} className="flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400 hover:bg-emerald-500/20">
              <Play className="h-4 w-4" /> Start
            </button>
          )}
          {computer.status === "running" && (
            <>
              <button onClick={() => handleLifecycle("stop")} className="flex items-center gap-1.5 rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-400 hover:bg-amber-500/20">
                <Square className="h-4 w-4" /> Stop
              </button>
              <button onClick={() => handleLifecycle("restart")} className="flex items-center gap-1.5 rounded-md bg-blue-500/10 px-3 py-2 text-sm text-blue-400 hover:bg-blue-500/20">
                <RotateCcw className="h-4 w-4" /> Restart
              </button>
            </>
          )}
          <button onClick={handleSnapshot} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
            <Camera className="h-4 w-4" /> Snapshot
          </button>
          <button onClick={handleClone} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
            <Copy className="h-4 w-4" /> Clone
          </button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="desktop">
        <TabsList>
          <TabsTrigger value="desktop">Desktop</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="actions">Actions</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="desktop">
          <DesktopViewer
            computerId={id}
            vncUrl={vncUrl}
            status={computer.status}
            provider={computer.provider}
          />
        </TabsContent>

        <TabsContent value="terminal">
          <TerminalViewer
            computerId={id}
            terminalUrl={terminalUrl}
            status={computer.status}
          />
        </TabsContent>

        <TabsContent value="actions">
          <div className="space-y-6">
            <ActionPanel
              computerId={id}
              sessionId={activeSession}
              onAction={handleAction}
              disabled={computer.status !== "running"}
            />
            {/* Action history */}
            {actionHistory.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-2">Recent Actions</h3>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {actionHistory.map((a) => (
                    <div key={a.id} className="flex items-center justify-between px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${a.status === "completed" ? "bg-emerald-500" : a.status === "failed" ? "bg-red-500" : "bg-amber-500"}`} />
                        <span className="font-medium">{a.actionType}</span>
                        {a.payload && Object.keys(a.payload).length > 0 && (
                          <span className="text-muted-foreground font-mono">
                            {JSON.stringify(a.payload).slice(0, 60)}
                          </span>
                        )}
                      </div>
                      <span className="text-muted-foreground">
                        {a.createdAt ? new Date(a.createdAt).toLocaleTimeString() : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="files">
          <FileBrowser workspaceId={computer.workspaceId} computerId={id} />
        </TabsContent>

        <TabsContent value="memory">
          <MemoryEditor scopeType="computer" scopeId={id} />
        </TabsContent>

        <TabsContent value="sessions">
          <SessionTimeline sessions={sessions} />
        </TabsContent>

        {/* Metrics Tab */}
        <TabsContent value="metrics">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">Uptime</p>
              <p className="text-2xl font-bold mt-1">{totalHours.toFixed(1)}h</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">Total Actions</p>
              <p className="text-2xl font-bold mt-1">{totalActions}</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">Screenshots</p>
              <p className="text-2xl font-bold mt-1">{totalScreenshots}</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">Est. Cost</p>
              <p className="text-2xl font-bold mt-1">${(totalCostCents / 100).toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">Hourly Rate</p>
              <p className="text-2xl font-bold mt-1">${(costPerHour / 100).toFixed(2)}</p>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground">Projected Monthly (8h/day)</p>
              <p className="text-2xl font-bold mt-1">${(estimateMonthlyCost(computer.sizeKey, 8) / 100).toFixed(2)}</p>
            </div>
          </div>

          <div className="mt-6 rounded-lg border border-border p-4">
            <h3 className="text-sm font-medium mb-3">Computer Specs</h3>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">CPU</dt>
                <dd className="font-medium">{computer.cpuCores} cores</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">RAM</dt>
                <dd className="font-medium">{(computer.ramMb / 1024).toFixed(0)} GB</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Disk</dt>
                <dd className="font-medium">{computer.diskGb} GB</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Resolution</dt>
                <dd className="font-medium">{computer.resolutionWidth}x{computer.resolutionHeight}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sessions</dt>
                <dd className="font-medium">{sessions.length}</dd>
              </div>
            </dl>
          </div>
        </TabsContent>

        {/* Settings Tab */}
        <TabsContent value="settings">
          <div className="max-w-lg space-y-6">
            <div>
              <label className="text-sm font-medium mb-1 block">Name</label>
              <input
                value={settingsName}
                onChange={(e) => setSettingsName(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Auto-stop after idle</label>
              <select
                value={settingsAutoStop}
                onChange={(e) => setSettingsAutoStop(Number(e.target.value))}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
                <option value={60}>1 hour</option>
                <option value={120}>2 hours</option>
                <option value={0}>Never</option>
              </select>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium">Persistence</label>
                <p className="text-xs text-muted-foreground">Keep disk state between stops</p>
              </div>
              <button
                type="button"
                onClick={() => setSettingsPersistence(!settingsPersistence)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  settingsPersistence ? "bg-primary" : "bg-muted"
                }`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settingsPersistence ? "translate-x-6" : "translate-x-1"
                }`} />
              </button>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Controller</label>
              <select
                value={settingsController}
                onChange={(e) => setSettingsController(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                <option value="human">Human Only</option>
                <option value="agent">Agent Only</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </div>

            {(settingsController === "agent" || settingsController === "hybrid") && (
              <div>
                <label className="text-sm font-medium mb-1 block">Model</label>
                <select
                  value={settingsModel}
                  onChange={(e) => setSettingsModel(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                >
                  <option value="">None</option>
                  {Object.entries(MODEL_LABELS).map(([key, cfg]) => (
                    <option key={key} value={key}>{cfg.label}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleSaveSettings}
                disabled={saving}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {saving ? "Saving..." : "Save Settings"}
              </button>
            </div>

            {/* Danger zone */}
            <div className="mt-8 rounded-lg border border-red-500/20 p-4">
              <h3 className="text-sm font-medium text-red-400 mb-2">Danger Zone</h3>
              <p className="text-xs text-muted-foreground mb-3">
                Permanently delete this computer and all its data.
              </p>
              <button
                onClick={handleDelete}
                className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/20"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Computer
              </button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
