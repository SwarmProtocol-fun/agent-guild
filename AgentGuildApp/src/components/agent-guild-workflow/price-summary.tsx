/** Price Summary — Cost estimation + execution controls for the workflow canvas. */
'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Square } from 'lucide-react';
import { type WorkflowValidation, formatCostCents } from '@/lib/swarm-workflow';

interface PriceSummaryProps {
  validation: WorkflowValidation;
  agentCount: number;
  onExecute: () => void;
  executing: boolean;
  onCancel?: () => void;
}

export function PriceSummary({ validation, agentCount, onExecute, executing, onCancel }: PriceSummaryProps) {
  return (
    <div className="border-t border-border bg-card px-4 py-3 flex items-center justify-between gap-4">
      <div className="flex items-center gap-4">
        <div className="text-sm">
          <span className="text-muted-foreground">Agents: </span>
          <span className="font-semibold">{agentCount}</span>
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground">Est. Total: </span>
          <span className="font-bold text-amber-700 text-base">
            {formatCostCents(validation.totalCostCents)}
          </span>
        </div>
        {!validation.isValid && validation.errors.length > 0 && (
          <Badge className="bg-red-50 text-red-700 border-red-200 text-xs">
            {validation.errors[0]}
          </Badge>
        )}
      </div>
      <div className="flex items-center gap-2">
        {onCancel && executing && (
          <Button
            onClick={onCancel}
            variant="outline"
            size="sm"
            className="text-red-600 border-red-200 hover:bg-red-50"
          >
            <Square className="h-3 w-3 mr-1.5" />
            Cancel
          </Button>
        )}
        <Button
          onClick={onExecute}
          disabled={!validation.isValid || executing}
          className="bg-amber-600 hover:bg-amber-700 text-black disabled:opacity-50"
        >
          {executing ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Executing...
            </span>
          ) : (
            `Execute Swarm (${formatCostCents(validation.totalCostCents)})`
          )}
        </Button>
      </div>
    </div>
  );
}
