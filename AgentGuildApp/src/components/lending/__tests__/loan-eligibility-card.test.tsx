import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/contexts/SessionContext", () => ({ useSession: () => ({ address: "0xabc" }) }));
vi.mock("@/lib/lending/client", () => ({
    fetchLendingTreasury: () => Promise.resolve({ pricesUsd: { usdc: 1, sol: 150, eth: 3000 } }),
}));

import { LoanEligibilityCard } from "../loan-eligibility-card";

const eligibility = {
    policyTier: "standard",
    creditScore: 680,
    completedTrustLoans: 0,
    completedUnsecuredLoans: 0,
    trustLoansRequiredForUnsecured: 2,
    activeLoanCount: 0,
    hasUnresolvedDefault: false,
    trust: { eligible: true, maxAmountUsd: 75, rateBps: 800 },
    unsecured: { eligible: false, maxAmountUsd: 0, rateBps: 1000, reason: "locked" },
};
const pool = { id: "usdc-pool", asset: "usdc", availableLiquidity: 10_000 };

function json(body: unknown, status = 200) {
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe("LoanEligibilityCard → RequestLoanDialog", () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        fetchMock = vi.fn((url: string, init?: RequestInit) => {
            if (url.startsWith("/api/v1/lending/eligibility")) return json(eligibility);
            if (url === "/api/v1/lending/pools") return json({ pools: [pool] });
            if (url === "/api/v1/lending/loans" && init?.method === "POST") return json({ loan: { id: "l1" } }, 201);
            return json({}, 404);
        });
        vi.stubGlobal("fetch", fetchMock);
    });

    it("keeps the dialog open on success so the next steps are shown", async () => {
        const onLoanRequested = vi.fn();
        render(<LoanEligibilityCard agentId="a1" orgId="o1" onLoanRequested={onLoanRequested} />);

        fireEvent.click((await screen.findAllByRole("button", { name: "Request" }))[0]);
        fireEvent.click(await screen.findByRole("button", { name: "Request Loan" }));

        expect(await screen.findByText("Loan Approved")).toBeTruthy();
        expect(screen.getByText(/post the collateral/)).toBeTruthy();
        expect(onLoanRequested).toHaveBeenCalledOnce();
        const post = fetchMock.mock.calls.find(([u, i]) => u === "/api/v1/lending/loans" && i?.method === "POST")!;
        const body = JSON.parse(post[1].body);
        expect(body).toMatchObject({ agentId: "a1", kind: "trust", source: "pool", poolId: "usdc-pool", amount: 75 });
        expect(body).not.toHaveProperty("purpose");

        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        await waitFor(() => expect(screen.queryByText("Loan Approved")).toBeNull());
    });

    it("shows the server's rejection reason", async () => {
        fetchMock.mockImplementation((url: string, init?: RequestInit) => {
            if (url.startsWith("/api/v1/lending/eligibility")) return json(eligibility);
            if (url === "/api/v1/lending/pools") return json({ pools: [pool] });
            if (init?.method === "POST") return json({ error: "Pool is dry" }, 400);
            return json({}, 404);
        });
        render(<LoanEligibilityCard agentId="a1" orgId="o1" onLoanRequested={vi.fn()} />);
        fireEvent.click((await screen.findAllByRole("button", { name: "Request" }))[0]);
        fireEvent.click(await screen.findByRole("button", { name: "Request Loan" }));
        expect(await screen.findByText("Pool is dry")).toBeTruthy();
    });
});
