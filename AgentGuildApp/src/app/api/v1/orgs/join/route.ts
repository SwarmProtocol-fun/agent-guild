import { NextResponse } from 'next/server';
import { validateSession } from '@/lib/session';
import { db } from '@/lib/firebase';
import { collection, query, where, getDocs, updateDoc, doc, arrayUnion } from 'firebase/firestore';

export async function POST(req: Request) {
  try {
    const session = await validateSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { inviteCode } = await req.json().catch(() => ({}));

    if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.length !== 6) {
      return NextResponse.json({ error: 'Invalid invite code format' }, { status: 400 });
    }

    const q = query(
      collection(db, 'organizations'),
      where('inviteCode', '==', inviteCode.toUpperCase())
    );

    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return NextResponse.json({ error: 'Invalid or expired invite code' }, { status: 404 });
    }

    const orgDoc = snapshot.docs[0];
    const orgData = orgDoc.data();
    const orgId = orgDoc.id;
    const walletAddress = session.sub.toLowerCase();

    // Check if user is already a member
    const members = (orgData.members as string[]) || [];
    const isMember = members.some((m) => m.toLowerCase() === walletAddress);

    if (isMember) {
      return NextResponse.json({ error: 'You are already a member of this organization' }, { status: 400 });
    }

    // Add user to the members array
    await updateDoc(doc(db, 'organizations', orgId), {
      members: arrayUnion(walletAddress),
    });

    return NextResponse.json({ success: true, orgId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[POST /api/v1/orgs/join]', msg, error);
    return NextResponse.json({ error: 'Failed to join organization' }, { status: 500 });
  }
}
