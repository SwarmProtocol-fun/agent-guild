/**
 * Swarm Compute — Knowledge Graph Helpers
 *
 * Context Vault PRD §27/§76/§139 — entity relationships (agent/task/
 * project/memory/document), scoped exactly as the PRD's own §139
 * resolution: no graph database, edges live in the existing Firestore
 * persistence layer (see compute/firestore.ts's graphEdges collection).
 * This answers "what is connected to X" (PRD §28) — a two-query lookup,
 * not general graph traversal.
 */

import type { GraphEdge, GraphEntityRef, GraphEntityType } from "./types";
import { createGraphEdge, getGraphEdgesForEntity } from "./firestore";

const VALID_ENTITY_TYPES: GraphEntityType[] = ["agent", "task", "project", "memory", "document"];
const MAX_RELATION_LENGTH = 100;
const MAX_ENTITY_ID_LENGTH = 200;

export class InvalidGraphEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGraphEntityError";
  }
}

function assertValidEntity(entity: GraphEntityRef, label: string): void {
  if (!VALID_ENTITY_TYPES.includes(entity.type)) {
    throw new InvalidGraphEntityError(
      `${label}.type must be one of: ${VALID_ENTITY_TYPES.join(", ")} (got "${entity.type}")`,
    );
  }
  if (!entity.id || typeof entity.id !== "string" || entity.id.length > MAX_ENTITY_ID_LENGTH) {
    throw new InvalidGraphEntityError(`${label}.id must be a non-empty string (max ${MAX_ENTITY_ID_LENGTH} chars)`);
  }
}

/**
 * Creates a directed edge between two entities. Existence of the entities
 * themselves is not verified — same trust level as other cross-collection
 * references in this codebase (e.g. Task.assigneeAgentId isn't checked
 * against `agents` either). Validates shape only: known entity types,
 * bounded id/relation length.
 */
export async function linkEntities(
  orgId: string,
  from: GraphEntityRef,
  to: GraphEntityRef,
  relation: string,
  createdBy: GraphEntityRef | null = null,
): Promise<string> {
  assertValidEntity(from, "from");
  assertValidEntity(to, "to");
  if (createdBy) assertValidEntity(createdBy, "createdBy");
  const trimmedRelation = relation.trim();
  if (!trimmedRelation || trimmedRelation.length > MAX_RELATION_LENGTH) {
    throw new InvalidGraphEntityError(`relation must be a non-empty string (max ${MAX_RELATION_LENGTH} chars)`);
  }

  return createGraphEdge({ orgId, from, to, relation: trimmedRelation, createdBy });
}

/**
 * All edges touching `entity` (either endpoint), newest first. This is the
 * whole "graph query" surface for v1 — one hop, not multi-hop traversal.
 */
export async function getRelatedEntities(
  orgId: string,
  entity: GraphEntityRef,
  opts?: { relation?: string; limit?: number },
): Promise<GraphEdge[]> {
  assertValidEntity(entity, "entity");
  return getGraphEdgesForEntity(orgId, entity, opts);
}
