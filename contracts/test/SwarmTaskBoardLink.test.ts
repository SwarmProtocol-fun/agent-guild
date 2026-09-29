import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import type { MockLINK, SwarmTaskBoardLink } from "../typechain-types";

const BUDGET = ethers.parseUnits("100", 18);

async function deployFixture() {
  const [owner, poster, agent, otherAgent, outsider] = await ethers.getSigners();

  const MockLINKFactory = await ethers.getContractFactory("MockLINK");
  const link = (await MockLINKFactory.deploy()) as unknown as MockLINK;
  await link.waitForDeployment();

  const TaskBoardFactory = await ethers.getContractFactory("SwarmTaskBoardLink");
  const board = (await TaskBoardFactory.deploy(await link.getAddress())) as unknown as SwarmTaskBoardLink;
  await board.waitForDeployment();

  // Fund poster with LINK and approve the board to pull budget.
  await link.mint(poster.address, ethers.parseUnits("10000", 18));
  await link.connect(poster).approve(await board.getAddress(), ethers.MaxUint256);

  return { owner, poster, agent, otherAgent, outsider, link, board };
}

async function postTask(
  board: SwarmTaskBoardLink,
  poster: any,
  deadlineOffsetSeconds: number,
  budget = BUDGET,
) {
  const deadline = (await time.latest()) + deadlineOffsetSeconds;
  const tx = await board
    .connect(poster)
    .postTask(ethers.ZeroAddress, "Title", "Description", "js,ts", deadline, budget);
  await tx.wait();
  const taskId = (await board.taskCount()) - 1n;
  return { taskId, deadline };
}

describe("SwarmTaskBoardLink", function () {
  describe("postTask / claimTask / submitDelivery / approveDelivery (existing flow)", function () {
    it("escrows LINK on post and pays the agent on approval", async function () {
      const { poster, agent, link, board } = await loadFixture(deployFixture);
      const { taskId } = await postTask(board, poster, 3600);

      expect(await link.balanceOf(await board.getAddress())).to.equal(BUDGET);

      await board.connect(agent).claimTask(taskId);
      await board.connect(agent).submitDelivery(taskId, ethers.id("delivery"));

      const before = await link.balanceOf(agent.address);
      await board.connect(poster).approveDelivery(taskId);
      const after = await link.balanceOf(agent.address);

      expect(after - before).to.equal(BUDGET);
      expect((await board.getTask(taskId)).status).to.equal(2n); // Completed
    });

    it("rejects claiming your own posted task", async function () {
      const { poster, board } = await loadFixture(deployFixture);
      const { taskId } = await postTask(board, poster, 3600);
      await expect(board.connect(poster).claimTask(taskId)).to.be.revertedWith(
        "Cannot claim own task",
      );
    });
  });

  describe("reclaimExpired", function () {
    it("refunds the poster when nobody claimed the task before the deadline", async function () {
      const { poster, link, board } = await loadFixture(deployFixture);
      const { taskId, deadline } = await postTask(board, poster, 100);

      await time.increaseTo(deadline + 1);

      const before = await link.balanceOf(poster.address);
      await expect(board.connect(poster).reclaimExpired(taskId))
        .to.emit(board, "TaskExpiredReclaimed")
        .withArgs(taskId, poster.address, BUDGET, anyValue);
      const after = await link.balanceOf(poster.address);

      expect(after - before).to.equal(BUDGET);
      expect((await board.getTask(taskId)).status).to.equal(3n); // Expired
    });

    it("refunds the poster when the task was claimed but never delivered", async function () {
      const { poster, agent, link, board } = await loadFixture(deployFixture);
      const { taskId, deadline } = await postTask(board, poster, 100);

      await board.connect(agent).claimTask(taskId);
      await time.increaseTo(deadline + 1);

      const before = await link.balanceOf(poster.address);
      await board.connect(poster).reclaimExpired(taskId);
      const after = await link.balanceOf(poster.address);

      expect(after - before).to.equal(BUDGET);
    });

    it("rejects reclaim before the deadline has passed", async function () {
      const { poster, board } = await loadFixture(deployFixture);
      const { taskId } = await postTask(board, poster, 3600);
      await expect(board.connect(poster).reclaimExpired(taskId)).to.be.revertedWith(
        "Not yet expired",
      );
    });

    it("rejects reclaim by anyone other than the poster", async function () {
      const { poster, outsider, board } = await loadFixture(deployFixture);
      const { taskId, deadline } = await postTask(board, poster, 100);
      await time.increaseTo(deadline + 1);
      await expect(board.connect(outsider).reclaimExpired(taskId)).to.be.revertedWith(
        "Only poster can reclaim",
      );
    });

    it("rejects reclaim once delivery has been submitted, even after the deadline", async function () {
      const { poster, agent, board } = await loadFixture(deployFixture);
      const { taskId, deadline } = await postTask(board, poster, 100);
      await board.connect(agent).claimTask(taskId);
      await board.connect(agent).submitDelivery(taskId, ethers.id("delivery"));
      await time.increaseTo(deadline + 1);

      await expect(board.connect(poster).reclaimExpired(taskId)).to.be.revertedWith(
        "Not reclaimable",
      );
    });

    it("rejects double-reclaim", async function () {
      const { poster, board } = await loadFixture(deployFixture);
      const { taskId, deadline } = await postTask(board, poster, 100);
      await time.increaseTo(deadline + 1);

      await board.connect(poster).reclaimExpired(taskId);
      await expect(board.connect(poster).reclaimExpired(taskId)).to.be.revertedWith(
        "Not reclaimable",
      );
    });

    it("rejects reclaim on a disputed task — must go through resolveDispute", async function () {
      const { poster, agent, board } = await loadFixture(deployFixture);
      const { taskId, deadline } = await postTask(board, poster, 100);
      await board.connect(agent).claimTask(taskId);
      await board.connect(poster).disputeDelivery(taskId);
      await time.increaseTo(deadline + 1);

      await expect(board.connect(poster).reclaimExpired(taskId)).to.be.revertedWith(
        "Not reclaimable",
      );
    });
  });

  describe("resolveDispute", function () {
    async function disputedFixture() {
      const base = await deployFixture();
      const { taskId } = await postTask(base.board, base.poster, 3600);
      await base.board.connect(base.agent).claimTask(taskId);
      await base.board.connect(base.agent).submitDelivery(taskId, ethers.id("delivery"));
      await base.board.connect(base.poster).disputeDelivery(taskId);
      return { ...base, taskId };
    }

    it("pays the agent when the owner resolves in the agent's favor", async function () {
      const { owner, agent, link, board, taskId } = await loadFixture(disputedFixture);

      const before = await link.balanceOf(agent.address);
      await expect(board.connect(owner).resolveDispute(taskId, true))
        .to.emit(board, "DisputeResolved")
        .withArgs(taskId, owner.address, true, BUDGET, anyValue);
      const after = await link.balanceOf(agent.address);

      expect(after - before).to.equal(BUDGET);
      expect((await board.getTask(taskId)).status).to.equal(2n); // Completed
    });

    it("refunds the poster when the owner resolves against the agent", async function () {
      const { owner, poster, link, board, taskId } = await loadFixture(disputedFixture);

      const before = await link.balanceOf(poster.address);
      await board.connect(owner).resolveDispute(taskId, false);
      const after = await link.balanceOf(poster.address);

      expect(after - before).to.equal(BUDGET);
      expect((await board.getTask(taskId)).status).to.equal(5n); // Refunded
    });

    it("rejects resolution from a non-owner", async function () {
      const { poster, board, taskId } = await loadFixture(disputedFixture);
      await expect(board.connect(poster).resolveDispute(taskId, true)).to.be.revertedWithCustomError(
        board,
        "OwnableUnauthorizedAccount",
      );
    });

    it("rejects resolving a task that isn't disputed", async function () {
      const { owner, poster, board } = await loadFixture(deployFixture);
      const { taskId } = await postTask(board, poster, 3600);
      await expect(board.connect(owner).resolveDispute(taskId, true)).to.be.revertedWith(
        "Not disputed",
      );
    });

    it("rejects double-resolution", async function () {
      const { owner, board, taskId } = await loadFixture(disputedFixture);
      await board.connect(owner).resolveDispute(taskId, true);
      await expect(board.connect(owner).resolveDispute(taskId, true)).to.be.revertedWith(
        "Not disputed",
      );
    });
  });
});
