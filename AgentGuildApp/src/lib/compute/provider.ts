/**
 * Swarm Compute — Provider Abstraction
 *
 * Decouples all compute operations from any specific VM provider.
 * Supports E2B Desktop Sandbox as the primary real provider.
 * StubComputeProvider used for development when no E2B_API_KEY is set.
 */

import type { InstanceConfig, ProviderResult, ActionEnvelope, ActionResult } from "./types";

// ═══════════════════════════════════════════════════════════════
// Provider Interface
// ═══════════════════════════════════════════════════════════════

export interface ComputeProvider {
  readonly name: string;
  createInstance(config: InstanceConfig): Promise<ProviderResult>;
  startInstance(providerInstanceId: string): Promise<void>;
  stopInstance(providerInstanceId: string): Promise<void>;
  restartInstance(providerInstanceId: string): Promise<void>;
  deleteInstance(providerInstanceId: string): Promise<void>;
  takeScreenshot(providerInstanceId: string): Promise<{ url: string; base64?: string }>;
  executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult>;
  getVncUrl(providerInstanceId: string): Promise<string>;
  getTerminalUrl(providerInstanceId: string): Promise<string>;
  createSnapshot(providerInstanceId: string, label: string): Promise<string>;
  cloneInstance(providerInstanceId: string, newName: string): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════
// Provider Availability
// ═══════════════════════════════════════════════════════════════

export interface ProviderAvailability {
  provider: string;
  available: boolean;
  reason?: string;
  label: string;
}

/**
 * Check whether a provider has the required credentials configured.
 * Returns availability status with a human-readable reason if unavailable.
 */
export function checkProviderAvailability(providerKey: string): ProviderAvailability {
  const cred = PROVIDER_CREDENTIALS[providerKey];
  const labels: Record<string, string> = {
    e2b: "E2B Desktop",
    azure: "Microsoft Azure",
    aws: "AWS EC2",
    gcp: "GCP Compute Engine",
    "swarm-node": "Swarm Node",
    stub: "Development (Stub)",
  };

  const label = labels[providerKey] || providerKey;

  // Stub provider is always "available" in dev but must be flagged
  if (providerKey === "stub") {
    return {
      provider: providerKey,
      available: false,
      reason: "Stub provider is for development only — no real instances will be created",
      label,
    };
  }

  if (!cred) {
    return { provider: providerKey, available: true, label };
  }

  if (!process.env[cred.envVar]) {
    return {
      provider: providerKey,
      available: false,
      reason: `Missing required credential: ${cred.label}`,
      label,
    };
  }

  return { provider: providerKey, available: true, label };
}

/**
 * Check availability for all known providers.
 */
export function getAllProviderAvailability(): ProviderAvailability[] {
  return ["e2b", "azure", "aws", "gcp", "swarm-node", "stub"].map(checkProviderAvailability);
}

// ═══════════════════════════════════════════════════════════════
// E2B Desktop Provider
// ═══════════════════════════════════════════════════════════════

export class E2BComputeProvider implements ComputeProvider {
  readonly name = "e2b";

  /** Lazy import to avoid loading E2B SDK at module level in client bundles */
  private async sdk() {
    const { Sandbox } = await import("@e2b/desktop");
    return Sandbox;
  }

  async createInstance(config: InstanceConfig): Promise<ProviderResult> {
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.create({
      resolution: [config.resolutionWidth, config.resolutionHeight],
      timeoutMs: 300_000, // 5 min creation timeout
    });

    // Start VNC stream immediately so desktop viewer works
    await sandbox.stream.start({ requireAuth: true });

    return {
      providerInstanceId: sandbox.sandboxId,
      status: "running",
    };
  }

  async startInstance(providerInstanceId: string): Promise<void> {
    // E2B sandboxes are created running. "Start" means reconnect and ensure stream is up.
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.connect(providerInstanceId);
    try {
      await sandbox.stream.start({ requireAuth: true });
    } catch {
      // Stream may already be running
    }
  }

  async stopInstance(providerInstanceId: string): Promise<void> {
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.connect(providerInstanceId);
    await sandbox.stream.stop().catch(() => {});
    await sandbox.kill();
  }

  async restartInstance(providerInstanceId: string): Promise<void> {
    // E2B doesn't have restart — kill and re-create would lose state.
    // For now, just reboot via command.
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.connect(providerInstanceId);
    await sandbox.commands.run("sudo reboot").catch(() => {});
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.connect(providerInstanceId);
    await sandbox.stream.stop().catch(() => {});
    await sandbox.kill();
  }

  async takeScreenshot(providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.connect(providerInstanceId);
    const screenshot = await sandbox.screenshot();
    // screenshot returns a base64 PNG image
    const base64 = typeof screenshot === "string" ? screenshot : Buffer.from(screenshot).toString("base64");
    return {
      url: `data:image/png;base64,${base64}`,
      base64,
    };
  }

  async executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.connect(providerInstanceId);
    const start = Date.now();

    try {
      switch (action.actionType) {
        case "click": {
          const x = action.payload.x as number;
          const y = action.payload.y as number;
          await sandbox.leftClick(x, y);
          break;
        }
        case "double_click": {
          const x = action.payload.x as number;
          const y = action.payload.y as number;
          await sandbox.doubleClick(x, y);
          break;
        }
        case "type": {
          const text = action.payload.text as string;
          await sandbox.write(text);
          break;
        }
        case "key": {
          const key = action.payload.key as string;
          await sandbox.press(key);
          break;
        }
        case "scroll": {
          const direction = (action.payload.direction as "up" | "down") || "down";
          const amount = (action.payload.amount as number) || 3;
          if (action.payload.x !== undefined && action.payload.y !== undefined) {
            await sandbox.moveMouse(action.payload.x as number, action.payload.y as number);
          }
          await sandbox.scroll(direction, amount);
          break;
        }
        case "drag": {
          const from = action.payload.from as [number, number];
          const to = action.payload.to as [number, number];
          await sandbox.drag(from, to);
          break;
        }
        case "screenshot": {
          const screenshot = await sandbox.screenshot();
          const base64 = typeof screenshot === "string" ? screenshot : Buffer.from(screenshot).toString("base64");
          return {
            success: true,
            data: { base64, url: `data:image/png;base64,${base64}` },
            durationMs: Date.now() - start,
          };
        }
        case "wait": {
          const ms = (action.payload.ms as number) || 1000;
          await sandbox.wait(ms);
          break;
        }
        case "bash":
        case "exec": {
          const command = action.payload.command as string;
          const result = await sandbox.commands.run(command, {
            timeoutMs: action.timeoutMs,
          });
          return {
            success: result.exitCode === 0,
            data: {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
            },
            durationMs: Date.now() - start,
          };
        }
        default:
          return {
            success: false,
            error: `Unsupported action type: ${action.actionType}`,
            durationMs: Date.now() - start,
          };
      }

      return {
        success: true,
        data: { actionType: action.actionType },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Action failed",
        durationMs: Date.now() - start,
      };
    }
  }

  async getVncUrl(providerInstanceId: string): Promise<string> {
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.connect(providerInstanceId);
    try {
      const authKey = sandbox.stream.getAuthKey();
      return sandbox.stream.getUrl({ authKey, autoConnect: true, resize: "scale" });
    } catch {
      // Stream not started — try to start it
      await sandbox.stream.start({ requireAuth: true });
      const authKey = sandbox.stream.getAuthKey();
      return sandbox.stream.getUrl({ authKey, autoConnect: true, resize: "scale" });
    }
  }

  async getTerminalUrl(providerInstanceId: string): Promise<string> {
    // E2B doesn't have a separate terminal URL — use the desktop VNC
    // Terminal access is via bash actions through the action endpoint
    return "";
  }

  async createSnapshot(providerInstanceId: string, _label: string): Promise<string> {
    const Sandbox = await this.sdk();
    const sandbox = await Sandbox.connect(providerInstanceId);
    const snapshot = await sandbox.createSnapshot();
    return snapshot.snapshotId;
  }

  async cloneInstance(providerInstanceId: string, _newName: string): Promise<string> {
    const Sandbox = await this.sdk();
    const original = await Sandbox.connect(providerInstanceId);
    // Snapshot the original, then create a new sandbox from the snapshot
    const snapshot = await original.createSnapshot();
    const screenSize = await original.getScreenSize();
    const newSandbox = await Sandbox.create(snapshot.snapshotId, {
      resolution: [screenSize.width, screenSize.height],
    });
    await newSandbox.stream.start({ requireAuth: true });
    return newSandbox.sandboxId;
  }
}

// ═══════════════════════════════════════════════════════════════
// Stub Provider (Development)
// ═══════════════════════════════════════════════════════════════

export class StubComputeProvider implements ComputeProvider {
  readonly name = "stub";

  private counter = 0;

  private nextId(): string {
    return `stub-${Date.now()}-${++this.counter}`;
  }

  async createInstance(_config: InstanceConfig): Promise<ProviderResult> {
    return { providerInstanceId: this.nextId(), status: "stopped" };
  }

  async startInstance(_providerInstanceId: string): Promise<void> {
    // No-op in stub
  }

  async stopInstance(_providerInstanceId: string): Promise<void> {
    // No-op in stub
  }

  async restartInstance(_providerInstanceId: string): Promise<void> {
    // No-op in stub
  }

  async deleteInstance(_providerInstanceId: string): Promise<void> {
    // No-op in stub
  }

  async takeScreenshot(_providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    return { url: "/placeholder-screenshot.png" };
  }

  async executeAction(_providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    return {
      success: true,
      data: { actionType: action.actionType, stub: true },
      durationMs: 50,
    };
  }

  async getVncUrl(_providerInstanceId: string): Promise<string> {
    // Stub mode — return empty so viewers show placeholder
    return "";
  }

  async getTerminalUrl(_providerInstanceId: string): Promise<string> {
    // Stub mode — return empty so viewers show placeholder
    return "";
  }

  async createSnapshot(_providerInstanceId: string, _label: string): Promise<string> {
    return this.nextId();
  }

  async cloneInstance(_providerInstanceId: string, _newName: string): Promise<string> {
    return this.nextId();
  }
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

import type { ProviderKey } from "./types";

// ═══════════════════════════════════════════════════════════════
// Provider Credential Error
// ═══════════════════════════════════════════════════════════════

/**
 * Thrown when a specific compute provider is requested but the
 * required credentials are missing. This prevents silent fallback
 * to the stub provider, which would create phantom instances.
 */
export class ProviderCredentialError extends Error {
  public readonly provider: string;
  public readonly missingEnvVar: string;

  constructor(provider: string, missingEnvVar: string) {
    super(
      `Compute provider "${provider}" was requested but ${missingEnvVar} is not set. ` +
      `Set the required environment variable or remove the explicit provider selection to use auto-detection.`
    );
    this.name = "ProviderCredentialError";
    this.provider = provider;
    this.missingEnvVar = missingEnvVar;
  }
}

const PROVIDER_CREDENTIALS: Record<string, { envVar: string; label: string }> = {
  e2b:   { envVar: "E2B_API_KEY",                    label: "E2B_API_KEY" },
  azure: { envVar: "AZURE_SUBSCRIPTION_ID",           label: "AZURE_SUBSCRIPTION_ID" },
  aws:   { envVar: "AWS_ACCESS_KEY_ID",               label: "AWS_ACCESS_KEY_ID" },
  gcp:   { envVar: "GOOGLE_APPLICATION_CREDENTIALS",  label: "GOOGLE_APPLICATION_CREDENTIALS" },
};

const providerCache = new Map<string, ComputeProvider>();

/**
 * Get a compute provider instance by key.
 * Providers are cached — one instance per key.
 *
 * If a specific provider is requested (via argument or COMPUTE_PROVIDER env var)
 * but credentials are missing, a ProviderCredentialError is thrown instead of
 * silently falling back to the stub provider.
 *
 * The stub provider is only used when no provider is explicitly requested
 * and no credentials are detected (i.e. pure auto-detection in dev).
 *
 * @param providerKey — Explicit provider key. Falls back to env detection.
 * @param azureProduct — For Azure provider, specify which product (vm, aci, spot, etc.)
 */
export function getComputeProvider(providerKey?: ProviderKey | string, azureProduct?: string): ComputeProvider {
  const explicitKey = providerKey || process.env.COMPUTE_PROVIDER;
  const key = explicitKey || (process.env.E2B_API_KEY ? "e2b" : "stub");

  // If a provider was explicitly requested, validate credentials exist.
  // Throw instead of silently falling back to stub — phantom instances are worse than errors.
  if (explicitKey) {
    const cred = PROVIDER_CREDENTIALS[key];
    if (cred && !process.env[cred.envVar]) {
      throw new ProviderCredentialError(key, cred.label);
    }
  }

  // For Azure, include product type in cache key
  const cacheKey = key === "azure" && azureProduct ? `azure:${azureProduct}` : key;

  const cached = providerCache.get(cacheKey);
  if (cached) return cached;

  let provider: ComputeProvider;

  switch (key) {
    case "e2b":
      provider = new E2BComputeProvider();
      break;
    case "aws": {
      // Lazy require to avoid loading cloud SDKs when not needed
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { AwsComputeProvider } = require("./providers/aws");
      provider = new AwsComputeProvider();
      break;
    }
    case "gcp": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GcpComputeProvider } = require("./providers/gcp");
      provider = new GcpComputeProvider();
      break;
    }
    case "azure": {
      if (azureProduct && (azureProduct === "aci" || azureProduct === "spot")) {
        // Use multi-product Azure provider
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getAzureProvider } = require("./providers/azure-multi");
        provider = getAzureProvider(azureProduct as import("./types").AzureProductType);
      } else {
        // Default to regular VM provider
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AzureComputeProvider } = require("./providers/azure");
        provider = new AzureComputeProvider();
      }
      break;
    }
    case "swarm-node": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { SwarmNodeProvider } = require("./providers/swarm-node");
      provider = new SwarmNodeProvider();
      break;
    }
    default:
      provider = new StubComputeProvider();
  }

  providerCache.set(cacheKey, provider);
  return provider;
}
