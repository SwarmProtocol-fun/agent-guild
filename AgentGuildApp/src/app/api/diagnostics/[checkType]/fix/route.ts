/**
 * POST /api/diagnostics/:checkType/fix
 *
 * Auto-fix issues for a specific diagnostic check type.
 * Body: { orgId, issue }
 */

import { NextRequest } from "next/server";
import {
  runAutoFix,
  type DiagnosticCheckType,
  type DiagnosticIssue,
} from "@/lib/diagnostics";
import { requirePlatformAdmin } from "@/lib/auth-guard";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ checkType: string }> }
) {
  const adminCheck = requirePlatformAdmin(request);
  if (!adminCheck.ok) {
    return Response.json({ error: adminCheck.error }, { status: 403 });
  }

  const { checkType } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, issue } = body;

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  if (!issue) {
    return Response.json({ error: "issue is required" }, { status: 400 });
  }

  // Validate checkType
  const validCheckTypes: DiagnosticCheckType[] = [
    "stale_agents",
    "high_error_rate",
    "budget_overrun",
    "orphaned_tasks",
    "circuit_breakers",
  ];

  if (!validCheckTypes.includes(checkType as DiagnosticCheckType)) {
    return Response.json(
      { error: `Invalid check type: ${checkType}` },
      { status: 400 }
    );
  }

  try {
    const result = await runAutoFix(
      orgId as string,
      checkType as DiagnosticCheckType,
      issue as DiagnosticIssue
    );

    if (result.success) {
      return Response.json({
        ok: true,
        result,
        message: `Auto-fix applied successfully: ${result.action}`,
      });
    } else {
      return Response.json(
        {
          ok: false,
          result,
          message: `Auto-fix failed: ${result.error}`,
        },
        { status: 500 }
      );
    }
  } catch (err) {
    console.error("Auto-fix error:", err);
    return Response.json(
      { error: "Failed to apply auto-fix" },
      { status: 500 }
    );
  }
}
