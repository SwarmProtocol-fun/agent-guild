import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { SwarmASNRegistry } from "../typechain-types";

const ASN_A = "ASN-SWM-2026-AAAA-1111-XY";
const ASN_B = "ASN-SWM-2026-BBBB-2222-ZW";

async function deployFixture() {
  const [owner, agent, otherAgent] = await ethers.getSigners();

  const Factory = await ethers.getContractFactory("SwarmASNRegistry");
  const registry = (await Factory.deploy()) as unknown as SwarmASNRegistry;
  await registry.waitForDeployment();

  return { owner, agent, otherAgent, registry };
}

describe("SwarmASNRegistry", function () {
  describe("registerASN", function () {
    it("registers the caller with default credit/trust scores", async function () {
      const { agent, registry } = await loadFixture(deployFixture);

      await expect(registry.connect(agent).registerASN(ASN_A, "Scout", "trading"))
        .to.emit(registry, "ASNRegistered")
        .withArgs(ASN_A, agent.address, "Scout", anyValue);

      const record = await registry.getRecord(ASN_A);
      expect(record.owner).to.equal(agent.address);
      expect(record.creditScore).to.equal(680);
      expect(record.trustScore).to.equal(50);
      expect(record.active).to.equal(true);
      expect(await registry.ownerToASN(agent.address)).to.equal(ASN_A);
      expect(await registry.totalRecords()).to.equal(1n);
    });

    it("rejects a duplicate ASN", async function () {
      const { agent, otherAgent, registry } = await loadFixture(deployFixture);
      await registry.connect(agent).registerASN(ASN_A, "Scout", "trading");

      await expect(
        registry.connect(otherAgent).registerASN(ASN_A, "Impostor", "trading"),
      ).to.be.revertedWith("ASN already registered");
    });

    it("rejects a second ASN for an address that already has one", async function () {
      const { agent, registry } = await loadFixture(deployFixture);
      await registry.connect(agent).registerASN(ASN_A, "Scout", "trading");

      await expect(
        registry.connect(agent).registerASN(ASN_B, "Scout II", "trading"),
      ).to.be.revertedWith("Address already has ASN");
    });

    it("rejects an empty ASN", async function () {
      const { agent, registry } = await loadFixture(deployFixture);
      await expect(registry.connect(agent).registerASN("", "Scout", "trading")).to.be.revertedWith(
        "ASN required",
      );
    });
  });

  describe("registerASNFor", function () {
    it("lets the owner register on behalf of an agent address", async function () {
      const { owner, agent, registry } = await loadFixture(deployFixture);
      await registry.connect(owner).registerASNFor(agent.address, ASN_A, "Scout", "trading");

      expect((await registry.getRecord(ASN_A)).owner).to.equal(agent.address);
    });

    it("rejects a non-owner caller", async function () {
      const { agent, otherAgent, registry } = await loadFixture(deployFixture);
      await expect(
        registry.connect(agent).registerASNFor(otherAgent.address, ASN_A, "Scout", "trading"),
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("updateCredit", function () {
    it("updates credit and trust scores within bounds", async function () {
      const { owner, agent, registry } = await loadFixture(deployFixture);
      await registry.connect(agent).registerASN(ASN_A, "Scout", "trading");

      await expect(registry.connect(owner).updateCredit(ASN_A, 750, 80))
        .to.emit(registry, "CreditUpdated")
        .withArgs(ASN_A, 750, 80, anyValue);

      const record = await registry.getRecord(ASN_A);
      expect(record.creditScore).to.equal(750);
      expect(record.trustScore).to.equal(80);
    });

    it("rejects credit scores outside 300-900", async function () {
      const { owner, agent, registry } = await loadFixture(deployFixture);
      await registry.connect(agent).registerASN(ASN_A, "Scout", "trading");

      await expect(registry.connect(owner).updateCredit(ASN_A, 250, 50)).to.be.revertedWith(
        "Credit 300-900",
      );
    });

    it("rejects trust scores above 100", async function () {
      const { owner, agent, registry } = await loadFixture(deployFixture);
      await registry.connect(agent).registerASN(ASN_A, "Scout", "trading");

      await expect(registry.connect(owner).updateCredit(ASN_A, 700, 101)).to.be.revertedWith(
        "Trust 0-100",
      );
    });

    it("rejects updates from a non-owner", async function () {
      const { agent, registry } = await loadFixture(deployFixture);
      await registry.connect(agent).registerASN(ASN_A, "Scout", "trading");

      await expect(
        registry.connect(agent).updateCredit(ASN_A, 700, 60),
      ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });
  });

  describe("recordTaskCompletion", function () {
    it("accumulates task count and volume", async function () {
      const { owner, agent, registry } = await loadFixture(deployFixture);
      await registry.connect(agent).registerASN(ASN_A, "Scout", "trading");

      await registry.connect(owner).recordTaskCompletion(ASN_A, 100n);
      await registry.connect(owner).recordTaskCompletion(ASN_A, 50n);

      const record = await registry.getRecord(ASN_A);
      expect(record.tasksCompleted).to.equal(2n);
      expect(record.totalVolumeWei).to.equal(150n);
    });
  });

  describe("reads", function () {
    it("getAllRecords reflects registration order", async function () {
      const { agent, otherAgent, registry } = await loadFixture(deployFixture);
      await registry.connect(agent).registerASN(ASN_A, "Scout", "trading");
      await registry.connect(otherAgent).registerASN(ASN_B, "Courier", "logistics");

      const records = await registry.getAllRecords();
      expect(records.map((r) => r.asn)).to.deep.equal([ASN_A, ASN_B]);
    });

    it("getRecordByOwner rejects an address with no ASN", async function () {
      const { otherAgent, registry } = await loadFixture(deployFixture);
      await expect(registry.getRecordByOwner(otherAgent.address)).to.be.revertedWith(
        "No ASN for address",
      );
    });
  });
});

