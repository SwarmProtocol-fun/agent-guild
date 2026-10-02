// Migrations are an early feature. Currently, they're nothing more than this
// single deploy script that's invoked from the CLI, injecting a provider
// configured from the workspace's Anchor.toml.
//
// `initialize` has no built-in authorization beyond "the payer must be this
// program's current upgrade authority" (see registry.rs) — whoever calls it
// first after a deploy becomes the permanent `config.authority`, so this
// script exists to make deploy+initialize one atomic step instead of a
// manual follow-up an attacker could race. Run via `anchor migrate` right
// after `anchor deploy`, using the same wallet that holds upgrade authority.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { AgentGuild } from "../target/types/agent_guild";

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);

  const program = anchor.workspace.AgentGuild as anchor.Program<AgentGuild>;
  const payer = provider.wallet.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("guild-config")], program.programId);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], program.programId);
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID,
  );

  const configAccount = await provider.connection.getAccountInfo(configPda);
  if (configAccount) {
    console.log("guild-config already initialized at", configPda.toBase58(), "— skipping initialize.");
    return;
  }

  console.log("Initializing guild config as", payer.toBase58(), "…");
  await program.methods
    .initialize()
    .accounts({
      payer,
      config: configPda,
      programData: programDataPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Initializing treasury …");
  await program.methods
    .initializeTreasury()
    .accounts({
      payer,
      config: configPda,
      treasury: treasuryPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("Done. authority =", payer.toBase58());
};
