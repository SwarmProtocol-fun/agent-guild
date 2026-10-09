/**
 * Tests for GET /api/v1/lending/eligibility — session auth.
 *
 * The session JWT carries the wallet in `sub` (there is no `address` claim);
 * checking `session.address` made the Lending card on /agents/[id]/credit
 * show "Unauthorized" to every signed-in user.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const validateSession = vi.fn();
const getEligibility = vi.fn();

vi.mock('@/lib/session', () => ({
  validateSession: () => validateSession(),
}));
vi.mock('@/lib/lending/lending-service', () => ({
  getEligibility: (...args: unknown[]) => getEligibility(...args),
}));

import { GET } from '../route';

function get(agentId = 'agent_1') {
  return GET(new NextRequest(`https://agent-guild.com/api/v1/lending/eligibility?agentId=${agentId}`));
}

describe('GET /api/v1/lending/eligibility', () => {
  beforeEach(() => {
    validateSession.mockReset();
    getEligibility.mockReset();
  });

  it('serves a signed-in session (wallet in sub)', async () => {
    validateSession.mockResolvedValue({ sub: 'Wallet111', sid: 's1', role: 'operator' });
    getEligibility.mockResolvedValue({ policyTier: 'standard', trust: { eligible: true, maxAmountUsd: 75, rateBps: 980 } });

    const res = await get('FyqvDBs9nUmpDEPyylOU');

    expect(res.status).toBe(200);
    expect(getEligibility).toHaveBeenCalledWith('FyqvDBs9nUmpDEPyylOU');
    expect((await res.json()).trust.rateBps).toBe(980);
  });

  it('rejects a request with no session', async () => {
    validateSession.mockResolvedValue(null);

    const res = await get();

    expect(res.status).toBe(401);
    expect(getEligibility).not.toHaveBeenCalled();
  });
});
