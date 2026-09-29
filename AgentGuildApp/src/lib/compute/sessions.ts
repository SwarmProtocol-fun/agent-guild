/**
 * Swarm Compute — Session Management
 *
 * Handles session lifecycle and wires billing/metering into
 * session end events automatically via recordComputeHours.
 */

import type { ControllerType, ModelKey } from "./types";
import { createSession, endSession, getSession, getSessions as getSessionsDb, addHoursUsed } from "./firestore";
import { estimateHourlyCost } from "./pricing";
import { recordComputeHours } from "./billing";
import { getComputer } from "./firestore";

export async function startComputeSession(
  computerId: string,
  workspaceId: string,
  controllerType: ControllerType,
  userId: string | null,
  modelKey?: ModelKey | null,
): Promise<string> {
  return createSession({
    computerId,
    workspaceId,
    controllerType,
    userId,
    modelKey: modelKey || null,
    recordingUrl: null,
  });
}

export async function endComputeSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.endedAt) return;

  const durationMs = session.startedAt
    ? Date.now() - session.startedAt.getTime()
    : 0;
  const hours = durationMs / (1000 * 60 * 60);

  const computer = await getComputer(session.computerId);
  const costPerHour = computer ? estimateHourlyCost(computer.sizeKey) : 8;
  const estimatedCostCents = Math.ceil(hours * costPerHour);

  // End the session record
  await endSession(sessionId, {
    totalActions: session.totalActions,
    totalScreenshots: session.totalScreenshots,
    estimatedCostCents,
  });

  // Write to billing ledger + usage records for real metering
  if (computer && hours > 0) {
    await recordComputeHours(
      session.workspaceId,
      session.computerId,
      hours,
      computer.sizeKey,
      {
        orgId: computer.orgId,
        sessionId,
        provider: computer.provider || "stub",
        region: computer.region,
      },
    );

    // Track hours against entitlement quota
    await addHoursUsed(computer.orgId, hours);
  }
}

export async function getActiveSessions(workspaceId: string): Promise<number> {
  const sessions = await getSessionsDb({ workspaceId, limit: 200 });
  return sessions.filter((s) => !s.endedAt).length;
}
