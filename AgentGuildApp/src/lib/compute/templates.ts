/**
 * Swarm Compute — Template Helpers
 */

import type { ComputeTemplate, SizeKey, Region, ControllerType, ModelKey, ProviderKey } from "./types";
import { SIZE_PRESETS, DEFAULT_AUTO_STOP_MINUTES, DEFAULT_RESOLUTION } from "./types";
import { getTemplate, createComputer } from "./firestore";
import { getComputeProvider } from "./provider";

/**
 * Launch a new computer from a template.
 */
export async function launchFromTemplate(opts: {
  templateId: string;
  workspaceId: string;
  orgId: string;
  name: string;
  sizeKey?: SizeKey;
  region?: Region;
  provider?: ProviderKey;
  controllerType?: ControllerType;
  modelKey?: ModelKey | null;
  createdByUserId: string;
  autoStart?: boolean;
}): Promise<{ computerId: string }> {
  const template = await getTemplate(opts.templateId);
  if (!template) throw new Error("Template not found");

  const sizeKey = opts.sizeKey || "medium";
  const preset = SIZE_PRESETS[sizeKey];
  const providerKey = opts.provider || (process.env.COMPUTE_PROVIDER as ProviderKey) || "stub";

  const computerId = await createComputer({
    workspaceId: opts.workspaceId,
    orgId: opts.orgId,
    name: opts.name,
    status: opts.autoStart ? "provisioning" : "stopped",
    provider: providerKey,
    providerInstanceId: null,
    providerInstanceType: null,
    providerRegion: null,
    providerImage: null,
    providerMetadata: {},
    templateId: opts.templateId,
    sizeKey,
    cpuCores: preset.cpu,
    ramMb: preset.ram,
    diskGb: preset.disk,
    resolutionWidth: DEFAULT_RESOLUTION.width,
    resolutionHeight: DEFAULT_RESOLUTION.height,
    region: opts.region || "us-east",
    persistenceEnabled: true,
    staticIpEnabled: false,
    autoStopMinutes: DEFAULT_AUTO_STOP_MINUTES,
    controllerType: opts.controllerType || "human",
    modelKey: opts.modelKey || null,
    openclawVariant: null,
    ownerWallet: opts.createdByUserId,
    ownerOrgId: opts.orgId,
    transferable: true,
    listedForSale: false,
    listingPriceCents: null,
    listingDescription: null,
    createdByUserId: opts.createdByUserId,
  });

  if (opts.autoStart) {
    const provider = getComputeProvider(providerKey);
    try {
      const result = await provider.createInstance({
        name: opts.name,
        sizeKey,
        cpuCores: preset.cpu,
        ramMb: preset.ram,
        diskGb: preset.disk,
        resolutionWidth: DEFAULT_RESOLUTION.width,
        resolutionHeight: DEFAULT_RESOLUTION.height,
        region: opts.region || "us-east",
        baseImage: template.baseImage,
        startupScript: template.startupScript || undefined,
        persistenceEnabled: true,
      });
      // Update provider instance ID — import updateComputer inline to avoid circular
      const { updateComputer } = await import("./firestore");
      await updateComputer(computerId, {
        providerInstanceId: result.providerInstanceId,
        providerInstanceType: result.providerInstanceType || null,
        providerRegion: result.providerRegion || null,
        status: result.status,
      });
    } catch (err) {
      const { updateComputer } = await import("./firestore");
      await updateComputer(computerId, { status: "error" });
      console.error("[compute/templates] Auto-start failed:", err);
    }
  }

  return { computerId };
}

/**
 * Generate a slug from a template name.
 */
export function slugifyTemplate(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
