/** /api/v1/lending/loans/[id]/repay/agent-wallet — only the borrowing org's members can move the agent's funds. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const requireOrgMember = vi.fn();
const getLoan = vi.fn();
const repayFromAgentWallet = vi.fn();
const finishAgentRepay = vi.fn();
const quoteAgentRepay = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
    requireOrgMember: (...a: unknown[]) => requireOrgMember(...a),
    unauthorized: (msg: string) => Response.json({ error: msg }, { status: 401 }),
    forbidden: (msg: string) => Response.json({ error: msg }, { status: 403 }),
}));
vi.mock("@/lib/lending/lending-service", () => ({ getLoan: (...a: unknown[]) => getLoan(...a) }));
vi.mock("@/lib/lending/agent-repay", () => ({
    repayFromAgentWallet: (...a: unknown[]) => repayFromAgentWallet(...a),
    finishAgentRepay: (...a: unknown[]) => finishAgentRepay(...a),
    quoteAgentRepay: (...a: unknown[]) => quoteAgentRepay(...a),
}));

import { GET, POST } from "../route";

const params = { params: Promise.resolve({ id: "L1" }) };
const post = (body: unknown) => POST(new NextRequest("https://x/api", { method: "POST", body: JSON.stringify(body) }), params);

describe("agent-wallet repay route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getLoan.mockResolvedValue({ id: "L1", borrowerOrgId: "org1" });
        requireOrgMember.mockResolvedValue({ ok: true, walletAddress: "0xmember" });
        repayFromAgentWallet.mockResolvedValue({ status: "posted", txSig: "s", message: "ok" });
        finishAgentRepay.mockResolvedValue({ status: "confirming", txSig: "s", message: "wait" });
        quoteAgentRepay.mockResolvedValue({ wallets: [] });
    });

    it("refuses non-members and never touches the wallet", async () => {
        requireOrgMember.mockResolvedValue({ ok: false, status: 403, error: "Not a member" });
        expect((await post({ amount: 5 })).status).toBe(403);
        expect((await GET(new NextRequest("https://x/api?amount=5"), params)).status).toBe(403);
        expect(repayFromAgentWallet).not.toHaveBeenCalled();
        expect(requireOrgMember).toHaveBeenCalledWith(expect.anything(), "org1");
    });

    it("repays for a member, attributing it to their wallet", async () => {
        expect((await post({ amount: 5, walletId: "w1" })).status).toBe(200);
        expect(repayFromAgentWallet).toHaveBeenCalledWith("L1", 5, "0xmember", "w1");
    });

    it("rejects a missing or non-positive amount without sending", async () => {
        expect((await post({})).status).toBe(400);
        expect((await post({ amount: -1 })).status).toBe(400);
        expect(repayFromAgentWallet).not.toHaveBeenCalled();
    });

    it("check only re-verifies, never sends", async () => {
        expect(await (await post({ check: true })).json()).toMatchObject({ status: "confirming" });
        expect(repayFromAgentWallet).not.toHaveBeenCalled();
    });

    it("quotes with the amount from the query", async () => {
        await GET(new NextRequest("https://x/api?amount=2.5"), params);
        expect(quoteAgentRepay).toHaveBeenCalledWith("L1", 2.5);
    });
});
