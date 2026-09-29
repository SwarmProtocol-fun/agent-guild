/**
 * GET /api/admin/risk/queue/[id]
 * POST /api/admin/risk/queue/[id]
 *
 * Single fraud review case: fetch details and perform review actions.
 */

import { NextRequest } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { requirePlatformAdmin, getWalletAddress } from "@/lib/auth-guard";
import { recordAuditEntry } from "@/lib/audit-log";
import { logActivity } from "@/lib/firestore-admin";
import {
  getFraudReviewCase,
  updateFraudReviewCase,
  getActiveSignals,
  getRiskProfile,
  updateSignalStatus,
  saveRiskProfile,
} from "@/lib/fraud-detection";
import { computeRiskProfile } from "@/lib/fraud-risk-scoring";
import { createPenaltyProposal, emitPenalty } from "@/lib/mod-stubs";
// [swarm-core] Hedera integration removed — install swarm-hedera mod
// [swarm-core] Hedera integration removed — install swarm-hedera mod

/** GET — Fetch single case with full details */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await params;

  try {
    const reviewCase = await getFraudReviewCase(id);
    if (!reviewCase) {
      return Response.json({ error: "Case not found" }, { status: 404 });
    }

    // Enrich with agent info, risk profile, and signals
    const [agentDoc, riskProfile, activeSignals] = await Promise.all([
      adminDb().collection("agents").doc(reviewCase.agentId).get(),
      getRiskProfile(reviewCase.agentId),
      getActiveSignals(reviewCase.agentId),
    ]);

    const agent = agentDoc.exists ? {
      id: agentDoc.id,
      name: agentDoc.data()!.name,
      asn: agentDoc.data()!.asn,
      walletAddress: agentDoc.data()!.walletAddress,
      creditScore: agentDoc.data()!.creditScore,
      trustScore: agentDoc.data()!.trustScore,
      status: agentDoc.data()!.status,
      orgId: agentDoc.data()!.orgId,
    } : null;

    return Response.json({
      ok: true,
      case: reviewCase,
      agent,
      riskProfile,
      signals: activeSignals,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to fetch case",
    }, { status: 500 });
  }
}

/** POST — Review action on a fraud case */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requirePlatformAdmin(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: 403 });

  const { id } = await params;
  const adminWallet = getWalletAddress(req) || "platform-admin";

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const action = body.action as string;
  const notes = (body.notes as string) || "";
  const creditPenalty = body.creditPenalty as number | undefined;
  const trustPenalty = body.trustPenalty as number | undefined;

  const validActions = ["dismiss", "warn", "penalty", "ban"];
  if (!action || !validActions.includes(action)) {
    return Response.json({
      error: `action must be one of: ${validActions.join(", ")}`,
    }, { status: 400 });
  }

  try {
    const reviewCase = await getFraudReviewCase(id);
    if (!reviewCase) {
      return Response.json({ error: "Case not found" }, { status: 404 });
    }

    const agentDoc = await adminDb().collection("agents").doc(reviewCase.agentId).get();
    if (!agentDoc.exists) {
      return Response.json({ error: "Agent not found" }, { status: 404 });
    }

    const agent = agentDoc.data()!;
    const reviewEntry = {
      action,
      performedBy: adminWallet,
      notes: notes || undefined,
      timestamp: new Date().toISOString(),
    };

    switch (action) {
      case "dismiss": {
        // Mark all trigger signals as dismissed
        for (const signalId of reviewCase.triggerSignalIds) {
          await updateSignalStatus(signalId, "dismissed", adminWallet);
        }

        // Recalculate risk profile
        const remainingSignals = await getActiveSignals(reviewCase.agentId);
        const newProfile = computeRiskProfile(reviewCase.agentId, remainingSignals);
        await saveRiskProfile(newProfile);

        await updateFraudReviewCase(id, {
          status: "resolved_clean",
          resolution: {
            action: "dismiss",
            notes: notes || "Dismissed by admin",
            resolvedBy: adminWallet,
            resolvedAt: FieldValue.serverTimestamp(),
          },
          reviewHistory: [...reviewCase.reviewHistory, reviewEntry],
        });
        break;
      }

      case "warn": {
        await updateFraudReviewCase(id, {
          status: "resolved_clean",
          resolution: {
            action: "warn",
            notes: notes || "Warning issued",
            resolvedBy: adminWallet,
            resolvedAt: FieldValue.serverTimestamp(),
          },
          reviewHistory: [...reviewCase.reviewHistory, reviewEntry],
        });

        await logActivity({
          orgId: reviewCase.orgId || "platform",
          eventType: "fraud.case_resolved" as any,
          actorType: "user",
          actorId: adminWallet,
          targetType: "agent",
          targetId: reviewCase.agentId,
          targetName: reviewCase.agentName,
          description: `Warning issued for fraud case: ${notes || "No details"}`,
        }).catch(() => {});
        break;
      }

      case "penalty": {
        if (!creditPenalty || creditPenalty <= 0) {
          return Response.json({ error: "creditPenalty must be a positive number" }, { status: 400 });
        }

        if (!agent.asn || !agent.walletAddress) {
          return Response.json({ error: "Agent missing ASN or wallet address" }, { status: 400 });
        }

        // Apply penalty
        if (creditPenalty > 50) {
          // Route through governance
          await createPenaltyProposal(
            agent.asn,
            agent.walletAddress,
            -creditPenalty,
            `ADMIN FRAUD REVIEW: ${notes || reviewCase.triggerReason}`,
            adminWallet,
            [adminWallet],
          );
        } else {
          await emitPenalty(
            agent.asn,
            agent.walletAddress,
            -creditPenalty,
            `ADMIN FRAUD PENALTY: ${notes || reviewCase.triggerReason}`,
          );
        }

        // Mark signals as penalized
        for (const signalId of reviewCase.triggerSignalIds) {
          await updateSignalStatus(signalId, "penalized", adminWallet);
        }

        await updateFraudReviewCase(id, {
          status: "resolved_penalized",
          resolution: {
            action: "penalty",
            creditPenalty: -creditPenalty,
            trustPenalty: trustPenalty ? -trustPenalty : undefined,
            notes: notes || "Penalty applied",
            resolvedBy: adminWallet,
            resolvedAt: FieldValue.serverTimestamp(),
          },
          reviewHistory: [...reviewCase.reviewHistory, reviewEntry],
        });
        break;
      }

      case "ban": {
        // Pause the agent
        await adminDb().collection("agents").doc(reviewCase.agentId).update({
          status: "paused",
          pauseReason: "FRAUD_BANNED",
        });

        // Apply penalty if specified
        if (creditPenalty && creditPenalty > 0 && agent.asn && agent.walletAddress) {
          if (creditPenalty > 50) {
            await createPenaltyProposal(
              agent.asn,
              agent.walletAddress,
              -creditPenalty,
              `ADMIN BAN: ${notes || reviewCase.triggerReason}`,
              adminWallet,
              [adminWallet],
            );
          } else {
            await emitPenalty(
              agent.asn,
              agent.walletAddress,
              -creditPenalty,
              `ADMIN BAN PENALTY: ${notes || reviewCase.triggerReason}`,
            );
          }
        }

        // Mark signals as penalized
        for (const signalId of reviewCase.triggerSignalIds) {
          await updateSignalStatus(signalId, "penalized", adminWallet);
        }

        await updateFraudReviewCase(id, {
          status: "resolved_banned",
          resolution: {
            action: "ban",
            creditPenalty: creditPenalty ? -creditPenalty : undefined,
            trustPenalty: trustPenalty ? -trustPenalty : undefined,
            notes: notes || "Agent banned",
            resolvedBy: adminWallet,
            resolvedAt: FieldValue.serverTimestamp(),
          },
          reviewHistory: [...reviewCase.reviewHistory, reviewEntry],
        });

        await logActivity({
          orgId: reviewCase.orgId || "platform",
          eventType: "fraud.agent_banned" as any,
          actorType: "user",
          actorId: adminWallet,
          targetType: "agent",
          targetId: reviewCase.agentId,
          targetName: reviewCase.agentName,
          description: `Agent banned for fraud: ${notes || reviewCase.triggerReason}`,
        }).catch(() => {});
        break;
      }
    }

    // Audit log for all actions
    await recordAuditEntry({
      action: `fraud.review.${action}`,
      performedBy: adminWallet,
      targetType: "fraud_case",
      targetId: id,
      metadata: {
        agentId: reviewCase.agentId,
        creditPenalty: creditPenalty ? -creditPenalty : undefined,
        notes,
      },
    }).catch(() => {});

    return Response.json({
      ok: true,
      action,
      caseId: id,
      agentId: reviewCase.agentId,
    });
  } catch (err) {
    return Response.json({
      error: err instanceof Error ? err.message : "Failed to process review action",
    }, { status: 500 });
  }
}
