/** Node Registry — Exports all custom workflow node types for the React Flow canvas. */
import { TriggerNode } from './trigger-node';
import { AgentNode } from './agent-node';
import { OutputNode } from './output-node';

export const nodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  output: OutputNode,
};
