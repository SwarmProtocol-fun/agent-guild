/** Map Agent Node — ChatDev-inspired agent node with role persona, communication status, and skill badges. */
"use client";

import { memo, useState } from "react";
import { Handle, Position } from "@xyflow/react";

// ChatDev-inspired role configuration with distinct visual identities
const ROLE_CONFIG: Record<string, { icon: string; color: string; bg: string; border: string; glow: string; title: string }> = {
  // Leadership
  coordinator: { icon: "👔", color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500", glow: "shadow-blue-500/20", title: "Coordinator" },
  manager: { icon: "📋", color: "text-blue-400", bg: "bg-blue-500/10", border: "border-blue-500", glow: "shadow-blue-500/20", title: "Manager" },
  // Development
  coder: { icon: "💻", color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500", glow: "shadow-emerald-500/20", title: "Programmer" },
  developer: { icon: "💻", color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500", glow: "shadow-emerald-500/20", title: "Developer" },
  engineer: { icon: "🔧", color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500", glow: "shadow-emerald-500/20", title: "Engineer" },
  // Research & Analysis
  research: { icon: "🔬", color: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500", glow: "shadow-purple-500/20", title: "Researcher" },
  analyst: { icon: "📊", color: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500", glow: "shadow-purple-500/20", title: "Analyst" },
  analytics: { icon: "📊", color: "text-purple-400", bg: "bg-purple-500/10", border: "border-purple-500", glow: "shadow-purple-500/20", title: "Data Analyst" },
  // Trading & Finance
  trading: { icon: "📈", color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500", glow: "shadow-amber-500/20", title: "Trader" },
  finance: { icon: "💰", color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500", glow: "shadow-amber-500/20", title: "Finance" },
  // Operations & DevOps
  operations: { icon: "⚙️", color: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500", glow: "shadow-orange-500/20", title: "Ops" },
  devops: { icon: "🚀", color: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500", glow: "shadow-orange-500/20", title: "DevOps" },
  // Testing & QA
  tester: { icon: "🧪", color: "text-pink-400", bg: "bg-pink-500/10", border: "border-pink-500", glow: "shadow-pink-500/20", title: "Tester" },
  qa: { icon: "✅", color: "text-pink-400", bg: "bg-pink-500/10", border: "border-pink-500", glow: "shadow-pink-500/20", title: "QA" },
  // Security
  security: { icon: "🛡️", color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500", glow: "shadow-red-500/20", title: "Security" },
  scout: { icon: "🔍", color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500", glow: "shadow-red-500/20", title: "Scout" },
  // Support & Communication
  support: { icon: "🛟", color: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500", glow: "shadow-cyan-500/20", title: "Support" },
  communications: { icon: "📡", color: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500", glow: "shadow-cyan-500/20", title: "Comms" },
  // Creative
  designer: { icon: "🎨", color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500", glow: "shadow-rose-500/20", title: "Designer" },
  writer: { icon: "✍️", color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500", glow: "shadow-rose-500/20", title: "Writer" },
  // Swarm
  swarm: { icon: "🐝", color: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500", glow: "shadow-yellow-500/20", title: "Swarm" },
};

const DEFAULT_ROLE = { icon: "🤖", color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-600", glow: "shadow-amber-500/20", title: "Agent" };

function getRoleConfig(type: string) {
  const lower = type.toLowerCase();
  return ROLE_CONFIG[lower] || Object.entries(ROLE_CONFIG).find(([k]) => lower.includes(k))?.[1] || DEFAULT_ROLE;
}

const STATUS_STYLES: Record<string, { dot: string; ring: string; label: string }> = {
  online: { dot: "bg-emerald-400", ring: "ring-emerald-400/30", label: "Online" },
  busy: { dot: "bg-amber-400 animate-pulse", ring: "ring-amber-400/30", label: "Working" },
  offline: { dot: "bg-zinc-500", ring: "ring-zinc-500/20", label: "Offline" },
};

interface MapAgentNodeData {
  label: string;
  agentName: string;
  type: string;
  status: string;
  taskCount: number;
  activeCount: number;
  costEstimate: string;
  activeJobName?: string;
  assignedCost?: number;
  currencySymbol?: string;
  asn?: string;
  creditScore?: number;
  trustScore?: number;
  skills?: string[];
  lastMessage?: string;
  messageCount?: number;
  [key: string]: unknown;
}

export const MapAgentNode = memo(function MapAgentNode({ data }: { data: MapAgentNodeData }) {
  const [expanded, setExpanded] = useState(false);
  const role = getRoleConfig(data.type);
  const statusStyle = STATUS_STYLES[data.status] || STATUS_STYLES.offline;
  const isWorking = data.status === "busy" && data.activeJobName;
  const doneCount = data.taskCount - data.activeCount;

  // Credit score tier
  const creditScore = data.creditScore ?? 0;
  const tier = creditScore >= 850 ? "Platinum" : creditScore >= 700 ? "Gold" : creditScore >= 550 ? "Silver" : creditScore > 0 ? "Bronze" : null;
  const tierColor = tier === "Platinum" ? "text-cyan-400" : tier === "Gold" ? "text-yellow-400" : tier === "Silver" ? "text-zinc-300" : "text-orange-400";

  return (
    <div
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      className={`rounded-xl border-2 bg-card/95 backdrop-blur-sm shadow-lg cursor-pointer transition-all duration-200 ${
        expanded ? "min-w-[260px] max-w-[300px]" : "min-w-[200px] max-w-[240px]"
      } ${role.border} ${isWorking ? `animate-glow-pulse shadow-lg ${role.glow}` : ""}`}
    >
      {/* Input handle (left) for receiving messages from other agents */}
      <Handle type="target" position={Position.Left} className={`!w-3 !h-3 !${role.border.replace("border-", "bg-")}`} />

      {/* Role header bar */}
      <div className={`${role.bg} rounded-t-[10px] px-3 py-1.5 flex items-center justify-between border-b border-border/50`}>
        <span className={`text-[10px] font-bold uppercase tracking-wider ${role.color}`}>
          {role.icon} {role.title}
        </span>
        <div className="flex items-center gap-1.5">
          {isWorking && <span className="animate-spin text-[10px]">⚙️</span>}
          <span className={`h-2 w-2 rounded-full ${statusStyle.dot} ring-2 ${statusStyle.ring}`} />
        </div>
      </div>

      {/* Agent identity */}
      <div className="px-3 py-2">
        <p className="text-sm font-semibold text-foreground truncate">{data.agentName}</p>
        {data.asn && (
          <p className="text-[10px] font-mono text-muted-foreground/60 truncate">{data.asn}</p>
        )}
      </div>

      {/* Quick stats (collapsed) */}
      {!expanded && (
        <div className="px-3 pb-2 space-y-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted-foreground">{data.taskCount} tasks</span>
            <span className="text-muted-foreground/40">|</span>
            <span className={role.color}>{data.activeCount} active</span>
            {tier && (
              <>
                <span className="text-muted-foreground/40">|</span>
                <span className={`${tierColor} font-medium`}>{tier}</span>
              </>
            )}
          </div>
          {isWorking && (
            <div className={`text-[10px] ${role.color} truncate`}>
              Working on: {data.activeJobName}
            </div>
          )}
          {data.lastMessage && (
            <div className="text-[10px] text-muted-foreground/50 italic truncate">
              "{data.lastMessage}"
            </div>
          )}
        </div>
      )}

      {/* Expanded details */}
      {expanded && (
        <div className="px-3 pb-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
          {/* Status + cost */}
          <div className={`flex items-center justify-between px-2 py-1.5 rounded-lg ${role.bg}`}>
            <span className="text-[11px] font-medium flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${statusStyle.dot}`} />
              {statusStyle.label}
            </span>
            <span className="text-[10px] text-muted-foreground">{data.costEstimate}/run</span>
          </div>

          {/* Active job */}
          {isWorking && (
            <div className={`px-2 py-1.5 rounded-lg ${role.bg} border ${role.border}/20`}>
              <p className="text-[10px] text-muted-foreground mb-0.5">Current Task</p>
              <p className={`text-[11px] ${role.color} font-medium`}>{data.activeJobName}</p>
            </div>
          )}

          {/* Task breakdown */}
          <div className="grid grid-cols-3 gap-1 text-center">
            <div className="px-1 py-1.5 rounded-lg bg-muted/40">
              <p className="text-sm font-bold">{data.taskCount}</p>
              <p className="text-[9px] text-muted-foreground">Total</p>
            </div>
            <div className={`px-1 py-1.5 rounded-lg ${role.bg}`}>
              <p className={`text-sm font-bold ${role.color}`}>{data.activeCount}</p>
              <p className="text-[9px] text-muted-foreground">Active</p>
            </div>
            <div className="px-1 py-1.5 rounded-lg bg-emerald-500/10">
              <p className="text-sm font-bold text-emerald-500">{doneCount}</p>
              <p className="text-[9px] text-muted-foreground">Done</p>
            </div>
          </div>

          {/* Credit & Trust scores */}
          {creditScore > 0 && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-muted/30">
              <div className="flex-1">
                <p className="text-[9px] text-muted-foreground">Credit</p>
                <div className="flex items-center gap-1">
                  <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${tier === "Platinum" ? "bg-cyan-400" : tier === "Gold" ? "bg-yellow-400" : tier === "Silver" ? "bg-zinc-300" : "bg-orange-400"}`} style={{ width: `${((creditScore - 300) / 600) * 100}%` }} />
                  </div>
                  <span className={`text-[10px] font-mono font-bold ${tierColor}`}>{creditScore}</span>
                </div>
              </div>
              {data.trustScore != null && (
                <div className="flex-1">
                  <p className="text-[9px] text-muted-foreground">Trust</p>
                  <div className="flex items-center gap-1">
                    <div className="flex-1 h-1.5 bg-muted/50 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${data.trustScore}%` }} />
                    </div>
                    <span className="text-[10px] font-mono font-bold text-emerald-400">{data.trustScore}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Skills */}
          {data.skills && data.skills.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.skills.slice(0, 5).map((skill, i) => (
                <span key={i} className={`text-[9px] px-1.5 py-0.5 rounded-full ${role.bg} ${role.color} border ${role.border}/20`}>
                  {skill}
                </span>
              ))}
            </div>
          )}

          {/* Message count */}
          {(data.messageCount ?? 0) > 0 && (
            <div className="flex items-center justify-between px-2 py-1 rounded-lg bg-muted/20">
              <span className="text-[10px] text-muted-foreground">Messages exchanged</span>
              <span className={`text-[10px] font-bold ${role.color}`}>{data.messageCount}</span>
            </div>
          )}

          {/* Assigned budget */}
          {(data.assignedCost ?? 0) > 0 && (
            <div className={`flex items-center justify-between px-2 py-1.5 rounded-lg ${role.bg} border ${role.border}/20`}>
              <span className="text-[10px] text-muted-foreground">Budget</span>
              <span className={`text-xs font-bold ${role.color}`}>
                {data.assignedCost?.toLocaleString()} {data.currencySymbol || "$"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Output handle (right) for sending messages to other agents/jobs */}
      <Handle type="source" position={Position.Right} className="!bg-emerald-500 !w-3 !h-3" id="job-source" />
    </div>
  );
});
