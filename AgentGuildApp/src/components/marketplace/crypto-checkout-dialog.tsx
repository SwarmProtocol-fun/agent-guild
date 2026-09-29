/**
 * CryptoCheckoutDialog — Multi-step crypto payment flow for marketplace items.
 *
 * Steps: Select Chain → Review Payment → Sign Transaction → Verify → Success
 *
 * For EVM chains: uses window.ethereum (MetaMask/injected wallet) to sign.
 * For Solana/Hedera: shows recipient + amount for manual send with txHash input.
 */
"use client";

import { useState, useCallback } from "react";
import {
    Loader2, CheckCircle2, AlertCircle, ExternalLink,
    Wallet, ArrowRight, Copy, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { PAYMENT_CHAINS, CHAIN_CONFIGS, type ChainConfig } from "@/lib/chains";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

interface CryptoCheckoutDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    itemId: string;
    itemName: string;
    itemIcon: string;
    plan: string;
    orgId: string;
    walletAddress: string;
    priceUsd: number;
    currency: string;
    onSuccess: () => void;
}

type Step = "select-chain" | "review" | "signing" | "verify" | "success" | "error";

interface PaymentIntent {
    paymentId: string;
    recipientAddress: string;
    amount: number;
    currency: string;
    paymentToken: string;
    usdcContractAddress?: string;
    chainName: string;
    explorerTxUrl: string;
    expiresAt: string;
}

// EVM chain keys (can use window.ethereum)
const EVM_CHAIN_KEYS = new Set(["ethereum", "avalanche", "base", "sepolia", "filecoin"]);

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function CryptoCheckoutDialog({
    open,
    onOpenChange,
    itemId,
    itemName,
    itemIcon,
    plan,
    orgId,
    walletAddress,
    priceUsd,
    currency: _priceCurrency,
    onSuccess,
}: CryptoCheckoutDialogProps) {
    const [step, setStep] = useState<Step>("select-chain");
    const [selectedChain, setSelectedChain] = useState<string | null>(null);
    const [paymentToken, setPaymentToken] = useState<"native" | "usdc">("native");
    const [paymentIntent, setPaymentIntent] = useState<PaymentIntent | null>(null);
    const [txHash, setTxHash] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);

    const selectedChainConfig = selectedChain ? CHAIN_CONFIGS[selectedChain] : null;

    const reset = useCallback(() => {
        setStep("select-chain");
        setSelectedChain(null);
        setPaymentToken("native");
        setPaymentIntent(null);
        setTxHash("");
        setError(null);
        setLoading(false);
        setCopied(false);
    }, []);

    const handleClose = useCallback((open: boolean) => {
        if (!open) reset();
        onOpenChange(open);
    }, [onOpenChange, reset]);

    // Step 1 → 2: Create payment intent
    const handleCreateIntent = useCallback(async () => {
        if (!selectedChain) return;
        setLoading(true);
        setError(null);

        try {
            const res = await fetch("/api/v1/marketplace/crypto-checkout", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-wallet-address": walletAddress,
                },
                body: JSON.stringify({
                    modId: itemId,
                    plan,
                    orgId,
                    chain: selectedChain,
                    paymentToken,
                }),
            });

            const data = await res.json();
            if (!res.ok || !data.ok) {
                throw new Error(data.error || "Failed to create payment intent");
            }

            setPaymentIntent(data as PaymentIntent);
            setStep("review");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to create payment");
        } finally {
            setLoading(false);
        }
    }, [selectedChain, paymentToken, walletAddress, itemId, plan, orgId]);

    // Step 2 → 3: Sign transaction (EVM chains only)
    const handleSignEvmTx = useCallback(async () => {
        if (!paymentIntent || !selectedChain || !selectedChainConfig) return;
        setStep("signing");
        setError(null);

        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ethereum = (window as any).ethereum;
            if (!ethereum) {
                throw new Error("No Ethereum wallet detected. Install MetaMask or another wallet.");
            }

            const { BrowserProvider, parseUnits, Contract } = await import("ethers");
            const provider = new BrowserProvider(ethereum);

            // Request account access
            await provider.send("eth_requestAccounts", []);

            // Switch to the correct chain
            const chainId = "0x" + selectedChainConfig.chainId.toString(16);
            try {
                await provider.send("wallet_switchEthereumChain", [{ chainId }]);
            } catch {
                // Chain not added — could add it, but for now just inform the user
                throw new Error(`Please add ${selectedChainConfig.name} (chain ID ${selectedChainConfig.chainId}) to your wallet.`);
            }

            const signer = await provider.getSigner();
            let hash: string;

            if (paymentIntent.paymentToken === "usdc" && paymentIntent.usdcContractAddress) {
                // ERC-20 USDC transfer
                const abi = ["function transfer(address to, uint256 amount) returns (bool)"];
                const contract = new Contract(paymentIntent.usdcContractAddress, abi, signer);
                const amount = parseUnits(paymentIntent.amount.toString(), 6);
                const tx = await contract.transfer(paymentIntent.recipientAddress, amount);
                hash = tx.hash;
                await tx.wait();
            } else {
                // Native transfer
                const tx = await signer.sendTransaction({
                    to: paymentIntent.recipientAddress,
                    value: parseUnits(
                        paymentIntent.amount.toString(),
                        selectedChainConfig.nativeCurrency.decimals,
                    ),
                });
                hash = tx.hash;
                await tx.wait();
            }

            setTxHash(hash);
            // Auto-verify after signing
            await verifyTransaction(hash);
        } catch (err) {
            const msg = err instanceof Error ? err.message : "Transaction failed";
            // User rejected = go back to review, don't show as error
            if (msg.includes("user rejected") || msg.includes("User denied")) {
                setStep("review");
            } else {
                setError(msg);
                setStep("error");
            }
        }
    }, [paymentIntent, selectedChain, selectedChainConfig]);

    // Verify transaction (works for all chains)
    const verifyTransaction = useCallback(async (hash?: string) => {
        const txHashToVerify = hash || txHash;
        if (!paymentIntent || !txHashToVerify) return;

        setStep("verify");
        setLoading(true);
        setError(null);

        try {
            const res = await fetch("/api/v1/marketplace/crypto-verify", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-wallet-address": walletAddress,
                },
                body: JSON.stringify({
                    paymentId: paymentIntent.paymentId,
                    txHash: txHashToVerify,
                }),
            });

            const data = await res.json();
            if (!res.ok || !data.verified) {
                throw new Error(data.error || "Verification failed");
            }

            setStep("success");
        } catch (err) {
            setError(err instanceof Error ? err.message : "Verification failed");
            setStep("error");
        } finally {
            setLoading(false);
        }
    }, [paymentIntent, txHash, walletAddress]);

    const handleCopy = useCallback((text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, []);

    const isEvmChain = selectedChain ? EVM_CHAIN_KEYS.has(selectedChain) : false;

    // ═══════════════════════════════════════════════════════════════
    // Render
    // ═══════════════════════════════════════════════════════════════

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <span className="text-xl">{itemIcon}</span>
                        Pay with Crypto
                    </DialogTitle>
                    <DialogDescription>
                        {itemName} — {plan} plan
                    </DialogDescription>
                </DialogHeader>

                {/* ─── Step 1: Select Chain ─── */}
                {step === "select-chain" && (
                    <div className="space-y-4">
                        <p className="text-sm text-muted-foreground">
                            Choose a blockchain to pay with. You can use native currency or USDC where available.
                        </p>
                        <div className="grid gap-2">
                            {PAYMENT_CHAINS.map((chain) => (
                                <button
                                    key={chain.key}
                                    onClick={() => {
                                        setSelectedChain(chain.key);
                                        setPaymentToken("native");
                                    }}
                                    className={`flex items-center gap-3 p-3 rounded-lg border transition-colors text-left ${
                                        selectedChain === chain.key
                                            ? "border-purple-500 bg-purple-500/10"
                                            : "border-border hover:border-muted-foreground/30 hover:bg-muted/30"
                                    }`}
                                >
                                    <div className="flex-1">
                                        <div className="font-medium text-sm">{chain.name}</div>
                                        <div className="text-xs text-muted-foreground">
                                            {chain.nativeCurrency.symbol}
                                            {chain.contracts.usdc && " / USDC"}
                                        </div>
                                    </div>
                                    {EVM_CHAIN_KEYS.has(chain.key) && (
                                        <Badge variant="outline" className="text-[10px]">Auto-sign</Badge>
                                    )}
                                    {selectedChain === chain.key && (
                                        <CheckCircle2 className="h-4 w-4 text-purple-500" />
                                    )}
                                </button>
                            ))}
                        </div>

                        {/* USDC toggle */}
                        {selectedChain && CHAIN_CONFIGS[selectedChain]?.contracts.usdc && (
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setPaymentToken("native")}
                                    className={`flex-1 py-2 rounded-md text-xs font-medium border transition-colors ${
                                        paymentToken === "native"
                                            ? "border-purple-500 bg-purple-500/10 text-purple-400"
                                            : "border-border hover:bg-muted/30"
                                    }`}
                                >
                                    {CHAIN_CONFIGS[selectedChain]?.nativeCurrency.symbol}
                                </button>
                                <button
                                    onClick={() => setPaymentToken("usdc")}
                                    className={`flex-1 py-2 rounded-md text-xs font-medium border transition-colors ${
                                        paymentToken === "usdc"
                                            ? "border-purple-500 bg-purple-500/10 text-purple-400"
                                            : "border-border hover:bg-muted/30"
                                    }`}
                                >
                                    USDC
                                </button>
                            </div>
                        )}

                        {error && (
                            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
                                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                                {error}
                            </div>
                        )}

                        <DialogFooter>
                            <Button variant="ghost" onClick={() => handleClose(false)}>Cancel</Button>
                            <Button
                                onClick={handleCreateIntent}
                                disabled={!selectedChain || loading}
                            >
                                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <ArrowRight className="h-4 w-4 mr-2" />}
                                Continue
                            </Button>
                        </DialogFooter>
                    </div>
                )}

                {/* ─── Step 2: Review Payment ─── */}
                {step === "review" && paymentIntent && (
                    <div className="space-y-4">
                        <div className="rounded-lg border border-border p-4 space-y-3">
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Chain</span>
                                <span className="font-medium">{paymentIntent.chainName}</span>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Amount</span>
                                <span className="font-bold text-lg">
                                    {paymentIntent.amount} {paymentIntent.currency}
                                </span>
                            </div>
                            <div className="flex justify-between text-sm items-center">
                                <span className="text-muted-foreground">To</span>
                                <button
                                    onClick={() => handleCopy(paymentIntent.recipientAddress)}
                                    className="flex items-center gap-1.5 font-mono text-xs hover:text-purple-400 transition-colors"
                                >
                                    {paymentIntent.recipientAddress.slice(0, 10)}...{paymentIntent.recipientAddress.slice(-6)}
                                    {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                                </button>
                            </div>
                            <div className="flex justify-between text-sm">
                                <span className="text-muted-foreground">Expires</span>
                                <span className="text-xs">{new Date(paymentIntent.expiresAt).toLocaleTimeString()}</span>
                            </div>
                        </div>

                        {isEvmChain ? (
                            <div className="space-y-3">
                                <p className="text-xs text-muted-foreground">
                                    Your wallet will open to sign the transaction. Make sure you&apos;re connected to {paymentIntent.chainName}.
                                </p>
                                <DialogFooter>
                                    <Button variant="ghost" onClick={() => { setStep("select-chain"); setPaymentIntent(null); }}>Back</Button>
                                    <Button onClick={handleSignEvmTx}>
                                        <Wallet className="h-4 w-4 mr-2" /> Sign & Pay
                                    </Button>
                                </DialogFooter>
                            </div>
                        ) : (
                            <div className="space-y-3">
                                <p className="text-xs text-muted-foreground">
                                    Send the exact amount to the address above using your {paymentIntent.chainName} wallet,
                                    then paste the transaction hash below to verify.
                                </p>
                                <div className="flex gap-2">
                                    <Input
                                        value={txHash}
                                        onChange={(e) => setTxHash(e.target.value)}
                                        placeholder="Paste transaction hash..."
                                        className="font-mono text-xs"
                                    />
                                </div>
                                <DialogFooter>
                                    <Button variant="ghost" onClick={() => { setStep("select-chain"); setPaymentIntent(null); }}>Back</Button>
                                    <Button
                                        onClick={() => verifyTransaction()}
                                        disabled={!txHash.trim() || loading}
                                    >
                                        {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                                        Verify Payment
                                    </Button>
                                </DialogFooter>
                            </div>
                        )}
                    </div>
                )}

                {/* ─── Step 3: Signing (EVM auto-sign in progress) ─── */}
                {step === "signing" && (
                    <div className="flex flex-col items-center gap-4 py-8">
                        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
                        <div className="text-center">
                            <p className="font-medium">Waiting for wallet confirmation...</p>
                            <p className="text-sm text-muted-foreground mt-1">
                                Confirm the transaction in your wallet
                            </p>
                        </div>
                    </div>
                )}

                {/* ─── Step 4: Verifying ─── */}
                {step === "verify" && (
                    <div className="flex flex-col items-center gap-4 py-8">
                        <Loader2 className="h-8 w-8 animate-spin text-amber-400" />
                        <div className="text-center">
                            <p className="font-medium">Verifying transaction...</p>
                            <p className="text-sm text-muted-foreground mt-1">
                                Checking on-chain confirmation
                            </p>
                        </div>
                    </div>
                )}

                {/* ─── Step 5: Success ─── */}
                {step === "success" && (
                    <div className="flex flex-col items-center gap-4 py-6">
                        <div className="rounded-full bg-emerald-500/20 p-3">
                            <CheckCircle2 className="h-8 w-8 text-emerald-400" />
                        </div>
                        <div className="text-center">
                            <p className="font-bold text-lg">Payment Confirmed</p>
                            <p className="text-sm text-muted-foreground mt-1">
                                Your subscription to {itemName} is now active.
                            </p>
                        </div>
                        {txHash && paymentIntent && (
                            <a
                                href={`${paymentIntent.explorerTxUrl}${txHash}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1.5 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                            >
                                View on explorer <ExternalLink className="h-3 w-3" />
                            </a>
                        )}
                        <DialogFooter className="w-full">
                            <Button className="w-full" onClick={() => { handleClose(false); onSuccess(); }}>
                                Done
                            </Button>
                        </DialogFooter>
                    </div>
                )}

                {/* ─── Error State ─── */}
                {step === "error" && (
                    <div className="space-y-4">
                        <div className="flex flex-col items-center gap-3 py-4">
                            <div className="rounded-full bg-red-500/20 p-3">
                                <AlertCircle className="h-8 w-8 text-red-400" />
                            </div>
                            <div className="text-center">
                                <p className="font-bold">Payment Failed</p>
                                <p className="text-sm text-red-400 mt-1">{error}</p>
                            </div>
                        </div>

                        {/* Allow manual txHash submission for non-EVM or if auto-sign failed */}
                        {paymentIntent && (
                            <div className="space-y-2">
                                <p className="text-xs text-muted-foreground">
                                    If you already sent the transaction, paste the hash to retry verification:
                                </p>
                                <div className="flex gap-2">
                                    <Input
                                        value={txHash}
                                        onChange={(e) => setTxHash(e.target.value)}
                                        placeholder="Transaction hash..."
                                        className="font-mono text-xs"
                                    />
                                    <Button
                                        size="sm"
                                        onClick={() => verifyTransaction()}
                                        disabled={!txHash.trim() || loading}
                                    >
                                        Retry
                                    </Button>
                                </div>
                            </div>
                        )}

                        <DialogFooter>
                            <Button variant="ghost" onClick={() => handleClose(false)}>Close</Button>
                            <Button variant="outline" onClick={reset}>Try Again</Button>
                        </DialogFooter>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
