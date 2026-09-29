/**
 * Server-side SIWE (EIP-4361) helpers, provider-agnostic.
 *
 * Any wallet adapter that can personal_sign works: the client asks for a
 * payload, signs the returned `message`, and posts { payload, signature }
 * back. The nonce is an HMAC over (random, address, expiry) keyed with
 * SESSION_SECRET, so the server stays stateless but can prove it issued it.
 * Smart-contract wallets are supported via ERC-1271/6492 verification.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { createPublicClient, getAddress, http, isAddress, recoverMessageAddress, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { getChainById } from "@/lib/chains";

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
    .update(`${random}|${address.toLowerCase()}|${expirationTime}`)
    .digest("hex")
    .slice(0, 32);
}

function toMessage(p: SiwePayload): string {
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
  if (!isAddress(opts.address, { strict: false })) throw new Error("Invalid address");
  const address = getAddress(opts.address);
  const now = Date.now();
  const expirationTime = new Date(now + EXPIRATION_SECONDS * 1000).toISOString();
  const random = randomBytes(16).toString("hex");
  const payload: SiwePayload = {
    domain: opts.domain,
    address,
    statement: STATEMENT,
    uri: opts.uri,
    version: "1",
    chainId: opts.chainId && opts.chainId > 0 ? opts.chainId : 1,
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
  if (!isAddress(payload.address, { strict: false })) return { valid: false, error: "Invalid address" };
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

  const address = getAddress(payload.address);
  const message = toMessage(payload);
  const sig = signature as Hex;

  // EOA: recover locally, no RPC needed.
  try {
    if ((await recoverMessageAddress({ message, signature: sig })) === address) {
      return { valid: true, payload: { address } };
    }
  } catch { /* not an ECDSA signature — try contract-wallet verification */ }

  // Smart-contract wallet (ERC-1271 / ERC-6492) on the chain it signed for.
  try {
    const rpc = getChainById(payload.chainId)?.rpc;
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
