/**
 * GET /api/memory/[agentId]/working
 *
 * Get or create WORKING.md for an agent.
 *
 * PUT /api/memory/[agentId]/working
 *
 * Update WORKING.md content.
 * Body: { content, section? }
 */

import { NextRequest } from "next/server";
import { getMemoryEntries, addMemoryEntry } from "@/lib/firestore-admin";
import {
  getTemplateForSubtype,
  updateWorkingMdSection,
  updateTimestamp,
} from "@/lib/memory-templates";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { getWalletAddress, requireMemoryAccess } from "@/lib/auth-guard";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const wallet = getWalletAddress(request);
  if (!wallet) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  const { agentId } = await params;
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
    // Find WORKING.md memory
    const memories = await getMemoryEntries(orgId, agentId, "workspace");
    const workingMd = memories.find((m) => m.subtype === "working_md");

    if (workingMd) {
      return Response.json({
        ok: true,
        content: workingMd.content,
        id: workingMd.id,
        updatedAt: workingMd.updatedAt,
      });
    }

    // Create WORKING.md if it doesn't exist
    const agentName = searchParams.get("agentName") || agentId;
    const template = getTemplateForSubtype("working_md", agentName);

    const id = await addMemoryEntry({
      orgId,
      agentId,
      agentName,
      type: "workspace",
      title: "WORKING.md",
      content: template,
      subtype: "working_md",
      structuredData: { template: "working_md" },
    });

    return Response.json({
      ok: true,
      content: template,
      id,
      created: true,
    });
  } catch (err) {
    console.error("Get WORKING.md error:", err);
    return Response.json(
      { error: "Failed to get WORKING.md" },
      { status: 500 }
    );
  }
}

export async function PUT(
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

  const { orgId, content, section, memoryId } = body;

  if (!orgId || !content) {
    return Response.json(
      { error: "orgId and content are required" },
      { status: 400 }
    );
  }

  // Verify caller is an org member or the wallet holding this agent's identity NFT
  const orgAuth = await requireMemoryAccess(request, orgId as string, agentId);
  if (!orgAuth.ok) {
    return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
  }

  try {
    let newContent = content as string;

    // If updating a specific section
    if (section && typeof section === "string") {
      const memories = await getMemoryEntries(orgId as string, agentId, "workspace");
      const workingMd = memories.find((m) => m.subtype === "working_md");

      if (workingMd) {
        newContent = updateWorkingMdSection(
          workingMd.content,
          section as any,
          content as string
        );
      }
    }

    // Update timestamp
    newContent = updateTimestamp(newContent);

    // Update in Firestore
    if (memoryId) {
      await adminDb().collection("agentMemories").doc(memoryId as string).set(
        {
          content: newContent,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return Response.json({
      ok: true,
      content: newContent,
    });
  } catch (err) {
    console.error("Update WORKING.md error:", err);
    return Response.json(
      { error: "Failed to update WORKING.md" },
      { status: 500 }
    );
  }
}
