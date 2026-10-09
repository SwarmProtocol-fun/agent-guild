/** POST/GET /api/v1/lending/loans/[id]/collateral/agent-wallet — only the borrowing org's members can move the agent's funds. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const requireOrgMember = vi.fn();
const getLoan = vi.fn();
const postCollateralFromAgentWallet = vi.fn();
const finishAgentCollateral = vi.fn();
const quoteAgentCollateral = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
    requireOrgMember: (...a: unknown[]) => requireOrgMember(...a),
    unauthorized: (msg: string) => Response.json({ error: msg }, { status: 401 }),
    forbidden: (msg: string) => Response.json({ error: msg }, { status: 403 }),
}));
vi.mock("@/lib/lending/lending-service", () => ({ getLoan: (...a: unknown[]) => getLoan(...a) }));
vi.mock("@/lib/lending/agent-collateral", () => ({
    AgentCollateralError: class extends Error { constructor(m: string, readonly status = 400) { super(m); } },
    postCollateralFromAgentWallet: (...a: unknown[]) => postCollateralFromAgentWallet(...a),
    finishAgentCollateral: (...a: unknown[]) => finishAgentCollateral(...a),
    quoteAgentCollateral: (...a: unknown[]) => quoteAgentCollateral(...a),
}));

import { GET, POST } from "../route";

const params = { params: Promise.resolve({ id: "L1" }) };
const post = (body: unknown) => POST(new NextRequest("https://x/api", { method: "POST", body: JSON.stringify(body) }), params);

describe("agent-wallet collateral route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getLoan.mockResolvedValue({ id: "L1", borrowerOrgId: "org1" });
        requireOrgMember.mockResolvedValue({ ok: true, walletAddress: "0xmember" });
        postCollateralFromAgentWallet.mockResolvedValue({ status: "posted", txSig: "s", message: "ok" });
        finishAgentCollateral.mockResolvedValue({ status: "confirming", txSig: "s", message: "wait" });
    });

    it("refuses non-members and never touches the wallet", async () => {
        requireOrgMember.mockResolvedValue({ ok: false, status: 403, error: "Not a member of this organization" });
        expect((await post({})).status).toBe(403);
        expect((await GET(new NextRequest("https://x/api"), params)).status).toBe(403);
        expect(postCollateralFromAgentWallet).not.toHaveBeenCalled();
        expect(requireOrgMember).toHaveBeenCalledWith(expect.anything(), "org1");
    });

    it("sends for a member, attributing it to their wallet", async () => {
        const res = await post({ walletId: "w1" });
        expect(res.status).toBe(200);
        expect(postCollateralFromAgentWallet).toHaveBeenCalledWith("L1", "0xmember", "w1");
    });

    it("check only re-verifies, never sends", async () => {
        expect(await (await post({ check: true })).json()).toMatchObject({ status: "confirming" });
        expect(postCollateralFromAgentWallet).not.toHaveBeenCalled();
    });

    it("404s an unknown loan", async () => {
        getLoan.mockResolvedValue(null);
        expect((await post({})).status).toBe(404);
    });
});
