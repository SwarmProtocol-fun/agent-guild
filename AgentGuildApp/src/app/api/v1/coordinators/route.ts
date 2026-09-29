/**
 * GET/POST /api/v1/coordinators
 *
 * Coordinator agent management
 * - GET: List coordinators for org/project/channel
 * - POST: Register agent as coordinator
 *
 * Auth: Ed25519 signature
 * Signature message: "GET:/v1/coordinators:{agentId}:{ts}" or "POST:/v1/coordinators:{ts}"
 */

import { NextRequest } from 'next/server';
import { verifyAgentRequest, unauthorized } from '../verify';
import { rateLimit } from '../rate-limit';
import { db } from '@/lib/firebase';
import {
  collection,
  getDocs,
  addDoc,
  query,
  where,
} from 'firebase/firestore';

/**
 * GET /api/v1/coordinators
 * List active coordinators
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const agentId = searchParams.get('agent');
    const sig = searchParams.get('sig');
    const ts = searchParams.get('ts');
    const projectId = searchParams.get('projectId');
    const channelId = searchParams.get('channelId');

    const limited = await rateLimit(agentId || 'anon');
    if (limited) return limited;

    if (!agentId || !sig || !ts) {
      return unauthorized('agent, sig, and ts parameters are required');
    }

    const signedMessage = `GET:/v1/coordinators:${agentId}:${ts}`;
    const agent = await verifyAgentRequest(agentId, signedMessage, sig);
    if (!agent) return unauthorized();

    const constraints = [
      where('orgId', '==', agent.orgId),
      where('active', '==', true),
    ];

    if (projectId) {
      constraints.push(where('projectId', '==', projectId));
    } else if (channelId) {
      constraints.push(where('channelId', '==', channelId));
    }

    const q = query(collection(db, 'coordinators'), ...constraints);
    const snapshot = await getDocs(q);
    const coordinators = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
      registeredAt: d.data().registeredAt?.toMillis?.() || null,
    }));

    return Response.json({ coordinators });
  } catch (err) {
    console.error('[coordinators GET] Error:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/coordinators
 * Register as coordinator
 */
export async function POST(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const agentId = searchParams.get('agent');
    const sig = searchParams.get('sig');
    const ts = searchParams.get('ts');

    const limited = await rateLimit(agentId || 'anon');
    if (limited) return limited;

    if (!agentId || !sig || !ts) {
      return unauthorized('agent, sig, and ts parameters are required');
    }

    const signedMessage = `POST:/v1/coordinators:${ts}`;
    const agent = await verifyAgentRequest(agentId, signedMessage, sig);
    if (!agent) return unauthorized();

    const body = await req.json();
    const { projectId, channelId, responsibilities, maxConcurrentTasks } = body;

    if (!responsibilities || !Array.isArray(responsibilities)) {
      return Response.json(
        { error: 'responsibilities must be an array of strings' },
        { status: 400 }
      );
    }

    // Check if already registered
    const existingQ = query(
      collection(db, 'coordinators'),
      where('agentId', '==', agent.agentId),
      where('orgId', '==', agent.orgId),
      where('active', '==', true)
    );
    const existing = await getDocs(existingQ);

    if (!existing.empty) {
      return Response.json(
        { error: 'Agent already registered as coordinator', coordinatorId: existing.docs[0].id },
        { status: 400 }
      );
    }

    // Create coordinator
    const coordRef = await addDoc(collection(db, 'coordinators'), {
      agentId: agent.agentId,
      agentName: agent.agentName,
      orgId: agent.orgId,
      projectId: projectId || null,
      channelId: channelId || null,
      responsibilities,
      active: true,
      maxConcurrentTasks: maxConcurrentTasks || 10,
      currentLoad: 0,
      registeredAt: new Date(),
    });

    return Response.json({
      success: true,
      coordinatorId: coordRef.id,
      agentId: agent.agentId,
      responsibilities,
      maxConcurrentTasks: maxConcurrentTasks || 10,
    });
  } catch (err) {
    console.error('[coordinators POST] Error:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
