/**
 * POST /api/v1/orgs/join — join an organization with its human-member invite code.
 *
 * Auth: wallet session. Body: { inviteCode: string } (6 chars).
 * Codes resolve through orgInvites (server-only) — see resolveOrgInviteCode.
 * Rate limited per wallet so codes can't be brute-forced.
 */
import { NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';
import { validateSession } from '@/lib/session';
import { adminDb } from '@/lib/firebase-admin';
import { resolveOrgInviteCode } from '@/lib/firestore-admin';
import { canonicalizeWalletAddress } from '@/lib/wallet-address';
import { rateLimit } from '../../rate-limit';

export async function POST(req: Request) {
  try {
    const session = await validateSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const walletAddress = session.sub.toLowerCase();

    const limited = await rateLimit(`org-join:${walletAddress}`);
    if (limited) return limited;

    const { inviteCode } = await req.json().catch(() => ({}));

    if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.length !== 6) {
      return NextResponse.json({ error: 'Invalid invite code format' }, { status: 400 });
    }

    const orgId = await resolveOrgInviteCode(inviteCode);
    if (!orgId) {
      return NextResponse.json({ error: 'Invalid or expired invite code' }, { status: 404 });
    }

    const orgRef = adminDb().collection('organizations').doc(orgId);
    const orgData = (await orgRef.get()).data();
    if (!orgData) {
      return NextResponse.json({ error: 'Invalid or expired invite code' }, { status: 404 });
    }

    // Check if user is already a member
    const members = (orgData.members as string[]) || [];
    const isMember =
      (orgData.ownerAddress && canonicalizeWalletAddress(orgData.ownerAddress) === canonicalizeWalletAddress(walletAddress)) ||
      members.some((m) => m.toLowerCase() === walletAddress);

    if (isMember) {
      return NextResponse.json({ error: 'You are already a member of this organization' }, { status: 400 });
    }

    await orgRef.update({ members: FieldValue.arrayUnion(walletAddress) });

    return NextResponse.json({ success: true, orgId });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[POST /api/v1/orgs/join]', msg, error);
    return NextResponse.json({ error: 'Failed to join organization' }, { status: 500 });
  }
}
