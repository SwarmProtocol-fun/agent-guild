import { describe, it, expect } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { BN, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import idlJson from "@/lib/solana/idl/agent_guild.json";
import { buildInstructions, coerceArg, resolveAddress, type AddressContext } from "../../../../mods/solana-settlement/txbuilder";
import { DevtoolsInputError } from "../../../../mods/solana-settlement/devtools";

const idl = idlJson as unknown as Idl;
const PROGRAM = new PublicKey(idl.address);
const payer = Keypair.generate().publicKey;
// An inline IDL means no RPC call is made — any network access would throw.
const offline = new Proxy({}, { get: () => { throw new Error("unexpected RPC call"); } }) as unknown as Connection;
const ctx = (): AddressContext => ({ payer, newSigners: new Map() });

describe("address placeholders", () => {
  it("resolves payer/self and reuses new:<label> keypairs", () => {
    const c = ctx();
    expect(resolveAddress("payer", c).equals(payer)).toBe(true);
    expect(resolveAddress("self", c).equals(payer)).toBe(true);
    const a = resolveAddress("new:mint", c);
    expect(resolveAddress("new:mint", c).equals(a)).toBe(true);
    expect(c.newSigners.size).toBe(1);
    expect(() => resolveAddress("nope", c)).toThrow(DevtoolsInputError);
  });
});

describe("IDL arg coercion", () => {
  // Shaped like Anchor's camelCased program.idl, which coercion runs against.
  const types = [
    { name: "kind", type: { kind: "enum", variants: [{ name: "simple" }, { name: "withData", fields: [{ name: "amountIn", type: "u64" }] }] } },
    { name: "point", type: { kind: "struct", fields: [{ name: "xPos", type: "i64" }, { name: "owner", type: "pubkey" }] } },
  ];

  it("turns JSON into the shapes Anchor's coder expects", () => {
    const c = ctx();
    expect(BN.isBN(coerceArg("u64", "18446744073709551615", [], "a", c))).toBe(true);
    expect(coerceArg("u16", "7", [], "a", c)).toBe(7);
    expect(coerceArg({ option: "u8" }, null, [], "a", c)).toBeNull();
    expect(Array.from(coerceArg({ vec: "u8" }, "0x0102", [], "a", c) as Uint8Array)).toEqual([1, 2]);
    expect(coerceArg({ array: ["u8", 2] }, "0xffee", [], "a", c)).toEqual([255, 238]);
    expect(coerceArg({ defined: { name: "kind" } }, "Simple", types, "a", c)).toEqual({ simple: {} });
    const v = coerceArg({ defined: { name: "kind" } }, { WithData: { amountIn: "5" } }, types, "a", c) as { withData: { amountIn: BN } };
    expect(v.withData.amountIn.toString()).toBe("5");
    const p = coerceArg({ defined: { name: "point" } }, { x_pos: -3, owner: "payer" }, types, "a", c) as { xPos: BN; owner: PublicKey };
    expect(p.xPos.toString()).toBe("-3");
    expect(p.owner.equals(payer)).toBe(true);
  });

  it("reports the path of a bad value", () => {
    expect(() => coerceArg({ array: ["u8", 32] }, "0x00", [], "args.hash", ctx())).toThrow(/args.hash.*length 32/);
    expect(() => coerceArg({ defined: { name: "kind" } }, "Nope", types, "args.kind", ctx())).toThrow(/unknown kind variant/);
  });
});

describe("buildInstructions", () => {
  it("builds an Anchor call by name, deriving PDAs from the IDL", async () => {
    const wallet = Keypair.generate().publicKey;
    const { instructions } = await buildInstructions(offline, payer, [{
      programId: PROGRAM.toBase58(),
      instruction: "register_agent",
      idl,
      args: { name: "chef", skills: "rust", asn: "ASN-1", fee_rate_bps: 250 },
      accounts: { agent_wallet: wallet.toBase58() },
    }]);
    const ix = instructions[0];
    expect(ix.programId.equals(PROGRAM)).toBe(true);
    const [agentPda] = PublicKey.findProgramAddressSync([Buffer.from("agent"), wallet.toBuffer()], PROGRAM);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toContain(agentPda.toBase58());
    expect(ix.keys.find((k) => k.pubkey.equals(wallet))?.isSigner).toBe(true);

    const decoded = new BorshInstructionCoder(idl).decode(Buffer.from(ix.data));
    expect(decoded?.name).toBe("register_agent");
    expect((decoded?.data as { fee_rate_bps: number }).fee_rate_bps).toBe(250);
  });

  it("encodes big integers and fixed byte arrays from strings", async () => {
    const { instructions } = await buildInstructions(offline, payer, [
      { programId: PROGRAM.toBase58(), instruction: "submitDelivery", idl, args: [`0x${"ab".repeat(32)}`], accounts: { claimant: "payer", task_account: "new:task" } },
      { programId: PROGRAM.toBase58(), instruction: "post_task", idl, args: { title: "t", description: "d", required_skills: "s", deadline: "-1", budget_lamports: "5000000000" },
        // task_account's seeds read GuildConfig.task_counter on-chain, so offline it must be given.
        accounts: { poster: "payer", task_account: "new:task" } },
    ]);
    const coder = new BorshInstructionCoder(idl);
    const delivery = coder.decode(Buffer.from(instructions[0].data))!.data as { delivery_hash: number[] };
    expect(Buffer.from(delivery.delivery_hash).toString("hex")).toBe("ab".repeat(32));
    const task = coder.decode(Buffer.from(instructions[1].data))!.data as { deadline: BN; budget_lamports: BN };
    expect(task.deadline.toString()).toBe("-1");
    expect(task.budget_lamports.toString()).toBe("5000000000");
  });

  it("builds raw instructions and transfers", async () => {
    const to = Keypair.generate().publicKey;
    const { instructions, newSigners } = await buildInstructions(offline, payer, [
      { kind: "transfer", to: to.toBase58(), sol: 0.5 },
      { kind: "raw", programId: SystemProgram.programId.toBase58(), keys: [{ pubkey: "new:acct", isSigner: true, isWritable: true }], dataHex: "0x0102" },
    ]);
    expect(instructions[0].keys[0].pubkey.equals(payer)).toBe(true);
    expect(Array.from(instructions[1].data)).toEqual([1, 2]);
    expect(instructions[1].keys[0].pubkey.equals(newSigners.get("acct")!.publicKey)).toBe(true);
  });

  it("rejects unknown instructions and missing accounts as input errors", async () => {
    await expect(buildInstructions(offline, payer, [{ programId: PROGRAM.toBase58(), instruction: "nope", idl }])).rejects.toThrow(/not in the IDL — one of/);
    await expect(buildInstructions(offline, payer, [{ programId: PROGRAM.toBase58(), instruction: "claim_task", idl, accounts: { claimant: "payer" } }]))
      .rejects.toBeInstanceOf(DevtoolsInputError);
    await expect(buildInstructions(offline, payer, [])).rejects.toThrow(/required/);
    await expect(buildInstructions(offline, payer, [{ programId: PROGRAM.toBase58(), instruction: "claim_task", idl, accounts: { claimer: "payer" } }]))
      .rejects.toThrow(/no account "claimer" — one of claimant, taskAccount/);
  });
});
