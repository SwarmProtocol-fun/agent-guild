/**
 * ClawFlows workflow template catalog — types and an empty default.
 *
 * The community template catalog moved to the swarm-flow mod in the open-core
 * split. The Workflows page still renders a "Templates" tab from these
 * exports, so core keeps the shapes and ships an empty catalog; the mod is
 * expected to supply the entries.
 */

export interface ClawFlow {
  slug: string;
  label: string;
  description: string;
  schedule?: string;
  sourceUrl: string;
}

export interface ClawFlowCategory {
  id: string;
  emoji: string;
  label: string;
  flows: ClawFlow[];
}

export const CLAWFLOW_CATEGORIES: ClawFlowCategory[] = [];

export const TOTAL_FLOWS = CLAWFLOW_CATEGORIES.reduce((n, c) => n + c.flows.length, 0);
