/**
 * POST /api/v1/marketplace/crypto-verify
 *
 * Verifies an on-chain transaction for a crypto payment intent.
 * If verified, activates the subscription.
 *
 * Supports: Hedera (Mirror Node), Solana (RPC), all EVM chains (ethers).
 *
 * Input: { paymentId, txHash }
 * Returns: { ok, verified, subscriptionId? }
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { SubscriptionPlan } from "@/lib/skills";
import { subscribeToItem } from "@/lib/firestore-admin";
import { getMarketplaceSettings } from "@/lib/marketplace-settings";
import { CHAIN_CONFIGS } from "@/lib/chains";

const CRYPTO_PAYMENTS_COLLECTION = "cryptoPayments";
const EVM_CHAINS = new Set(["ethereum", "avalanche", "base", "sepolia", "filecoin"]);

// ═══════════════════════════════════════════════════════════════
// Hedera Verifier (existing — via Mirror Node REST API)
// ═══════════════════════════════════════════════════════════════

async function verifyHederaTx(
    txHash: string,
    expectedRecipient: string,
    expectedAmount: number,
): Promise<{ verified: boolean; error?: string }> {
    try {
        const mirrorUrl = process.env.HEDERA_MIRROR_URL || "https://testnet.mirrornode.hedera.com";
        const res = await fetch(`${mirrorUrl}/api/v1/transactions/${txHash}`);
        if (!res.ok) return { verified: false, error: "Transaction not found on Hedera" };

        const data = await res.json();
        const tx = data.transactions?.[0];
        if (!tx) return { verified: false, error: "Transaction not found" };

        if (tx.result !== "SUCCESS") {
            return { verified: false, error: `Transaction status: ${tx.result}` };
        }

        const transfers = tx.transfers || [];
        const recipientTransfer = transfers.find(
            (t: { account: string; amount: number }) =>
                t.account === expectedRecipient && t.amount > 0,
        );

        if (!recipientTransfer) {
            return { verified: false, error: "Recipient not found in transaction transfers" };
        }

        // Convert tinybars to HBAR (1 HBAR = 100_000_000 tinybars)
        const receivedHbar = recipientTransfer.amount / 100_000_000;
        if (receivedHbar < expectedAmount * 0.95) {
            return { verified: false, error: `Insufficient amount: expected ${expectedAmount} HBAR, got ${receivedHbar}` };
        }

        return { verified: true };
    } catch (err) {
        return { verified: false, error: err instanceof Error ? err.message : "Verification failed" };
    }
}

// ═══════════════════════════════════════════════════════════════
// Solana Verifier (existing — via JSON-RPC)
// ═══════════════════════════════════════════════════════════════

async function verifySolanaTx(
    txHash: string,
    expectedRecipient: string,
    expectedAmount: number,
): Promise<{ verified: boolean; error?: string }> {
    try {
        const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
        const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getTransaction",
                params: [txHash, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
            }),
        });

        const data = await res.json();
        const tx = data.result;
        if (!tx) return { verified: false, error: "Transaction not found on Solana" };

        if (tx.meta?.err) {
            return { verified: false, error: `Transaction failed: ${JSON.stringify(tx.meta.err)}` };
        }

        const accountKeys = tx.transaction?.message?.accountKeys || [];
        const recipientIdx = accountKeys.findIndex(
            (k: { pubkey: string } | string) =>
                (typeof k === "string" ? k : k.pubkey) === expectedRecipient,
        );

        if (recipientIdx === -1) {
            return { verified: false, error: "Recipient not found in transaction" };
        }

        // Check lamport delta (1 SOL = 1_000_000_000 lamports)
        const preBalance = tx.meta.preBalances[recipientIdx] || 0;
        const postBalance = tx.meta.postBalances[recipientIdx] || 0;
        const receivedSol = (postBalance - preBalance) / 1_000_000_000;

        if (receivedSol < expectedAmount * 0.95) {
            return { verified: false, error: `Insufficient amount: expected ${expectedAmount} SOL, got ${receivedSol}` };
        }

        return { verified: true };
    } catch (err) {
        return { verified: false, error: err instanceof Error ? err.message : "Verification failed" };
    }
}

// ═══════════════════════════════════════════════════════════════
// EVM Verifier (NEW — Ethereum, Base, Avalanche, Sepolia, etc.)
// ═══════════════════════════════════════════════════════════════

/** ERC-20 Transfer event topic */
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

async function verifyEvmTx(
    txHash: string,
    expectedRecipient: string,
    expectedAmount: number,
    chain: string,
    paymentToken: string,
    usdcContractAddress?: string,
    usdcDecimals?: number,
): Promise<{ verified: boolean; error?: string }> {
    const chainConfig = CHAIN_CONFIGS[chain];
    if (!chainConfig) {
        return { verified: false, error: `Unknown chain: ${chain}` };
    }

    try {
        const { JsonRpcProvider, formatUnits } = await import("ethers");
        const provider = new JsonRpcProvider(chainConfig.rpc);
        const receipt = await provider.getTransactionReceipt(txHash);

        if (!receipt) {
            return { verified: false, error: "Transaction not found or not yet confirmed" };
        }

        if (receipt.status !== 1) {
            return { verified: false, error: "Transaction reverted on-chain" };
        }

        if (paymentToken === "usdc" && usdcContractAddress) {
            // Verify USDC (ERC-20) transfer via logs
            const decimals = usdcDecimals ?? 6;
            const recipientPadded = "0x" + expectedRecipient.toLowerCase().slice(2).padStart(64, "0");

            const transferLog = receipt.logs.find((log) =>
                log.address.toLowerCase() === usdcContractAddress.toLowerCase() &&
                log.topics[0] === ERC20_TRANSFER_TOPIC &&
                log.topics[2]?.toLowerCase() === recipientPadded,
            );

            if (!transferLog) {
                return { verified: false, error: "USDC Transfer event to recipient not found in logs" };
            }

            const transferredAmount = parseFloat(formatUnits(transferLog.data, decimals));
            if (transferredAmount < expectedAmount * 0.95) {
                return {
                    verified: false,
                    error: `Insufficient USDC: expected ${expectedAmount}, got ${transferredAmount}`,
                };
            }

            return { verified: true };
        } else {
            // Verify native currency transfer
            const tx = await provider.getTransaction(txHash);
            if (!tx) {
                return { verified: false, error: "Transaction data not found" };
            }

            // Check recipient
            if (tx.to?.toLowerCase() !== expectedRecipient.toLowerCase()) {
                return { verified: false, error: "Transaction recipient does not match treasury" };
            }

            // Check value
            const receivedNative = parseFloat(formatUnits(tx.value, chainConfig.nativeCurrency.decimals));
            if (receivedNative < expectedAmount * 0.95) {
                return {
                    verified: false,
                    error: `Insufficient amount: expected ${expectedAmount} ${chainConfig.nativeCurrency.symbol}, got ${receivedNative}`,
                };
            }

            return { verified: true };
        }
    } catch (err) {
        return { verified: false, error: err instanceof Error ? err.message : "EVM verification failed" };
    }
}

// ═══════════════════════════════════════════════════════════════
// Route Handler
// ═══════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
    const wallet = req.headers.get("x-wallet-address")?.toLowerCase();
    if (!wallet) {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json();
    const { paymentId, txHash } = body as { paymentId: string; txHash: string };

    if (!paymentId || !txHash) {
        return NextResponse.json({ error: "Missing paymentId or txHash" }, { status: 400 });
    }

    // Fetch payment intent
    const paymentRef = adminDb().collection(CRYPTO_PAYMENTS_COLLECTION).doc(paymentId);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
        return NextResponse.json({ error: "Payment intent not found" }, { status: 404 });
    }

    const payment = paymentSnap.data()!;

    if (payment.status === "verified") {
        return NextResponse.json({ ok: true, verified: true, alreadyVerified: true });
    }

    if (payment.status !== "pending") {
        return NextResponse.json({ error: `Payment is ${payment.status}` }, { status: 400 });
    }

    // Check expiry
    const expiresAt = payment.expiresAt instanceof Timestamp
        ? payment.expiresAt.toDate()
        : new Date(payment.expiresAt);
    if (expiresAt < new Date()) {
        await paymentRef.update({ status: "expired" });
        return NextResponse.json({ error: "Payment intent expired" }, { status: 410 });
    }

    // Dispatch to the correct chain verifier
    const chain = payment.chain as string;
    let result: { verified: boolean; error?: string };

    if (chain === "hedera") {
        result = await verifyHederaTx(txHash, payment.recipientAddress, payment.amount);
    } else if (chain === "solana") {
        result = await verifySolanaTx(txHash, payment.recipientAddress, payment.amount);
    } else if (EVM_CHAINS.has(chain)) {
        result = await verifyEvmTx(
            txHash,
            payment.recipientAddress,
            payment.amount,
            chain,
            payment.paymentToken || "native",
            payment.usdcContractAddress,
            payment.usdcDecimals,
        );
    } else {
        result = { verified: false, error: `Unsupported chain: ${chain}` };
    }

    if (!result.verified) {
        return NextResponse.json({
            ok: false,
            verified: false,
            error: result.error || "Transaction verification failed",
        }, { status: 400 });
    }

    // Activate subscription
    try {
        await subscribeToItem(
            payment.orgId,
            payment.modId,
            payment.plan as SubscriptionPlan,
            payment.wallet,
        );

        await paymentRef.update({
            status: "verified",
            txHash,
            verifiedAt: FieldValue.serverTimestamp(),
        });

        // Record crypto transaction to marketplaceTransactions for revenue tracking
        try {
            let itemName = payment.modId as string;
            let publisherWallet = (payment.publisherWallet as string) || "";

            if (!publisherWallet) {
                const communitySnap = await adminDb().collection("communityMarketItems").doc(payment.modId).get();
                if (communitySnap.exists) {
                    itemName = (communitySnap.data()!.name as string) || itemName;
                    publisherWallet = (communitySnap.data()!.submittedBy as string) || "";
                } else {
                    const agentSnap = await adminDb().collection("marketplaceAgents").doc(payment.modId).get();
                    if (agentSnap.exists) {
                        itemName = (agentSnap.data()!.name as string) || itemName;
                        publisherWallet = (agentSnap.data()!.authorWallet as string) || "";
                    }
                }
            }

            const settings = await getMarketplaceSettings();
            const amount = (payment.amount as number) || 0;
            const platformFee = Math.round(amount * (settings.platformFeePercent / 100) * 100) / 100;

            await adminDb().collection("marketplaceTransactions").add({
                itemId: payment.modId,
                itemName,
                buyerWallet: wallet,
                publisherWallet,
                amount,
                platformFee,
                type: "subscription",
                status: "completed",
                paymentMethod: "crypto",
                chain,
                paymentToken: payment.paymentToken || "native",
                txHash,
                plan: payment.plan,
                createdAt: FieldValue.serverTimestamp(),
            });
        } catch {
            // Non-blocking — subscription is already active
        }

        return NextResponse.json({ ok: true, verified: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to activate subscription";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
