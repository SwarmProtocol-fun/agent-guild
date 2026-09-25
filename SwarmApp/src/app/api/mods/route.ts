/** GET /api/mods — installed runtime mods (manifest data only). */
import { listManifests } from "@/lib/mods/runtime";

export function GET() {
  return Response.json({
    mods: listManifests().map(({ id, name, version, description, author, permissions, panels }) => ({
      id, name, version, description, author, permissions, panels: panels ?? [],
    })),
  });
}
