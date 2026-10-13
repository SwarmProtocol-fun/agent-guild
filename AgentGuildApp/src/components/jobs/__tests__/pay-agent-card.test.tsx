/** The job page's "Pay agent" card: what it offers, and what it sends. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const api = {
  options: null as unknown,
  recorded: [] as unknown[],
};
vi.mock("@/lib/wallet", () => ({ useEvmSender: () => null, useSolanaSender: () => null }));
vi.mock("@/lib/solana/client", () => ({ getConnection: () => ({}) }));
vi.mock("@/lib/jobs-client", () => ({
  getJobPaymentOptions: async () => api.options,
  recordJobPayment: async (_id: string, body: Record<string, unknown>) => {
    api.recorded.push(body);
    return { method: "offplatform", channel: body.channel, amountUsdc: body.amountUsdc, reference: body.reference, paidBy: "0xowner", paidAt: 1 };
  },
}));

import { PayAgentCard } from "../pay-agent-card";

const baseOptions = {
  payable: true,
  reason: null,
  payment: null,
  suggestedUsdc: 50,
  agent: { id: "a1", name: "Ada" },
  wallets: { evm: [{ address: "0x2222222222222222222222222222222222222222", label: "Hyperliquid trading" }], solana: [] },
  rails: {
    base: { chainKey: "baseSepolia", chainId: 84532, name: "Base Sepolia", rpcUrl: "x", explorerUrl: "x", usdc: "0xusdc", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } },
    solana: { cluster: "devnet", usdcMint: "Mint" },
  },
  offplatformChannels: ["bank", "paypal", "cash"],
  canPay: true,
};

beforeEach(() => { api.recorded = []; api.options = { ...baseOptions }; });

describe("PayAgentCard", () => {
  it("offers Base, Solana and off-platform, prefilled with the reward", async () => {
    render(<PayAgentCard jobId="j1" />);
    expect(await screen.findByText("Pay Ada")).toBeTruthy();
    expect(screen.getByText("USDC · Base")).toBeTruthy();
    expect(screen.getByText("USDC · Solana")).toBeTruthy();
    expect(screen.getByText("Off-platform")).toBeTruthy();
    expect((screen.getByLabelText("Amount (USD)") as HTMLInputElement).value).toBe("50");
    expect(screen.getByText(/Connect an EVM wallet to send/)).toBeTruthy();
    expect(screen.getByText(/Test network: Base Sepolia/)).toBeTruthy();
  });

  it("records an off-platform payment and shows it as paid", async () => {
    const onPaid = vi.fn();
    render(<PayAgentCard jobId="j1" onPaid={onPaid} />);
    fireEvent.click(await screen.findByText("Off-platform"));
    fireEvent.change(screen.getByPlaceholderText(/Reference/), { target: { value: "INV-7" } });
    fireEvent.click(screen.getByText("Mark as paid"));
    await waitFor(() => expect(onPaid).toHaveBeenCalled());
    expect(api.recorded[0]).toMatchObject({ method: "offplatform", channel: "bank", reference: "INV-7", amountUsdc: 50 });
    expect(await screen.findByText(/Paid \$50/)).toBeTruthy();
  });

  it("explains when the agent has no wallet on a chain", async () => {
    render(<PayAgentCard jobId="j1" />);
    fireEvent.click(await screen.findByText("USDC · Solana"));
    expect(await screen.findByText(/has no Solana wallet/)).toBeTruthy();
  });

  it("starts on off-platform when the agent has no wallets at all", async () => {
    api.options = { ...baseOptions, wallets: { evm: [], solana: [] } };
    render(<PayAgentCard jobId="j1" />);
    expect(await screen.findByText("Mark as paid")).toBeTruthy();
  });

  it("members who can't pay just see who will", async () => {
    api.options = { ...baseOptions, canPay: false };
    render(<PayAgentCard jobId="j1" />);
    expect(await screen.findByText(/Waiting for the org owner/)).toBeTruthy();
  });

  it("shows a past payment", async () => {
    api.options = {
      ...baseOptions, payable: false, reason: "This job is already paid",
      payment: { method: "base-usdc", amountUsdc: 50, to: "0x2222222222222222222222222222222222222222", txSig: "0xabc", explorerUrl: "https://x/tx/0xabc", paidBy: "0xowner", paidAt: 1 },
    };
    render(<PayAgentCard jobId="j1" />);
    expect(await screen.findByText(/Paid \$50 · USDC on Base/)).toBeTruthy();
    expect(screen.getByText("View transaction")).toBeTruthy();
  });
});
