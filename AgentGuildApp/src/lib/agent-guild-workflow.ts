import type { Agent } from './firestore';
import { AGENT_TYPE_CATEGORIES, getAgentType, type AgentTypeCategory } from './agent-types';

// ─── Node Data Types ────────────────────────────────────

export interface TriggerNodeData {
  label: string;
  description: string;
}

export interface AgentNodeData {
  agentId: string;
  agentName: string;
  agentType: string;
  agentStatus: Agent['status'];
  capabilities: string[];
  estimatedCost: number; // in USD cents
}

export interface OutputNodeData {
  label: string;
  outputType: 'result' | 'report' | 'action';
}

// ─── Price Configuration ────────────────────────────────

/** Default cost per category (in USD cents). Individual type overrides can be added as needed. */
const CATEGORY_COSTS: Record<AgentTypeCategory, number> = {
  "core-development": 300,       // $3.00
  "language-specialists": 250,   // $2.50
  "infrastructure": 225,         // $2.25
  "quality-security": 250,       // $2.50
  "data-ai": 275,                // $2.75
  "developer-experience": 200,   // $2.00
  "specialized-domains": 275,    // $2.75
  "business-product": 150,       // $1.50
  "meta-orchestration": 100,     // $1.00
  "research-analysis": 150,      // $1.50
};

/** Get estimated cost for an agent type (in USD cents). */
export function getAgentTypeCost(typeId: string): number {
  const info = getAgentType(typeId);
  if (!info) return 150; // default
  return CATEGORY_COSTS[info.category] ?? 150;
}

// Legacy lookup kept for backward compat in existing code
export const AGENT_TYPE_COSTS: Record<string, number> = {
  Research: 150,       Trading: 300,        Operations: 100,
  Support: 75,         Analytics: 200,      Scout: 125,
  Security: 250,       Creative: 175,       Engineering: 350,
  DevOps: 225,         Marketing: 150,      Finance: 275,
  Data: 200,           Coordinator: 100,    Legal: 300,
  Communication: 125,
};

/** Category-based icons for new types; keyed by category. */
const CATEGORY_ICONS: Record<AgentTypeCategory, string> = {
  "core-development": '💻',
  "language-specialists": '🔤',
  "infrastructure": '🏗️',
  "quality-security": '🛡️',
  "data-ai": '🧠',
  "developer-experience": '🔧',
  "specialized-domains": '🎯',
  "business-product": '📊',
  "meta-orchestration": '🎛️',
  "research-analysis": '🔬',
};

/** Get icon for an agent type. */
export function getAgentTypeIcon(typeId: string): string {
  // Check legacy icons first
  if (typeId in AGENT_TYPE_ICONS) return AGENT_TYPE_ICONS[typeId];
  const info = getAgentType(typeId);
  if (!info) return '🤖';
  return CATEGORY_ICONS[info.category] ?? '🤖';
}

// Legacy lookup kept for backward compat
export const AGENT_TYPE_ICONS: Record<string, string> = {
  Research: '🔬',     Trading: '📈',       Operations: '⚙️',
  Support: '🛟',      Analytics: '📊',     Scout: '🔭',
  Security: '🛡️',    Creative: '🎨',      Engineering: '💻',
  DevOps: '🚀',       Marketing: '📣',     Finance: '💰',
  Data: '🗄️',        Coordinator: '🎯',   Legal: '⚖️',
  Communication: '📡',
};

// ─── Workflow Validation ────────────────────────────────

export interface WorkflowValidation {
  isValid: boolean;
  errors: string[];
  totalCostCents: number;
}

export function validateWorkflow(
  nodes: Array<{ id: string; type?: string; data: Record<string, unknown> }>,
  edges: Array<{ source: string; target: string }>
): WorkflowValidation {
  const errors: string[] = [];

  const triggerNodes = nodes.filter(n => n.type === 'trigger');
  const agentNodes = nodes.filter(n => n.type === 'agent');
  const outputNodes = nodes.filter(n => n.type === 'output');

  if (triggerNodes.length === 0) {
    errors.push('Add a Trigger node to start');
  }
  if (triggerNodes.length > 1) {
    errors.push('Only one Trigger node allowed');
  }
  if (agentNodes.length === 0) {
    errors.push('Add at least one Agent node');
  }
  if (outputNodes.length === 0) {
    errors.push('Add an Output node');
  }
  if (nodes.length > 1 && edges.length === 0) {
    errors.push('Connect the nodes together');
  }

  const totalCostCents = agentNodes.reduce((sum, node) => {
    return sum + ((node.data?.estimatedCost as number) || 0);
  }, 0);

  return {
    isValid: errors.length === 0,
    errors,
    totalCostCents,
  };
}

export function formatCostCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
