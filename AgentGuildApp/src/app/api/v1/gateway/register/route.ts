/**
 * POST /api/v1/gateway/register — Self-service gateway registration
 *
 * Gateways register with their Ed25519 public key. No INTERNAL_SERVICE_SECRET needed.
 * The gateway proves key ownership by signing a challenge message.
 *
 * Body:
 *   orgId: string
 *   name: string
 *   publicKey: string (PEM SPKI format)
 *   proof: string (base64 Ed25519 signature of "gateway:register:{orgId}:{ts}")
 *   ts: number (milliseconds since epoch)
 *   resources: { maxCpuCores, maxMemoryMb, maxConcurrent }
 *   capabilities: { taskTypes, runtimes?, tags? }
 *   region?: string
 *   ipAddress?: string
 *
 * Auth: org membership (wallet session) — the registering user must be an org member
 *   OR: proof-of-key-ownership (no wallet needed, but org must exist)
 */

import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import { registerWorker, getOrgWorkers } from "@/lib/gateway/store";
import { verifyEd25519Proof, isTimestampFresh } from "../verify";
import { getOrganization } from "@/lib/firestore-admin";

const MAX_WORKERS_PER_ORG = 50;

interface RegisterBody {
  orgId: string;
  name: string;
  publicKey: string;
  proof: string;
  ts: number;
  resources: {
    maxCpuCores: number;
    maxMemoryMb: number;
    maxConcurrent: number;
  };
  capabilities: {
    taskTypes: string[];
    runtimes?: string[];
    tags?: string[];
  };
  region?: string;
  ipAddress?: string;
}

export async function POST(req: NextRequest) {
  let body: RegisterBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Validate required fields
  if (!body.orgId || !body.name || !body.publicKey || !body.proof || !body.ts) {
    return Response.json(
      { error: "orgId, name, publicKey, proof, and ts are required" },
      { status: 400 },
    );
  }

  if (!body.resources || !body.capabilities?.taskTypes?.length) {
    return Response.json(
      { error: "resources and capabilities.taskTypes are required" },
      { status: 400 },
    );
  }

  // Validate PEM format
  if (!body.publicKey.includes("BEGIN PUBLIC KEY") || !body.publicKey.includes("END PUBLIC KEY")) {
    return Response.json(
      { error: "publicKey must be in PEM SPKI format" },
      { status: 400 },
    );
  }

  // Validate timestamp freshness (prevent replay)
  if (!isTimestampFresh(body.ts)) {
    return Response.json(
      { error: "Stale timestamp — must be within 2 minutes" },
      { status: 400 },
    );
  }

  // Verify proof-of-key-ownership
  const proofMessage = `gateway:register:${body.orgId}:${body.ts}`;
  const proofValid = verifyEd25519Proof(body.publicKey, proofMessage, body.proof);
  if (!proofValid) {
    return Response.json(
      { error: "Invalid proof — signature does not match public key" },
      { status: 401 },
    );
  }

  // Auth: either wallet-based org member or just verify org exists
  const wallet = getWalletAddress(req);
  if (wallet) {
    const orgAuth = await requireOrgMember(req, body.orgId);
    if (!orgAuth.ok) {
      return Response.json({ error: orgAuth.error }, { status: orgAuth.status || 403 });
    }
  } else {
    // No wallet — verify org exists (gateway CLI won't have a wallet session)
    const org = await getOrganization(body.orgId);
    if (!org) {
      return Response.json({ error: "Organization not found" }, { status: 404 });
    }
  }

  // Check worker limit per org
  try {
    const existing = await getOrgWorkers(body.orgId);
    if (existing.length >= MAX_WORKERS_PER_ORG) {
      return Response.json(
        { error: `Maximum ${MAX_WORKERS_PER_ORG} workers per org` },
        { status: 429 },
      );
    }
  } catch {
    // Non-fatal — proceed with registration
  }

  // Register the worker with its public key
  try {
    const workerId = await registerWorker({
      orgId: body.orgId,
      name: body.name,
      status: "idle",
      resources: {
        maxCpuCores: body.resources.maxCpuCores,
        maxMemoryMb: body.resources.maxMemoryMb,
        maxConcurrent: body.resources.maxConcurrent,
        activeTasks: 0,
      },
      capabilities: {
        taskTypes: body.capabilities.taskTypes,
        runtimes: body.capabilities.runtimes || [],
        tags: body.capabilities.tags || [],
      },
      region: body.region,
      ipAddress: body.ipAddress,
      publicKey: body.publicKey,
    });

    return Response.json({ ok: true, workerId });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to register worker" },
      { status: 500 },
    );
  }
}
