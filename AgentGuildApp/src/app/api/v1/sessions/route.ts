/**
 * GET/POST /api/v1/sessions
 *
 * Agent session management for multi-step workflows
 * - GET: List active sessions for agent
 * - POST: Create new session
 *
 * Auth: Ed25519 signature
 * Signature message: "GET:/v1/sessions:{agentId}:{ts}" or "POST:/v1/sessions:{ts}"
 */

import { NextRequest } from 'next/server';
import { verifyAgentRequest, unauthorized } from '../verify';
import { rateLimit } from '../rate-limit';
import { db } from '@/lib/firebase';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
} from 'firebase/firestore';

/**
 * GET /api/v1/sessions
 * List active sessions for agent
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const agentId = searchParams.get('agent');
    const sig = searchParams.get('sig');
    const ts = searchParams.get('ts');
    const status = searchParams.get('status') || 'active';
    const coordinatorId = searchParams.get('coordinatorId');

    const limited = await rateLimit(agentId || 'anon');
    if (limited) return limited;

    if (!agentId || !sig || !ts) {
      return unauthorized('agent, sig, and ts parameters are required');
    }

    const signedMessage = `GET:/v1/sessions:${agentId}:${ts}`;
    const agent = await verifyAgentRequest(agentId, signedMessage, sig);
    if (!agent) return unauthorized();

    const constraints = [
      where('orgId', '==', agent.orgId),
      where('status', '==', status),
    ];

    if (coordinatorId) {
      constraints.push(where('coordinatorId', '==', coordinatorId));
    } else {
      constraints.push(where('participants', 'array-contains', agent.agentId));
    }

    const q = query(
      collection(db, 'agentSessions'),
      ...constraints,
      orderBy('createdAt', 'desc'),
      firestoreLimit(50)
    );
    const snapshot = await getDocs(q);
    const sessions = snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
      createdAt: d.data().createdAt?.toMillis?.() || null,
      expiresAt: d.data().expiresAt?.toMillis?.() || null,
    }));

    return Response.json({ sessions });
  } catch (err) {
    console.error('[sessions GET] Error:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/v1/sessions
 * Create new agent session
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

    const signedMessage = `POST:/v1/sessions:${ts}`;
    const agent = await verifyAgentRequest(agentId, signedMessage, sig);
    if (!agent) return unauthorized();

    const body = await req.json();
    const { coordinatorId, participants, purpose, metadata, ttlMinutes } = body;

    if (!coordinatorId) {
      return Response.json({ error: 'coordinatorId is required' }, { status: 400 });
    }

    if (!participants || !Array.isArray(participants) || participants.length === 0) {
      return Response.json(
        { error: 'participants must be a non-empty array' },
        { status: 400 }
      );
    }

    // Verify coordinator exists
    const coordSnap = await getDoc(doc(db, 'coordinators', coordinatorId));
    if (!coordSnap.exists()) {
      return Response.json({ error: 'Coordinator not found' }, { status: 404 });
    }

    // Create session
    const ttl = ttlMinutes || 60;
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

    const sessionRef = await addDoc(collection(db, 'agentSessions'), {
      coordinatorId,
      orgId: agent.orgId,
      participants,
      purpose: purpose || 'Multi-step workflow',
      metadata: metadata || {},
      status: 'active',
      messageCount: 0,
      createdBy: agent.agentId,
      createdByName: agent.agentName,
      createdAt: new Date(),
      expiresAt,
    });

    return Response.json({
      success: true,
      sessionId: sessionRef.id,
      coordinatorId,
      participants,
      expiresAt: expiresAt.getTime(),
    });
  } catch (err) {
    console.error('[sessions POST] Error:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
