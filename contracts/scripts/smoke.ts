/**
 * Post-Deploy Smoke Script — PRD 4
 *
 * Validates deployed contracts are reachable and have the expected
 * public interface before marking a deployment as green.
 *
 * Usage:
 *   npx hardhat run scripts/smoke.ts --network sepolia
 *   npx hardhat run scripts/smoke.ts --network hederaTestnet
 *   npx hardhat run scripts/smoke.ts --network hyperliquidTestnet
 *
 * Reads addresses from the *-deployed-addresses.json file matching the
 * network passed via --network (deploy.ts / deploy-hedera.ts /
 * deploy-hyperliquid.ts all write the same `{ contracts: {...} }` shape).
 * Exits 0 on success, 1 on any failure.
 */

import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface DeployedAddresses {
  network: string;
  deployedAt: string;
  contracts: {
    asnRegistry?: string;
    agentRegistry?: string;
    taskBoard?: string;
    treasury?: string;
    agentIdentityNFT?: string;
  };
}

/** Maps a hardhat --network name to the addresses file its deploy script writes. */
const ADDRESS_FILE_BY_NETWORK: Record<string, string> = {
  sepolia: "deployed-addresses.json",
  hederaTestnet: "hedera-deployed-addresses.json",
  hyperliquidTestnet: "hyperliquid-deployed-addresses.json",
};

const PASS = "✓";
const FAIL = "✗";
let failures = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
  } else {
    console.error(`  ${FAIL} ${label}${detail ? ": " + detail : ""}`);
    failures++;
  }
}

async function main() {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  Swarm Contract Post-Deploy Smoke Check");
  console.log("═══════════════════════════════════════════════\n");

  // Load deployed addresses for the network this was invoked with
  const addressFileName = ADDRESS_FILE_BY_NETWORK[network.name];
  if (!addressFileName) {
    console.error(`${FAIL} No known deployed-addresses file for network "${network.name}"`);
    process.exit(1);
  }
  const addressFile = path.resolve(__dirname, "..", addressFileName);
  if (!fs.existsSync(addressFile)) {
    console.error(`${FAIL} ${addressFileName} not found — run the matching deploy script first`);
    process.exit(1);
  }

  const addresses: DeployedAddresses = JSON.parse(fs.readFileSync(addressFile, "utf-8"));
  console.log(`Network: ${addresses.network}`);
  console.log(`Deployed at: ${addresses.deployedAt}\n`);

  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  const chainId = (await provider.getNetwork()).chainId;

  console.log(`Signer: ${signer.address}`);
  console.log(`Chain ID: ${chainId}`);
  console.log();

  const { asnRegistry, agentRegistry, taskBoard, treasury, agentIdentityNFT } = addresses.contracts;

  // ── 1. Code exists at each deployed address ───────────────────────────────

  console.log("1. Bytecode presence");

  for (const [name, addr] of Object.entries(addresses.contracts)) {
    if (!addr) continue;
    const code = await provider.getCode(addr);
    check(`${name} has bytecode at ${addr}`, code !== "0x" && code.length > 2);
  }

  // ── 2. SwarmASNRegistry ────────────────────────────────────────────────────

  if (asnRegistry) {
    console.log("\n2. SwarmASNRegistry");
    try {
      const asn = await ethers.getContractAt("SwarmASNRegistry", asnRegistry);
      const owner = await asn.owner();
      check("owner() returns an address", ethers.isAddress(owner));
      check("owner is non-zero", owner !== ethers.ZeroAddress);

      const count = await asn.totalRecords();
      check(`totalRecords() returns a number (${count})`, typeof count === "bigint");
    } catch (err: any) {
      check("SwarmASNRegistry read calls", false, err.message);
    }
  }

  // ── 3. SwarmAgentRegistryLink ──────────────────────────────────────────────

  if (agentRegistry) {
    console.log("\n3. SwarmAgentRegistryLink");
    try {
      const registry = await ethers.getContractAt("SwarmAgentRegistryLink", agentRegistry);
      const owner = await registry.owner();
      check("owner() returns an address", ethers.isAddress(owner));
      check("owner is non-zero", owner !== ethers.ZeroAddress);

      const count = await registry.agentCount();
      check(`agentCount() returns a number (${count})`, typeof count === "bigint");

      // isRegistered for a random address should return false without reverting
      const result = await registry.isRegistered(ethers.ZeroAddress);
      check("isRegistered(zero) returns false", result === false);
    } catch (err: any) {
      check("SwarmAgentRegistryLink read calls", false, err.message);
    }
  }

  // ── 4. SwarmTaskBoardLink ──────────────────────────────────────────────────

  if (taskBoard) {
    console.log("\n4. SwarmTaskBoardLink");
    try {
      const board = await ethers.getContractAt("SwarmTaskBoardLink", taskBoard);
      const linkAddr = await board.linkToken();
      check("linkToken() returns an address", ethers.isAddress(linkAddr));
      check("linkToken is non-zero", linkAddr !== ethers.ZeroAddress);

      const taskCount = await board.taskCount();
      check(`taskCount() returns a number (${taskCount})`, typeof taskCount === "bigint");

      const openTasks = await board.getOpenTasks();
      check(`getOpenTasks() returns an array (${openTasks.length} open)`, Array.isArray(openTasks));
    } catch (err: any) {
      check("SwarmTaskBoardLink read calls", false, err.message);
    }
  }

  // ── 5. SwarmTreasuryLink ───────────────────────────────────────────────────

  if (treasury) {
    console.log("\n5. SwarmTreasuryLink");
    try {
      const treasuryContract = await ethers.getContractAt("SwarmTreasuryLink", treasury);
      const owner = await treasuryContract.owner();
      check("owner() returns an address", ethers.isAddress(owner));
      check("owner is non-zero", owner !== ethers.ZeroAddress);
    } catch (err: any) {
      check("SwarmTreasuryLink read calls", false, err.message);
    }
  }

  // ── 6. SwarmAgentIdentityNFT ───────────────────────────────────────────────

  if (agentIdentityNFT) {
    console.log("\n6. SwarmAgentIdentityNFT");
    try {
      const nft = await ethers.getContractAt("SwarmAgentIdentityNFT", agentIdentityNFT);
      const owner = await nft.owner();
      check("owner() returns an address", ethers.isAddress(owner));
      check("owner is non-zero", owner !== ethers.ZeroAddress);

      const hasNFT = await nft.hasNFT(ethers.ZeroAddress);
      check("hasNFT(zero) returns false", hasNFT === false);
    } catch (err: any) {
      check("SwarmAgentIdentityNFT read calls", false, err.message);
    }
  }

  // ── 7. Cross-contract consistency ─────────────────────────────────────────

  if (agentRegistry && taskBoard) {
    console.log("\n7. Cross-contract consistency");
    try {
      const registry = await ethers.getContractAt("SwarmAgentRegistryLink", agentRegistry);
      const board = await ethers.getContractAt("SwarmTaskBoardLink", taskBoard);

      const registryOwner = await registry.owner();
      const boardOwner = await board.owner();
      check(
        "AgentRegistry and TaskBoard share the same owner",
        registryOwner.toLowerCase() === boardOwner.toLowerCase(),
        `registry=${registryOwner}, board=${boardOwner}`
      );
    } catch (err: any) {
      check("Cross-contract owner check", false, err.message);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════");
  if (failures === 0) {
    console.log(`  ✓ All smoke checks passed — deployment is green`);
    console.log("═══════════════════════════════════════════════\n");
  } else {
    console.error(`  ✗ ${failures} smoke check(s) FAILED — do not proceed`);
    console.log("═══════════════════════════════════════════════\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke script crashed:", err);
  process.exit(1);
});
