/**
 * Shared credit-event types.
 *
 * Restores the `ScoreEvent` shape that used to live in hedera-hcs-client.ts.
 * Hedera was extracted into the agent-guild-hedera mod, but the credit engine still
 * produces and consumes events of this shape, so the type belongs in core.
 */

/** Score delta event — compact JSON, optionally anchored on an external ledger by a mod. */
export interface ScoreEvent {
    /** Event type */
    type: "task_complete" | "task_fail" | "skill_report" | "penalty" | "bonus" | "checkpoint" | "admin_override" | "fraud_penalty";
    /** Agent ASN */
    asn: string;
    /** Agent wallet address */
    agentAddress: string;
    /** Credit score delta (+ or -) */
    creditDelta: number;
    /** Trust score delta (+ or -) */
    trustDelta: number;
    /** Event timestamp (Unix seconds) */
    timestamp: number;
    /** Event metadata (task ID, reason, etc.) */
    metadata?: Record<string, unknown>;
    /** Signature (ECDSA over event data, signed by platform or agent) */
    signature?: string;
}
