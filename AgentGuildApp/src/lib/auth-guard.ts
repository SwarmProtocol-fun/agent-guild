/**
 * Shared authorization guards for API routes.
 *
 * Provides consistent auth checks and error responses across all endpoints.
 * Guards are composable — each returns { ok, error?, status?, ... } so callers
 * can decide how to respond.
 *
 * Auth tiers (from least to most privileged):
 *   1. public read        — no auth needed (catalog, prices)
 *   2. agent-signed       — Ed25519 signature or API key
 *   3. authenticated user — wallet address + org membership
 *   4. org admin          — wallet address + org ownership
 *   5. platform admin     — PLATFORM_ADMIN_SECRET bearer token
 *   6. internal service   — INTERNAL_SERVICE_SECRET bearer token
 */
import { NextRequest } from "next/server";
import { verifyAgentRequest, isTimestampFresh } from "@/app/api/v1/verify";
import { authenticateAgent, type AuthResult } from "@/app/api/webhooks/auth";
import { getOrganization, type Organization } from "@/lib/firestore";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import crypto from "crypto";

// ─── Standard error responses ────────────────────────────

export function authError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

export function unauthorized(message = "Authentication required") {
  return authError(message, 401);
}

export function forbidden(message = "Insufficient permissions") {
  return authError(message, 403);
}

// ─── Platform admin (wallet session OR env-based secret) ─

/** Platform admin addresses from env (PLATFORM_ADMIN_WALLETS=addr1,addr2) */
const PLATFORM_ADMINS = new Set(
  (process.env.PLATFORM_ADMIN_WALLETS || "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean),
);

export function requirePlatformAdmin(req: NextRequest): { ok: boolean; error?: string } {
  // 1. Wallet-based auth via session (injected by middleware)
  const sessionRole = req.headers.get("x-session-role");
  const walletAddress = req.headers.get("x-wallet-address")?.toLowerCase();

  if (sessionRole === "platform_admin") {
    return { ok: true };
  }

  if (walletAddress && PLATFORM_ADMINS.has(walletAddress)) {
    return { ok: true };
  }

  // 2. Secret-based auth (programmatic / API access fallback)
  const secret = process.env.PLATFORM_ADMIN_SECRET;
  if (secret) {
    const authHeader = req.headers.get("authorization") || "";
    const headerSecret = req.headers.get("x-platform-secret") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

    let tokenMatch = false;
    let headerMatch = false;

    try {
      if (token.length === secret.length) {
        tokenMatch = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
      }
    } catch {
      tokenMatch = false;
    }

    try {
      if (headerSecret.length === secret.length) {
        headerMatch = crypto.timingSafeEqual(Buffer.from(headerSecret), Buffer.from(secret));
      }
    } catch {
      headerMatch = false;
    }

    if (tokenMatch || headerMatch) {
      return { ok: true };
    }
  }

  return { ok: false, error: "Platform admin access required" };
}

// ─── Internal service (env-based secret) ─────────────────

export function requireInternalService(req: NextRequest): { ok: boolean; error?: string } {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    return { ok: false, error: "Internal service auth not configured" };
  }

  const authHeader = req.headers.get("authorization") || "";
  const headerSecret = req.headers.get("x-service-secret") || "";

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // Timing-safe comparison to prevent timing attacks
  let tokenMatch = false;
  let headerMatch = false;

  try {
    if (token.length === secret.length) {
      tokenMatch = crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
    }
  } catch {
    tokenMatch = false;
  }

  try {
    if (headerSecret.length === secret.length) {
      headerMatch = crypto.timingSafeEqual(Buffer.from(headerSecret), Buffer.from(secret));
    }
  } catch {
    headerMatch = false;
  }

  if (tokenMatch || headerMatch) {
    return { ok: true };
  }

  return { ok: false, error: "Invalid service credentials" };
}

// ─── Org membership / ownership ──────────────────────────

export interface OrgAuthResult {
  ok: boolean;
  org?: Organization;
  walletAddress?: string;
  error?: string;
  status?: number;
}

/** Extract wallet address from request headers. */
export function getWalletAddress(req: NextRequest): string | null {
  const raw = req.headers.get("x-wallet-address");
  return raw ? canonicalizeWalletAddress(raw) : null;
}

/**
 * Verify the caller is a member (or owner) of the specified org.
 * Requires `x-wallet-address` header.
 */
export async function requireOrgMember(
  req: NextRequest,
  orgId: string,
): Promise<OrgAuthResult> {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return { ok: false, error: "Missing x-wallet-address header", status: 401 };
  }

  const org = await getOrganization(orgId);
  if (!org) {
    return { ok: false, error: "Organization not found", status: 404 };
  }

  const isOwner = org.ownerAddress != null && canonicalizeWalletAddress(org.ownerAddress) === wallet;
  const isMember = org.members?.some((m) => canonicalizeWalletAddress(m) === wallet);

  if (!isOwner && !isMember) {
    return { ok: false, error: "Not a member of this organization", status: 403 };
  }

  return { ok: true, org, walletAddress: wallet };
}

/**
 * Verify a wallet address is a member (or owner) of the specified org.
 * Same check as `requireOrgMember`, but for callers that already have a
 * verified wallet address in hand instead of a `NextRequest` to read the
 * `x-wallet-address` header from — e.g. mod routes, which get the caller's
 * address from the session object `/api/mods/*` already built server-side
 * (see `ModSession` in `@agent-guild/sdk`).
 */
export async function requireOrgMembershipByAddress(
  walletAddress: string,
  orgId: string,
): Promise<OrgAuthResult> {
  const wallet = canonicalizeWalletAddress(walletAddress);
  const org = await getOrganization(orgId);
  if (!org) {
    return { ok: false, error: "Organization not found", status: 404 };
  }

  const isOwner = org.ownerAddress != null && canonicalizeWalletAddress(org.ownerAddress) === wallet;
  const isMember = org.members?.some((m) => canonicalizeWalletAddress(m) === wallet);

  if (!isOwner && !isMember) {
    return { ok: false, error: "Not a member of this organization", status: 403 };
  }

  return { ok: true, org, walletAddress: wallet };
}

/**
 * Verify the caller is the owner (admin) of the specified org.
 * Requires `x-wallet-address` header.
 */
export async function requireOrgAdmin(
  req: NextRequest,
  orgId: string,
): Promise<OrgAuthResult> {
  const wallet = getWalletAddress(req);
  if (!wallet) {
    return { ok: false, error: "Missing x-wallet-address header", status: 401 };
  }

  const org = await getOrganization(orgId);
  if (!org) {
    return { ok: false, error: "Organization not found", status: 404 };
  }

  if (org.ownerAddress == null || canonicalizeWalletAddress(org.ownerAddress) !== wallet) {
    return { ok: false, error: "Only the organization owner can perform this action", status: 403 };
  }

  return { ok: true, org, walletAddress: wallet };
}

// ─── Agent auth (unified Ed25519 + API key) ──────────────

export interface AgentAuthResult {
  ok: boolean;
  agent?: AuthResult & { orgId: string };
  error?: string;
}

/**
 * Authenticate an agent via Ed25519 signature OR API key.
 *
 * Ed25519 params (query): agent, sig, ts
 * API key params (query): agentId, apiKey
 *
 * @param signedMessage — The message format to verify against (e.g. "POST:/v1/credit/task-complete:<ts>")
 *                        Only needed for Ed25519. If null, skips Ed25519 and only tries API key.
 */
export async function requireAgentAuth(
  req: NextRequest,
  signedMessagePrefix?: string,
): Promise<AgentAuthResult> {
  const url = req.nextUrl;

  // Try Ed25519 first
  const agentParam = url.searchParams.get("agent");
  const sig = url.searchParams.get("sig");
  const ts = url.searchParams.get("ts");

  if (agentParam && sig && ts && signedMessagePrefix) {
    const tsNum = parseInt(ts, 10);
    if (!isTimestampFresh(tsNum)) {
      return { ok: false, error: "Stale timestamp" };
    }

    const message = `${signedMessagePrefix}:${ts}`;
    const verified = await verifyAgentRequest(agentParam, message, sig);
    if (!verified) {
      return { ok: false, error: "Invalid signature" };
    }

    return {
      ok: true,
      agent: {
        agentId: verified.agentId,
        agentName: verified.agentName,
        orgId: verified.orgId,
        agentType: verified.agentType,
      },
    };
  }

  // Fallback: API key
  const agentId = url.searchParams.get("agentId") || (agentParam ?? null);
  const apiKey = url.searchParams.get("apiKey");
  const auth = await authenticateAgent(agentId, apiKey);
  if (!auth) {
    return { ok: false, error: "Invalid agent credentials" };
  }

  return {
    ok: true,
    agent: {
      agentId: auth.agentId,
      orgId: auth.orgId,
      agentName: auth.agentName,
      agentType: auth.agentType,
    },
  };
}

// ─── Combined: platform admin OR org member ──────────────

/**
 * Allow access if the caller is either a platform admin or an org member.
 * Useful for routes that platform admins should be able to bypass.
 */
export async function requirePlatformAdminOrOrgMember(
  req: NextRequest,
  orgId: string,
): Promise<OrgAuthResult> {
  const adminCheck = requirePlatformAdmin(req);
  if (adminCheck.ok) {
    const org = await getOrganization(orgId);
    return { ok: true, org: org || undefined };
  }

  return requireOrgMember(req, orgId);
}

// ─── Combined: platform admin OR agent auth ──────────────

/**
 * Allow access if the caller is either a platform admin or an authenticated agent.
 */
export async function requirePlatformAdminOrAgent(
  req: NextRequest,
  signedMessagePrefix?: string,
): Promise<{ ok: boolean; agent?: AgentAuthResult["agent"]; isPlatformAdmin?: boolean; error?: string }> {
  const adminCheck = requirePlatformAdmin(req);
  if (adminCheck.ok) {
    return { ok: true, isPlatformAdmin: true };
  }

  const agentCheck = await requireAgentAuth(req, signedMessagePrefix);
  if (agentCheck.ok) {
    return { ok: true, agent: agentCheck.agent };
  }

  return { ok: false, error: "Platform admin credentials or agent authentication required" };
}

// ─── Gateway auth (Ed25519 signature) ───────────────────

export interface GatewayAuthResult {
  ok: boolean;
  gateway?: { gatewayId: string; workerName: string; orgId: string; region: string };
  error?: string;
}

/**
 * Authenticate a gateway worker via Ed25519 signature.
 *
 * Query params: gateway, sig, ts
 * Signed message format: "{prefix}:{ts}"
 */
export async function requireGatewayAuth(
  req: NextRequest,
  signedMessagePrefix: string,
): Promise<GatewayAuthResult> {
  const { verifyGatewayRequest, isTimestampFresh } = await import(
    "@/app/api/v1/gateway/verify"
  );

  const url = req.nextUrl;
  const gatewayId = url.searchParams.get("gateway");
  const sig = url.searchParams.get("sig");
  const ts = url.searchParams.get("ts");

  if (!gatewayId || !sig || !ts) {
    return { ok: false, error: "Missing gateway, sig, or ts query params" };
  }

  const tsNum = parseInt(ts, 10);
  if (!isTimestampFresh(tsNum)) {
    return { ok: false, error: "Stale timestamp" };
  }

  const message = `${signedMessagePrefix}:${ts}`;
  const result = await verifyGatewayRequest(gatewayId, message, sig);
  if (!result) {
    return { ok: false, error: "Invalid gateway signature" };
  }

  return { ok: true, gateway: result };
}

// Credit policy resolution (resolveAgentPolicy / PolicyGuardResult) lives in
// ./agent-policy.ts — it must stay free of this file's firebase-admin
// dependency so client-reachable dynamic imports of it don't pull
// firebase-admin into the browser bundle.
