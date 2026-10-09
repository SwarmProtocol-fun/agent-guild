/** POST /api/v1/lending/loans/[id]/collateral/top-up — members only; credited to the signed-in account. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const requireOrgMember = vi.fn();
const getLoan = vi.fn();
const addLoanCollateral = vi.fn();

vi.mock("@/lib/auth-guard", () => ({
    requireOrgMember: (...a: unknown[]) => requireOrgMember(...a),
    unauthorized: (msg: string) => Response.json({ error: msg }, { status: 401 }),
    forbidden: (msg: string) => Response.json({ error: msg }, { status: 403 }),
}));
vi.mock("@/lib/lending/lending-service", () => ({
    getLoan: (...a: unknown[]) => getLoan(...a),
    addLoanCollateral: (...a: unknown[]) => addLoanCollateral(...a),
}));

import { POST } from "../route";

const params = { params: Promise.resolve({ id: "L1" }) };
const post = (body: unknown) => POST(new NextRequest("https://x/api", { method: "POST", body: JSON.stringify(body) }), params);

describe("collateral top-up route", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getLoan.mockResolvedValue({ id: "L1", borrowerOrgId: "org1" });
        requireOrgMember.mockResolvedValue({ ok: true, walletAddress: "MEMBER" });
        addLoanCollateral.mockResolvedValue({ id: "L1", collateral: 12 });
    });

    it("adds verified collateral for a member", async () => {
        const res = await post({ amount: 2, txSig: "sig" });
        expect(res.status).toBe(200);
        expect(addLoanCollateral).toHaveBeenCalledWith("L1", "MEMBER", 2, "sig");
    });

    it("refuses non-members", async () => {
        requireOrgMember.mockResolvedValue({ ok: false, status: 401, error: "Sign in" });
        expect((await post({ amount: 2, txSig: "sig" })).status).toBe(401);
        expect(addLoanCollateral).not.toHaveBeenCalled();
    });

    it("validates the body", async () => {
        expect((await post({ txSig: "sig" })).status).toBe(400);
        expect((await post({ amount: 2 })).status).toBe(400);
    });

    it("passes the ledger's explanation through when the transfer is queued back", async () => {
        addLoanCollateral.mockRejectedValue(new Error("Extra collateral must come from X. Your transfer was recorded and its return has been queued."));
        const res = await post({ amount: 2, txSig: "sig" });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/return has been queued/);
    });
});
