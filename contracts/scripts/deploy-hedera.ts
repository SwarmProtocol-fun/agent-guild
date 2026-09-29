import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploy Agent Guild contracts to Hedera Testnet
 *
 * Hedera Testnet:
 * - Chain ID: 296
 * - RPC: https://testnet.hashio.io/api
 * - Block Explorer: https://hashscan.io/testnet
 *
 * Run: npx hardhat run scripts/deploy-hedera.ts --network hederaTestnet
 */

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("=".repeat(60));
  console.log("🚀 Deploying Agent Guild to Hedera Testnet");
  console.log("=".repeat(60));
  console.log("Deployer:   ", deployer.address);
  console.log("Chain ID:   ", network.chainId.toString());
  console.log("Network:    ", network.name);
  console.log("Balance:    ", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "HBAR");
  console.log("-".repeat(60));

  // Hedera-specific gas overrides (EIP-1559)
  // Hedera testnet requires minimum 960 Gwei
  const gasOverrides = {
    maxFeePerGas: ethers.parseUnits("1000", "gwei"), // Above 960 Gwei minimum
    maxPriorityFeePerGas: ethers.parseUnits("10", "gwei"),
    gasLimit: 15_000_000,
  };

  // 0. Deploy MockLINK token (for demo/testing on Hedera)
  console.log("\n[0/5] Deploying MockLINK token...");
  const MockLINK = await ethers.getContractFactory("MockLINK");
  const mockLink = await MockLINK.deploy(gasOverrides);
  await mockLink.waitForDeployment();
  const linkAddr = await mockLink.getAddress();
  console.log("✅ MockLINK deployed to:", linkAddr);

  // 1. AgentGuildASNRegistry
  console.log("\n[1/5] Deploying AgentGuildASNRegistry...");
  const ASNRegistry = await ethers.getContractFactory("AgentGuildASNRegistry");
  const asnRegistry = await ASNRegistry.deploy(gasOverrides);
  await asnRegistry.waitForDeployment();
  const asnAddr = await asnRegistry.getAddress();
  console.log("✅ AgentGuildASNRegistry deployed to:", asnAddr);

  // 2. AgentGuildAgentRegistryLink (includes credit & trust scores)
  console.log("\n[2/5] Deploying AgentGuildAgentRegistryLink...");
  const AgentRegistry = await ethers.getContractFactory("AgentGuildAgentRegistryLink");
  const agentRegistry = await AgentRegistry.deploy(gasOverrides);
  await agentRegistry.waitForDeployment();
  const agentAddr = await agentRegistry.getAddress();
  console.log("✅ AgentGuildAgentRegistryLink deployed to:", agentAddr);

  // 3. AgentGuildTaskBoardLink
  console.log("\n[3/5] Deploying AgentGuildTaskBoardLink...");
  const TaskBoard = await ethers.getContractFactory("AgentGuildTaskBoardLink");
  const taskBoard = await TaskBoard.deploy(linkAddr, gasOverrides);
  await taskBoard.waitForDeployment();
  const taskAddr = await taskBoard.getAddress();
  console.log("✅ AgentGuildTaskBoardLink deployed to:", taskAddr);

  // 4. AgentGuildTreasuryLink
  console.log("\n[4/5] Deploying AgentGuildTreasuryLink...");
  const Treasury = await ethers.getContractFactory("AgentGuildTreasuryLink");
  const treasury = await Treasury.deploy(linkAddr, gasOverrides);
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log("✅ AgentGuildTreasuryLink deployed to:", treasuryAddr);

  // 5. AgentGuildAgentIdentityNFT (Dynamic NFT for agent reputation)
  console.log("\n[5/5] Deploying AgentGuildAgentIdentityNFT...");
  const metadataBaseURI = "https://agent-guild.com/api/nft/agent";
  const AgentNFT = await ethers.getContractFactory("AgentGuildAgentIdentityNFT");
  const agentNFT = await AgentNFT.deploy(metadataBaseURI, gasOverrides);
  await agentNFT.waitForDeployment();
  const agentNFTAddr = await agentNFT.getAddress();
  console.log("✅ AgentGuildAgentIdentityNFT deployed to:", agentNFTAddr);

  // ── Output Summary ──
  console.log("\n" + "=".repeat(60));
  console.log("📋 HEDERA TESTNET DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log("Network:            Hedera Testnet (Chain ID: 296)");
  console.log("Deployer:          ", deployer.address);
  console.log("MockLINK Token:    ", linkAddr);
  console.log("-".repeat(60));
  console.log("ASN Registry:      ", asnAddr);
  console.log("Agent Registry:    ", agentAddr);
  console.log("Task Board:        ", taskAddr);
  console.log("Treasury:          ", treasuryAddr);
  console.log("Agent Identity NFT:", agentNFTAddr);
  console.log("=".repeat(60));

  // ── Write hedera-deployed-addresses.json ──
  const addresses = {
    network: "hedera-testnet",
    chainId: 296,
    linkToken: linkAddr,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
    rpcUrl: "https://testnet.hashio.io/api",
    explorer: "https://hashscan.io/testnet",
    contracts: {
      mockLink: linkAddr,
      asnRegistry: asnAddr,
      agentRegistry: agentAddr,
      taskBoard: taskAddr,
      treasury: treasuryAddr,
      agentIdentityNFT: agentNFTAddr,
    },
  };

  const jsonPath = path.join(__dirname, "..", "hedera-deployed-addresses.json");
  fs.writeFileSync(jsonPath, JSON.stringify(addresses, null, 2));
  console.log("\n✅ Saved to:", jsonPath);

  // ── Output .env snippet ──
  const envSnippet = [
    "",
    "# ── Agent Guild Hedera Contracts (Testnet) ── deployed " + new Date().toISOString(),
    `NEXT_PUBLIC_HEDERA_MOCK_LINK=${linkAddr}`,
    `NEXT_PUBLIC_HEDERA_AGENT_REGISTRY=${agentAddr}`,
    `NEXT_PUBLIC_HEDERA_TASK_BOARD=${taskAddr}`,
    `NEXT_PUBLIC_HEDERA_ASN_REGISTRY=${asnAddr}`,
    `NEXT_PUBLIC_HEDERA_TREASURY=${treasuryAddr}`,
    `NEXT_PUBLIC_HEDERA_AGENT_NFT=${agentNFTAddr}`,
    `NEXT_PUBLIC_HEDERA_CHAIN_ID=296`,
    `NEXT_PUBLIC_HEDERA_RPC_URL=https://testnet.hashio.io/api`,
    `HEDERA_PLATFORM_KEY=${process.env.DEPLOYER_PRIVATE_KEY || "# same key used for deployment"}`,
    "",
  ].join("\n");

  console.log("\n" + "=".repeat(60));
  console.log("📝 ADD TO AgentGuildApp/.env.local");
  console.log("=".repeat(60));
  console.log(envSnippet);
  console.log("=".repeat(60));

  // Auto-append to .env.local if it exists
  const envLocalPath = path.join(__dirname, "..", "..", "AgentGuildApp", ".env.local");
  if (fs.existsSync(envLocalPath)) {
    const existing = fs.readFileSync(envLocalPath, "utf-8");
    // Remove old Hedera contract vars if present
    const cleaned = existing
      .split("\n")
      .filter(line =>
        !line.startsWith("NEXT_PUBLIC_HEDERA_") &&
        !line.startsWith("HEDERA_PLATFORM_KEY=")
      )
      .join("\n");
    fs.writeFileSync(envLocalPath, cleaned.trimEnd() + "\n" + envSnippet);
    console.log("\n✅ Auto-appended to", envLocalPath);
  } else {
    console.log("\n⚠️  Create AgentGuildApp/.env.local and paste the snippet above");
  }

  console.log("\n" + "=".repeat(60));
  console.log("🎯 NEXT STEPS:");
  console.log("=".repeat(60));
  console.log("1. Verify contracts on HashScan:");
  console.log(`   https://hashscan.io/testnet/contract/${agentAddr}`);
  console.log(`   https://hashscan.io/testnet/contract/${agentNFTAddr}`);
  console.log("2. Test agent registration → NFT auto-mints with ASN");
  console.log("3. View NFT in Hedera wallet with live credit score!");
  console.log("4. Demo: Task completion → credit score updates → NFT metadata refreshes");
  console.log("5. KILLER FEATURE: Portable, verifiable, tradable agent reputation!");
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("\n❌ Deployment failed:", error);
  process.exitCode = 1;
});
