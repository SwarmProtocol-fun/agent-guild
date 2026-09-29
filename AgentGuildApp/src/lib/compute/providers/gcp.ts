/**
 * Swarm Compute — GCP Compute Engine Provider
 *
 * Uses Compute Engine for VM lifecycle, OS Login for IAM-based SSH,
 * and the instances.getScreenshot API for provider-side screenshots.
 * Desktop access is via in-guest VNC + noVNC stack.
 */

import type { ComputeProvider } from "../provider";
import type {
  InstanceConfig,
  ProviderResult,
  ActionEnvelope,
  ActionResult,
  SizeKey,
  Region,
} from "../types";
import { PROVIDER_SIZE_MAP, PROVIDER_REGION_MAP, PROVIDER_BASE_IMAGES } from "../types";

export class GcpComputeProvider implements ComputeProvider {
  readonly name = "gcp";

  private get projectId(): string {
    return process.env.GCP_PROJECT_ID || "";
  }

  private resolveZone(region: Region): string {
    const gcpRegion = PROVIDER_REGION_MAP.gcp[region] || "us-east1";
    return `${gcpRegion}-b`; // Default to -b zone
  }

  private resolveMachineType(sizeKey: SizeKey): string {
    return PROVIDER_SIZE_MAP.gcp[sizeKey] || "e2-standard-2";
  }

  async createInstance(config: InstanceConfig): Promise<ProviderResult> {
    const compute = await import("@google-cloud/compute");
    const instancesClient = new compute.InstancesClient();

    const zone = config.providerRegion ? `${config.providerRegion}-b` : this.resolveZone(config.region);
    const machineType = config.providerInstanceType || this.resolveMachineType(config.sizeKey);
    const sourceImage = config.providerImage || PROVIDER_BASE_IMAGES.gcp;
    const instanceName = `swarm-${config.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    const [operation] = await instancesClient.insert({
      project: this.projectId,
      zone,
      instanceResource: {
        name: instanceName,
        machineType: `zones/${zone}/machineTypes/${machineType}`,
        disks: [{
          boot: true,
          autoDelete: !config.persistenceEnabled,
          initializeParams: {
            sourceImage,
            diskSizeGb: String(config.diskGb),
            diskType: `zones/${zone}/diskTypes/pd-ssd`,
          },
        }],
        networkInterfaces: [{
          accessConfigs: [{ name: "External NAT", type: "ONE_TO_ONE_NAT" }],
        }],
        metadata: {
          items: [
            { key: "startup-script", value: this.buildStartupScript(config) },
            { key: "swarm-managed", value: "true" },
            { key: "swarm-size", value: config.sizeKey },
            { key: "enable-oslogin", value: "TRUE" },
          ],
        },
        labels: {
          "swarm-managed": "true",
          "swarm-size": config.sizeKey,
        },
      },
    });

    // Wait for operation to complete
    if (operation.latestResponse) {
      const operationsClient = new compute.ZoneOperationsClient();
      await operationsClient.wait({
        project: this.projectId,
        zone,
        operation: operation.latestResponse.name as string,
      });
    }

    return {
      providerInstanceId: instanceName,
      status: "starting",
      providerInstanceType: machineType,
      providerRegion: zone,
      metadata: { sourceImage, zone },
    };
  }

  async startInstance(providerInstanceId: string): Promise<void> {
    const compute = await import("@google-cloud/compute");
    const client = new compute.InstancesClient();
    const zone = await this.getInstanceZone(providerInstanceId);
    await client.start({ project: this.projectId, zone, instance: providerInstanceId });
  }

  async stopInstance(providerInstanceId: string): Promise<void> {
    const compute = await import("@google-cloud/compute");
    const client = new compute.InstancesClient();
    const zone = await this.getInstanceZone(providerInstanceId);
    await client.stop({ project: this.projectId, zone, instance: providerInstanceId });
  }

  async restartInstance(providerInstanceId: string): Promise<void> {
    const compute = await import("@google-cloud/compute");
    const client = new compute.InstancesClient();
    const zone = await this.getInstanceZone(providerInstanceId);
    await client.reset({ project: this.projectId, zone, instance: providerInstanceId });
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    const compute = await import("@google-cloud/compute");
    const client = new compute.InstancesClient();
    const zone = await this.getInstanceZone(providerInstanceId);
    await client.delete({ project: this.projectId, zone, instance: providerInstanceId });
  }

  async takeScreenshot(providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    // GCP has a native screenshot API
    const compute = await import("@google-cloud/compute");
    const client = new compute.InstancesClient();
    const zone = await this.getInstanceZone(providerInstanceId);
    const [response] = await client.getScreenshot({
      project: this.projectId,
      zone,
      instance: providerInstanceId,
    });
    const base64 = (response as { contents?: string }).contents || "";
    return {
      url: base64 ? `data:image/png;base64,${base64}` : "",
      base64: base64 || undefined,
    };
  }

  async executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    const start = Date.now();

    switch (action.actionType) {
      case "bash":
      case "exec": {
        const command = action.payload.command as string;
        return this.runSshCommand(providerInstanceId, command);
      }
      case "screenshot": {
        const data = await this.takeScreenshot(providerInstanceId);
        return { success: !!data.url, data, durationMs: Date.now() - start };
      }
      case "click":
      case "double_click":
      case "type":
      case "key":
      case "scroll":
      case "drag": {
        const xdoCmd = this.buildXdotoolCommand(action);
        return this.runSshCommand(providerInstanceId, xdoCmd);
      }
      case "wait": {
        const ms = (action.payload.ms as number) || 1000;
        await new Promise(r => setTimeout(r, ms));
        return { success: true, data: {}, durationMs: ms };
      }
      default:
        return { success: false, error: `Unsupported action: ${action.actionType}`, durationMs: 0 };
    }
  }

  async getVncUrl(providerInstanceId: string): Promise<string> {
    const ip = await this.getPublicIp(providerInstanceId);
    if (!ip) return "";
    return `https://${ip}:6080/vnc.html?autoconnect=true&resize=scale`;
  }

  async getTerminalUrl(providerInstanceId: string): Promise<string> {
    const zone = await this.getInstanceZone(providerInstanceId);
    return `https://console.cloud.google.com/compute/instancesDetail/zones/${zone}/instances/${providerInstanceId}?project=${this.projectId}&tab=ssh`;
  }

  async createSnapshot(providerInstanceId: string, label: string): Promise<string> {
    const compute = await import("@google-cloud/compute");
    const client = new compute.InstancesClient();
    const zone = await this.getInstanceZone(providerInstanceId);

    // Get the boot disk name
    const [instance] = await client.get({ project: this.projectId, zone, instance: providerInstanceId });
    const bootDisk = instance.disks?.find(d => d.boot)?.source?.split("/").pop();
    if (!bootDisk) throw new Error("No boot disk found");

    const snapshotsClient = new compute.SnapshotsClient();
    const snapshotName = `swarm-${label}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const disksClient = new compute.DisksClient();
    await disksClient.createSnapshot({
      project: this.projectId,
      zone,
      disk: bootDisk,
      snapshotResource: {
        name: snapshotName,
        labels: { "swarm-managed": "true" },
      },
    });
    return snapshotName;
  }

  async cloneInstance(providerInstanceId: string, newName: string): Promise<string> {
    const snapshotId = await this.createSnapshot(providerInstanceId, "clone");
    // Caller would use the snapshot to create a new instance
    return snapshotId;
  }

  // ── Helpers ────────────────────────────────────────────

  private async runSshCommand(instanceId: string, command: string): Promise<ActionResult> {
    // In production, use OS Login + SSH or a guest agent.
    // For MVP, route through the in-guest command bridge via noVNC websocket.
    // Fallback: use GCP Serial Console API or a lightweight agent inside the VM.
    const start = Date.now();
    // Placeholder — in production, use gcloud compute ssh or OS Login API
    return {
      success: false,
      error: "SSH command execution not yet configured — install swarm-agent in guest",
      durationMs: Date.now() - start,
    };
  }

  private async getPublicIp(instanceId: string): Promise<string | null> {
    const compute = await import("@google-cloud/compute");
    const client = new compute.InstancesClient();
    const zone = await this.getInstanceZone(instanceId);
    const [instance] = await client.get({ project: this.projectId, zone, instance: instanceId });
    return instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP || null;
  }

  private async getInstanceZone(_instanceId: string): Promise<string> {
    // In production, look up from Firestore computer record.
    return process.env.GCP_ZONE || "us-east1-b";
  }

  private buildStartupScript(config: InstanceConfig): string {
    return `#!/bin/bash
set -e
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y xfce4 xfce4-terminal tigervnc-standalone-server novnc websockify xdotool imagemagick
mkdir -p /root/.vnc
echo "swarmvnc" | vncpasswd -f > /root/.vnc/passwd
chmod 600 /root/.vnc/passwd
cat > /root/.vnc/xstartup << 'XSTARTUP'
#!/bin/bash
exec startxfce4
XSTARTUP
chmod +x /root/.vnc/xstartup
vncserver :1 -geometry ${config.resolutionWidth}x${config.resolutionHeight} -depth 24
websockify --web /usr/share/novnc 6080 localhost:5901 &
${config.startupScript || ""}
`;
  }

  private safeInt(val: unknown): number {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error(`Invalid coordinate: ${val}`);
    return Math.round(n);
  }

  private shellEscape(text: string): string {
    return text.replace(/[\x00-\x1f\x7f]/g, "").replace(/'/g, "'\\''");
  }

  private safeKey(val: unknown): string {
    const key = String(val);
    if (!/^[a-zA-Z0-9_+]+$/.test(key)) throw new Error(`Invalid key: ${key}`);
    return key;
  }

  private buildXdotoolCommand(action: ActionEnvelope): string {
    const env = "DISPLAY=:1";
    switch (action.actionType) {
      case "click": {
        const x = this.safeInt(action.payload.x);
        const y = this.safeInt(action.payload.y);
        return `${env} xdotool mousemove ${x} ${y} click 1`;
      }
      case "double_click": {
        const x = this.safeInt(action.payload.x);
        const y = this.safeInt(action.payload.y);
        return `${env} xdotool mousemove ${x} ${y} click --repeat 2 1`;
      }
      case "type":
        return `${env} xdotool type --clearmodifiers '${this.shellEscape(String(action.payload.text || ""))}'`;
      case "key":
        return `${env} xdotool key ${this.safeKey(action.payload.key)}`;
      case "scroll": {
        const dir = action.payload.direction === "up" ? 4 : 5;
        const amt = this.safeInt(action.payload.amount || 3);
        return `${env} xdotool click --repeat ${amt} ${dir}`;
      }
      case "drag": {
        const from = action.payload.from as number[];
        const to = action.payload.to as number[];
        return `${env} xdotool mousemove ${this.safeInt(from[0])} ${this.safeInt(from[1])} mousedown 1 mousemove ${this.safeInt(to[0])} ${this.safeInt(to[1])} mouseup 1`;
      }
      default:
        return "echo unsupported";
    }
  }
}
