import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { SwarmAgentIdentityNFT } from "../typechain-types";

const ASN_A = "ASN-SWM-2026-AAAA-1111-XY";
const BASE_URI = "https://swarmprotocol.fun/api/nft/agent";

async function deployFixture() {
  const [owner, agent, otherAgent, stranger] = await ethers.getSigners();

  const Factory = await ethers.getContractFactory("SwarmAgentIdentityNFT");
  const nft = (await Factory.deploy(BASE_URI)) as unknown as SwarmAgentIdentityNFT;
  await nft.waitForDeployment();

  return { owner, agent, otherAgent, stranger, nft };
}

describe("SwarmAgentIdentityNFT", function () {
  describe("mintAgentNFT", function () {
    it("mints token id 1 to the agent and records identity data", async function () {
      const { owner, agent, nft } = await loadFixture(deployFixture);

      await expect(nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50))
        .to.emit(nft, "AgentNFTMinted")
        .withArgs(agent.address, 1n, ASN_A, anyValue);

      expect(await nft.ownerOf(1)).to.equal(agent.address);
      expect(await nft.getTokenId(agent.address)).to.equal(1n);
      expect(await nft.hasNFT(agent.address)).to.equal(true);

      const identity = await nft.getAgentIdentity(1);
      expect(identity.asn).to.equal(ASN_A);
      expect(identity.creditScore).to.equal(680);
      expect(identity.trustScore).to.equal(50);
    });

    it("increments token ids across mints", async function () {
      const { owner, agent, otherAgent, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);
      await nft.connect(owner).mintAgentNFT(otherAgent.address, "ASN-SWM-2026-BBBB-2222-ZW", 680, 50);

      expect(await nft.getTokenId(agent.address)).to.equal(1n);
      expect(await nft.getTokenId(otherAgent.address)).to.equal(2n);
    });

    it("rejects minting a second NFT to the same agent", async function () {
      const { owner, agent, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);

      await expect(
        nft.connect(owner).mintAgentNFT(agent.address, "ASN-SWM-2026-BBBB-2222-ZW", 680, 50),
      ).to.be.revertedWith("Agent already has NFT");
    });

    it("rejects an empty ASN", async function () {
      const { owner, agent, nft } = await loadFixture(deployFixture);
      await expect(nft.connect(owner).mintAgentNFT(agent.address, "", 680, 50)).to.be.revertedWith(
        "ASN required",
      );
    });

    it("rejects minting from a non-owner", async function () {
      const { agent, otherAgent, nft } = await loadFixture(deployFixture);
      await expect(
        nft.connect(agent).mintAgentNFT(otherAgent.address, ASN_A, 680, 50),
      ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    });
  });

  describe("updateReputation / batchUpdateReputation", function () {
    it("updates credit and trust scores and the reputation tier", async function () {
      const { owner, agent, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);

      await expect(nft.connect(owner).updateReputation(agent.address, 860, 90))
        .to.emit(nft, "ReputationUpdated")
        .withArgs(1n, 860, 90, anyValue);

      const identity = await nft.getAgentIdentity(1);
      expect(identity.creditScore).to.equal(860);
      expect(identity.trustScore).to.equal(90);
      expect(await nft.getReputationTier(1)).to.equal("Platinum");
    });

    it("rejects updating an agent with no NFT", async function () {
      const { owner, stranger, nft } = await loadFixture(deployFixture);
      await expect(
        nft.connect(owner).updateReputation(stranger.address, 700, 50),
      ).to.be.revertedWith("Agent has no NFT");
    });

    it("batch-updates multiple agents in one call", async function () {
      const { owner, agent, otherAgent, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);
      await nft.connect(owner).mintAgentNFT(otherAgent.address, "ASN-SWM-2026-BBBB-2222-ZW", 680, 50);

      await nft.connect(owner).batchUpdateReputation(
        [agent.address, otherAgent.address],
        [750, 600],
        [70, 40],
      );

      expect((await nft.getAgentIdentity(1)).creditScore).to.equal(750);
      expect((await nft.getAgentIdentity(2)).creditScore).to.equal(600);
    });
  });

  describe("soulbound transfer restriction", function () {
    it("blocks a user-to-user transfer", async function () {
      const { owner, agent, stranger, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);

      await expect(
        nft.connect(agent).transferFrom(agent.address, stranger.address, 1),
      ).to.be.revertedWith("SwarmAgentIdentityNFT: non-transferable");
    });

    it("blocks even the contract owner from a direct transferFrom — recovery only via emergencyTransfer", async function () {
      const { owner, agent, stranger, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);

      // _update's soulbound check applies to every caller, owner included —
      // the only supported recovery path is emergencyTransfer() (see below).
      await expect(
        nft.connect(owner).transferFrom(agent.address, stranger.address, 1),
      ).to.be.revertedWith("SwarmAgentIdentityNFT: non-transferable");
    });
  });

  describe("emergencyTransfer", function () {
    it("re-points token ownership and the address mappings to a new agent wallet", async function () {
      const { owner, agent, stranger, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);

      await nft.connect(owner).emergencyTransfer(1, stranger.address);

      expect(await nft.ownerOf(1)).to.equal(stranger.address);
      expect(await nft.getTokenId(stranger.address)).to.equal(1n);
      expect(await nft.getTokenId(agent.address)).to.equal(0n);
    });

    it("rejects recovery to a wallet that already has an NFT", async function () {
      const { owner, agent, otherAgent, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);
      await nft.connect(owner).mintAgentNFT(otherAgent.address, "ASN-SWM-2026-BBBB-2222-ZW", 680, 50);

      await expect(nft.connect(owner).emergencyTransfer(1, otherAgent.address)).to.be.revertedWith(
        "New agent already has NFT",
      );
    });

    it("rejects recovery from a non-owner", async function () {
      const { owner, agent, stranger, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);

      await expect(
        nft.connect(agent).emergencyTransfer(1, stranger.address),
      ).to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount");
    });
  });

  describe("tokenURI", function () {
    it("points at the base URI plus the agent's address", async function () {
      const { owner, agent, nft } = await loadFixture(deployFixture);
      await nft.connect(owner).mintAgentNFT(agent.address, ASN_A, 680, 50);

      expect(await nft.tokenURI(1)).to.equal(`${BASE_URI}/${agent.address.toLowerCase()}`);
    });
  });
});
