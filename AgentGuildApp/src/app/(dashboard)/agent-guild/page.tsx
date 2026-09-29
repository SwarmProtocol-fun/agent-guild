/** Swarm — Diablo-style agent inventory for the Swarm Protocol. */
"use client";

import { useState, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogHeader, DialogTitle, DialogContent } from "@/components/ui/dialog";
import { useOrg } from "@/contexts/OrgContext";
import { getAgentsByOrg, getOrganization, updateOrganization, ensureAgentGroupChat, sendMessage, type Agent } from "@/lib/firestore";
import { getAgentAvatarUrl } from "@/lib/agent-avatar";
import { cn } from "@/lib/utils";
// [swarm-core] ReactBits + Slots extracted to mods
const SpotlightCard = ({ children, className, ...props }: { children: React.ReactNode; className?: string; spotlightColor?: string; [k: string]: unknown }) => <div className={className} {...props}>{children}</div>;
const SlotPolicyBuilder = () => null;
const SlotExecutionHistory = () => null;
interface SlotPolicy { slotId: string; agentId: string; priority: number; conditions?: Record<string, unknown>; }
import {
  FileText, Shield, GitBranch, BarChart3, MessageSquare, Wrench,
  Zap, X, Search, Plus, History, Power, Trash2,
} from "lucide-react";

// ═══════════════════════════════════════════════════════════════
// Protocol Slot Definitions
// ═══════════════════════════════════════════════════════════════

interface ProtocolSlot {
  id: string;
  name: string;
  description: string;
  icon: typeof Shield;
  color: string;
  rgb: string; // for SpotlightCard glow
}

const PROTOCOL_SLOTS: ProtocolSlot[] = [
  { id: "daily-briefings", name: "Daily Briefings", description: "Generates daily org summaries and briefings", icon: FileText, color: "amber", rgb: "245,158,11" },
  { id: "security-monitor", name: "Security Monitor", description: "Watches for threats, anomalies, suspicious activity", icon: Shield, color: "red", rgb: "239,68,68" },
  { id: "task-coordinator", name: "Task Coordinator", description: "Auto-assigns tasks and manages workflow", icon: GitBranch, color: "purple", rgb: "168,85,247" },
  { id: "data-analyst", name: "Data Analyst", description: "Monitors metrics and generates reports", icon: BarChart3, color: "cyan", rgb: "6,182,212" },
  { id: "communications", name: "Communications", description: "Handles cross-org messaging and notifications", icon: MessageSquare, color: "blue", rgb: "59,130,246" },
  { id: "maintenance", name: "Maintenance", description: "Health checks, cleanup, and optimization", icon: Wrench, color: "emerald", rgb: "16,185,129" },
];

// Color classes per slot — full strings so Tailwind JIT finds them
const SLOT_STYLES: Record<string, { border: string; bg: string; text: string; badgeBg: string; badgeBorder: string; glow: string; ring: string }> = {
  amber:   { border: "border-amber-500/30",   bg: "bg-amber-500/5",   text: "text-amber-400",   badgeBg: "bg-amber-500/10",   badgeBorder: "border-amber-500/20",   glow: "from-amber-500/10",   ring: "border-amber-500/40" },
  red:     { border: "border-red-500/30",     bg: "bg-red-500/5",     text: "text-red-400",     badgeBg: "bg-red-500/10",     badgeBorder: "border-red-500/20",     glow: "from-red-500/10",     ring: "border-red-500/40" },
  purple:  { border: "border-purple-500/30",  bg: "bg-purple-500/5",  text: "text-purple-400",  badgeBg: "bg-purple-500/10",  badgeBorder: "border-purple-500/20",  glow: "from-purple-500/10",  ring: "border-purple-500/40" },
  cyan:    { border: "border-cyan-500/30",    bg: "bg-cyan-500/5",    text: "text-cyan-400",    badgeBg: "bg-cyan-500/10",    badgeBorder: "border-cyan-500/20",    glow: "from-cyan-500/10",    ring: "border-cyan-500/40" },
  blue:    { border: "border-blue-500/30",    bg: "bg-blue-500/5",    text: "text-blue-400",    badgeBg: "bg-blue-500/10",    badgeBorder: "border-blue-500/20",    glow: "from-blue-500/10",    ring: "border-blue-500/40" },
  emerald: { border: "border-emerald-500/30", bg: "bg-emerald-500/5", text: "text-emerald-400", badgeBg: "bg-emerald-500/10", badgeBorder: "border-emerald-500/20", glow: "from-emerald-500/10", ring: "border-emerald-500/40" },
};

const STATUS_DOT: Record<string, string> = {
  online: "bg-emerald-400",
  busy: "bg-amber-400",
  offline: "bg-gray-400",
};

// Grid positions: 3x3, center is emblem
const GRID_ORDER = [0, -1, 1, 2, -2, 3, 4, -1, 5]; // -2 = emblem, -1 = spacer

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export default function SwarmPage() {
  const { currentOrg } = useOrg();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [assignments, setAssignments] = useState<Record<string, { agentId: string; assignedAt: unknown } | null>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Automation state
  const [policies, setPolicies] = useState<Record<string, SlotPolicy[]>>({});
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderSlotId, setBuilderSlotId] = useState("");
  const [builderSlotName, setBuilderSlotName] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPolicyId, setHistoryPolicyId] = useState("");
  const [historyPolicyName, setHistoryPolicyName] = useState("");

  // Fetch policies for all slots
  const fetchPolicies = useCallback(async () => {
    if (!currentOrg) return;
    try {
      const res = await fetch(`/api/v1/slots?orgId=${currentOrg.id}`);
      if (!res.ok) return;
      const data = await res.json();
      const bySlot: Record<string, SlotPolicy[]> = {};
      for (const p of data.policies || []) {
        if (!bySlot[p.slotId]) bySlot[p.slotId] = [];
        bySlot[p.slotId].push(p);
      }
      setPolicies(bySlot);
    } catch {
      // Silently fail — policies are optional enhancement
    }
  }, [currentOrg]);

  // Load agents and slot assignments
  useEffect(() => {
    if (!currentOrg) return;
    setLoading(true);
    Promise.all([
      getAgentsByOrg(currentOrg.id),
      getOrganization(currentOrg.id),
    ]).then(([agentList, freshOrg]) => {
      setAgents(agentList);
      setAssignments(freshOrg?.swarmSlots || {});
    }).finally(() => setLoading(false));

    fetchPolicies();
  }, [currentOrg, fetchPolicies]);

  const filledCount = PROTOCOL_SLOTS.filter(s => assignments[s.id]?.agentId).length;
  const allEquipped = filledCount === PROTOCOL_SLOTS.length;

  const assignedAgentIds = new Set(
    Object.values(assignments).filter(Boolean).map(a => a!.agentId)
  );

  const filteredAgents = agents.filter(a => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return a.name.toLowerCase().includes(q) || a.type.toLowerCase().includes(q);
    }
    return true;
  });

  async function assignAgent(slotId: string, agentId: string) {
    if (!currentOrg) return;
    setSaving(true);
    const updated = { ...assignments, [slotId]: { agentId, assignedAt: new Date() } };
    try {
      await updateOrganization(currentOrg.id, { swarmSlots: updated } as Partial<typeof currentOrg>);
      setAssignments(updated);

      // Notify Agent Hub about the new assignment
      const agent = agents.find(a => a.id === agentId);
      const slot = PROTOCOL_SLOTS.find(s => s.id === slotId);
      if (agent && slot) {
        ensureAgentGroupChat(currentOrg.id).then(hub => {
          sendMessage({
            channelId: hub.id,
            senderId: "system",
            senderName: "Swarm Protocol",
            senderType: "agent",
            content: `⚡ **@${agent.name}** has been assigned to **${slot.name}**.\n\n${slot.description}.\n\nYou are now responsible for this role within the Swarm Protocol. Begin operations when ready.`,
            orgId: currentOrg.id,
            createdAt: new Date(),
          });
        }).catch(() => {});
      }
    } catch (err) {
      console.error("Failed to assign agent:", err);
    }
    setSaving(false);
    setSelectedSlot(null);
  }

  async function assignAgentToAll(agentId: string) {
    if (!currentOrg) return;
    setSaving(true);
    const updated: Record<string, { agentId: string; assignedAt: unknown } | null> = {};
    for (const slot of PROTOCOL_SLOTS) {
      updated[slot.id] = { agentId, assignedAt: new Date() };
    }
    try {
      await updateOrganization(currentOrg.id, { swarmSlots: updated } as Partial<typeof currentOrg>);
      setAssignments(updated);

      const agent = agents.find(a => a.id === agentId);
      if (agent) {
        ensureAgentGroupChat(currentOrg.id).then(hub => {
          sendMessage({
            channelId: hub.id,
            senderId: "system",
            senderName: "Swarm Protocol",
            senderType: "agent",
            content: `⚡ **@${agent.name}** has been assigned to **all ${PROTOCOL_SLOTS.length} protocol roles**.\n\nThis agent is now responsible for: ${PROTOCOL_SLOTS.map(s => s.name).join(", ")}.\n\nFull swarm operations active.`,
            orgId: currentOrg.id,
            createdAt: new Date(),
          });
        }).catch(() => {});
      }
    } catch (err) {
      console.error("Failed to assign agent to all slots:", err);
    }
    setSaving(false);
    setSelectedSlot(null);
  }

  async function unassignAgent(slotId: string) {
    if (!currentOrg) return;
    setSaving(true);
    const updated = { ...assignments, [slotId]: null };
    try {
      await updateOrganization(currentOrg.id, { swarmSlots: updated } as Partial<typeof currentOrg>);
      setAssignments(updated);
    } catch (err) {
      console.error("Failed to unassign agent:", err);
    }
    setSaving(false);
  }

  function getAgent(slotId: string): Agent | undefined {
    const a = assignments[slotId];
    if (!a) return undefined;
    return agents.find(ag => ag.id === a.agentId);
  }

  const selectedSlotInfo = PROTOCOL_SLOTS.find(s => s.id === selectedSlot);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Zap className={cn("h-6 w-6", allEquipped ? "text-amber-400" : "text-muted-foreground")} />
            Swarm Protocol
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Equip agents to protocol roles. Fill all slots to fully activate the swarm.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className={cn(
            "text-xs",
            allEquipped ? "bg-amber-500/10 text-amber-400 border-amber-500/20" : ""
          )}>
            {filledCount}/{PROTOCOL_SLOTS.length} Equipped
          </Badge>
          {allEquipped && (
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 animate-pulse">
              Fully Operational
            </Badge>
          )}
        </div>
      </div>

      {/* Main layout: Grid + Agent panel */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
        {/* Inventory Grid */}
        <div className="grid grid-cols-3 gap-4">
          {GRID_ORDER.map((slotIdx, gridIdx) => {
            // Center emblem
            if (slotIdx === -2) {
              return (
                <div
                  key="emblem"
                  className={cn(
                    "flex flex-col items-center justify-center rounded-2xl border-2 p-6 transition-all duration-700",
                    allEquipped
                      ? "border-amber-500/50 bg-amber-500/5 shadow-[0_0_60px_rgba(245,158,11,0.15)]"
                      : "border-border bg-card/50"
                  )}
                >
                  <Zap className={cn(
                    "h-12 w-12 mb-2 transition-all duration-700",
                    allEquipped ? "text-amber-400 drop-shadow-[0_0_12px_rgba(245,158,11,0.6)]" : "text-muted-foreground/30"
                  )} />
                  <span className={cn(
                    "text-[10px] font-bold uppercase tracking-[0.2em] transition-colors",
                    allEquipped ? "text-amber-400" : "text-muted-foreground/30"
                  )}>
                    Swarm
                  </span>
                  <span className={cn(
                    "text-[10px] uppercase tracking-widest transition-colors mt-0.5",
                    allEquipped ? "text-amber-400/60" : "text-muted-foreground/20"
                  )}>
                    Protocol
                  </span>
                </div>
              );
            }

            // Empty spacer cells
            if (slotIdx === -1) {
              return <div key={`spacer-${gridIdx}`} />;
            }

            // Slot card
            const slot = PROTOCOL_SLOTS[slotIdx];
            const agent = getAgent(slot.id);
            const styles = SLOT_STYLES[slot.color];

            if (agent) {
              // Filled slot — click to swap agent
              return (
                <SpotlightCard
                  key={slot.id}
                  className="p-0 group cursor-pointer"
                  spotlightColor={`rgba(${slot.rgb}, 0.1)`}
                >
                  <div
                    className={cn(
                      "p-4 rounded-xl border relative overflow-hidden min-h-[160px] flex flex-col",
                      styles.border, styles.bg
                    )}
                    onClick={() => setSelectedSlot(slot.id)}
                  >
                    {/* Glow gradient */}
                    <div className={cn("absolute inset-0 bg-gradient-to-br to-transparent opacity-60", styles.glow)} />

                    <div className="relative z-10 flex-1 flex flex-col">
                      {/* Header */}
                      <div className="flex items-center justify-between mb-3">
                        <Badge className={cn("text-[10px]", styles.badgeBg, styles.text, styles.badgeBorder)}>
                          <slot.icon className="h-3 w-3 mr-1" />
                          {slot.name}
                        </Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => { e.stopPropagation(); unassignAgent(slot.id); }}
                          disabled={saving}
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>

                      {/* Agent info */}
                      <div className="flex items-center gap-3 mt-auto">
                        <img
                          src={agent.avatarUrl || getAgentAvatarUrl(agent.name, agent.type)}
                          alt={agent.name}
                          className={cn("w-10 h-10 rounded-full border-2 shadow-lg", styles.ring)}
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{agent.name}</p>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className={cn("w-2 h-2 rounded-full shrink-0", STATUS_DOT[agent.status] || STATUS_DOT.offline)} />
                            <span className="text-[10px] text-muted-foreground">{agent.status}</span>
                            <Badge variant="outline" className="text-[9px] ml-1">{agent.type}</Badge>
                          </div>
                        </div>
                      </div>

                      {/* Automation badges */}
                      {(policies[slot.id]?.length ?? 0) > 0 && (
                        <div className="flex items-center gap-1 mt-2">
                          <Badge variant="outline" className="text-[9px] border-purple-500/30 text-purple-400">
                            <Zap className="w-2.5 h-2.5 mr-0.5" />
                            {policies[slot.id].length} automation{policies[slot.id].length !== 1 ? "s" : ""}
                          </Badge>
                        </div>
                      )}

                      <p className="text-[10px] text-muted-foreground/40 text-center mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        Click to swap agent
                      </p>
                    </div>
                  </div>
                </SpotlightCard>
              );
            }

            // Empty slot
            return (
              <SpotlightCard
                key={slot.id}
                className="p-0 cursor-pointer"
                spotlightColor={`rgba(${slot.rgb}, 0.06)`}
              >
                <button
                  className="w-full p-4 border-2 border-dashed border-muted-foreground/15 rounded-xl hover:border-muted-foreground/30 transition-all min-h-[160px] flex flex-col items-center justify-center gap-2 text-center"
                  onClick={() => setSelectedSlot(slot.id)}
                >
                  <slot.icon className={cn("h-7 w-7", `text-muted-foreground/25`)} />
                  <span className="text-xs font-semibold text-muted-foreground/40">{slot.name}</span>
                  <span className="text-[10px] text-muted-foreground/25">{slot.description}</span>
                  <span className="text-[10px] text-muted-foreground/20 mt-1">Click to assign</span>
                </button>
              </SpotlightCard>
            );
          })}
        </div>

        {/* Right panel: Available Agents */}
        <Card className="p-4 h-fit lg:sticky lg:top-20">
          <h3 className="text-sm font-semibold mb-3">Available Agents</h3>
          <div className="relative mb-3">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search agents..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="h-8 text-xs pl-8"
            />
          </div>
          <div className="space-y-1.5 max-h-[60vh] overflow-y-auto pr-1">
            {filteredAgents.length === 0 && (
              <p className="text-xs text-muted-foreground/50 text-center py-4">No agents found</p>
            )}
            {filteredAgents.map(agent => {
              const equippedSlotCount = PROTOCOL_SLOTS.filter(s => assignments[s.id]?.agentId === agent.id).length;
              return (
                <button
                  key={agent.id}
                  onClick={() => {
                    // Find first empty slot, or first slot not assigned to this agent
                    const emptySlot = PROTOCOL_SLOTS.find(s => !assignments[s.id]?.agentId);
                    if (emptySlot) {
                      setSelectedSlot(emptySlot.id);
                    } else {
                      // All filled — let user pick which to swap
                      setSelectedSlot(PROTOCOL_SLOTS[0].id);
                    }
                  }}
                  className="w-full flex items-center gap-2.5 p-2.5 rounded-lg border border-border hover:border-muted-foreground/30 hover:bg-muted/30 cursor-pointer transition-all text-left"
                >
                  <img
                    src={agent.avatarUrl || getAgentAvatarUrl(agent.name, agent.type)}
                    alt={agent.name}
                    className="w-7 h-7 rounded-full shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{agent.name}</p>
                    <p className="text-[10px] text-muted-foreground">{agent.type}</p>
                  </div>
                  <span className={cn("w-2 h-2 rounded-full shrink-0", STATUS_DOT[agent.status] || STATUS_DOT.offline)} />
                  {equippedSlotCount > 0 && (
                    <Badge variant="outline" className="text-[9px] shrink-0">
                      {equippedSlotCount === PROTOCOL_SLOTS.length ? "All" : equippedSlotCount} Slot{equippedSlotCount !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Assignment Dialog */}
      <Dialog open={!!selectedSlot} onOpenChange={() => setSelectedSlot(null)}>
        <DialogHeader>
          <DialogTitle>
            {selectedSlotInfo ? `Assign Agent to ${selectedSlotInfo.name}` : "Assign Agent"}
          </DialogTitle>
        </DialogHeader>
        <DialogContent>
          {selectedSlotInfo && (
            <p className="text-xs text-muted-foreground mb-3">{selectedSlotInfo.description}</p>
          )}

          {/* Automation section */}
          {selectedSlotInfo && (
            <div className="mb-4 pb-4 border-b border-border">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Automations
                </h4>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[10px] text-purple-400 border-purple-500/30 hover:bg-purple-500/10"
                  onClick={() => {
                    setBuilderSlotId(selectedSlotInfo.id);
                    setBuilderSlotName(selectedSlotInfo.name);
                    setBuilderOpen(true);
                  }}
                >
                  <Plus className="w-3 h-3 mr-1" /> Add Automation
                </Button>
              </div>
              {(policies[selectedSlotInfo.id]?.length ?? 0) === 0 ? (
                <p className="text-[10px] text-muted-foreground/50 py-2">
                  No automations configured. Add one to trigger actions automatically.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {policies[selectedSlotInfo.id].map((policy) => (
                    <div
                      key={policy.id}
                      className="flex items-center gap-2 p-2 rounded-lg border border-border bg-card/50"
                    >
                      <Zap className={cn("w-3.5 h-3.5 shrink-0", policy.enabled ? "text-purple-400" : "text-zinc-600")} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{policy.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {policy.trigger.type.replace(/_/g, " ")} → {policy.action.type.replace(/_/g, " ")}
                        </p>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[9px]",
                          policy.enabled
                            ? "border-emerald-500/30 text-emerald-400"
                            : "border-zinc-600 text-zinc-500"
                        )}
                      >
                        {policy.enabled ? "Active" : "Off"}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-zinc-500 hover:text-zinc-300"
                        onClick={() => {
                          setHistoryPolicyId(policy.id);
                          setHistoryPolicyName(policy.name);
                          setHistoryOpen(true);
                        }}
                        title="View execution history"
                      >
                        <History className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-zinc-500 hover:text-amber-400"
                        onClick={async () => {
                          try {
                            await fetch(`/api/v1/slots/${policy.id}`, {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ enabled: !policy.enabled }),
                            });
                            fetchPolicies();
                          } catch {}
                        }}
                        title={policy.enabled ? "Disable" : "Enable"}
                      >
                        <Power className="w-3 h-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-zinc-500 hover:text-red-400"
                        onClick={async () => {
                          try {
                            await fetch(`/api/v1/slots/${policy.id}`, { method: "DELETE" });
                            fetchPolicies();
                          } catch {}
                        }}
                        title="Delete automation"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-1.5 max-h-[40vh] overflow-y-auto">
            {agents.map(agent => {
              const currentlyInSlot = selectedSlot && assignments[selectedSlot]?.agentId === agent.id;
              return (
                <div key={agent.id} className="flex items-center gap-2">
                  <button
                    className={cn(
                      "flex-1 flex items-center gap-3 p-3 rounded-lg border transition-all text-left",
                      currentlyInSlot
                        ? "border-amber-500/40 bg-amber-500/10 opacity-60"
                        : "border-border hover:border-amber-500/30 hover:bg-amber-500/5"
                    )}
                    onClick={() => !currentlyInSlot && assignAgent(selectedSlot!, agent.id)}
                    disabled={saving || !!currentlyInSlot}
                  >
                    <img
                      src={agent.avatarUrl || getAgentAvatarUrl(agent.name, agent.type)}
                      alt={agent.name}
                      className="w-9 h-9 rounded-full"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{agent.name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={cn("w-2 h-2 rounded-full", STATUS_DOT[agent.status] || STATUS_DOT.offline)} />
                        <span className="text-[10px] text-muted-foreground">{agent.status}</span>
                        <Badge variant="outline" className="text-[9px] ml-1">{agent.type}</Badge>
                      </div>
                      {agent.bio && (
                        <p className="text-[10px] text-muted-foreground/70 mt-1 line-clamp-1">{agent.bio}</p>
                      )}
                    </div>
                    {currentlyInSlot && (
                      <Badge className="text-[9px] bg-amber-500/20 text-amber-400 border-amber-500/30 shrink-0">Current</Badge>
                    )}
                  </button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-[10px] h-8 px-2"
                    onClick={() => assignAgentToAll(agent.id)}
                    disabled={saving}
                    title={`Assign ${agent.name} to all slots`}
                  >
                    All Slots
                  </Button>
                </div>
              );
            })}
            {agents.length === 0 && (
              <p className="text-xs text-muted-foreground/50 text-center py-4">
                No agents available. Register agents first.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Slot Policy Builder Dialog */}
      <SlotPolicyBuilder
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        slotId={builderSlotId}
        slotName={builderSlotName}
        orgId={currentOrg?.id || ""}
        onSave={fetchPolicies}
      />

      {/* Execution History Dialog */}
      <SlotExecutionHistory
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        policyId={historyPolicyId}
        policyName={historyPolicyName}
      />
    </div>
  );
}
