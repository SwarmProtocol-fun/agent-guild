/**
 * POST /api/memory/[agentId]/append
 *
 * Append entry to MEMORY.md.
 * Body: { orgId, entry, section? }
 */

import { NextRequest } from "next/server";
import { getMemoryEntries, addMemoryEntry } from "@/lib/firestore-admin";
import {
  getTemplateForSubtype,
  appendToMemoryMd,
  updateTimestamp,
} from "@/lib/memory-templates";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { agentId } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { orgId, entry, section } = body;

  if (!orgId || !entry) {
    return Response.json(
      { error: "orgId and entry are required" },
      { status: 400 }
    );
  }

  // Verify caller is a member of the org
  const orgAuth = await requireOrgMember(request, orgId as string);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  try {
    // Find MEMORY.md
    const memories = await getMemoryEntries(orgId as string, agentId, "long_term");
    const memoryMd = memories.find((m) => m.subtype === "memory_md");

    let content: string;
    let memoryId: string;

    if (memoryMd) {
      // Append to existing MEMORY.md
      content = appendToMemoryMd(
        memoryMd.content,
        entry as string,
        section as string | undefined
      );
      content = updateTimestamp(content);
      memoryId = memoryMd.id;

      // Update in Firestore
      await adminDb().collection("agentMemories").doc(memoryId).set(
        {
          content,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } else {
      // Create MEMORY.md
      const agentName = body.agentName as string | undefined || agentId;
      content = getTemplateForSubtype("memory_md", agentName);
      content = appendToMemoryMd(content, entry as string, section as string | undefined);

      memoryId = await addMemoryEntry({
        orgId: orgId as string,
        agentId,
        agentName,
        type: "long_term",
        title: "MEMORY.md",
        content,
        subtype: "memory_md",
        structuredData: { template: "memory_md" },
      });
    }

    return Response.json({
      ok: true,
      memoryId,
      appended: true,
    });
  } catch (err) {
    console.error("Append to MEMORY.md error:", err);
    return Response.json(
      { error: "Failed to append to MEMORY.md" },
      { status: 500 }
    );
  }
}
