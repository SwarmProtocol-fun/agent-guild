/** Trigger Node — Visual workflow node representing an event trigger (cron, webhook, manual). */
'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';

export function TriggerNode({ data, selected }: NodeProps) {
  const label = data.label as string;
  const description = data.description as string | undefined;

  return (
    <div className={cn(
      'rounded-lg border-2 bg-card shadow-sm px-4 py-3 min-w-[180px]',
      selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-amber-300'
    )}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">⚡</span>
        <span className="text-xs font-semibold uppercase tracking-wide text-amber-700">Trigger</span>
      </div>
      <p className="text-sm font-medium text-foreground">{label}</p>
      {description ? (
        <p className="text-xs text-muted-foreground mt-1">{description}</p>
      ) : null}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-amber-500 !border-2 !border-white"
      />
    </div>
  );
}
