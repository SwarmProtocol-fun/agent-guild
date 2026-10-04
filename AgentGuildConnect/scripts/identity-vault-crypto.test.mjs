import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { identityAddress, identityCurveAgrees, identityShared, openIdentityVault, sealIdentityVault } from "./identity-vault-crypto.mjs";

function pem() {
  return crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
}

const protocol = pem();
const agent = pem();
const user = pem();
const stranger = pem();
const recipients = {
  protocol: identityAddress(protocol),
  agent: identityAddress(agent),
  user: identityAddress(user),
};

test("an Ed25519 identity key is the same X25519 point from either side", () => {
  for (const key of [protocol, agent, user, stranger]) {
    assert.equal(identityCurveAgrees(key), true);
  }
  const shared = identityShared(protocol, recipients.agent);
  assert.equal(shared.length, 32);
  assert.equal(identityShared(agent, recipients.protocol).equals(shared), true);
  assert.equal(identityShared(protocol, recipients.user).equals(shared), false);
});

test("protocol, agent, and user each open the same slot", () => {
  const sealed = sealIdentityVault(agent, "memory", "the couch is past the kitchen", recipients);
  assert.equal(sealed.v, 2);
  assert.ok(sealed.wraps.protocol && sealed.wraps.agent && sealed.wraps.user);
  assert.equal(JSON.stringify(sealed).includes("couch"), false);
  for (const key of [protocol, agent, user]) {
    assert.equal(openIdentityVault(key, "memory", sealed), "the couch is past the kitchen");
  }
  assert.throws(() => openIdentityVault(stranger, "memory", sealed));
  assert.throws(() => openIdentityVault(agent, "capabilities", sealed));
});

test("a missing user copy leaves that wrap off", () => {
  const sealed = sealIdentityVault(agent, "memory", "protocol and agent only", {
    protocol: recipients.protocol,
    agent: recipients.agent,
    user: null,
  });
  assert.equal(sealed.wraps.user, null);
  assert.equal(openIdentityVault(protocol, "memory", sealed), "protocol and agent only");
  assert.equal(openIdentityVault(agent, "memory", sealed), "protocol and agent only");
  assert.throws(() => openIdentityVault(user, "memory", sealed));
});
