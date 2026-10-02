/**
 * POST /api/v1/shroud/openai/v1/chat/completions — OpenAI Chat Completions through Shroud.
 * SDK: new OpenAI({ baseURL: "https://agent-guild.com/api/v1/shroud/openai/v1", apiKey: "<agt_ token>" })
 */
import { handleShroud } from "@/lib/shroud/proxy";

export const maxDuration = 300;

export async function POST(req: Request) {
  return handleShroud("openai", req);
}
