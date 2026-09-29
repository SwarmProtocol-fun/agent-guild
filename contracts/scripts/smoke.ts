/**
 * Post-Deploy Smoke Script — PRD 4
 *
 * Validates deployed contracts are reachable and have the expected
 * public interface before marking a deployment as green.
 *
 * Usage:
 *   npx hardhat run scripts/smoke.ts --network sepolia
 *
 * Reads addresses from deployed-addresses.json (written by deploy.ts).
 * Exits 0 on success, 1 on any failure.
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface DeployedAddresses {
  AgentGuildASNRegistry: string;
  AgentGuildAgentRegistryLink: string;
  AgentGuildTaskBoardLink: string;
  AgentGuildTreasuryLink: string;
  network: string;
  deployedAt: string;
}

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
  console.log("  Agent Guild Contract Post-Deploy Smoke Check");
  console.log("═══════════════════════════════════════════════\n");

  // Load deployed addresses
  const addressFile = path.resolve(__dirname, "../deployed-addresses.json");
  if (!fs.existsSync(addressFile)) {
    console.error(`${FAIL} deployed-addresses.json not found — run deploy first`);
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

  // ── 1. Code exists at each address ────────────────────────────────────────

  console.log("1. Bytecode presence");

  for (const [name, addr] of Object.entries(addresses)) {
    if (name === "network" || name === "deployedAt") continue;
    const code = await provider.getCode(addr as string);
    check(`${name} has bytecode at ${addr}`, code !== "0x" && code.length > 2);
  }

  // ── 2. AgentGuildASNRegistry ────────────────────────────────────────────────────

  console.log("\n2. AgentGuildASNRegistry");

  try {
    const asn = await ethers.getContractAt("AgentGuildASNRegistry", addresses.AgentGuildASNRegistry);
    const owner = await asn.owner();
    check("owner() returns an address", ethers.isAddress(owner));
    check("owner is non-zero", owner !== ethers.ZeroAddress);

    const count = await asn.asnCount();
    check(`asnCount() returns a number (${count})`, typeof count === "bigint");
  } catch (err: any) {
    check("AgentGuildASNRegistry read calls", false, err.message);
  }

  // ── 3. AgentGuildAgentRegistryLink ──────────────────────────────────────────────

  console.log("\n3. AgentGuildAgentRegistryLink");

  try {
    const registry = await ethers.getContractAt("AgentGuildAgentRegistryLink", addresses.AgentGuildAgentRegistryLink);
    const owner = await registry.owner();
    check("owner() returns an address", ethers.isAddress(owner));
    check("owner is non-zero", owner !== ethers.ZeroAddress);

    const count = await registry.agentCount();
    check(`agentCount() returns a number (${count})`, typeof count === "bigint");

    // isRegistered for a random address should return false without reverting
    const result = await registry.isRegistered(ethers.ZeroAddress);
    check("isRegistered(zero) returns false", result === false);
  } catch (err: any) {
    check("AgentGuildAgentRegistryLink read calls", false, err.message);
  }

  // ── 4. AgentGuildTaskBoardLink ──────────────────────────────────────────────────

  console.log("\n4. AgentGuildTaskBoardLink");

  try {
    const board = await ethers.getContractAt("AgentGuildTaskBoardLink", addresses.AgentGuildTaskBoardLink);
    const linkAddr = await board.linkToken();
    check("linkToken() returns an address", ethers.isAddress(linkAddr));
    check("linkToken is non-zero", linkAddr !== ethers.ZeroAddress);

    const taskCount = await board.taskCount();
    check(`taskCount() returns a number (${taskCount})`, typeof taskCount === "bigint");

    const openTasks = await board.getOpenTasks();
    check(`getOpenTasks() returns an array (${openTasks.length} open)`, Array.isArray(openTasks));
  } catch (err: any) {
    check("AgentGuildTaskBoardLink read calls", false, err.message);
  }

  // ── 5. AgentGuildTreasuryLink ───────────────────────────────────────────────────

  console.log("\n5. AgentGuildTreasuryLink");

  try {
    const treasury = await ethers.getContractAt("AgentGuildTreasuryLink", addresses.AgentGuildTreasuryLink);
    const owner = await treasury.owner();
    check("owner() returns an address", ethers.isAddress(owner));
    check("owner is non-zero", owner !== ethers.ZeroAddress);
  } catch (err: any) {
    check("AgentGuildTreasuryLink read calls", false, err.message);
  }

  // ── 6. Cross-contract consistency ─────────────────────────────────────────

  console.log("\n6. Cross-contract consistency");

  try {
    const registry = await ethers.getContractAt("AgentGuildAgentRegistryLink", addresses.AgentGuildAgentRegistryLink);
    const board = await ethers.getContractAt("AgentGuildTaskBoardLink", addresses.AgentGuildTaskBoardLink);

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
