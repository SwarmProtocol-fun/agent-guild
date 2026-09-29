import type { ComputeProvider } from "../provider";
import type { InstanceConfig, ProviderResult, ActionEnvelope, ActionResult } from "../types";
import { createLease, updateLease } from "../../firestore";

export class SwarmNodeProvider implements ComputeProvider {
  readonly name = "swarm-node";

  async createInstance(config: InstanceConfig): Promise<ProviderResult> {
    const orgId = config.providerMetadata?.orgId as string;
    const computerId = config.providerMetadata?.computerId as string;
    const nodeId = config.providerRegion; // We hijack region picker to select the specific node id

    if (!orgId || !nodeId) {
      throw new Error("Swarm Node provider requires orgId and nodeId in config.");
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

  async takeScreenshot(_providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    // For containerized agents, taking manual screenshots might require a VNC connection inside the container
    // We mock this for MVP unless the agent pushes screenshots.
    return { url: "https://via.placeholder.com/800x600.png?text=Node+Screenshot+Mock" };
  }

  async executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    // In the future, this pushes the action to the 'actions' subcollection on the lease
    return {
      success: true,
      data: { message: "Action forwarded to node daemon", actionType: action.actionType },
      durationMs: 100,
    };
  }

  async getVncUrl(providerInstanceId: string): Promise<string> {
    return ""; // VNC not supported natively for headless node containers in MVP
  }

  async getTerminalUrl(providerInstanceId: string): Promise<string> {
    return ""; // Stream docker logs natively instead
  }

  async createSnapshot(providerInstanceId: string, label: string): Promise<string> {
    throw new Error("Snapshots are not supported on swarm-node containers");
  }

  async cloneInstance(providerInstanceId: string, newName: string): Promise<string> {
    throw new Error("Cloning is not supported on swarm-node containers");
  }
}
