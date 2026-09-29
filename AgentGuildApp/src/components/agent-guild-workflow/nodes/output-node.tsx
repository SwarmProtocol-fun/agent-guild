/** Output Node — Visual workflow node representing a task output or result sink. */
'use client';

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';

const OUTPUT_ICONS: Record<string, string> = {
  result: '🎯',
  report: '📄',
  action: '🚀',
};

export function OutputNode({ data, selected }: NodeProps) {
  const outputType = (data.outputType as string) || 'result';

  return (
    <div className={cn(
      'rounded-lg border-2 bg-card shadow-sm px-4 py-3 min-w-[180px]',
      selected ? 'border-emerald-500 ring-2 ring-emerald-200' : 'border-emerald-300'
    )}>
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-emerald-500 !border-2 !border-white"
      />
      <div className="flex items-center gap-2 mb-1">
        <span className="text-lg">{OUTPUT_ICONS[outputType] || '🎯'}</span>
        <span className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Output</span>
      </div>
      <p className="text-sm font-medium text-foreground">{data.label as string}</p>
      <p className="text-xs text-muted-foreground mt-1 capitalize">{outputType}</p>
    </div>
  );
}
