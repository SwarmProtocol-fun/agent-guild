/**
 * Swarm Compute — Provider Health Checks
 *
 * Polls cloud provider APIs until an instance reaches a healthy state,
 * then probes VNC/SSH connectivity. Times out after a configurable
 * duration (default 10 minutes) and marks the instance as "error".
 */

import { updateComputer, getComputer } from "./firestore";
import { getComputeProvider } from "./provider";
import type { Computer, ComputerStatus } from "./types";

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

/** Maximum time to wait for a provider instance to become healthy */
const HEALTH_CHECK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** Interval between provider state polls */
const POLL_INTERVAL_MS = 15_000; // 15 seconds

/** Timeout for individual VNC/SSH probe attempts */
const PROBE_TIMEOUT_MS = 5_000; // 5 seconds

/** Number of consecutive successful probes required to consider healthy */
const REQUIRED_PROBE_SUCCESSES = 1;

// ═══════════════════════════════════════════════════════════════
// Health Check Result
// ═══════════════════════════════════════════════════════════════

export interface HealthCheckResult {
  healthy: boolean;
  providerState: string | null;
  vncReachable: boolean;
  sshReachable: boolean;
  durationMs: number;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// Azure Power State Polling
// ═══════════════════════════════════════════════════════════════

/**
 * Query Azure VM instance view to get the current power state.
 * Returns a string like "PowerState/running", "PowerState/starting", etc.
 */
async function getAzurePowerState(
  providerInstanceId: string,
  resourceGroup: string,
  subscriptionId: string,
): Promise<string | null> {
  try {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const { DefaultAzureCredential } = await import("@azure/identity");
    const credential = new DefaultAzureCredential();
    const client = new ComputeManagementClient(credential, subscriptionId);

    const instanceView = await client.virtualMachines.instanceView(
      resourceGroup,
      providerInstanceId,
    );

    const powerState = instanceView.statuses?.find(
      (s) => s.code?.startsWith("PowerState/"),
    );
    return powerState?.code || null;
  } catch (err) {
    console.warn(
      `[health] Failed to get Azure power state for ${providerInstanceId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Query E2B sandbox status via reconnect attempt.
 */
async function getE2bStatus(providerInstanceId: string): Promise<string | null> {
  try {
    const { Sandbox } = await import("@e2b/desktop");
    const sandbox = await Sandbox.connect(providerInstanceId);
    // If we can connect, it's running
    void sandbox; // keep reference alive briefly
    return "running";
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Connectivity Probes
// ═══════════════════════════════════════════════════════════════

/**
 * Probe whether a VNC endpoint (port 6080) is reachable on the given IP.
 * Uses a raw TCP connection attempt with timeout.
 */
async function probeVnc(ip: string): Promise<boolean> {
  return probeTcp(ip, 6080);
}

/**
 * Probe whether SSH (port 22) is reachable on the given IP.
 */
async function probeSsh(ip: string): Promise<boolean> {
  return probeTcp(ip, 22);
}

/**
 * Attempt a TCP connection to host:port with a timeout.
 */
function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // Dynamic import to avoid bundling net in client
    import("net").then(({ createConnection }) => {
      const socket = createConnection({ host, port, timeout: PROBE_TIMEOUT_MS });

      socket.on("connect", () => {
        socket.destroy();
        resolve(true);
      });

      socket.on("timeout", () => {
        socket.destroy();
        resolve(false);
      });

      socket.on("error", () => {
        socket.destroy();
        resolve(false);
      });
    }).catch(() => resolve(false));
  });
}

/**
 * Get the public IP for an Azure VM via its associated public IP resource.
 */
async function getAzurePublicIp(
  providerInstanceId: string,
  resourceGroup: string,
  subscriptionId: string,
): Promise<string | null> {
  try {
    const { NetworkManagementClient } = await import("@azure/arm-network");
    const { DefaultAzureCredential } = await import("@azure/identity");
    const credential = new DefaultAzureCredential();
    const client = new NetworkManagementClient(credential, subscriptionId);

    const ipName = `${providerInstanceId}-ip`;
    const result = await client.publicIPAddresses.get(resourceGroup, ipName);
    return result.ipAddress || null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Main Health Check — Poll Until Ready
// ═══════════════════════════════════════════════════════════════

/**
 * Poll a provider instance until it reaches a healthy state.
 *
 * For Azure VMs:
 *   1. Poll Azure API until PowerState/running
 *   2. Probe VNC (port 6080) and SSH (port 22) connectivity
 *   3. If both pass, mark as "running"
 *   4. Timeout after 10 minutes → mark as "error"
 *
 * For E2B:
 *   1. Attempt to reconnect to the sandbox
 *   2. If successful, mark as "running"
 *
 * This function updates the computer's Firestore record directly.
 * It runs asynchronously — callers should fire-and-forget.
 */
export async function pollUntilHealthy(computerId: string): Promise<HealthCheckResult> {
  const startTime = Date.now();
  let lastProviderState: string | null = null;
  let vncReachable = false;
  let sshReachable = false;

  const computer = await getComputer(computerId);
  if (!computer) {
    return {
      healthy: false,
      providerState: null,
      vncReachable: false,
      sshReachable: false,
      durationMs: Date.now() - startTime,
      error: "Computer not found",
    };
  }

  if (!computer.providerInstanceId) {
    return {
      healthy: false,
      providerState: null,
      vncReachable: false,
      sshReachable: false,
      durationMs: Date.now() - startTime,
      error: "No provider instance ID",
    };
  }

  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID || "";
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP || "swarm-compute";

  // ── Polling loop ──
  while (Date.now() - startTime < HEALTH_CHECK_TIMEOUT_MS) {
    // Re-fetch computer to check if it was manually stopped/deleted
    const current = await getComputer(computerId);
    if (!current || current.status === "stopped" || current.status === "stopping") {
      return {
        healthy: false,
        providerState: lastProviderState,
        vncReachable: false,
        sshReachable: false,
        durationMs: Date.now() - startTime,
        error: "Computer was stopped during health check",
      };
    }

    // Step 1: Check provider power state
    if (computer.provider === "azure") {
      lastProviderState = await getAzurePowerState(
        computer.providerInstanceId!,
        resourceGroup,
        subscriptionId,
      );

      if (lastProviderState === "PowerState/running") {
        // Step 2: Probe connectivity
        const publicIp = await getAzurePublicIp(
          computer.providerInstanceId!,
          resourceGroup,
          subscriptionId,
        );

        if (publicIp) {
          let probeSuccesses = 0;
          for (let i = 0; i < REQUIRED_PROBE_SUCCESSES; i++) {
            const [vnc, ssh] = await Promise.all([
              probeVnc(publicIp),
              probeSsh(publicIp),
            ]);
            vncReachable = vnc;
            sshReachable = ssh;

            // Either VNC or SSH reachable is sufficient
            if (vnc || ssh) {
              probeSuccesses++;
            }
          }

          if (probeSuccesses >= REQUIRED_PROBE_SUCCESSES) {
            // Healthy! Update status
            await updateComputer(computerId, {
              status: "running",
              lastActiveAt: new Date(),
              providerMetadata: {
                ...computer.providerMetadata,
                publicIp,
                healthCheckPassed: new Date().toISOString(),
                healthCheckDurationMs: Date.now() - startTime,
              },
            });

            return {
              healthy: true,
              providerState: lastProviderState,
              vncReachable,
              sshReachable,
              durationMs: Date.now() - startTime,
            };
          }
        }
        // IP not yet assigned or probes failed — keep polling
      }
    } else if (computer.provider === "e2b") {
      lastProviderState = await getE2bStatus(computer.providerInstanceId!);
      if (lastProviderState === "running") {
        await updateComputer(computerId, {
          status: "running",
          lastActiveAt: new Date(),
        });
        return {
          healthy: true,
          providerState: "running",
          vncReachable: true,
          sshReachable: false,
          durationMs: Date.now() - startTime,
        };
      }
    } else {
      // For stub/other providers, mark healthy immediately
      await updateComputer(computerId, {
        status: "running",
        lastActiveAt: new Date(),
      });
      return {
        healthy: true,
        providerState: "running",
        vncReachable: false,
        sshReachable: false,
        durationMs: Date.now() - startTime,
      };
    }

    // Update metadata with polling progress
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    await updateComputer(computerId, {
      providerMetadata: {
        ...computer.providerMetadata,
        healthCheckStatus: "polling",
        healthCheckElapsedSec: elapsed,
        lastProviderState,
      },
    });

    // Wait before next poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // ── Timeout: mark as error ──
  const errorMsg = `Health check timed out after ${HEALTH_CHECK_TIMEOUT_MS / 1000}s. ` +
    `Last provider state: ${lastProviderState || "unknown"}. ` +
    `VNC: ${vncReachable ? "reachable" : "unreachable"}, SSH: ${sshReachable ? "reachable" : "unreachable"}`;

  console.error(`[health] ${errorMsg} for computer ${computerId}`);

  await updateComputer(computerId, {
    status: "error",
    providerMetadata: {
      ...computer.providerMetadata,
      healthCheckStatus: "timeout",
      healthCheckError: errorMsg,
      healthCheckDurationMs: Date.now() - startTime,
    },
  });

  return {
    healthy: false,
    providerState: lastProviderState,
    vncReachable,
    sshReachable,
    durationMs: Date.now() - startTime,
    error: errorMsg,
  };
}

// ═══════════════════════════════════════════════════════════════
// One-Shot Health Probe (for status endpoint)
// ═══════════════════════════════════════════════════════════════

/**
 * Perform a single health probe on a running computer.
 * Does NOT modify Firestore — returns the result for the caller to act on.
 */
export async function probeInstanceHealth(computer: Computer): Promise<HealthCheckResult> {
  const startTime = Date.now();

  if (!computer.providerInstanceId) {
    return {
      healthy: false,
      providerState: null,
      vncReachable: false,
      sshReachable: false,
      durationMs: Date.now() - startTime,
      error: "No provider instance ID",
    };
  }

  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID || "";
  const resourceGroup = process.env.AZURE_RESOURCE_GROUP || "swarm-compute";

  let providerState: string | null = null;
  let vncReachable = false;
  let sshReachable = false;

  if (computer.provider === "azure") {
    providerState = await getAzurePowerState(
      computer.providerInstanceId,
      resourceGroup,
      subscriptionId,
    );

    if (providerState === "PowerState/running") {
      const publicIp = await getAzurePublicIp(
        computer.providerInstanceId,
        resourceGroup,
        subscriptionId,
      );

      if (publicIp) {
        [vncReachable, sshReachable] = await Promise.all([
          probeVnc(publicIp),
          probeSsh(publicIp),
        ]);
      }
    }
  } else if (computer.provider === "e2b") {
    providerState = await getE2bStatus(computer.providerInstanceId);
    vncReachable = providerState === "running";
  }

  return {
    healthy: providerState?.includes("running") === true && (vncReachable || sshReachable || computer.provider !== "azure"),
    providerState,
    vncReachable,
    sshReachable,
    durationMs: Date.now() - startTime,
  };
}
