/**
 * POST /api/v1/shroud/anthropic/v1/messages — Anthropic Messages API through Shroud.
 * SDK: new Anthropic({ baseURL: "https://agent-guild.com/api/v1/shroud/anthropic", apiKey: "<agt_ token>" })
 */
import { handleShroud } from "@/lib/shroud/proxy";

export const maxDuration = 300;

export async function POST(req: Request) {
  return handleShroud("anthropic", req);
}
