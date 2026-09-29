/** Agent Node — Visual workflow node representing an AI agent with config, status, and connection handles. */
'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AGENT_TYPE_ICONS, formatCostCents } from '@/lib/swarm-workflow';
import { getTypeColor, getTypeLabel } from '@/lib/agent-types';

export function AgentNode({ data, selected }: NodeProps) {
  const agentType = data.agentType as string;
  const agentStatus = data.agentStatus as string;

  return (
    <div className={cn(
      'rounded-lg border-2 bg-card shadow-sm min-w-[220px]',
      selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-border'
    )}>
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-amber-500 !border-2 !border-white"
      />

      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-sm font-bold text-amber-700">
            {(data.agentName as string).charAt(0)}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{data.agentName as string}</p>
            <div className="flex items-center gap-1.5">
              <Badge className={cn('text-[10px] py-0', getTypeColor(agentType))}>
                {AGENT_TYPE_ICONS[agentType as keyof typeof AGENT_TYPE_ICONS] || '🤖'} {getTypeLabel(agentType)}
              </Badge>
              <span className={cn('w-1.5 h-1.5 rounded-full',
                agentStatus === 'online' ? 'bg-emerald-500' :
                agentStatus === 'busy' ? 'bg-orange-500' : 'bg-muted'
              )} />
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 py-2 bg-muted rounded-b-lg flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Est. Cost</span>
        <span className="text-sm font-bold text-amber-700">
          {formatCostCents(data.estimatedCost as number)}
        </span>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-amber-500 !border-2 !border-white"
      />
    </div>
  );
}
