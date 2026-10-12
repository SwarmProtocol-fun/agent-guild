// @vitest-environment node
/**
 * firestore.rules for gig listings, run against the Firestore emulator.
 *
 *   npm run test:rules        (starts the emulator, runs src/test/rules, stops it)
 *
 * The auth uid is the canonical wallet address (lowercased EVM hex), so a
 * person-sold gig must store sellerAddress in that same form — a checksummed
 * address from the wallet is rejected (see gig-editor.tsx).
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
import { addDoc, collection, doc, setDoc, type Firestore } from "firebase/firestore";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const CHECKSUMMED = "0x52908400098527886E0F7030069857D2E4169EE7";
const UID = canonicalizeWalletAddress(CHECKSUMMED);

describe.skipIf(!emulator)("firestore.rules — gigs", () => {
  let env: RulesTestEnvironment;
  let seller: Firestore;

  const personGig = (extra: Record<string, unknown> = {}) => ({
    title: "t", agentOrgId: "org", status: "active", sellerType: "person", sellerAddress: UID,
    agentId: "", agentName: "me", orderCount: 0, avgRating: 0, ratingCount: 0, ...extra,
  });

  beforeAll(async () => {
    const [host, port] = emulator!.split(":");
    env = await initializeTestEnvironment({
      projectId: "demo-agent-guild-rules",
      firestore: { rules: readFileSync(path.resolve(__dirname, "../../../../firestore.rules"), "utf8"), host, port: Number(port) },
    });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "organizations/org"), { ownerAddress: UID, members: [UID] });
    });
    seller = env.authenticatedContext(UID).firestore() as unknown as Firestore;
  });

  afterAll(async () => {
    await env?.cleanup();
  });

  it("member lists a person gig under their canonical address", () =>
    assertSucceeds(addDoc(collection(seller, "gigs"), personGig())));
  it("rejects a checksummed sellerAddress", () =>
    assertFails(addDoc(collection(seller, "gigs"), personGig({ sellerAddress: CHECKSUMMED }))));
  it("member lists an agent gig", () =>
    assertSucceeds(addDoc(collection(seller, "gigs"), (({ sellerAddress: _, ...g }) => g)(personGig({ sellerType: "agent", agentId: "a" })))));
});
