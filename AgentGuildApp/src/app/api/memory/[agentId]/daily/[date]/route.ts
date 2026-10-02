/**
 * GET /api/memory/[agentId]/daily/[date]
 *
 * Get or create daily note for a specific date (YYYY-MM-DD).
 */

import { NextRequest } from "next/server";
import { getMemoryEntries, addMemoryEntry } from "@/lib/firestore-admin";
import { getTemplateForSubtype } from "@/lib/memory-templates";
import { getWalletAddress, requireMemoryAccess } from "@/lib/auth-guard";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string; date: string }> }
) {
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { agentId, date } = await params;
  const { searchParams } = new URL(request.url);
  const orgId = searchParams.get("orgId");

  if (!orgId) {
    return Response.json({ error: "orgId is required" }, { status: 400 });
  }

  // Verify caller is an org member or the wallet holding this agent's identity NFT
  const orgAuth = await requireMemoryAccess(request, orgId, agentId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  try {
    // Find daily note for this date
    const memories = await getMemoryEntries(orgId, agentId, "journal");
    const dailyNote = memories.find(
      (m) => m.subtype === "daily_note" && m.structuredData?.date === date
    );

    if (dailyNote) {
      return Response.json({
        ok: true,
        content: dailyNote.content,
        id: dailyNote.id,
        date,
        createdAt: dailyNote.createdAt,
        updatedAt: dailyNote.updatedAt,
      });
    }

    // Create daily note if it doesn't exist
    const agentName = searchParams.get("agentName") || agentId;
    const template = getTemplateForSubtype("daily_note", agentName, { date });

    const id = await addMemoryEntry({
      orgId,
      agentId,
      agentName,
      type: "journal",
      title: `Daily Note — ${date}`,
      content: template,
      subtype: "daily_note",
      structuredData: { date, template: "daily_note" },
    });

    return Response.json({
      ok: true,
      content: template,
      id,
      date,
      created: true,
    });
  } catch (err) {
    console.error("Get daily note error:", err);
    return Response.json(
      { error: "Failed to get daily note" },
      { status: 500 }
    );
  }
}
