/** Node Palette — Draggable panel of available workflow node types for the visual canvas editor. */
'use client';

import type { Agent } from '@/lib/firestore';
import { AGENT_TYPE_ICONS, AGENT_TYPE_COSTS, formatCostCents } from '@/lib/swarm-workflow';

interface NodePaletteProps {
  agents: Agent[];
}

export function NodePalette({ agents }: NodePaletteProps) {
  const onDragStart = (event: React.DragEvent, nodeType: string, data: string) => {
    event.dataTransfer.setData('application/reactflow-type', nodeType);
    event.dataTransfer.setData('application/reactflow-data', data);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="w-64 border-l border-border bg-muted/50 overflow-y-auto p-4 space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Node Palette
      </h3>

      {/* Control Nodes */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">Control</p>
        <div className="space-y-2">
          <div
            draggable
            onDragStart={(e) => onDragStart(e, 'trigger', JSON.stringify({ label: 'Start', description: 'Workflow trigger' }))}
            className="p-3 rounded-lg border-2 border-dashed border-amber-300 bg-amber-50 cursor-grab active:cursor-grabbing hover:border-amber-400 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span>⚡</span>
              <span className="text-sm font-medium">Trigger</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Start the workflow</p>
          </div>

          <div
            draggable
            onDragStart={(e) => onDragStart(e, 'output', JSON.stringify({ label: 'Result', outputType: 'result' }))}
            className="p-3 rounded-lg border-2 border-dashed border-emerald-300 bg-emerald-50 cursor-grab active:cursor-grabbing hover:border-emerald-400 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span>🎯</span>
              <span className="text-sm font-medium">Output</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">Workflow result</p>
          </div>
        </div>
      </div>

      {/* Agent Nodes */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Agents ({agents.length})
        </p>
        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No agents registered yet.
          </p>
        ) : (
          <div className="space-y-2">
            {agents.map((agent) => (
              <div
                key={agent.id}
                draggable
                onDragStart={(e) => onDragStart(e, 'agent', JSON.stringify({
                  agentId: agent.id,
                  agentName: agent.name,
                  agentType: agent.type,
                  agentStatus: agent.status,
                  capabilities: agent.capabilities,
                  estimatedCost: AGENT_TYPE_COSTS[agent.type],
                }))}
                className="p-3 rounded-lg border border-border bg-card cursor-grab active:cursor-grabbing hover:border-amber-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-full bg-amber-100 flex items-center justify-center text-xs font-bold text-amber-700">
                    {agent.name.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{agent.name}</p>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-muted-foreground">
                        {AGENT_TYPE_ICONS[agent.type]} {agent.type}
                      </span>
                      <span className="text-xs text-amber-600 dark:text-amber-400 font-medium ml-auto">
                        {formatCostCents(AGENT_TYPE_COSTS[agent.type])}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
