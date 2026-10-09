/**
 * Add collateral to an active collateral-market loan, lowering its
 * loan-to-value and moving it away from liquidation. Suggests the amount that
 * brings the loan back to a comfortable LTV and previews the result. It must
 * come from the wallet that posted the original collateral — from the agent's
 * wallet in one click, or sent by hand and verified.
 */
"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OnChainSendStep } from "./onchain-send-step";
import { AgentWalletSendStep } from "./agent-wallet-send-step";
import { SendSourceTabs, type SendSource } from "./send-source-tabs";
import { useWalletTransfer } from "./use-wallet-transfer";
import type { Loan } from "@/lib/lending/types";
import { assetInfo, roundAmount } from "@/lib/lending/assets";
import { collateralToReachLtv, loanToValue } from "@/lib/lending/math";
import { treasuryAddressFor, sendAssetLabel, type LendingTreasuryInfo } from "@/lib/lending/client";

interface AddCollateralDialogProps {
    loan: Loan;
    /** Live payoff in the loan's asset. */
    debt: number;
    treasuryInfo: LendingTreasuryInfo;
    onClose: () => void;
    onAdded: () => void;
}

/** Suggested target: 20 points under the liquidation threshold. */
const TARGET_GAP = 0.2;

export function AddCollateralDialog({ loan, debt, treasuryInfo, onClose, onAdded }: AddCollateralDialogProps) {
    const asset = loan.collateralAsset!;
    const { symbol, chain } = assetInfo(asset);
    const collPrice = treasuryInfo.pricesUsd[asset] ?? null;
    const debtPrice = treasuryInfo.pricesUsd[loan.asset ?? "usdc"] ?? null;
    const threshold = (loan.liquidationLtvBps ?? 0) / 10_000;
    // Rounded up to a readable precision (cents for USDC, 4 places otherwise) so it always reaches the target.
    const step = asset === "usdc" ? 100 : 10_000;
    const suggested = collPrice && debtPrice
        ? Math.ceil(collateralToReachLtv(debt * debtPrice, loan.collateral, collPrice, Math.max(0.05, threshold - TARGET_GAP)) * step) / step
        : 0;
    const [amount, setAmount] = useState(suggested > 0 ? String(suggested) : "");
    const [source, setSource] = useState<SendSource>("agent");
    const { canSend, send } = useWalletTransfer(treasuryInfo);
    const treasury = treasuryAddressFor(treasuryInfo, asset);

    const amountValue = roundAmount(asset, parseFloat(amount) || 0);
    const ltvNow = collPrice && debtPrice ? loanToValue(debt, debtPrice, loan.collateral, collPrice) : null;
    const ltvAfter = collPrice && debtPrice && amountValue > 0 ? loanToValue(debt, debtPrice, loan.collateral + amountValue, collPrice) : null;
    const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader><DialogTitle>Add Collateral</DialogTitle></DialogHeader>
                <div className="space-y-3">
                    <div>
                        <Label className="text-xs" htmlFor="topup-amount">Amount ({symbol})</Label>
                        <Input id="topup-amount" type="number" inputMode="decimal" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1" />
                        {suggested > 0 && (
                            <button type="button" className="text-[10px] text-emerald-500 hover:underline mt-1" onClick={() => setAmount(String(suggested))}>
                                Suggested: {suggested} {symbol} (brings LTV to {pct(Math.max(0.05, threshold - TARGET_GAP))})
                            </button>
                        )}
                    </div>
                    {ltvNow !== null && (
                        <div className="rounded-md border border-border p-2 text-xs space-y-1 tabular-nums">
                            <div className="flex justify-between"><span className="text-muted-foreground">LTV now</span><span>{pct(ltvNow)}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">LTV after</span><span className="text-emerald-500">{ltvAfter !== null ? pct(ltvAfter) : "—"}</span></div>
                            <div className="flex justify-between"><span className="text-muted-foreground">Liquidates at</span><span>{pct(threshold)}</span></div>
                        </div>
                    )}
                    <SendSourceTabs value={source} onChange={setSource} label="Add collateral from" />
                    {!(amountValue > 0) ? (
                        <p className="text-xs text-muted-foreground">Enter an amount to continue.</p>
                    ) : source === "agent" ? (
                        <AgentWalletSendStep
                            endpoint={`/api/v1/lending/loans/${loan.id}/collateral/top-up/agent-wallet`}
                            amount={amountValue}
                            verb="Add"
                            description={(a) => <>Sends {a} from the wallet that posted this loan&apos;s collateral to the lending treasury. It&apos;s returned with the rest when the loan is repaid.</>}
                            doneMessage="Collateral added. The loan's LTV is updated."
                            onPosted={() => { onAdded(); setTimeout(onClose, 1500); }}
                        />
                    ) : treasury ? (
                        <OnChainSendStep
                            recipientAddress={treasury}
                            amount={amountValue}
                            assetLabel={sendAssetLabel(treasuryInfo, asset)}
                            chain={chain}
                            helperText={`Send from ${loan.collateralPostedByWallet ?? "the wallet that posted the collateral"} — extra collateral from any other wallet is returned, not added.`}
                            submitLabel="Verify & Add"
                            onSendWithWallet={canSend(asset, loan.collateralPostedByWallet) ? () => send(asset, treasury, amountValue) : undefined}
                            onSubmit={async (txSig) => {
                                const res = await fetch(`/api/v1/lending/loans/${loan.id}/collateral/top-up`, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ amount: amountValue, txSig }),
                                });
                                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't add collateral");
                                onAdded();
                                onClose();
                            }}
                        />
                    ) : (
                        <p className="text-xs text-red-500">The {symbol} treasury is not configured.</p>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
