import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy the Agent Social Number identity contracts to HyperEVM Testnet.
 *
 * HyperEVM Testnet (best-known at time of writing — confirm against
 * Hyperliquid's current docs before deploying):
 * - Chain ID: 998
 * - RPC: https://rpc.hyperliquid-testnet.xyz/evm
 * - Block Explorer: https://testnet.purrsec.com
 *
 * Run: npx hardhat run scripts/deploy-hyperliquid.ts --network hyperliquidTestnet
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("=".repeat(60));
  console.log("🚀 Deploying Swarm ASN identity contracts to HyperEVM Testnet");
  console.log("=".repeat(60));
  console.log("Deployer:   ", deployer.address);
  console.log("Chain ID:   ", network.chainId.toString());
  console.log("Balance:    ", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "HYPE");
  console.log("-".repeat(60));

  // 1. SwarmASNRegistry
  console.log("\n[1/2] Deploying SwarmASNRegistry...");
  const ASNRegistry = await ethers.getContractFactory("SwarmASNRegistry");
  const asnRegistry = await ASNRegistry.deploy();
  await asnRegistry.waitForDeployment();
  const asnAddr = await asnRegistry.getAddress();
  console.log("✅ SwarmASNRegistry deployed to:", asnAddr);

  // 2. SwarmAgentIdentityNFT (soulbound identity NFT minted at agent "birth")
  console.log("\n[2/2] Deploying SwarmAgentIdentityNFT...");
  const metadataBaseURI = "https://swarmprotocol.fun/api/nft/agent";
  const AgentNFT = await ethers.getContractFactory("SwarmAgentIdentityNFT");
  const agentNFT = await AgentNFT.deploy(metadataBaseURI);
  await agentNFT.waitForDeployment();
  const agentNFTAddr = await agentNFT.getAddress();
  console.log("✅ SwarmAgentIdentityNFT deployed to:", agentNFTAddr);

  // ── Output Summary ──
  console.log("\n" + "=".repeat(60));
  console.log("📋 HYPEREVM TESTNET DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log("Network:            HyperEVM Testnet (Chain ID: 998)");
  console.log("Deployer:          ", deployer.address);
  console.log("ASN Registry:      ", asnAddr);
  console.log("Agent Identity NFT:", agentNFTAddr);
  console.log("=".repeat(60));

  // ── Write hyperliquid-deployed-addresses.json ──
  const addresses = {
    network: "hyperliquid-testnet",
    chainId: 998,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    rpcUrl: "https://rpc.hyperliquid-testnet.xyz/evm",
    explorer: "https://testnet.purrsec.com",
    contracts: {
      asnRegistry: asnAddr,
      agentIdentityNFT: agentNFTAddr,
    },
  };

  const jsonPath = path.join(__dirname, "..", "hyperliquid-deployed-addresses.json");
  fs.writeFileSync(jsonPath, JSON.stringify(addresses, null, 2));
  console.log("\n✅ Saved to:", jsonPath);

  // ── Output .env snippet ──
  const envSnippet = [
    "",
    "# ── Swarm HyperEVM Contracts (Testnet) ── deployed " + new Date().toISOString(),
    `HYPERLIQUID_AGENT_IDENTITY_NFT=${agentNFTAddr}`,
    `HYPERLIQUID_RPC_URL=https://rpc.hyperliquid-testnet.xyz/evm`,
    `PLATFORM_SETTLEMENT_KEY=${process.env.DEPLOYER_PRIVATE_KEY || "# same key used for deployment"}`,
    "",
  ].join("\n");

  console.log("\n" + "=".repeat(60));
  console.log("📝 ADD TO SwarmApp/.env.local");
  console.log("=".repeat(60));
  console.log(envSnippet);
  console.log("=".repeat(60));

  const envLocalPath = path.join(__dirname, "..", "..", "SwarmApp", ".env.local");
  if (fs.existsSync(envLocalPath)) {
    const existing = fs.readFileSync(envLocalPath, "utf-8");
    const cleaned = existing
      .split("\n")
      .filter((line) => !line.startsWith("HYPERLIQUID_AGENT_IDENTITY_NFT="))
      .join("\n");
    fs.writeFileSync(envLocalPath, cleaned.trimEnd() + "\n" + envSnippet);
    console.log("\n✅ Auto-appended to", envLocalPath);
  } else {
    console.log("\n⚠️  Create SwarmApp/.env.local and paste the snippet above");
  }
}

main().catch((error) => {
  console.error("\n❌ Deployment failed:", error);
  process.exitCode = 1;
});
