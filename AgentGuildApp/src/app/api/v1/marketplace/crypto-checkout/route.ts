/**
 * POST /api/v1/marketplace/crypto-checkout
 *
 * Creates a crypto payment intent for mod subscriptions.
 * Returns a payment ID, recipient address, and amount for the user to pay on-chain.
 *
 * Supports all payment-enabled chains: Ethereum, Avalanche, Base, Hedera, Sepolia, Solana.
 * Accepts native currency or USDC as payment token.
 *
 * Input: { modId, plan, orgId, chain, paymentToken?: "native" | "usdc" }
 * Returns: { ok, paymentId, recipientAddress, amount, currency, expiresAt, paymentToken, usdcContractAddress? }
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { SKILL_REGISTRY, type SubscriptionPlan } from "@/lib/skills";
// [swarm-core] mod-gateway extracted — remote mod lookup disabled
const getModService = async (_id: string) => null;
import { CHAIN_CONFIGS, PAYMENT_CHAINS, USDC_CONTRACTS, USDC_DECIMALS } from "@/lib/chains";

const CRYPTO_PAYMENTS_COLLECTION = "cryptoPayments";

/** Valid chain keys that accept payments */
const VALID_PAYMENT_CHAINS = new Set<string>(PAYMENT_CHAINS.map((c) => c.key));

/** Sentinel addresses that indicate "not configured" */
const UNCONFIGURED_ADDRESSES = new Set([
    "0.0.0000000",
    "11111111111111111111111111111111",
    "",
    undefined,
]);

/** Get recipient (treasury) address for a chain */
function getRecipientAddress(chain: string): string | undefined {
    return CHAIN_CONFIGS[chain]?.contracts.treasury;
}

export async function POST(req: NextRequest) {
    const wallet = req.headers.get("x-wallet-address")?.toLowerCase();
    if (!wallet) {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const body = await req.json();
    const { modId, plan, orgId, chain, paymentToken = "native" } = body as {
        modId: string;
        plan: SubscriptionPlan;
        orgId: string;
        chain: string;
        paymentToken?: "native" | "usdc";
    };

    if (!modId || !plan || !orgId || !chain) {
        return NextResponse.json({ error: "Missing modId, plan, orgId, or chain" }, { status: 400 });
    }

    if (!VALID_PAYMENT_CHAINS.has(chain)) {
        return NextResponse.json({
            error: `Invalid chain "${chain}". Supported: ${[...VALID_PAYMENT_CHAINS].join(", ")}`,
        }, { status: 400 });
    }

    if (paymentToken !== "native" && paymentToken !== "usdc") {
        return NextResponse.json({ error: "paymentToken must be 'native' or 'usdc'" }, { status: 400 });
    }

    // USDC not available on all chains
    if (paymentToken === "usdc" && !USDC_CONTRACTS[chain]) {
        return NextResponse.json({
            error: `USDC not available on ${chain}. Use native currency instead.`,
        }, { status: 400 });
    }

    // Look up pricing
    const staticMod = SKILL_REGISTRY.find((s) => s.id === modId);
    const remoteMod = !staticMod ? await getModService(modId) : null;
    const pricing = staticMod?.pricing || remoteMod?.pricing;

    if (!pricing || pricing.model === "free") {
        return NextResponse.json({ error: "This mod is free" }, { status: 400 });
    }

    const tier = pricing.tiers?.find((t) => t.plan === plan);
    if (!tier) {
        return NextResponse.json({ error: `Plan "${plan}" not available` }, { status: 400 });
    }

    const recipientAddress = getRecipientAddress(chain);
    if (!recipientAddress || UNCONFIGURED_ADDRESSES.has(recipientAddress)) {
        return NextResponse.json({ error: `${chain} treasury address not configured` }, { status: 503 });
    }

    const chainConfig = CHAIN_CONFIGS[chain];
    const currency = paymentToken === "usdc" ? "USDC" : chainConfig.nativeCurrency.symbol;
    // For now, use the USD price directly — in production, convert via oracle for native tokens
    const amount = tier.price;

    // Resolve publisherWallet for revenue attribution
    let publisherWallet = "";
    const communitySnap = await adminDb().collection("communityMarketItems").doc(modId).get();
    if (communitySnap.exists) {
        publisherWallet = (communitySnap.data()!.submittedBy as string) || "";
    } else {
        const agentSnap = await adminDb().collection("marketplaceAgents").doc(modId).get();
        if (agentSnap.exists) {
            publisherWallet = (agentSnap.data()!.authorWallet as string) || "";
        }
    }

    // Create payment intent in Firestore
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min expiry

    const usdcContractAddress = paymentToken === "usdc" ? USDC_CONTRACTS[chain] : undefined;

    try {
        const ref = await adminDb().collection(CRYPTO_PAYMENTS_COLLECTION).add({
            modId,
            plan,
            orgId,
            chain,
            wallet,
            recipientAddress,
            amount,
            currency,
            paymentToken,
            usdcContractAddress: usdcContractAddress || null,
            usdcDecimals: paymentToken === "usdc" ? USDC_DECIMALS : null,
            publisherWallet,
            status: "pending",
            expiresAt,
            createdAt: FieldValue.serverTimestamp(),
        });

        return NextResponse.json({
            ok: true,
            paymentId: ref.id,
            recipientAddress,
            amount,
            currency,
            paymentToken,
            usdcContractAddress,
            chainName: chainConfig.name,
            explorerTxUrl: chainConfig.explorer.txUrl("TX_HASH_PLACEHOLDER").replace("TX_HASH_PLACEHOLDER", ""),
            expiresAt: expiresAt.toISOString(),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create payment intent";
        return NextResponse.json({ error: message }, { status: 500 });
    }
}
