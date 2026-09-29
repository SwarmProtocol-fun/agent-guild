import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import { AgentGuild } from "../target/types/agent_guild";

describe("agent_guild", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AgentGuild as Program<AgentGuild>;
  const wallet = provider.wallet as anchor.Wallet;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("guild-config")],
    program.programId,
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId,
  );

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
  }

  it("initializes the guild config and treasury", async () => {
    await program.methods
      .initialize()
      .accounts({ payer: wallet.publicKey, config: configPda, systemProgram: SystemProgram.programId })
      .rpc();

    const config = await program.account.guildConfig.fetch(configPda);
    assert.equal(config.authority.toBase58(), wallet.publicKey.toBase58());
    assert.equal(config.taskCounter.toNumber(), 0);

    await program.methods
      .initializeTreasury()
      .accounts({ payer: wallet.publicKey, config: configPda, treasury: treasuryPda, systemProgram: SystemProgram.programId })
      .rpc();

    const treasury = await program.account.treasuryAccount.fetch(treasuryPda);
    assert.equal(treasury.computeBalance.toNumber(), 0);
  });

  it("registers an agent (self-service)", async () => {
    const agentWallet = Keypair.generate();
    await airdrop(agentWallet.publicKey, 1);

    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentWallet.publicKey.toBuffer()],
      program.programId,
    );
    const [asnPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("asn"), Buffer.from("ASN-TEST-1")],
      program.programId,
    );

    await program.methods
      .registerAgent("Test Agent", "solidity,rust", "ASN-TEST-1", 250)
      .accounts({
        agentWallet: agentWallet.publicKey,
        agentAccount: agentPda,
        asnRecord: asnPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([agentWallet])
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPda);
    assert.equal(agent.name, "Test Agent");
    assert.equal(agent.creditScore, 680);
    assert.equal(agent.trustScore, 50);
    assert.isTrue(agent.active);

    const asnRecord = await program.account.asnRecord.fetch(asnPda);
    assert.equal(asnRecord.agent.toBase58(), agentWallet.publicKey.toBase58());
  });

  it("sponsors registration via register_agent_for", async () => {
    const agentWallet = Keypair.generate(); // never funded — platform pays for everything

    const [agentPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentWallet.publicKey.toBuffer()],
      program.programId,
    );
    const [asnPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("asn"), Buffer.from("ASN-SPONSORED-1")],
      program.programId,
    );

    await program.methods
      .registerAgentFor(agentWallet.publicKey, "Sponsored Agent", "python", "ASN-SPONSORED-1", 0)
      .accounts({
        payer: wallet.publicKey,
        config: configPda,
        agentAccount: agentPda,
        asnRecord: asnPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const agent = await program.account.agentAccount.fetch(agentPda);
    assert.equal(agent.wallet.toBase58(), agentWallet.publicKey.toBase58());
  });

  it("runs the full task lifecycle: post -> claim -> deliver -> approve", async () => {
    const poster = Keypair.generate();
    const claimant = Keypair.generate();
    await airdrop(poster.publicKey, 2);
    await airdrop(claimant.publicKey, 1);

    const configBefore = await program.account.guildConfig.fetch(configPda);
    const taskId = configBefore.taskCounter;
    const [taskPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), taskId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const budget = 0.5 * LAMPORTS_PER_SOL;

    await program.methods
      .postTask("Ship a feature", "Implement X", "typescript", new anchor.BN(deadline), new anchor.BN(budget))
      .accounts({
        poster: poster.publicKey,
        config: configPda,
        taskAccount: taskPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([poster])
      .rpc();

    let task = await program.account.taskAccount.fetch(taskPda);
    assert.deepEqual(task.status, { open: {} });

    await program.methods
      .claimTask()
      .accounts({ claimant: claimant.publicKey, taskAccount: taskPda })
      .signers([claimant])
      .rpc();

    task = await program.account.taskAccount.fetch(taskPda);
    assert.deepEqual(task.status, { claimed: {} });
    assert.equal(task.claimedBy.toBase58(), claimant.publicKey.toBase58());

    const deliveryHash = new Uint8Array(32).fill(7);
    await program.methods
      .submitDelivery(Array.from(deliveryHash))
      .accounts({ claimant: claimant.publicKey, taskAccount: taskPda })
      .signers([claimant])
      .rpc();

    const claimantBalanceBefore = await provider.connection.getBalance(claimant.publicKey);

    await program.methods
      .approveDelivery()
      .accounts({
        poster: poster.publicKey,
        taskAccount: taskPda,
        claimant: claimant.publicKey,
      })
      .signers([poster])
      .rpc();

    task = await program.account.taskAccount.fetch(taskPda);
    assert.deepEqual(task.status, { completed: {} });

    const claimantBalanceAfter = await provider.connection.getBalance(claimant.publicKey);
    assert.equal(claimantBalanceAfter - claimantBalanceBefore, budget);
  });

  it("handles a disputed task via resolve_dispute", async () => {
    const poster = Keypair.generate();
    const claimant = Keypair.generate();
    await airdrop(poster.publicKey, 2);
    await airdrop(claimant.publicKey, 1);

    const configBefore = await program.account.guildConfig.fetch(configPda);
    const taskId = configBefore.taskCounter;
    const [taskPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("task"), taskId.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const budget = 1 * LAMPORTS_PER_SOL;

    await program.methods
      .postTask("Disputed task", "desc", "skills", new anchor.BN(deadline), new anchor.BN(budget))
      .accounts({ poster: poster.publicKey, config: configPda, taskAccount: taskPda, systemProgram: SystemProgram.programId })
      .signers([poster])
      .rpc();

    await program.methods
      .claimTask()
      .accounts({ claimant: claimant.publicKey, taskAccount: taskPda })
      .signers([claimant])
      .rpc();

    await program.methods
      .disputeDelivery()
      .accounts({ poster: poster.publicKey, taskAccount: taskPda })
      .signers([poster])
      .rpc();

    let task = await program.account.taskAccount.fetch(taskPda);
    assert.deepEqual(task.status, { disputed: {} });

    const posterBalanceBefore = await provider.connection.getBalance(poster.publicKey);
    const claimantBalanceBefore = await provider.connection.getBalance(claimant.publicKey);

    // 30% to the agent, 70% back to the poster
    await program.methods
      .resolveDispute(3000)
      .accounts({
        authority: wallet.publicKey,
        config: configPda,
        taskAccount: taskPda,
        poster: poster.publicKey,
        claimant: claimant.publicKey,
      })
      .rpc();

    task = await program.account.taskAccount.fetch(taskPda);
    assert.deepEqual(task.status, { resolved: {} });

    const agentShare = Math.floor((budget * 3000) / 10000);
    const posterShare = budget - agentShare;

    const posterBalanceAfter = await provider.connection.getBalance(poster.publicKey);
    const claimantBalanceAfter = await provider.connection.getBalance(claimant.publicKey);

    assert.equal(claimantBalanceAfter - claimantBalanceBefore, agentShare);
    assert.equal(posterBalanceAfter - posterBalanceBefore, posterShare);
  });

  it("deposits revenue into the treasury with a 50/30/20 split and withdraws", async () => {
    const depositor = Keypair.generate();
    await airdrop(depositor.publicKey, 2);

    const amount = 1 * LAMPORTS_PER_SOL;
    await program.methods
      .depositRevenue(new anchor.BN(amount))
      .accounts({ depositor: depositor.publicKey, treasury: treasuryPda, systemProgram: SystemProgram.programId })
      .signers([depositor])
      .rpc();

    const treasury = await program.account.treasuryAccount.fetch(treasuryPda);
    assert.equal(treasury.computeBalance.toNumber(), amount * 0.5);
    assert.equal(treasury.growthBalance.toNumber(), amount * 0.3);
    assert.equal(treasury.reserveBalance.toNumber(), amount * 0.2);

    const recipient = Keypair.generate();
    await program.methods
      .withdraw(new anchor.BN(amount / 2))
      .accounts({ authority: wallet.publicKey, config: configPda, treasury: treasuryPda, to: recipient.publicKey })
      .rpc();

    const recipientBalance = await provider.connection.getBalance(recipient.publicKey);
    assert.equal(recipientBalance, amount / 2);
  });
});
