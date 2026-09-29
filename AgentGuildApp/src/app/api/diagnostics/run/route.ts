/**
 * POST /api/diagnostics/run
 *
 * Run diagnostic checks for an organization.
 * Body: { orgId, checkType? }
 */

import { NextRequest } from "next/server";
import { runDiagnostics, type DiagnosticCheckType } from "@/lib/diagnostics";
import { requirePlatformAdmin } from "@/lib/auth-guard";

export async function POST(request: NextRequest) {
  const adminCheck = requirePlatformAdmin(request);
  if (!adminCheck.ok) {
    return Response.json({ error: adminCheck.error }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, checkType } = body;

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  try {
    const runs = await runDiagnostics(
      orgId as string,
      checkType as DiagnosticCheckType | undefined
    );

    const totalIssues = runs.reduce((sum, run) => sum + run.issuesFound, 0);

    return Response.json({
      ok: true,
      runs,
      totalIssues,
      message: `Diagnostic scan complete: ${totalIssues} issue${totalIssues !== 1 ? "s" : ""} found`,
    });
  } catch (err) {
    console.error("Run diagnostics error:", err);
    return Response.json(
      { error: "Failed to run diagnostics" },
      { status: 500 }
    );
  }
}
