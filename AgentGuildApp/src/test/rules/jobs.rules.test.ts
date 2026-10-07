// @vitest-environment node
/**
 * firestore.rules for the job lifecycle, run against the Firestore emulator.
 *
 *   npm run test:rules        (starts the emulator, runs src/test/rules, stops it)
 *
 * Skipped in a plain `npm test` — it needs the emulator (and Java). What it
 * pins down: the browser may read jobs and place well-formed gig orders, but
 * every other job state change goes through the server routes that validate
 * it and write the jobEvents audit trail (see lib/jobs-admin.ts).
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
import { addDoc, collection, deleteDoc, doc, getDoc, setDoc, updateDoc, type Firestore } from "firebase/firestore";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;

describe.skipIf(!emulator)("firestore.rules — jobs", () => {
  let env: RulesTestEnvironment;
  let alice: Firestore; // member of the buyer org
  let bob: Firestore; // member of the seller org
  let eve: Firestore; // member of neither

  const gigOrder = (extra: Record<string, unknown> = {}) => {
    const o: Record<string, unknown> = {
      orgId: "buyerOrg", gigId: "g", status: "in_progress", title: "t", sellerOrgId: "sellerOrg",
      escrow: { status: "funded", taskPda: "p" }, ...extra,
    };
    if (o.escrow === null) delete o.escrow;
    return o;
  };

  beforeAll(async () => {
    const [host, port] = emulator!.split(":");
    env = await initializeTestEnvironment({
      projectId: "demo-agent-guild-rules",
      firestore: { rules: readFileSync(path.resolve(__dirname, "../../../../firestore.rules"), "utf8"), host, port: Number(port) },
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, "organizations/buyerOrg"), { ownerAddress: "alice", members: ["alice"] });
      await setDoc(doc(db, "organizations/sellerOrg"), { ownerAddress: "bob", members: ["bob"] });
      await setDoc(doc(db, "jobs/j1"), { orgId: "buyerOrg", status: "completed", reviewStatus: "pending", deliveryNotes: "x" });
      await setDoc(doc(db, "jobs/gig1"), { orgId: "buyerOrg", sellerOrgId: "sellerOrg", gigId: "g", status: "in_progress", escrow: { status: "funded" } });
      await setDoc(doc(db, "jobApplications/a1"), { orgId: "buyerOrg", jobId: "j1", agentId: "x", status: "pending" });
      await setDoc(doc(db, "jobEvents/e1"), { orgId: "buyerOrg", jobId: "j1", type: "created" });
    });
    alice = env.authenticatedContext("alice").firestore();
    bob = env.authenticatedContext("bob").firestore();
    eve = env.authenticatedContext("eve").firestore();
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  describe("reads", () => {
    it("buyer org reads its jobs", () => assertSucceeds(getDoc(doc(alice, "jobs/j1"))));
    it("seller org reads gig orders it fulfils", () => assertSucceeds(getDoc(doc(bob, "jobs/gig1"))));
    it("outsiders can't", () => assertFails(getDoc(doc(eve, "jobs/j1"))));
  });

  describe("no job state changes from the browser", () => {
    it("can't approve a delivery directly", () =>
      assertFails(updateDoc(doc(alice, "jobs/j1"), { reviewStatus: "approved", status: "completed" })));
    it("can't change status", () => assertFails(updateDoc(doc(alice, "jobs/j1"), { status: "open" })));
    it("can't mark escrow released", () => assertFails(updateDoc(doc(alice, "jobs/gig1"), { "escrow.status": "released" })));
    it("can't delete a job (its audit trail would dangle)", () => assertFails(deleteDoc(doc(alice, "jobs/j1"))));
  });

  describe("creating jobs", () => {
    it("buyer places a gig order", () => assertSucceeds(addDoc(collection(alice, "jobs"), gigOrder())));
    it("gig order without escrow", () => assertSucceeds(addDoc(collection(alice, "jobs"), gigOrder({ escrow: null }))));
    it("a plain job must go through POST /api/jobs", () =>
      assertFails(addDoc(collection(alice, "jobs"), { orgId: "buyerOrg", status: "open", title: "t" })));
    it("gig order can't start completed", () => assertFails(addDoc(collection(alice, "jobs"), gigOrder({ status: "completed" }))));
    it("gig order can't start with escrow released", () =>
      assertFails(addDoc(collection(alice, "jobs"), gigOrder({ escrow: { status: "released" } }))));
    it("gig order can't carry a review", () => assertFails(addDoc(collection(alice, "jobs"), gigOrder({ reviewStatus: "approved" }))));
    it("gig order can't claim to be verified as paid", () =>
      assertFails(addDoc(collection(alice, "jobs"), gigOrder({ upfrontVerifiedAt: 1 }))));
    it("can't create in someone else's org", () => assertFails(addDoc(collection(eve, "jobs"), gigOrder())));
  });

  describe("applications are read-only from the browser", () => {
    it("buyer reads them", () => assertSucceeds(getDoc(doc(alice, "jobApplications/a1"))));
    it("can't accept a bid", () => assertFails(updateDoc(doc(alice, "jobApplications/a1"), { status: "accepted" })));
    it("can't apply directly", () => assertFails(addDoc(collection(alice, "jobApplications"), { orgId: "buyerOrg", jobId: "j1" })));
  });

  describe("audit log", () => {
    it("isn't readable from the browser", () => assertFails(getDoc(doc(alice, "jobEvents/e1"))));
    it("isn't writable from the browser", () => assertFails(addDoc(collection(alice, "jobEvents"), { orgId: "buyerOrg", jobId: "j1" })));
  });
});
