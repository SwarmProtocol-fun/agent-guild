/**
 * Tests for POST /api/auth/verify — Firebase custom-token uid canonicalization.
 *
 * The uid must match how createOrganization stores ownerAddress/members, or
 * firestore.rules' isOrgMember() denies every org-scoped client write
 * ("Missing or insufficient permissions" on /onboarding for Solana wallets).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const createCustomToken = vi.fn(async () => 'firebase-token');
const verifySiwePayload = vi.fn();

vi.mock('@/lib/session', () => ({
  resolveRole: vi.fn(() => 'operator'),
  createSession: vi.fn(async () => 'session_1'),
  signSessionJWT: vi.fn(async () => 'jwt'),
  setSessionCookie: vi.fn(async () => {}),
}));
vi.mock('@/lib/firestore-admin', () => ({
  getOrganizationsByWalletAdmin: vi.fn(async () => []),
}));
vi.mock('@/lib/firebase-admin', () => ({
  adminAuth: () => ({ createCustomToken }),
}));
vi.mock('@/lib/org-cache', () => ({
  getCachedOrgs: vi.fn(() => null),
  cacheOrgs: vi.fn(),
}));
vi.mock('@/lib/rate-limit-firestore', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, resetTime: 0 })),
  getClientIp: vi.fn(() => '127.0.0.1'),
}));
vi.mock('@/lib/auth/siwe', () => ({
  verifySiwePayload: (...args: unknown[]) => verifySiwePayload(...args),
  getDomainFromRequest: vi.fn(() => 'agent-guild.com'),
}));
vi.mock('@/lib/platform-analytics', () => ({ recordLogin: vi.fn(async () => {}) }));
vi.mock('@/lib/mods/runtime', () => ({ emitEvent: vi.fn(async () => {}) }));

import { POST } from '../route';

function login(address: string) {
  verifySiwePayload.mockResolvedValueOnce({ valid: true, payload: { address } });
  return POST(new Request('https://agent-guild.com/api/auth/verify', {
    method: 'POST',
    body: JSON.stringify({ payload: { address }, signature: 'sig' }),
  }));
}

describe('POST /api/auth/verify — Firebase uid', () => {
  beforeEach(() => {
    createCustomToken.mockClear();
  });

  it('keeps a Solana base58 address exact-case (lowercasing changes the address)', async () => {
    const sol = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const res = await login(sol);
    expect(res.status).toBe(200);
    expect(createCustomToken).toHaveBeenCalledWith(sol, { role: 'operator' });
  });

  it('lowercases a checksummed EVM address', async () => {
    const evm = '0x52908400098527886E0F7030069857D2E4169EE7';
    const res = await login(evm);
    expect(res.status).toBe(200);
    expect(createCustomToken).toHaveBeenCalledWith(evm.toLowerCase(), { role: 'operator' });
  });
});
