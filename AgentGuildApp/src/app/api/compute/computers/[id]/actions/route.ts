/**
 * POST /api/compute/computers/[id]/actions — Execute an action on a computer
 * Body: { actionType, payload, sessionId }
 */
import { NextRequest } from "next/server";
import { requireOrgMember, getWalletAddress } from "@/lib/auth-guard";
import { getComputer } from "@/lib/compute/firestore";
import { buildActionEnvelope, executeComputeAction } from "@/lib/compute/actions";
import type { ActionType } from "@/lib/compute/types";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const computer = await getComputer(id);
  if (!computer) return Response.json({ error: "Computer not found" }, { status: 404 });

  const auth = await requireOrgMember(req, computer.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  if (computer.status !== "running") {
    return Response.json(
      { error: `Computer is not running (current: "${computer.status}")` },
      { status: 409 },
    );
  }

  const body = await req.json();
  const { actionType, payload, sessionId } = body as {
    actionType: ActionType;
    payload: Record<string, unknown>;
    sessionId: string;
  };

  const VALID_ACTIONS: ActionType[] = [
    "screenshot", "click", "double_click", "drag", "type",
    "key", "scroll", "wait", "bash", "exec",
  ];
  if (!actionType || !sessionId) {
    return Response.json({ error: "actionType and sessionId are required" }, { status: 400 });
  }
  if (!VALID_ACTIONS.includes(actionType)) {
    return Response.json({ error: `Invalid actionType. Must be one of: ${VALID_ACTIONS.join(", ")}` }, { status: 400 });
  }

  const envelope = buildActionEnvelope(
    actionType,
    id,
    sessionId,
    { type: "user", id: wallet },
    payload || {},
  );

  try {
    const result = await executeComputeAction(envelope);
    return Response.json({ ok: true, actionId: envelope.idempotencyKey, result });
  } catch (err) {
    console.error("[compute/actions] Execution failed:", err);
    return Response.json({ error: "Action execution failed" }, { status: 500 });
  }
}
