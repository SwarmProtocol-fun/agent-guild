import type { ComputeProvider } from "../provider";
import type { InstanceConfig, ProviderResult, ActionEnvelope, ActionResult } from "../types";
import { createLease, updateLease, getLease, queueLeaseAction, onLeaseChange } from "../../firestore";

export class AgentGuildNodeProvider implements ComputeProvider {
  readonly name = "agent-guild-node";

  async createInstance(config: InstanceConfig): Promise<ProviderResult> {
    const orgId = config.providerMetadata?.orgId as string;
    const computerId = config.providerMetadata?.computerId as string;
    const nodeId = config.providerRegion; // We hijack region picker to select the specific node id

    if (!orgId || !nodeId) {
      throw new Error("Agent Guild Node provider requires orgId and nodeId in config.");
    }

    // Create a new lease for the node to pick up
    const leaseId = await createLease({
      nodeId,
      orgId,
      computerId: computerId || "pending", 
      containerImage: config.baseImage,
      memoryMb: config.ramMb,
      cpuCores: config.cpuCores,
    });

    return {
      providerInstanceId: leaseId,
      status: "starting",
      providerRegion: nodeId,
      metadata: { leaseId },
    };
  }

  async startInstance(providerInstanceId: string): Promise<void> {
    await updateLease(providerInstanceId, { status: "starting" });
  }

  async stopInstance(providerInstanceId: string): Promise<void> {
    await updateLease(providerInstanceId, { status: "stopping" });
  }

  async restartInstance(providerInstanceId: string): Promise<void> {
    await updateLease(providerInstanceId, { status: "stopping" });
    // In a full implementation, you'd wait for stopped, then set to starting
    setTimeout(() => {
      updateLease(providerInstanceId, { status: "starting" }).catch(console.error);
    }, 5000);
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    await updateLease(providerInstanceId, { status: "stopping" });
  }

  async takeScreenshot(providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    // Screenshots are published to the lease by the node daemon
    const lease = await getLease(providerInstanceId);
    if (!lease) throw new Error(`Lease ${providerInstanceId} not found`);
    if (!lease.screenshotUrl) throw new Error("Node has not published a screenshot for this container yet");
    return { url: lease.screenshotUrl };
  }

  async executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    // Queue the action on the lease, then wait for the node daemon to write back its result
    const start = Date.now();
    const actionId = action.idempotencyKey || `${start}-${Math.random().toString(36).slice(2, 8)}`;

    await queueLeaseAction(providerInstanceId, {
      id: actionId,
      actionType: action.actionType,
      payload: action.payload,
      queuedAt: start,
    });

    return new Promise<ActionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("Action timeout"));
      }, action.timeoutMs);

      const unsubscribe = onLeaseChange(providerInstanceId, (lease) => {
        const result = lease?.actionResults?.[actionId];
        if (!lease || !result) return;
        clearTimeout(timer);
        unsubscribe();
        resolve({
          success: result.success,
          data: result.data,
          error: result.error,
          durationMs: result.durationMs ?? Date.now() - start,
        });
      });
    });
  }

  async getVncUrl(providerInstanceId: string): Promise<string> {
    return ""; // VNC not supported natively for headless node containers in MVP
  }

  async getTerminalUrl(providerInstanceId: string): Promise<string> {
    return ""; // Stream docker logs natively instead
  }

  async createSnapshot(providerInstanceId: string, label: string): Promise<string> {
    throw new Error("Snapshots are not supported on agent-guild-node containers");
  }

  async cloneInstance(providerInstanceId: string, newName: string): Promise<string> {
    throw new Error("Cloning is not supported on agent-guild-node containers");
  }
}
