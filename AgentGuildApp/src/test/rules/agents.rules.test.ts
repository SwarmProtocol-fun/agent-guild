// @vitest-environment node
/**
 * firestore.rules for agent docs, run against the Firestore emulator
 * (`npm run test:rules`). Pins down the anti-sybil fields: the browser may
 * reserve an agent only as provisional (clocked by the server), and can
 * never bind a key, clear provisional status, touch the bond, or edit the
 * policy-tier inputs — those go through /api/v1/register and agent-bond.ts.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { addDoc, collection, doc, serverTimestamp, setDoc, updateDoc, type Firestore } from "firebase/firestore";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!emulator)("firestore.rules — agents", () => {
  let env: RulesTestEnvironment;
  let alice: Firestore; // member of org1

  const reservation = (extra: Record<string, unknown> = {}) => ({
    orgId: "org1", name: "bot", status: "offline", creditScore: 680, trustScore: 50,
    provisional: true, provisionalSince: serverTimestamp(), ...extra,
  });

  beforeAll(async () => {
    const [host, port] = emulator!.split(":");
    env = await initializeTestEnvironment({
      projectId: "demo-agent-guild-rules",
      firestore: { rules: readFileSync(path.resolve(__dirname, "../../../../firestore.rules"), "utf8"), host, port: Number(port) },
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "organizations/org1"), { ownerAddress: "alice", members: ["alice"] });
      await setDoc(doc(db, "agents/ag1"), {
        orgId: "org1", name: "Ada", publicKey: "PEM", provisional: true, riskFlags: ["sybil_suspicion"],
      });
    });
    alice = env.authenticatedContext("alice").firestore() as unknown as Firestore;
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it("an org member can reserve a provisional agent", async () => {
    await assertSucceeds(addDoc(collection(alice, "agents"), reservation()));
  });

  it("but not a non-provisional one", async () => {
    await assertFails(addDoc(collection(alice, "agents"), reservation({ provisional: false })));
    const { provisional: _p, ...noFlag } = reservation();
    await assertFails(addDoc(collection(alice, "agents"), noFlag));
  });

  it("nor with a back-dated provisional clock", async () => {
    await assertFails(addDoc(collection(alice, "agents"), reservation({ provisionalSince: new Date(2020, 0, 1) })));
  });

  it("nor pre-bound to a key, an owner, or a bond", async () => {
    await assertFails(addDoc(collection(alice, "agents"), reservation({ publicKey: "PEM" })));
    await assertFails(addDoc(collection(alice, "agents"), reservation({ ownerWallet: "x" })));
    await assertFails(addDoc(collection(alice, "agents"), reservation({ bond: { status: "posted" } })));
  });

  it("members can still edit display fields", async () => {
    await assertSucceeds(updateDoc(doc(alice, "agents/ag1"), { name: "Ada 2", description: "d" }));
  });

  it.each([
    ["swap the key", { publicKey: "OTHER" }],
    ["clear provisional", { provisional: false }],
    ["fake a bond", { bond: { status: "posted", amountUsd: 25 } }],
    ["clear risk flags", { riskFlags: [] }],
    ["self-certify", { verificationLevel: "certified" }],
    ["un-retire", { retiredAt: null }],
  ])("members can't %s", async (_label, patch) => {
    await assertFails(updateDoc(doc(alice, "agents/ag1"), patch));
  });

  it("registration grants and PoH records are server-only", async () => {
    await assertFails(setDoc(doc(alice, "agentRegistrationGrants/x"), { orgId: "org1" }));
    await assertFails(setDoc(doc(alice, "humanVerifications/alice"), { verified: true }));
  });
});
