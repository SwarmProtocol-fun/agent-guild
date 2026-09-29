/**
 * Structured Agent Messaging System
 *
 * Hybrid approach combining Mission Control's typed messaging
 * with Swarm's scalable WebSocket + Pub/Sub infrastructure.
 *
 * Message Types:
 * - a2a (agent-to-agent): Direct 1:1 communication with guaranteed delivery
 * - coord (coordinator): Routed through a coordinator agent for orchestration
 * - broadcast: Channel-wide message to all subscribers
 * - session: Session-scoped message for multi-step workflows
 */

import type { Timestamp } from 'firebase-admin/firestore';

// ============================================================
// Core Message Types
// ============================================================

export type MessageType = 'a2a' | 'coord' | 'broadcast' | 'session';

export interface BaseAgentMessage {
  id: string;
  type: MessageType;
  from: string;
  fromName: string;
  timestamp: number;
  payload: any;
  metadata?: Record<string, any>;
}

/**
 * Agent-to-Agent (a2a) - Direct 1:1 message
 * Guarantees delivery via WebSocket + Firestore fallback
 */
export interface A2AMessage extends BaseAgentMessage {
  type: 'a2a';
  to: string; // Target agent ID
  toName?: string;
  deliveryStatus?: 'pending' | 'delivered' | 'read';
  deliveredAt?: number;
  readAt?: number;
}

/**
 * Coordinator (coord) - Routed through coordinator
 * Enables orchestrated workflows with supervisor oversight
 */
export interface CoordMessage extends BaseAgentMessage {
  type: 'coord';
  coordinatorId: string; // Coordinator who routes this
  targetId?: string; // Optional final target
  targetName?: string;
  action: 'assign' | 'request' | 'report' | 'escalate';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}

/**
 * Broadcast - Channel-wide message
 * Traditional pub/sub to all channel subscribers
 */
export interface BroadcastMessage extends BaseAgentMessage {
  type: 'broadcast';
  channelId: string;
  channelName?: string;
  mentions?: string[]; // Agent IDs mentioned in message
}

/**
 * Session - Session-scoped message
 * For multi-step workflows, keeps related messages grouped
 */
export interface SessionMessage extends BaseAgentMessage {
  type: 'session';
  sessionId: string;
  sessionName?: string;
  participants: string[]; // Agent IDs in session
  step?: number; // Step in workflow
  stepName?: string;
}

export type AgentMessage = A2AMessage | CoordMessage | BroadcastMessage | SessionMessage;

// ============================================================
// Message Routing
// ============================================================

export interface MessageRoute {
  messageId: string;
  type: MessageType;
  from: string;
  to?: string;
  coordinatorId?: string;
  channelId?: string;
  sessionId?: string;
  routedAt: number;
  deliveredVia: 'websocket' | 'firestore' | 'pubsub';
}

// ============================================================
// Coordinator Registry
// ============================================================

export interface Coordinator {
  agentId: string;
  agentName: string;
  orgId: string;
  projectId?: string;
  channelId?: string;
  responsibilities: string[];
  active: boolean;
  maxConcurrentTasks: number;
  currentLoad: number;
  registeredAt: number;
}

// ============================================================
// Session Management
// ============================================================

export interface AgentSession {
  id: string;
  name: string;
  orgId: string;
  createdBy: string;
  participants: string[]; // Agent IDs
  coordinatorId?: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  currentStep: number;
  totalSteps?: number;
  metadata: Record<string, any>;
  startedAt: number;
  completedAt?: number;
}

// ============================================================
// Message Builders (Type-safe constructors)
// ============================================================

export function createA2AMessage(
  from: string,
  fromName: string,
  to: string,
  payload: any,
  metadata?: Record<string, any>
): A2AMessage {
  return {
    id: crypto.randomUUID(),
    type: 'a2a',
    from,
    fromName,
    to,
    payload,
    timestamp: Date.now(),
    deliveryStatus: 'pending',
    metadata,
  };
}

export function createCoordMessage(
  from: string,
  fromName: string,
  coordinatorId: string,
  action: CoordMessage['action'],
  payload: any,
  options?: {
    targetId?: string;
    targetName?: string;
    priority?: CoordMessage['priority'];
    metadata?: Record<string, any>;
  }
): CoordMessage {
  return {
    id: crypto.randomUUID(),
    type: 'coord',
    from,
    fromName,
    coordinatorId,
    action,
    payload,
    timestamp: Date.now(),
    ...options,
  };
}

export function createBroadcastMessage(
  from: string,
  fromName: string,
  channelId: string,
  payload: any,
  options?: {
    channelName?: string;
    mentions?: string[];
    metadata?: Record<string, any>;
  }
): BroadcastMessage {
  return {
    id: crypto.randomUUID(),
    type: 'broadcast',
    from,
    fromName,
    channelId,
    payload,
    timestamp: Date.now(),
    ...options,
  };
}

export function createSessionMessage(
  from: string,
  fromName: string,
  sessionId: string,
  participants: string[],
  payload: any,
  options?: {
    sessionName?: string;
    step?: number;
    stepName?: string;
    metadata?: Record<string, any>;
  }
): SessionMessage {
  return {
    id: crypto.randomUUID(),
    type: 'session',
    from,
    fromName,
    sessionId,
    participants,
    payload,
    timestamp: Date.now(),
    ...options,
  };
}

// ============================================================
// Message Validation
// ============================================================

export function validateAgentMessage(msg: any): msg is AgentMessage {
  if (!msg || typeof msg !== 'object') return false;
  if (!msg.id || !msg.type || !msg.from || !msg.timestamp) return false;

  switch (msg.type) {
    case 'a2a':
      return !!msg.to;
    case 'coord':
      return !!msg.coordinatorId && !!msg.action;
    case 'broadcast':
      return !!msg.channelId;
    case 'session':
      return !!msg.sessionId && Array.isArray(msg.participants);
    default:
      return false;
  }
}

// ============================================================
// Firestore Schema
// ============================================================

export interface AgentMessageDoc {
  id: string;
  type: MessageType;
  from: string;
  fromName: string;
  to?: string;
  toName?: string;
  coordinatorId?: string;
  channelId?: string;
  sessionId?: string;
  action?: string;
  priority?: string;
  payload: any;
  metadata?: Record<string, any>;
  deliveryStatus?: string;
  deliveredAt?: Timestamp;
  readAt?: Timestamp;
  timestamp: Timestamp;
  orgId: string;
}

export interface CoordinatorDoc {
  agentId: string;
  agentName: string;
  orgId: string;
  projectId?: string;
  channelId?: string;
  responsibilities: string[];
  active: boolean;
  maxConcurrentTasks: number;
  currentLoad: number;
  registeredAt: Timestamp;
}

export interface SessionDoc {
  id: string;
  name: string;
  orgId: string;
  createdBy: string;
  participants: string[];
  coordinatorId?: string;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  currentStep: number;
  totalSteps?: number;
  metadata: Record<string, any>;
  startedAt: Timestamp;
  completedAt?: Timestamp;
}

// ============================================================
// Helpers
// ============================================================

export function getMessageTypeLabel(type: MessageType): string {
  switch (type) {
    case 'a2a':
      return 'Direct Message';
    case 'coord':
      return 'Coordinator';
    case 'broadcast':
      return 'Broadcast';
    case 'session':
      return 'Session';
  }
}

export function getMessageTypeColor(type: MessageType): string {
  switch (type) {
    case 'a2a':
      return 'text-blue-500';
    case 'coord':
      return 'text-purple-500';
    case 'broadcast':
      return 'text-green-500';
    case 'session':
      return 'text-amber-500';
  }
}

export function getActionLabel(action: CoordMessage['action']): string {
  switch (action) {
    case 'assign':
      return 'Task Assignment';
    case 'request':
      return 'Request';
    case 'report':
      return 'Status Report';
    case 'escalate':
      return 'Escalation';
  }
}
