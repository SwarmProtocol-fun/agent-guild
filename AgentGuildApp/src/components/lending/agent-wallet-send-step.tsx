/**
 * Move a loan's money from the borrowing agent's own wallet in one click —
 * collateral, a collateral top-up or a repayment. Shows the agent's wallets on
 * the right chain with their balances; the server sends the amount and
 * verifies it (lib/lending/agent-wallet-send.ts). A transfer that's still
 * finalizing shows as "confirming" and can be re-checked; it also finishes on
 * its own via the lending sweep.
 */
"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, Wallet, Copy, Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentWalletSend } from "@/lib/lending/types";

interface QuoteWallet {
    walletId: string;
    address: string;
    balance: number | null;
    feeBalance: number | null;
    enough: boolean;
    shortfall: string | null;
}

interface Quote {
    asset: "usdc" | "sol" | "eth";
    symbol: string;
    chain: "solana" | "ethereum";
    /** Collateral quotes carry the fixed amount; others use the `amount` prop. */
    amount?: number;
    /** Top-ups: the wallet that posted the collateral (the only one allowed to add to it). */
    postedBy?: string | null;
    wallets: QuoteWallet[];
    send: AgentWalletSend | null;
}

interface Result {
    status: "posted" | "confirming" | "failed";
    txSig: string | null;
    message: string;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (n: number | null, symbol: string) => (n == null ? "—" : `${Number(n.toFixed(symbol === "USDC" ? 2 : 6))} ${symbol}`);

interface AgentWalletSendStepProps {
    /** The route: GET quotes (?amount=), POST sends ({ amount, walletId }) or re-checks ({ check: true }). */
    endpoint: string;
    /** Amount to send; omit when the route fixes it (collateral). */
    amount?: number;
    /** Verb for the button: "Post", "Add", "Repay". */
    verb: string;
    description: (amount: string) => ReactNode;
    doneMessage: string;
    onPosted: () => void;
}

export function AgentWalletSendStep({ endpoint, amount, verb, description, doneMessage, onPosted }: AgentWalletSendStepProps) {
    const [quote, setQuote] = useState<Quote | null>(null);
    const [walletId, setWalletId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<Result | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            const res = await fetch(amount !== undefined ? `${endpoint}?amount=${amount}` : endpoint);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Couldn't read the agent's wallets");
            setQuote(data);
            setWalletId((cur) => (cur && data.wallets.some((w: QuoteWallet) => w.walletId === cur)
                ? cur
                : (data.wallets.find((w: QuoteWallet) => w.enough) ?? data.wallets[0])?.walletId ?? null));
            if (data.send?.txSig && data.send.status === "sent") {
                setResult({ status: "confirming", txSig: data.send.txSig, message: "Sent from the agent's wallet; waiting for it to finalize." });
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't read the agent's wallets");
        }
    }, [endpoint, amount]);
    // Re-quote (debounced) as the amount changes, so "enough" stays accurate.
    useEffect(() => {
        const t = setTimeout(load, amount === undefined ? 0 : 300);
        return () => clearTimeout(t);
    }, [load, amount]);

    const call = async (body: Record<string, unknown>) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok && !data.status) throw new Error(data.error || "Sending from the agent's wallet failed");
            setResult(data);
            if (data.status === "posted") onPosted();
            else if (data.status === "failed") setError(data.message);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Sending from the agent's wallet failed");
        } finally {
            setBusy(false);
        }
    };

    const copy = (text: string) => {
        navigator.clipboard?.writeText(text);
        setCopied(text);
        setTimeout(() => setCopied(null), 1500);
    };

    if (!quote) {
        return error
            ? <p className="text-xs text-red-500">{error}</p>
            : <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
    }

    const sendAmount = amount ?? quote.amount ?? 0;
    const selected = quote.wallets.find((w) => w.walletId === walletId) ?? null;
    const confirming = result?.status === "confirming";
    const chainName = quote.chain === "ethereum" ? "Ethereum" : "Solana";

    if (result?.status === "posted") {
        return <p className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">{doneMessage}</p>;
    }

    return (
        <div className="space-y-3 text-sm">
            <p className="text-muted-foreground text-xs">{description(fmt(sendAmount, quote.symbol))}</p>

            {quote.wallets.length === 0 ? (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                    {quote.postedBy
                        ? <>The collateral was posted from {short(quote.postedBy)}, which isn&apos;t one of this agent&apos;s wallets. Add to it from that wallet instead.</>
                        : <>This agent has no {chainName} wallet yet. Generate one on the agent&apos;s Wallets tab, fund it, then come back. Or use your own wallet.</>}
                </p>
            ) : (
                <div className="space-y-1.5" role="radiogroup" aria-label="Agent wallet">
                    {quote.wallets.map((w) => (
                        <div key={w.walletId} className={`rounded-md border transition-colors ${walletId === w.walletId ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary))]/10" : "border-border"}`}>
                            <button
                                type="button" role="radio" aria-checked={walletId === w.walletId}
                                disabled={confirming || busy}
                                onClick={() => setWalletId(w.walletId)}
                                className="w-full rounded-md px-3 py-2 text-left hover:bg-[hsl(var(--accent))]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]"
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="flex items-center gap-1.5 font-mono text-xs">
                                        <span
                                            aria-hidden="true"
                                            className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${walletId === w.walletId ? "border-[hsl(var(--primary))]" : "border-[hsl(var(--muted-foreground))]/50"}`}
                                        >
                                            {walletId === w.walletId && <span className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--primary))]" />}
                                        </span>
                                        <Wallet className="h-3.5 w-3.5 text-muted-foreground" />{short(w.address)}
                                    </span>
                                    <span className="font-mono text-xs tabular-nums">{fmt(w.balance, quote.symbol)}</span>
                                </div>
                                {quote.asset === "usdc" && <div className="mt-0.5 text-[11px] text-muted-foreground">{fmt(w.feeBalance, "SOL")} for fees</div>}
                            </button>
                            {w.shortfall && (
                                <div className="flex items-center justify-between gap-2 px-3 pb-2 text-[11px] text-amber-700 dark:text-amber-400">
                                    <span>{w.shortfall}. Fund this address:</span>
                                    <button type="button" onClick={() => copy(w.address)} className="inline-flex shrink-0 items-center gap-1 underline">
                                        {copied === w.address ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} Copy
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {confirming && (
                <div className="rounded-md bg-blue-500/10 px-3 py-2 text-xs text-blue-800 dark:text-blue-300">
                    <p>{result!.message}</p>
                    {result!.txSig && <p className="mt-1 font-mono break-all">{result!.txSig}</p>}
                    <p className="mt-1">You can close this; it finishes automatically.</p>
                </div>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}

            {confirming ? (
                <Button className="w-full" variant="outline" disabled={busy} onClick={() => call({ check: true })}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Check now</>}
                </Button>
            ) : quote.wallets.length > 0 && (
                <div className="flex gap-2">
                    <Button className="flex-1" disabled={busy || !selected?.enough || !(sendAmount > 0)} onClick={() => call({ walletId, amount: sendAmount })}>
                        {busy
                            ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Sending{quote.chain === "solana" ? " & verifying…" : "…"}</>
                            : `${verb} ${fmt(sendAmount, quote.symbol)} from agent wallet`}
                    </Button>
                    <Button variant="outline" size="icon" aria-label="Refresh balances" disabled={busy} onClick={load}><RefreshCw className="h-3.5 w-3.5" /></Button>
                </div>
            )}
        </div>
    );
}
