/**
 * Swarm Compute — Action Runner
 *
 * Builds action envelopes and executes them via the provider.
 * Records all actions to Firestore for audit.
 */

import { v4 as uuidv4 } from "uuid";
import type { ActionType, ActionEnvelope, ActionResult } from "./types";
import { ACTION_TIMEOUTS } from "./types";
import { getComputeProvider } from "./provider";
import { recordAction, updateAction, getComputer } from "./firestore";

/**
 * Build a standardized action envelope.
 */
export function buildActionEnvelope(
  actionType: ActionType,
  computerId: string,
  sessionId: string,
  actor: { type: "user" | "model" | "system"; id: string },
  payload: Record<string, unknown>,
): ActionEnvelope {
  return {
    actionType,
    targetComputerId: computerId,
    sessionId,
    actorType: actor.type,
    actorId: actor.id,
    payload,
    timeoutMs: ACTION_TIMEOUTS[actionType] || 10_000,
    idempotencyKey: uuidv4(),
  };
}

/**
 * Execute a compute action:
 * 1. Record the action as "running" in Firestore
 * 2. Call the provider
 * 3. Update with result
 */
export async function executeComputeAction(envelope: ActionEnvelope): Promise<{ actionId: string; result: ActionResult }> {
  const computer = await getComputer(envelope.targetComputerId);
  if (!computer) {
    throw new Error("Computer not found");
  }
  if (computer.status !== "running") {
    throw new Error(`Computer is ${computer.status}, must be running`);
  }
  if (!computer.providerInstanceId) {
    throw new Error("Computer has no provider instance — cannot execute actions in stub mode");
  }

  // Record action as running
  const actionId = await recordAction({
    sessionId: envelope.sessionId,
    computerId: envelope.targetComputerId,
    actionType: envelope.actionType,
    payload: envelope.payload,
    result: null,
    status: "running",
  });

  const provider = getComputeProvider(computer.provider);
  const start = Date.now();

  try {
    // Execute with timeout
    const result = await Promise.race<ActionResult>([
      provider.executeAction(computer.providerInstanceId, envelope),
      new Promise<ActionResult>((_, reject) =>
        setTimeout(() => reject(new Error("Action timeout")), envelope.timeoutMs),
      ),
    ]);

    await updateAction(actionId, {
      result: result.data || {},
      status: result.success ? "completed" : "failed",
    });

    return { actionId, result };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    const isTimeout = errorMsg === "Action timeout";
    const result: ActionResult = {
      success: false,
      error: errorMsg,
      durationMs: Date.now() - start,
    };

    await updateAction(actionId, {
      result: { error: errorMsg },
      status: isTimeout ? "timeout" : "failed",
    });

    return { actionId, result };
  }
}
