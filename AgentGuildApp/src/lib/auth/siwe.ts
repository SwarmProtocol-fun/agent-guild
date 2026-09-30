/**
 * Server-side SIWE (EIP-4361) helpers, provider-agnostic.
 *
 * Any wallet adapter that can personal_sign works: the client asks for a
 * payload, signs the returned `message`, and posts { payload, signature }
 * back. The nonce is an HMAC over (random, address, expiry) keyed with
 * SESSION_SECRET, so the server stays stateless but can prove it issued it.
 * Smart-contract wallets are supported via ERC-1271/6492 verification.
 *
 * Solana wallets use the same payload/nonce machinery but a different
 * address format (base58, case-sensitive) and signature scheme (Ed25519,
 * verified directly — no RPC needed). Distinguished by `chainId === 0`,
 * the non-EVM sentinel this codebase already uses (see src/lib/chains.ts).
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { createPublicClient, getAddress, http, isAddress, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { CHAIN_CONFIGS } from "@/lib/chains";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";

const SOLANA_CHAIN_ID = 0;

function isSolanaAddress(address: string): boolean {
  try {
    const key = new PublicKey(address);
    return PublicKey.isOnCurve(key.toBytes());
  } catch {
    return false;
  }
}

const STATEMENT = "Sign in to Agent Guild — this does not trigger a blockchain transaction or cost gas.";
const EXPIRATION_SECONDS = 600;
const CLOCK_SKEW_MS = 60_000;

export interface SiwePayload {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: "1";
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET must be set to issue login payloads.");
  return s;
}

function mac(random: string, address: string, expirationTime: string): string {
  return createHmac("sha256", secret())
    .update(`${random}|${canonicalizeWalletAddress(address)}|${expirationTime}`)
    .digest("hex")
    .slice(0, 32);
}

// Mirrors the EIP-4361 message viem/siwe produces, worded for a Solana
// account instead — Solana has no equivalent standard library here, and
// viem's createSiweMessage hardcodes EVM address checksumming, so this is
// built by hand rather than forced through an EVM-shaped helper.
function toSolanaMessage(p: SiwePayload): string {
  return `${p.domain} wants you to sign in with your Solana account:
${p.address}

${p.statement}

URI: ${p.uri}
Version: ${p.version}
Chain ID: ${p.chainId}
Nonce: ${p.nonce}
Issued At: ${p.issuedAt}
Expiration Time: ${p.expirationTime}`;
}

function toMessage(p: SiwePayload): string {
  if (p.chainId === SOLANA_CHAIN_ID) return toSolanaMessage(p);
  return createSiweMessage({
    domain: p.domain,
    address: getAddress(p.address),
    statement: p.statement,
    uri: p.uri,
    version: p.version,
    chainId: p.chainId,
    nonce: p.nonce,
    issuedAt: new Date(p.issuedAt),
    expirationTime: new Date(p.expirationTime),
  });
}

export function generateSiwePayload(opts: {
  address: string;
  chainId?: number;
  domain: string;
  uri: string;
}): { payload: SiwePayload; message: string } {
  // `chainId === 0` is Solana's non-EVM sentinel (see chains.ts) — must be
  // distinguished from "omitted" (undefined), which still defaults to EVM
  // mainnet (1). A bare `opts.chainId && ...` here would treat 0 as falsy
  // and silently default a Solana login to Ethereum mainnet.
  const chainId = opts.chainId !== undefined ? opts.chainId : 1;
  const isSolana = chainId === SOLANA_CHAIN_ID;

  let address: string;
  if (isSolana) {
    if (!isSolanaAddress(opts.address)) throw new Error("Invalid address");
    address = new PublicKey(opts.address).toBase58();
  } else {
    if (!isAddress(opts.address, { strict: false })) throw new Error("Invalid address");
    address = getAddress(opts.address);
  }

  const now = Date.now();
  const expirationTime = new Date(now + EXPIRATION_SECONDS * 1000).toISOString();
  const random = randomBytes(16).toString("hex");
  const payload: SiwePayload = {
    domain: opts.domain,
    address,
    statement: STATEMENT,
    uri: opts.uri,
    version: "1",
    chainId,
    nonce: random + mac(random, address, expirationTime),
    issuedAt: new Date(now).toISOString(),
    expirationTime,
  };
  return { payload, message: toMessage(payload) };
}

export type SiweVerification =
  | { valid: true; payload: { address: string } }
  | { valid: false; error: string };

export async function verifySiwePayload(opts: {
  payload: SiwePayload;
  signature: string;
  domain: string;
}): Promise<SiweVerification> {
  const { payload, signature, domain } = opts;
  if (!payload || typeof payload !== "object") return { valid: false, error: "Malformed payload" };
  const isSolana = payload.chainId === SOLANA_CHAIN_ID;
  if (isSolana ? !isSolanaAddress(payload.address) : !isAddress(payload.address, { strict: false })) {
    return { valid: false, error: "Invalid address" };
  }
  if (payload.domain !== domain) return { valid: false, error: "Domain mismatch" };
  if (payload.statement !== STATEMENT || payload.version !== "1") return { valid: false, error: "Unexpected message" };

  const expires = Date.parse(payload.expirationTime);
  const issued = Date.parse(payload.issuedAt);
  if (!Number.isFinite(expires) || !Number.isFinite(issued)) return { valid: false, error: "Invalid timestamps" };
  if (expires < Date.now()) return { valid: false, error: "Login payload expired" };
  if (issued > Date.now() + CLOCK_SKEW_MS) return { valid: false, error: "Payload issued in the future" };

  const random = payload.nonce?.slice(0, 32) ?? "";
  const given = Buffer.from(payload.nonce?.slice(32) ?? "");
  const expected = Buffer.from(mac(random, payload.address, payload.expirationTime));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { valid: false, error: "Invalid nonce" };
  }

  const message = toMessage(payload);

  if (isSolana) {
    const address = new PublicKey(payload.address).toBase58();
    try {
      const sigBytes = Buffer.from(signature, "base64");
      const pubkeyBytes = bs58.decode(address);
      const messageBytes = new TextEncoder().encode(message);
      if (nacl.sign.detached.verify(messageBytes, sigBytes, pubkeyBytes)) {
        return { valid: true, payload: { address } };
      }
    } catch { /* malformed signature */ }
    return { valid: false, error: "Signature does not match address" };
  }

  const address = getAddress(payload.address);
  const sig = signature as Hex;

  // EOA: recover locally, no RPC needed.
  try {
    if ((await recoverMessageAddress({ message, signature: sig })) === address) {
      return { valid: true, payload: { address } };
    }
  } catch { /* not an ECDSA signature — try contract-wallet verification */ }

  // Smart-contract wallet (ERC-1271 / ERC-6492) on the chain it signed for.
  // Looked up across ALL configured chains, not just ones enabled for
  // payments/UI — a social-login embedded wallet (e.g. Google via Reown
  // AppKit) defaults to Ethereum mainnet, which is `enabled: false` in
  // chains.ts (payments aren't live there yet), but its signatures still
  // need to verify against that chain's RPC.
  try {
    const rpc = Object.values(CHAIN_CONFIGS).find((c) => c.chainId === payload.chainId)?.rpc;
    const client = createPublicClient({ transport: http(rpc) });
    if (await client.verifyMessage({ address, message, signature: sig })) {
      return { valid: true, payload: { address } };
    }
  } catch { /* fall through */ }

  return { valid: false, error: "Signature does not match address" };
}

/**
 * Domain from the request Host header so it matches the site the user is on
 * (localhost, preview deploys, production). Falls back to env / default.
 */
export function getDomainFromRequest(req: Request): string {
  const host = req.headers.get("host")
    || req.headers.get("x-forwarded-host")
    || process.env.APP_DOMAIN
    || process.env.NEXT_PUBLIC_APP_DOMAIN
    || "agent-guild.com";
  return host.replace(/:443$/, "").replace(/:80$/, "");
}

export function getOriginFromRequest(req: Request, domain: string): string {
  const proto = req.headers.get("x-forwarded-proto")
    || (domain.startsWith("localhost") || domain.startsWith("127.") ? "http" : "https");
  return `${proto}://${domain}`;
}
