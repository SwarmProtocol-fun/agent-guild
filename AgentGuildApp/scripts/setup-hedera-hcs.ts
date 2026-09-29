/**
 * Hedera HCS Setup Script
 *
 * Automated setup for Hedera Consensus Service reputation system.
 *
 * Usage:
 *   npx tsx scripts/setup-hedera-hcs.ts
 *
 * Requirements:
 *   - Hedera testnet account (https://portal.hedera.com)
 *   - Testnet HBAR (free from faucet: https://portal.hedera.com/faucet)
 *   - Environment variables set in .env
 */

import {
    Client,
    TopicCreateTransaction,
    AccountId,
    PrivateKey,
} from "@hashgraph/sdk";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../.env.local") });

// ═══════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════

const REQUIRED_ENV_VARS = [
    "HEDERA_OPERATOR_ID",
    "HEDERA_OPERATOR_KEY",
    "HEDERA_PLATFORM_KEY",
];

const TESTNET_RPC = "https://testnet.hashio.io/api";
const MIRROR_NODE = "https://testnet.mirrornode.hedera.com";

// ═══════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════

function validateEnvironment(): void {
    console.log("🔍 Validating environment...\n");

    const missing: string[] = [];

    for (const varName of REQUIRED_ENV_VARS) {
        if (!process.env[varName]) {
            missing.push(varName);
        }
    }

    if (missing.length > 0) {
        console.error("❌ Missing required environment variables:\n");
        missing.forEach(v => console.error(`   - ${v}`));
        console.error("\n📝 Please add these to your .env.local file\n");
        console.error("Example:");
        console.error("  HEDERA_OPERATOR_ID=0.0.YOUR_ACCOUNT_ID");
        console.error("  HEDERA_OPERATOR_KEY=302e020100300506032b657004220420...");
        console.error("  HEDERA_PLATFORM_KEY=0xYOUR_PRIVATE_KEY");
        console.error("\n💡 Get testnet account: https://portal.hedera.com");
        console.error("💡 Get testnet HBAR: https://portal.hedera.com/faucet\n");
        process.exit(1);
    }

    console.log("✅ All required environment variables found\n");
}

// ═══════════════════════════════════════════════════════════════
// HCS Topic Creation
// ═══════════════════════════════════════════════════════════════

async function createHCSTopic(): Promise<string> {
    console.log("🚀 Creating HCS reputation topic...\n");

    const operatorId = process.env.HEDERA_OPERATOR_ID!;
    const operatorKey = process.env.HEDERA_OPERATOR_KEY!;

    const client = Client.forTestnet();
    client.setOperator(
        AccountId.fromString(operatorId),
        PrivateKey.fromString(operatorKey),
    );

    console.log(`   Operator: ${operatorId}`);
    console.log(`   Network: Hedera Testnet`);
    console.log(`   Creating topic...\n`);

    const transaction = new TopicCreateTransaction()
        .setTopicMemo("Swarm Agent Reputation Events (Private)")
        .setMaxTransactionFee(2); // 2 HBAR max

    const txResponse = await transaction.execute(client);
    const receipt = await txResponse.getReceipt(client);
    const topicId = receipt.topicId;

    if (!topicId) {
        throw new Error("Failed to create HCS topic");
    }

    console.log("✅ HCS Topic Created!\n");
    console.log(`   Topic ID: ${topicId.toString()}`);
    console.log(`   Transaction: ${txResponse.transactionId.toString()}`);
    console.log(`   Mirror Node: ${MIRROR_NODE}/api/v1/topics/${topicId.toString()}/messages\n`);

    return topicId.toString();
}

// ═══════════════════════════════════════════════════════════════
// Environment File Update
// ═══════════════════════════════════════════════════════════════

function updateEnvFile(topicId: string): void {
    console.log("📝 Updating .env.local...\n");

    const envPath = path.join(__dirname, "../.env.local");
    let envContent = "";

    // Read existing .env.local
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, "utf8");
    }

    // Check if HEDERA_REPUTATION_TOPIC_ID already exists
    if (envContent.includes("HEDERA_REPUTATION_TOPIC_ID=")) {
        // Replace existing value
        envContent = envContent.replace(
            /HEDERA_REPUTATION_TOPIC_ID=.*/,
            `HEDERA_REPUTATION_TOPIC_ID=${topicId}`,
        );
    } else {
        // Add new line
        envContent += `\n# Hedera HCS Reputation Topic\nHEDERA_REPUTATION_TOPIC_ID=${topicId}\n`;
    }

    fs.writeFileSync(envPath, envContent);

    console.log("✅ Environment updated\n");
    console.log(`   HEDERA_REPUTATION_TOPIC_ID=${topicId}\n`);
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

function printSummary(topicId: string): void {
    console.log("═══════════════════════════════════════════════════════════\n");
    console.log("🎉 HEDERA HCS SETUP COMPLETE!\n");
    console.log("═══════════════════════════════════════════════════════════\n");

    console.log("📊 Topic Information:");
    console.log(`   Topic ID: ${topicId}`);
    console.log(`   Network: Hedera Mainnet`);
    console.log(`   Mirror Node: ${MIRROR_NODE}`);
    console.log(`   RPC: ${TESTNET_RPC}\n`);

    console.log("🔐 Privacy:");
    console.log("   ✅ Events encrypted by default (private mode)");
    console.log("   ✅ Only org members can decrypt");
    console.log("   ✅ Public opt-in available\n");

    console.log("🚀 Next Steps:\n");
    console.log("1. Restart your development server:");
    console.log("   npm run dev\n");

    console.log("2. Start the Mirror Node subscriber:");
    console.log("   curl -X POST http://localhost:3000/api/v1/hcs/start-subscriber \\\n");
    console.log("     -H \"Authorization: Bearer YOUR_SESSION\"\n");

    console.log("3. Start the checkpoint service:");
    console.log("   curl -X POST http://localhost:3000/api/v1/hcs/start-checkpoint \\\n");
    console.log("     -H \"Authorization: Bearer YOUR_SESSION\"\n");

    console.log("4. Start the auto-slashing service:");
    console.log("   curl -X POST http://localhost:3000/api/v1/slashing/start-service \\\n");
    console.log("     -H \"Authorization: Bearer YOUR_SESSION\"\n");

    console.log("5. Test the system:");
    console.log("   - Register an agent with skills → See +2 credit event");
    console.log("   - Complete a task → See +10 credit event");
    console.log("   - View analytics at /analytics/reputation\n");

    console.log("📚 Documentation:");
    console.log("   - HCS Setup: SwarmApp/HCS_SETUP.md");
    console.log("   - Privacy: SwarmApp/PRIVACY_ARCHITECTURE.md");
    console.log("   - Features: SwarmApp/FUTURE_ENHANCEMENTS_COMPLETE.md\n");

    console.log("═══════════════════════════════════════════════════════════\n");
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
    console.log("\n");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("        HEDERA HCS REPUTATION SYSTEM SETUP");
    console.log("═══════════════════════════════════════════════════════════\n");

    try {
        // Step 1: Validate environment
        validateEnvironment();

        // Step 2: Create HCS topic
        const topicId = await createHCSTopic();

        // Step 3: Update .env.local
        updateEnvFile(topicId);

        // Step 4: Print summary
        printSummary(topicId);

        process.exit(0);
    } catch (error) {
        console.error("\n❌ Setup failed:\n");
        console.error(error);
        console.error("\n");
        process.exit(1);
    }
}

main();
