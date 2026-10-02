/**
 * POST /api/v1/agents/:id/register-onchain
 *      Body: { orgId, name, skills?, feeRateBps? }
 *
 * Registers the agent on the Solana AgentGuild program under the agent's OWN
 * identity wallet (its `solanaAddress`, i.e. the address of its Ed25519
 * identity key) — never the dashboard user's connected wallet. The agent
 * holds that key, not the server, so the platform keypair sponsors the
 * transaction via `register_agent_for` (pays rent/fees, signs as payer) while
 * the on-chain AgentAccount and AsnRecord are keyed to the agent's address.
 * Auth: org membership.
 */
import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { FieldValue } from "firebase-admin/firestore";
import { requireOrgMember, unauthorized, forbidden } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import { adminDb } from "@/lib/firebase-admin";
import { registerAgentFor, solanaAddressFromEd25519Pem } from "@/lib/solana/client";
import { getPlatformKeypair, platformWallet, agentAlreadyRegistered } from "@/lib/solana/platform";

/** The agent's own Solana identity address — stored, or derived from its Ed25519 identity key. */
function resolveAgentAddress(agent: { solanaAddress?: string; publicKey?: string }): string | null {
  if (agent.solanaAddress) return agent.solanaAddress;
  if (agent.publicKey) {
    try {
      return solanaAddressFromEd25519Pem(agent.publicKey);
    } catch {
      return null;
    }
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: agentId } = await params;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgId = body.orgId as string | undefined;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const skills = typeof body.skills === "string" ? body.skills.trim() : "";
  const feeRateBps = body.feeRateBps === undefined ? 0 : Number(body.feeRateBps);
  if (!orgId) return Response.json({ error: "orgId is required" }, { status: 400 });
  if (!name) return Response.json({ error: "name is required" }, { status: 400 });
  if (!Number.isInteger(feeRateBps) || feeRateBps < 0 || feeRateBps > 10_000) {
    return Response.json({ error: "feeRateBps must be an integer between 0 and 10000" }, { status: 400 });
  }

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return auth.status === 403 ? forbidden(auth.error) : unauthorized(auth.error);

  const agent = await getAgent(agentId);
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
  if (agent.orgId !== orgId) {
    return Response.json({ error: "Agent does not belong to this organization" }, { status: 403 });
  }
  if (!agent.asn) return Response.json({ error: "Agent has no ASN yet" }, { status: 400 });

  const agentAddress = resolveAgentAddress(agent as typeof agent & { publicKey?: string });
  if (!agentAddress) {
    return Response.json(
      { error: "Agent has no Solana identity wallet — connect the agent (or generate its Solana wallet) first" },
      { status: 400 },
    );
  }

  const keypair = getPlatformKeypair();
  if (!keypair) {
    return Response.json({ error: "On-chain registration is not configured (SOLANA_PLATFORM_KEYPAIR missing)" }, { status: 503 });
  }

  if (await agentAlreadyRegistered(agentAddress)) {
    return Response.json({ error: "This agent's wallet is already registered on-chain" }, { status: 409 });
  }

  try {
    const txSignature = await registerAgentFor(platformWallet(keypair), {
      agentWallet: new PublicKey(agentAddress),
      name,
      skills,
      asn: agent.asn,
      feeRateBps,
    });
    await adminDb().collection("agents").doc(agentId).update({
      onChainTxHash: txSignature,
      onChainRegistered: true,
      onChainError: FieldValue.delete(),
    });
    return Response.json({ txSignature, agentAddress });
  } catch (err) {
    console.error("register-onchain error:", err);
    const message = err instanceof Error ? err.message : "Failed to register agent on-chain";
    return Response.json({ error: message }, { status: 500 });
  }
}
