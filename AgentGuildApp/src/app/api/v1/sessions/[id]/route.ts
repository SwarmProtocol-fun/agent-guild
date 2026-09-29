/**
 * GET/PATCH /api/v1/sessions/:id
 *
 * Get or update a specific agent session
 * Auth: Ed25519 signature
 * Signature message: "GET:/v1/sessions:{agentId}:{ts}" or "PATCH:/v1/sessions:{ts}"
 */

import { NextRequest } from 'next/server';
import { verifyAgentRequest, unauthorized } from '../../verify';
import { rateLimit } from '../../rate-limit';
import { db } from '@/lib/firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';

/**
 * PATCH /api/v1/sessions/:id
 * Update session status (close, complete, etc.)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: sessionId } = await params;
    const { searchParams } = req.nextUrl;
    const agentId = searchParams.get('agent');
    const sig = searchParams.get('sig');
    const ts = searchParams.get('ts');

    const limited = await rateLimit(agentId || 'anon');
    if (limited) return limited;

    if (!agentId || !sig || !ts) {
      return unauthorized('agent, sig, and ts parameters are required');
    }

    const signedMessage = `PATCH:/v1/sessions:${ts}`;
    const agent = await verifyAgentRequest(agentId, signedMessage, sig);
    if (!agent) return unauthorized();

    const body = await req.json();
    const { status, metadata } = body;

    const validStatuses = ['active', 'completed', 'cancelled', 'expired'];
    if (!status || !validStatuses.includes(status)) {
      return Response.json(
        { error: `status must be one of: ${validStatuses.join(', ')}` },
        { status: 400 }
      );
    }

    const sessionRef = doc(db, 'agentSessions', sessionId);
    const sessionSnap = await getDoc(sessionRef);

    if (!sessionSnap.exists()) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const session = sessionSnap.data();

    // Verify agent is participant or creator
    const isParticipant = session?.participants?.includes(agent.agentId);
    const isCreator = session?.createdBy === agent.agentId;

    if (!isParticipant && !isCreator) {
      return Response.json(
        { error: 'You are not authorized to modify this session' },
        { status: 403 }
      );
    }

    if (session?.orgId !== agent.orgId) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

     
    const updateData: Record<string, any> = {
      status,
      updatedAt: new Date(),
      updatedBy: agent.agentId,
    };

    if (metadata) {
      updateData.metadata = { ...session.metadata, ...metadata };
    }

    if (status === 'completed' || status === 'cancelled') {
      updateData.closedAt = new Date();
      updateData.closedBy = agent.agentId;
    }

    await updateDoc(sessionRef, updateData);

    return Response.json({
      success: true,
      sessionId,
      status,
      updatedAt: updateData.updatedAt.getTime(),
    });
  } catch (err) {
    console.error('[sessions PATCH] Error:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/v1/sessions/:id
 * Get session details
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: sessionId } = await params;
    const { searchParams } = req.nextUrl;
    const agentId = searchParams.get('agent');
    const sig = searchParams.get('sig');
    const ts = searchParams.get('ts');

    const limited = await rateLimit(agentId || 'anon');
    if (limited) return limited;

    if (!agentId || !sig || !ts) {
      return unauthorized('agent, sig, and ts parameters are required');
    }

    const signedMessage = `GET:/v1/sessions:${agentId}:${ts}`;
    const agent = await verifyAgentRequest(agentId, signedMessage, sig);
    if (!agent) return unauthorized();

    const sessionSnap = await getDoc(doc(db, 'agentSessions', sessionId));

    if (!sessionSnap.exists()) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const session = sessionSnap.data();

    const isParticipant = session?.participants?.includes(agent.agentId);
    const isCreator = session?.createdBy === agent.agentId;

    if (!isParticipant && !isCreator) {
      return Response.json(
        { error: 'You are not authorized to view this session' },
        { status: 403 }
      );
    }

    if (session?.orgId !== agent.orgId) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    return Response.json({
      session: {
        id: sessionSnap.id,
        ...session,
        createdAt: session.createdAt?.toMillis?.() || null,
        expiresAt: session.expiresAt?.toMillis?.() || null,
        closedAt: session.closedAt?.toMillis?.() || null,
      },
    });
  } catch (err) {
    console.error('[sessions GET] Error:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
