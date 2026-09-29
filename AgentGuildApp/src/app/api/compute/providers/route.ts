/**
 * GET /api/compute/providers — List available compute providers
 *
 * Returns availability status for all providers so the UI can:
 * - Show "unavailable" badge on providers missing credentials
 * - Disable the "Create Instance" button for unavailable providers
 * - Display the reason why a provider is unavailable
 */
import { NextRequest } from "next/server";
import { getWalletAddress } from "@/lib/auth-guard";
import { getAllProviderAvailability } from "@/lib/compute/provider";
import { PROVIDER_LABELS } from "@/lib/compute/types";

export async function GET(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const availability = getAllProviderAvailability();

  // Enrich with labels and metadata from types
  const providers = availability.map((p) => {
    const meta = PROVIDER_LABELS[p.provider as keyof typeof PROVIDER_LABELS];
    return {
      ...p,
      description: meta?.description || "",
      comingSoon: meta?.comingSoon || false,
    };
  });

  // Which provider would be auto-selected for new instances
  const defaultProvider = process.env.COMPUTE_PROVIDER
    || (process.env.E2B_API_KEY ? "e2b" : null);

  const anyAvailable = providers.some((p) => p.available);

  return Response.json({
    ok: true,
    providers,
    defaultProvider,
    anyAvailable,
    message: anyAvailable
      ? undefined
      : "No compute providers are configured. Set provider credentials in environment variables to enable instance creation.",
  });
}
