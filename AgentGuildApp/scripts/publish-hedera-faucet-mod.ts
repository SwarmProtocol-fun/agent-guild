/**
 * Publish Hedera Testnet Faucet Mod to Marketplace
 *
 * Publishes the Hedera testnet faucet as a free mod in the Swarm marketplace.
 * Uses platform admin secret for auto-approval.
 */

const PLATFORM_ADMIN_SECRET = process.env.PLATFORM_ADMIN_SECRET || "dev-admin-secret";
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

interface PublishResponse {
  published: boolean;
  id: string;
  type: string;
  status: string;
  stage: string;
  name: string;
}

async function publishHederaFaucetMod() {
  console.log("🚀 Publishing Hedera Testnet Faucet Mod...\n");

  const modData = {
    // Required fields
    name: "Hedera Testnet Faucet",
    type: "mod",
    category: "developer-tools",
    icon: "💧",
    description:
      "Get free testnet HBAR instantly. Request up to 100 testnet HBAR every 24 hours for testing and development on Hedera testnet.",
    version: "1.0.0",

    // Optional fields
    longDescription: `
# Hedera Testnet Faucet

The easiest way to get free testnet HBAR for your Swarm agents and development.

## Features

✅ **100 HBAR per request** — Enough for extensive testing
✅ **Instant delivery** — Receive testnet HBAR in seconds
✅ **24h cooldown** — Fair distribution for all users
✅ **Rate-limited** — Prevents abuse and ensures availability
✅ **Transaction tracking** — View your faucet requests on HashScan

## How It Works

1. **Connect your wallet** — Authenticate with your Ethereum wallet
2. **Enter Hedera account ID** — Provide your testnet account (format: 0.0.xxxx)
3. **Request HBAR** — Get 100 testnet HBAR instantly
4. **Start building** — Use testnet HBAR for agent operations, HCS messages, and smart contract interactions

## Rate Limits

- **Per wallet**: 1 request every 24 hours
- **Amount**: 100 HBAR per request
- **Network**: Hedera Testnet only

## Use Cases

- **Agent registration** — Create new Hedera accounts for your AI agents
- **HCS reputation logging** — Submit agent events to Hedera Consensus Service
- **Smart contract testing** — Deploy and test Swarm contracts on testnet
- **Payment simulation** — Test HBAR micro-payments in your agent workflows
- **NFT minting** — Mint agent identity NFTs on testnet

## Alternative Faucets

If you need more testnet HBAR, visit the [official Hedera faucet](https://portal.hedera.com/faucet) for up to 10,000 testnet HBAR.

## Hackathon-Friendly

This faucet makes it easy for Hedera hackathon judges to test Swarm without needing to find external faucets or wait for manual HBAR distribution.
    `.trim(),

    tags: [
      "hedera",
      "testnet",
      "faucet",
      "hbar",
      "developer-tools",
      "testing",
      "hackathon",
    ],

    pricing: {
      model: "free",
    },

    modManifest: {
      tools: ["hedera-transfer"],
      workflows: ["faucet-request"],
    },

    permissionsRequired: ["external_api", "wallet_access"],

    publisherName: "Swarm Protocol",
    submissionType: "build",
    submissionTrack: "prd_only",

    demoUrl: "/mods/hedera-faucet",
    screenshotUrls: [],
  };

  try {
    const response = await fetch(`${API_BASE}/api/v1/marketplace/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PLATFORM_ADMIN_SECRET}`,
      },
      body: JSON.stringify(modData),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(
        `Failed to publish: ${error.error || response.statusText}`
      );
    }

    const result: PublishResponse = await response.json();

    console.log("✅ Successfully published Hedera Faucet mod!\n");
    console.log(`   ID: ${result.id}`);
    console.log(`   Type: ${result.type}`);
    console.log(`   Status: ${result.status}`);
    console.log(`   Stage: ${result.stage}`);
    console.log(`   Name: ${result.name}`);
    console.log(`\n🌐 Access at: ${API_BASE}/mods/hedera-faucet`);
    console.log(`📦 View in marketplace: ${API_BASE}/market`);

    return result;
  } catch (err) {
    console.error("❌ Failed to publish Hedera Faucet mod:");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  publishHederaFaucetMod();
}

export { publishHederaFaucetMod };
