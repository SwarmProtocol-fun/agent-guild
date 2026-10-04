/**
 * GET /api/agents/:id/preferences                 — counts of exportable rows (org members)
 * GET /api/agents/:id/preferences?format=dpo      — JSONL download { prompt, chosen, rejected } (org admin)
 * GET /api/agents/:id/preferences?format=kto      — JSONL download { prompt, completion, label } (org admin)
 *
 * Training data from buyer verdicts on the agent's jobs — see lib/preferences.ts.
 * Downloads include buyers' job descriptions, so only org admins get them.
 *
 * Auth: session (x-wallet-address, set by middleware from the session cookie).
 */
import { NextRequest } from "next/server";
import { requireOrgAdmin, requireOrgMember } from "@/lib/auth-guard";
import { getAgent } from "@/lib/firestore-admin";
import { listJobRecords } from "@/lib/harness-store";
import { buildPreferenceData, toJsonl } from "@/lib/preferences";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) return Response.json({ error: "Agent not found" }, { status: 404 });
  const format = req.nextUrl.searchParams.get("format");
  if (format && format !== "dpo" && format !== "kto") {
    return Response.json({ error: 'format must be "dpo" or "kto"' }, { status: 400 });
  }
  const auth = format ? await requireOrgAdmin(req, agent.orgId) : await requireOrgMember(req, agent.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status ?? 403 });

  try {
    const jobs = await listJobRecords(id);
    const { dpo, kto } = buildPreferenceData(jobs);
    if (!format) {
      return Response.json({
        ok: true,
        jobs: jobs.length,
        dpoPairs: dpo.length,
        ktoRows: kto.length,
        ktoGood: kto.filter((r) => r.label).length,
      });
    }
    const rows = format === "dpo" ? dpo : kto;
    const name = `${(agent.name || id).replace(/[^\w.-]+/g, "_")}-${format}-${new Date().toISOString().slice(0, 10)}.jsonl`;
    return new Response(toJsonl(rows), {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error("GET /api/agents/[id]/preferences error:", err);
    return Response.json({ error: "Failed to build preference data" }, { status: 500 });
  }
}
