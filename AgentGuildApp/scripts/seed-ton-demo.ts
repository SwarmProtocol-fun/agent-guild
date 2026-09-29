/**
 * TON Treasury Demo Seed Script
 *
 * Seeds Firestore with predictable demo data for screen recording:
 *   - 1 verified TON wallet
 *   - 1 spending policy (sensible defaults)
 *   - 1 fee config (2% platform fee)
 *   - 1 agent wallet (active)
 *   - 3 bounties (open, claimed, executed/released)
 *   - 3 payments (pending_approval, ready, executed with txHash)
 *   - 1 active subscription
 *   - audit entries for each action
 *
 * Usage:
 *   npx tsx scripts/seed-ton-demo.ts                     # uses .env.local
 *   npx tsx scripts/seed-ton-demo.ts --orgId=abc123      # specify org
 *   npx tsx scripts/seed-ton-demo.ts --clean              # delete all seed data first
 *
 * Requirements:
 *   - Firebase env vars in .env.local
 */

import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env.local") });
dotenv.config({ path: path.join(__dirname, "../.env") });

import { initializeApp, getApps } from "firebase/app";
import {
    getFirestore,
    collection,
    doc,
    setDoc,
    addDoc,
    getDocs,
    deleteDoc,
    query,
    where,
    serverTimestamp,
    Timestamp,
} from "firebase/firestore";

// ═══════════════════════════════════════════════════════════════
// Firebase init (standalone — not importing from src/lib)
// ═══════════════════════════════════════════════════════════════

const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const db = getFirestore(app);

// ═══════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const ORG_ID = args.find(a => a.startsWith("--orgId="))?.split("=")[1] || "demo-org-ton";
const CLEAN = args.includes("--clean");

// Demo addresses (TON testnet-style)
const DEMO_WALLET = "0:b5ee9c72df09aa0b3858b7a8a7e1ba5ab39db29e38fb6b2c0cf5a3f0e4d7c1a2";
const DEMO_WALLET_FRIENDLY = "EQC17pxy3wmqoLOFi3qKfhulqznnKeTj-2sswyDPWj8OTcGi";
const DEMO_AGENT_WALLET = "0:a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456";
const DEMO_RECIPIENT = "0:deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb";
const DEMO_TX_HASH = "a8f3b2c1d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef";
const DEMO_ADMIN = "0xDemoAdmin1234567890abcdef12345678";

const SEED_PREFIX = "seed-demo-";

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function tonToNano(ton: string): string {
    const [whole = "0", frac = ""] = ton.split(".");
    return (BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0").slice(0, 9))).toString();
}

function ago(hours: number): Timestamp {
    return Timestamp.fromDate(new Date(Date.now() - hours * 3600_000));
}

async function cleanCollection(collectionName: string) {
    const q = query(collection(db, collectionName), where("orgId", "==", ORG_ID));
    const snap = await getDocs(q);
    let count = 0;
    for (const d of snap.docs) {
        await deleteDoc(d.ref);
        count++;
    }
    if (count > 0) console.log(`  cleaned ${count} docs from ${collectionName}`);
}

// ═══════════════════════════════════════════════════════════════
// Seed functions
// ═══════════════════════════════════════════════════════════════

async function seedWallet() {
    const id = `${SEED_PREFIX}wallet-1`;
    await setDoc(doc(db, "tonWallets", id), {
        orgId: ORG_ID,
        address: DEMO_WALLET,
        walletName: "Tonkeeper",
        verified: true,
        publicKey: "b5ee9c72df09aa0b3858b7a8a7e1ba5ab39db29e38fb6b2c0cf5a3f0e4d7c1a2",
        connectedAt: ago(48),
    });
    console.log("  + wallet (verified)");
}

async function seedPolicy() {
    await setDoc(doc(db, "tonPolicies", ORG_ID), {
        orgId: ORG_ID,
        perTxCapNano: tonToNano("10"),       // 10 TON max per tx
        dailyCapNano: tonToNano("50"),       // 50 TON daily
        monthlyCapNano: tonToNano("500"),    // 500 TON monthly
        approvalThresholdNano: tonToNano("3"), // >3 TON needs approval
        allowlist: [],
        paused: false,
        requireApprovalForAll: false,
        notifyTelegramChatId: null,
        createdBy: DEMO_ADMIN,
        createdAt: ago(48),
        updatedAt: ago(48),
    });
    console.log("  + policy (10 TON/tx, 50/day, approval >3 TON)");
}

async function seedFeeConfig() {
    await setDoc(doc(db, "tonFeeConfigs", ORG_ID), {
        orgId: ORG_ID,
        feeBps: 200,                          // 2%
        feeRecipientAddress: DEMO_WALLET,
        minFeeBountyNano: tonToNano("1"),
        enabled: true,
        updatedBy: DEMO_ADMIN,
        updatedAt: ago(48),
    });
    console.log("  + fee config (2%)");
}

async function seedAgentWallet() {
    const id = `${SEED_PREFIX}agent-wallet-1`;
    await setDoc(doc(db, "tonAgentWallets", id), {
        orgId: ORG_ID,
        agentId: "agent-alpha",
        label: "Alpha Agent Wallet",
        address: DEMO_AGENT_WALLET,
        publicKey: "a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456",
        privateKeyMasked: "a1b2…3456",
        encryptedPrivateKey: "DEMO_ENCRYPTED",
        privateKeyIv: "DEMO_IV",
        network: "mainnet",
        status: "active",
        createdBy: DEMO_ADMIN,
        createdAt: ago(24),
    });
    console.log("  + agent wallet (Alpha Agent)");
}

async function seedBounties() {
    // 1. Open bounty — waiting to be claimed (hero path: agent claims this)
    await setDoc(doc(db, "tonBounties", `${SEED_PREFIX}bounty-open`), {
        orgId: ORG_ID,
        title: "Integrate sentiment analysis into trading bot",
        description: "Add real-time sentiment scoring from Telegram channels to the existing trading signal pipeline. Must support at least 3 channels and emit scored events.",
        amountNano: tonToNano("5"),
        token: "TON",
        tokenSymbol: "TON",
        funderAddress: DEMO_WALLET,
        claimerAddress: null,
        claimerAgentId: null,
        status: "open",
        deliveryProof: null,
        releaseTxHash: null,
        feeNano: null,
        netAmountNano: null,
        deadline: Timestamp.fromDate(new Date(Date.now() + 7 * 86400_000)),
        tags: ["ai", "trading", "telegram"],
        postedBy: DEMO_ADMIN,
        createdAt: ago(6),
        claimedAt: null,
        submittedAt: null,
        resolvedAt: null,
    });

    // 2. Claimed bounty — agent working on it
    await setDoc(doc(db, "tonBounties", `${SEED_PREFIX}bounty-claimed`), {
        orgId: ORG_ID,
        title: "Build TON payment notification webhook",
        description: "Create a webhook that fires on every executed payment, posting to a configurable Telegram chat with amount, recipient, and explorer link.",
        amountNano: tonToNano("3"),
        token: "TON",
        tokenSymbol: "TON",
        funderAddress: DEMO_WALLET,
        claimerAddress: DEMO_AGENT_WALLET,
        claimerAgentId: "agent-alpha",
        status: "claimed",
        deliveryProof: null,
        releaseTxHash: null,
        feeNano: null,
        netAmountNano: null,
        deadline: Timestamp.fromDate(new Date(Date.now() + 3 * 86400_000)),
        tags: ["webhook", "notifications"],
        postedBy: DEMO_ADMIN,
        createdAt: ago(24),
        claimedAt: ago(12),
        submittedAt: null,
        resolvedAt: null,
    });

    // 3. Released bounty — completed with on-chain payout
    await setDoc(doc(db, "tonBounties", `${SEED_PREFIX}bounty-released`), {
        orgId: ORG_ID,
        title: "Deploy NFT gate for premium agent access",
        description: "Implement NFT ownership check for gating access to premium agent capabilities. Verified against TON NFT collections.",
        amountNano: tonToNano("8"),
        token: "TON",
        tokenSymbol: "TON",
        funderAddress: DEMO_WALLET,
        claimerAddress: DEMO_AGENT_WALLET,
        claimerAgentId: "agent-alpha",
        status: "released",
        deliveryProof: "https://github.com/swarm/nft-gate-pr-42",
        releaseTxHash: DEMO_TX_HASH,
        feeNano: tonToNano("0.16"),       // 2% of 8 TON
        netAmountNano: tonToNano("7.84"),
        deadline: null,
        tags: ["nft", "access-control"],
        postedBy: DEMO_ADMIN,
        createdAt: ago(72),
        claimedAt: ago(60),
        submittedAt: ago(48),
        resolvedAt: ago(36),
    });

    console.log("  + 3 bounties (open, claimed, released)");
}

async function seedPayments() {
    // 1. Pending approval — waiting for admin
    await setDoc(doc(db, "tonPayments", `${SEED_PREFIX}pay-pending`), {
        orgId: ORG_ID,
        fromAddress: DEMO_WALLET,
        toAddress: DEMO_RECIPIENT,
        amountNano: tonToNano("4.5"),
        memo: "Agent compute credits — March batch",
        status: "pending_approval",
        txHash: null,
        policyResult: "pending_approval",
        approvalId: null,
        approvedBy: null,
        subscriptionId: null,
        idempotencyKey: `${SEED_PREFIX}idem-1`,
        createdBy: DEMO_ADMIN,
        createdAt: ago(2),
        executedAt: null,
    });

    // 2. Ready — approved, waiting for on-chain execution
    await setDoc(doc(db, "tonPayments", `${SEED_PREFIX}pay-ready`), {
        orgId: ORG_ID,
        fromAddress: DEMO_WALLET,
        toAddress: DEMO_AGENT_WALLET,
        amountNano: tonToNano("2"),
        memo: "Agent wallet top-up",
        status: "ready",
        txHash: null,
        policyResult: "allowed",
        approvalId: null,
        approvedBy: DEMO_ADMIN,
        subscriptionId: null,
        idempotencyKey: `${SEED_PREFIX}idem-2`,
        createdBy: DEMO_ADMIN,
        createdAt: ago(4),
        executedAt: null,
    });

    // 3. Executed — completed with on-chain proof
    await setDoc(doc(db, "tonPayments", `${SEED_PREFIX}pay-executed`), {
        orgId: ORG_ID,
        fromAddress: DEMO_WALLET,
        toAddress: DEMO_RECIPIENT,
        amountNano: tonToNano("1.5"),
        memo: "Bounty payout — NFT gate implementation",
        status: "executed",
        txHash: DEMO_TX_HASH,
        policyResult: "allowed",
        approvalId: null,
        approvedBy: null,
        subscriptionId: null,
        idempotencyKey: `${SEED_PREFIX}idem-3`,
        createdBy: DEMO_ADMIN,
        createdAt: ago(36),
        executedAt: ago(35),
    });

    console.log("  + 3 payments (pending_approval, ready, executed)");
}

async function seedSubscription() {
    await setDoc(doc(db, "tonSubscriptions", `${SEED_PREFIX}sub-1`), {
        orgId: ORG_ID,
        fromAddress: DEMO_WALLET,
        toAddress: DEMO_AGENT_WALLET,
        amountNano: tonToNano("0.5"),
        memo: "Weekly agent maintenance stipend",
        frequency: "weekly",
        maxCycles: 12,
        cyclesCompleted: 3,
        status: "active",
        nextPaymentAt: Timestamp.fromDate(new Date(Date.now() + 4 * 86400_000)),
        createdBy: DEMO_ADMIN,
        createdAt: ago(21 * 24),
    });
    console.log("  + 1 subscription (weekly, 3/12 cycles)");
}

async function seedAuditLog() {
    const events = [
        { event: "wallet_connected", note: `Wallet ${DEMO_WALLET.slice(0, 16)}… connected via Tonkeeper`, fromAddress: DEMO_WALLET, hours: 48 },
        { event: "wallet_verified", note: `Wallet verified via ton_proof`, fromAddress: DEMO_WALLET, hours: 48 },
        { event: "policy_updated", note: `Spending policy configured: 10 TON/tx, 50/day, approval >3 TON`, fromAddress: null, hours: 47 },
        { event: "bounty_posted", note: `Bounty posted: "Deploy NFT gate" — 8 TON`, fromAddress: DEMO_WALLET, hours: 72, amountNano: tonToNano("8") },
        { event: "bounty_claimed", note: `Bounty claimed by agent-alpha`, fromAddress: DEMO_AGENT_WALLET, hours: 60 },
        { event: "payment_created", note: `Payment created: 1.5 TON → bounty payout`, fromAddress: DEMO_WALLET, toAddress: DEMO_RECIPIENT, amountNano: tonToNano("1.5"), hours: 36 },
        { event: "payment_executed", note: `Payment executed on-chain`, fromAddress: DEMO_WALLET, toAddress: DEMO_RECIPIENT, amountNano: tonToNano("1.5"), txHash: DEMO_TX_HASH, hours: 35 },
        { event: "bounty_released", note: `Bounty released: 7.84 TON (net) to agent-alpha`, fromAddress: DEMO_WALLET, amountNano: tonToNano("7.84"), txHash: DEMO_TX_HASH, hours: 36 },
        { event: "payment_created", note: `Payment created: 4.5 TON — compute credits (pending approval)`, fromAddress: DEMO_WALLET, toAddress: DEMO_RECIPIENT, amountNano: tonToNano("4.5"), hours: 2 },
        { event: "payment_created", note: `Payment created: 2 TON — agent wallet top-up (auto-approved)`, fromAddress: DEMO_WALLET, toAddress: DEMO_AGENT_WALLET, amountNano: tonToNano("2"), hours: 4 },
    ];

    for (const e of events) {
        await addDoc(collection(db, "tonAudit"), {
            orgId: ORG_ID,
            event: e.event,
            paymentId: null,
            subscriptionId: null,
            fromAddress: e.fromAddress || null,
            toAddress: (e as { toAddress?: string }).toAddress || null,
            amountNano: (e as { amountNano?: string }).amountNano || null,
            txHash: (e as { txHash?: string }).txHash || null,
            policyResult: null,
            reviewedBy: null,
            note: e.note,
            createdAt: ago(e.hours),
        });
    }
    console.log("  + 10 audit entries");
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log(`\nTON Treasury Demo Seed`);
    console.log(`  orgId: ${ORG_ID}`);
    console.log(`  project: ${process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "(not set)"}\n`);

    if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) {
        console.error("ERROR: Firebase env vars not found. Check .env.local");
        process.exit(1);
    }

    if (CLEAN) {
        console.log("Cleaning existing data…");
        for (const col of ["tonWallets", "tonPolicies", "tonFeeConfigs", "tonAgentWallets", "tonBounties", "tonPayments", "tonSubscriptions", "tonAudit"]) {
            await cleanCollection(col);
        }
        console.log("");
    }

    console.log("Seeding…");
    await seedWallet();
    await seedPolicy();
    await seedFeeConfig();
    await seedAgentWallet();
    await seedBounties();
    await seedPayments();
    await seedSubscription();
    await seedAuditLog();

    console.log(`\nDone! Open the TON Treasury mod page for org "${ORG_ID}" to see the data.`);
    console.log(`\nHero path for demo:`);
    console.log(`  1. Connect TON wallet (real TON Connect popup)`);
    console.log(`  2. See verified badge + balance on Overview`);
    console.log(`  3. Payments tab → approve pending 4.5 TON payment`);
    console.log(`  4. Payments tab → "Execute On-chain" the 2 TON ready payment`);
    console.log(`  5. Bounties tab → show open "sentiment analysis" bounty`);
    console.log(`  6. Audit tab → full trail of every action`);
    console.log(`  7. Open /tma?orgId=${ORG_ID} → Telegram Mini App view`);

    process.exit(0);
}

main().catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
});
