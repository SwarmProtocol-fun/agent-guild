/**
 * GET  /api/compute/computers?orgId=xxx         — List computers for an org
 * GET  /api/compute/computers?workspaceId=xxx   — List computers in a workspace
 * POST /api/compute/computers                   — Create a new computer
 */
import { NextRequest } from "next/server";
import { getWalletAddress, requireOrgMember } from "@/lib/auth-guard";
import {
  getComputers,
  getComputersByWorkspace,
  createComputer,
  getWorkspace,
} from "@/lib/compute/firestore";
import { checkProviderAvailability } from "@/lib/compute/provider";
import { SIZE_PRESETS, DEFAULT_AUTO_STOP_MINUTES, DEFAULT_RESOLUTION, PROVIDER_SIZE_MAP, PROVIDER_REGION_MAP, PROVIDER_BASE_IMAGES } from "@/lib/compute/types";
import type { SizeKey, Region, ControllerType, ModelKey, ComputerMode, ProviderKey } from "@/lib/compute/types";

export async function GET(req: NextRequest) {
  const orgId = req.nextUrl.searchParams.get("orgId");
  const workspaceId = req.nextUrl.searchParams.get("workspaceId");

  if (!orgId && !workspaceId) {
    return Response.json({ error: "orgId or workspaceId required" }, { status: 400 });
  }

  if (workspaceId) {
    const ws = await getWorkspace(workspaceId);
    if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });

    const auth = await requireOrgMember(req, ws.orgId);
    if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

    const computers = await getComputersByWorkspace(workspaceId);
    return Response.json({ ok: true, computers });
  }

  const auth = await requireOrgMember(req, orgId!);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const statusFilter = req.nextUrl.searchParams.get("status") || undefined;
  const computers = await getComputers(orgId!, { status: statusFilter as import("@/lib/compute/types").ComputerStatus | undefined });
  return Response.json({ ok: true, computers });
}

export async function POST(req: NextRequest) {
  const wallet = getWalletAddress(req);
  if (!wallet) return Response.json({ error: "Authentication required" }, { status: 401 });

  const body = await req.json();
  const { workspaceId, name, sizeKey, region, controllerType, modelKey, mode, provider: bodyProvider } = body as {
    workspaceId: string;
    name: string;
    sizeKey?: SizeKey;
    region?: Region;
    controllerType?: ControllerType;
    modelKey?: ModelKey | null;
    mode?: ComputerMode;
    provider?: ProviderKey;
  };

  if (!workspaceId || !name) {
    return Response.json({ error: "workspaceId and name are required" }, { status: 400 });
  }

  // Validate enum fields
  const VALID_SIZES: SizeKey[] = ["small", "medium", "large", "xl"];
  const VALID_REGIONS: Region[] = ["us-east", "us-west", "eu-west", "ap-southeast"];
  const VALID_CONTROLLERS: ControllerType[] = ["human", "agent", "hybrid"];
  const VALID_MODELS: (ModelKey | null)[] = ["claude", "openai", "gemini", "generic", null];
  const VALID_PROVIDERS: ProviderKey[] = ["e2b", "aws", "gcp", "azure", "stub"];

  if (sizeKey && !VALID_SIZES.includes(sizeKey)) {
    return Response.json({ error: `Invalid sizeKey. Must be one of: ${VALID_SIZES.join(", ")}` }, { status: 400 });
  }
  if (region && !VALID_REGIONS.includes(region)) {
    return Response.json({ error: `Invalid region. Must be one of: ${VALID_REGIONS.join(", ")}` }, { status: 400 });
  }
  if (controllerType && !VALID_CONTROLLERS.includes(controllerType)) {
    return Response.json({ error: `Invalid controllerType. Must be one of: ${VALID_CONTROLLERS.join(", ")}` }, { status: 400 });
  }
  if (modelKey !== undefined && !VALID_MODELS.includes(modelKey)) {
    return Response.json({ error: `Invalid modelKey. Must be one of: ${VALID_MODELS.filter(Boolean).join(", ")}` }, { status: 400 });
  }
  if (bodyProvider && !VALID_PROVIDERS.includes(bodyProvider)) {
    return Response.json({ error: `Invalid provider. Must be one of: ${VALID_PROVIDERS.join(", ")}` }, { status: 400 });
  }
  if (typeof name !== "string" || name.length < 1 || name.length > 100) {
    return Response.json({ error: "name must be a string between 1 and 100 characters" }, { status: 400 });
  }

  // Validate numeric fields
  const resW = body.resolutionWidth;
  const resH = body.resolutionHeight;
  if (resW !== undefined && (typeof resW !== "number" || resW < 640 || resW > 3840)) {
    return Response.json({ error: "resolutionWidth must be between 640 and 3840" }, { status: 400 });
  }
  if (resH !== undefined && (typeof resH !== "number" || resH < 480 || resH > 2160)) {
    return Response.json({ error: "resolutionHeight must be between 480 and 2160" }, { status: 400 });
  }
  const autoStop = body.autoStopMinutes;
  if (autoStop !== undefined && (typeof autoStop !== "number" || autoStop < 0 || autoStop > 1440)) {
    return Response.json({ error: "autoStopMinutes must be between 0 and 1440" }, { status: 400 });
  }

  const ws = await getWorkspace(workspaceId);
  if (!ws) return Response.json({ error: "Workspace not found" }, { status: 404 });

  const auth = await requireOrgMember(req, ws.orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status || 401 });

  const size = sizeKey || "medium";
  const preset = SIZE_PRESETS[size];

  // Resolve provider: body > workspace default > env > e2b
  const resolvedProvider = (bodyProvider || ws.defaultProvider || process.env.COMPUTE_PROVIDER || "e2b") as import("@/lib/compute/types").ProviderKey;

  // ── Provider availability check ──
  // Fail loudly if the resolved provider is stub or has missing credentials.
  // This prevents phantom instances from being created in Firestore.
  const availability = checkProviderAvailability(resolvedProvider);
  if (!availability.available) {
    return Response.json(
      {
        error: "Compute provider unavailable",
        provider: resolvedProvider,
        providerLabel: availability.label,
        reason: availability.reason,
        message: `Cannot create instances — ${availability.reason}. Configure the required credentials or select a different provider.`,
      },
      { status: 503 },
    );
  }

  const id = await createComputer({
    workspaceId,
    orgId: ws.orgId,
    name: name.trim(),
    status: "stopped",
    provider: resolvedProvider,
    providerInstanceId: null,
    providerInstanceType: null,
    providerRegion: null,
    providerImage: null,
    providerMetadata: {},
    templateId: body.templateId || null,
    sizeKey: size,
    cpuCores: preset.cpu,
    ramMb: preset.ram,
    diskGb: preset.disk,
    resolutionWidth: resW || DEFAULT_RESOLUTION.width,
    resolutionHeight: resH || DEFAULT_RESOLUTION.height,
    region: region || "us-east",
    persistenceEnabled: body.persistenceEnabled ?? true,
    staticIpEnabled: body.staticIpEnabled ?? false,
    autoStopMinutes: autoStop ?? DEFAULT_AUTO_STOP_MINUTES,
    controllerType: controllerType || "human",
    modelKey: modelKey || null,
    openclawVariant: body.openclawVariant || null,
    ownerWallet: wallet,
    ownerOrgId: ws.orgId,
    transferable: true,
    listedForSale: false,
    listingPriceCents: null,
    listingDescription: null,
    createdByUserId: wallet,
  });

  return Response.json({ ok: true, id }, { status: 201 });
}
