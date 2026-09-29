/**
 * POST /api/agents/:id/soul/validate
 *
 * Validate SOUL YAML configuration without saving.
 * Body: { soulConfig }
 */

import { NextRequest } from "next/server";
import { validateSOUL } from "@/lib/soul";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: agentId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { soulConfig } = body;

  if (!soulConfig || typeof soulConfig !== "string") {
    return Response.json(
      { error: "soulConfig (YAML string) is required" },
      { status: 400 }
    );
  }

  try {
    const validation = validateSOUL(soulConfig as string);

    return Response.json({
      ok: true,
      validation,
    });
  } catch (err) {
    console.error("Validate SOUL error:", err);
    return Response.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Failed to validate SOUL configuration",
      },
      { status: 500 }
    );
  }
}
