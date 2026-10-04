/**
 * Identity vault cipher. One payload, three wraps.
 *
 * Each identity NFT is three soulbound copies. The data key is sealed to
 * the holder of each copy:
 *   protocol — platform keypair (copy #1)
 *   agent    — this agent's Ed25519 key (copy #3)
 *   user     — the org owner's Solana wallet (copy #2), when that copy exists
 *
 * Any one of those private keys opens the slot. The hub stores the wraps
 * and never sees the data key.
 *
 * The public one-file CLI inlines these functions. Keep them identical.
 */
import crypto from "node:crypto";

const P = (1n << 255n) - 19n;
const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function readLe(buf) {
  let x = 0n;
  for (let i = 0; i < buf.length; i++) x += BigInt(buf[i]) << (8n * BigInt(i));
  return x;
}

function writeLe32(n) {
  const out = Buffer.alloc(32);
  let x = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Ed25519 public key (Solana address bytes) → X25519 public key. */
function edwardsToMontgomery(pub32) {
  const y = readLe(pub32) & ((1n << 255n) - 1n);
  const den = ((1n - y) % P + P) % P;
  const u = ((1n + y) * modPow(den, P - 2n, P)) % P;
  return writeLe32(u);
}

/** Ed25519 seed → X25519 scalar. SHA-512, then clamp. */
function seedToMontgomery(seed32) {
  const s = Buffer.from(crypto.createHash("sha512").update(seed32).digest().subarray(0, 32));
  s[0] &= 248;
  s[31] &= 127;
  s[31] |= 64;
  return s;
}

function b58decode(text) {
  if (typeof text !== "string" || !text) throw new Error("Missing identity address");
  let n = 0n;
  for (const ch of text) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("Bad identity address");
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  const body = Buffer.from(out.reverse());
  const raw = Buffer.concat([Buffer.alloc(zeros), body]);
  if (raw.length !== 32) throw new Error("Identity address must be 32 bytes");
  return raw;
}

function ed25519Seed(privateKeyPem) {
  const key = crypto.createPrivateKey({ key: privateKeyPem, format: "pem", type: "pkcs8" });
  const jwk = key.export({ format: "jwk" });
  if (!jwk.d) throw new Error("Identity key has no seed");
  return Buffer.from(jwk.d, "base64url");
}

function ed25519PublicRaw(privateKeyPem) {
  const key = crypto.createPrivateKey({ key: privateKeyPem, format: "pem", type: "pkcs8" });
  const der = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  return der.subarray(der.length - 32);
}

function x25519Private(scalar) {
  return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, scalar]), format: "der", type: "pkcs8" });
}

function x25519Public(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: "der", type: "spki" });
}

function wrapKey(dek, recipientAddress) {
  const recipient = x25519Public(edwardsToMontgomery(b58decode(recipientAddress)));
  const eph = crypto.generateKeyPairSync("x25519");
  const ephDer = eph.publicKey.export({ type: "spki", format: "der" });
  const ephRaw = ephDer.subarray(ephDer.length - 32);
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, ephRaw, Buffer.from("agent-guild-wrap-v2"), 32));
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const boxed = Buffer.concat([cipher.update(dek), cipher.final(), cipher.getAuthTag()]);
  return { eph: ephRaw.toString("base64"), nonce: nonce.toString("base64"), boxed: boxed.toString("base64") };
}

function unwrapKey(wrap, seed) {
  const eph = x25519Public(Buffer.from(wrap.eph, "base64"));
  const shared = crypto.diffieHellman({ privateKey: x25519Private(seedToMontgomery(seed)), publicKey: eph });
  const ephRaw = Buffer.from(wrap.eph, "base64");
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, ephRaw, Buffer.from("agent-guild-wrap-v2"), 32));
  const raw = Buffer.from(wrap.boxed, "base64");
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(wrap.nonce, "base64"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * Seal plaintext for one slot. `recipients` is { protocol, agent, user }
 * as Solana addresses. `user` may be null when copy #2 is not minted yet.
 */
export function sealIdentityVault(privateKeyPem, slot, plaintext, recipients) {
  if (!recipients?.protocol || !recipients?.agent) throw new Error("protocol and agent identity keys are required");
  const dek = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", dek, nonce);
  cipher.setAAD(Buffer.from(`v2:${slot}`, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    v: 2,
    nonce: nonce.toString("base64"),
    ciphertext: body.toString("base64"),
    wraps: {
      protocol: wrapKey(dek, recipients.protocol),
      agent: wrapKey(dek, recipients.agent),
      user: recipients.user ? wrapKey(dek, recipients.user) : null,
    },
  };
}

/** Open a slot with whichever of the three identity keys this PEM is. */
export function openIdentityVault(privateKeyPem, slot, record) {
  const seed = ed25519Seed(privateKeyPem);
  const wraps = record?.wraps || {};
  const order = [wraps.agent, wraps.protocol, wraps.user].filter(Boolean);
  let dek = null;
  for (const wrap of order) {
    try {
      dek = unwrapKey(wrap, seed);
      break;
    } catch { /* this wrap belongs to one of the other two holders */ }
  }
  if (!dek) throw new Error("None of the identity keys on this machine opened the slot");
  const raw = Buffer.from(record.ciphertext, "base64");
  const tag = raw.subarray(raw.length - 16);
  const body = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", dek, Buffer.from(record.nonce, "base64"));
  decipher.setAAD(Buffer.from(`v2:${slot}`, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/**
 * The clamped Ed25519 seed and the Edwards public key must land on the
 * same X25519 point. Node multiplies the scalar; we map the point.
 */
export function identityCurveAgrees(privateKeyPem) {
  const derived = crypto.createPublicKey(x25519Private(seedToMontgomery(ed25519Seed(privateKeyPem)))).export({ type: "spki", format: "der" });
  const mapped = edwardsToMontgomery(ed25519PublicRaw(privateKeyPem));
  return Buffer.from(derived).subarray(derived.length - 32).equals(mapped);
}

/** X25519 shared secret between this identity key and another Solana address. */
export function identityShared(privateKeyPem, recipientAddress) {
  const recipient = x25519Public(edwardsToMontgomery(b58decode(recipientAddress)));
  return Buffer.from(crypto.diffieHellman({
    privateKey: x25519Private(seedToMontgomery(ed25519Seed(privateKeyPem))),
    publicKey: recipient,
  }));
}

/** Solana address for an Ed25519 PEM. Same bytes the NFT copy is minted to. */
export function identityAddress(privateKeyPem) {
  const raw = ed25519PublicRaw(privateKeyPem);
  let zeros = 0;
  while (zeros < raw.length && raw[zeros] === 0) zeros++;
  let n = 0n;
  for (const byte of raw) n = (n << 8n) | BigInt(byte);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return "1".repeat(zeros) + (out || "");
}
