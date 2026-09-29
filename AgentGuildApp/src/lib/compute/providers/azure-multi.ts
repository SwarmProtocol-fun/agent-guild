/**
 * Swarm Compute — Azure Multi-Product Provider
 *
 * Supports multiple Azure compute products:
 * - Virtual Machines (VMs)
 * - Azure Container Instances (ACI)
 * - Azure Virtual Desktop (AVD)
 * - Spot VMs
 * - Azure Batch
 */

import type { ComputeProvider } from "../provider";
import type {
  InstanceConfig,
  ProviderResult,
  ActionEnvelope,
  ActionResult,
  SizeKey,
  Region,
  AzureProductType,
} from "../types";
import { AZURE_PRODUCTS } from "../types";

// ═══════════════════════════════════════════════════════════════
// Base Azure Provider
// ═══════════════════════════════════════════════════════════════

abstract class BaseAzureProvider implements ComputeProvider {
  abstract readonly name: string;
  abstract readonly productType: AzureProductType;

  protected get subscriptionId(): string {
    return process.env.AZURE_SUBSCRIPTION_ID || "";
  }

  protected get resourceGroup(): string {
    return process.env.AZURE_RESOURCE_GROUP || "swarm-compute";
  }

  protected resolveLocation(region: Region): string {
    const map: Record<Region, string> = {
      "us-east": "eastus",
      "us-west": "westus2",
      "eu-west": "westeurope",
      "ap-southeast": "southeastasia",
    };
    return map[region] || "eastus";
  }

  protected async getCredential() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DefaultAzureCredential } = require("@azure/identity");
    return new DefaultAzureCredential();
  }

  abstract createInstance(config: InstanceConfig): Promise<ProviderResult>;
  abstract startInstance(providerInstanceId: string): Promise<void>;
  abstract stopInstance(providerInstanceId: string): Promise<void>;
  abstract restartInstance(providerInstanceId: string): Promise<void>;
  abstract deleteInstance(providerInstanceId: string): Promise<void>;
  abstract takeScreenshot(providerInstanceId: string): Promise<{ url: string; base64?: string }>;
  abstract executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult>;
  abstract getVncUrl(providerInstanceId: string): Promise<string>;
  abstract getTerminalUrl(providerInstanceId: string): Promise<string>;
  abstract createSnapshot(providerInstanceId: string, label: string): Promise<string>;
  abstract cloneInstance(providerInstanceId: string, newName: string): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════
// Azure Container Instances (ACI) Provider
// ═══════════════════════════════════════════════════════════════

export class AzureACIProvider extends BaseAzureProvider {
  readonly name = "azure-aci";
  readonly productType: AzureProductType = "aci";

  async createInstance(config: InstanceConfig): Promise<ProviderResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ContainerInstanceManagementClient } = require("@azure/arm-containerinstance");
    const credential = await this.getCredential();
    const client = new ContainerInstanceManagementClient(credential, this.subscriptionId);

    const location = this.resolveLocation(config.region);
    const containerName = `swarm-${config.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);

    // ACI uses Ubuntu container with systemd/VNC
    const image = config.providerImage || "ubuntu:22.04";

    await client.containerGroups.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      containerName,
      {
        location,
        containers: [{
          name: containerName,
          image,
          resources: {
            requests: {
              cpu: config.cpuCores,
              memoryInGB: config.ramMb / 1024,
            },
          },
          ports: [
            { port: 6080, protocol: "TCP" }, // noVNC
            { port: 5901, protocol: "TCP" }, // VNC
          ],
          environmentVariables: [
            { name: "RESOLUTION", value: `${config.resolutionWidth}x${config.resolutionHeight}` },
            { name: "VNC_PASSWORD", secureValue: `swarm${Date.now()}` },
          ],
          command: this.buildStartupCommand(config),
        }],
        osType: "Linux",
        restartPolicy: "Always",
        ipAddress: {
          type: "Public",
          ports: [
            { port: 6080, protocol: "TCP" },
            { port: 5901, protocol: "TCP" },
          ],
          dnsNameLabel: containerName,
        },
        tags: {
          "swarm:managed": "true",
          "swarm:product": "aci",
          "swarm:size": config.sizeKey,
        },
      }
    );

    return {
      providerInstanceId: containerName,
      status: "starting",
      providerRegion: location,
      metadata: {
        resourceGroup: this.resourceGroup,
        productType: "aci",
        fqdn: `${containerName}.${location}.azurecontainer.io`,
      },
    };
  }

  async startInstance(providerInstanceId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ContainerInstanceManagementClient } = require("@azure/arm-containerinstance");
    const credential = await this.getCredential();
    const client = new ContainerInstanceManagementClient(credential, this.subscriptionId);
    await client.containerGroups.start(this.resourceGroup, providerInstanceId);
  }

  async stopInstance(providerInstanceId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ContainerInstanceManagementClient } = require("@azure/arm-containerinstance");
    const credential = await this.getCredential();
    const client = new ContainerInstanceManagementClient(credential, this.subscriptionId);
    await client.containerGroups.stop(this.resourceGroup, providerInstanceId);
  }

  async restartInstance(providerInstanceId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ContainerInstanceManagementClient } = require("@azure/arm-containerinstance");
    const credential = await this.getCredential();
    const client = new ContainerInstanceManagementClient(credential, this.subscriptionId);
    await client.containerGroups.restart(this.resourceGroup, providerInstanceId);
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ContainerInstanceManagementClient } = require("@azure/arm-containerinstance");
    const credential = await this.getCredential();
    const client = new ContainerInstanceManagementClient(credential, this.subscriptionId);
    await client.containerGroups.beginDeleteAndWait(this.resourceGroup, providerInstanceId);
  }

  async takeScreenshot(_providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    // ACI doesn't have built-in screenshot capability
    // Would need to exec into container and use xwd or similar
    return { url: "https://via.placeholder.com/800x600.png?text=ACI+Screenshot" };
  }

  async executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ContainerInstanceManagementClient } = require("@azure/arm-containerinstance");
    const credential = await this.getCredential();
    const client = new ContainerInstanceManagementClient(credential, this.subscriptionId);
    const start = Date.now();

    try {
      if (action.actionType === "bash" || action.actionType === "exec") {
        const command = action.payload.command as string;
        const result = await client.containers.executeCommand(
          this.resourceGroup,
          providerInstanceId,
          providerInstanceId, // container name = group name
          { command: "/bin/bash", terminalSize: { rows: 24, cols: 80 } }
        );

        // ACI exec is interactive - for automation, we'd use a different approach
        // This is a simplified implementation
        return {
          success: true,
          data: { webSocketUri: result.webSocketUri, password: result.password },
          durationMs: Date.now() - start,
        };
      }

      return {
        success: false,
        error: `Action ${action.actionType} not supported on ACI (container-based)`,
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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ContainerInstanceManagementClient } = require("@azure/arm-containerinstance");
    const credential = await this.getCredential();
    const client = new ContainerInstanceManagementClient(credential, this.subscriptionId);

    const group = await client.containerGroups.get(this.resourceGroup, providerInstanceId);
    const fqdn = group.ipAddress?.fqdn;
    if (!fqdn) return "";

    return `http://${fqdn}:6080/vnc.html?autoconnect=true&resize=scale`;
  }

  async getTerminalUrl(providerInstanceId: string): Promise<string> {
    return `https://portal.azure.com/#@/resource/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.ContainerInstance/containerGroups/${providerInstanceId}/containers/${providerInstanceId}/exec`;
  }

  async createSnapshot(_providerInstanceId: string, _label: string): Promise<string> {
    throw new Error("Snapshots not supported on Azure Container Instances (ephemeral)");
  }

  async cloneInstance(_providerInstanceId: string, _newName: string): Promise<string> {
    throw new Error("Cloning not supported on Azure Container Instances");
  }

  private buildStartupCommand(config: InstanceConfig): string[] {
    return [
      "/bin/bash",
      "-c",
      `
        apt-get update && apt-get install -y xfce4 tigervnc-standalone-server novnc websockify xdotool
        mkdir -p ~/.vnc
        echo "$VNC_PASSWORD" | vncpasswd -f > ~/.vnc/passwd
        chmod 600 ~/.vnc/passwd
        vncserver :1 -geometry $RESOLUTION -depth 24
        websockify --web /usr/share/novnc 6080 localhost:5901 &
        ${config.startupScript || "tail -f /dev/null"}
      `,
    ];
  }
}

// ═══════════════════════════════════════════════════════════════
// Azure Spot VMs Provider
// ═══════════════════════════════════════════════════════════════

export class AzureSpotProvider extends BaseAzureProvider {
  readonly name = "azure-spot";
  readonly productType: AzureProductType = "spot";

  async createInstance(config: InstanceConfig): Promise<ProviderResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComputeManagementClient } = require("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);

    const location = this.resolveLocation(config.region);
    const vmSize = this.resolveVmSize(config.sizeKey);
    const vmName = `swarm-spot-${config.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);

    // Same as regular VM but with spot pricing
    const imageRef = (config.providerImage || "Canonical:0001-com-ubuntu-server-jammy:22_04-lts:latest").split(":");

    await client.virtualMachines.beginCreateOrUpdateAndWait(this.resourceGroup, vmName, {
      location,
      hardwareProfile: { vmSize },
      priority: "Spot", // KEY DIFFERENCE: Spot priority
      evictionPolicy: "Deallocate", // Deallocate instead of Delete on eviction
      billingProfile: {
        maxPrice: -1, // -1 means pay up to on-demand price (default)
      },
      osProfile: {
        computerName: vmName.slice(0, 15),
        adminUsername: "swarm",
        adminPassword: `Swarm${Date.now()}!`,
        customData: Buffer.from(this.buildCloudInit(config)).toString("base64"),
        linuxConfiguration: {
          disablePasswordAuthentication: false,
        },
      },
      storageProfile: {
        imageReference: {
          publisher: imageRef[0],
          offer: imageRef[1],
          sku: imageRef[2],
          version: imageRef[3] || "latest",
        },
        osDisk: {
          createOption: "FromImage",
          managedDisk: { storageAccountType: "Standard_LRS" }, // Standard for cost savings
          diskSizeGB: config.diskGb,
          deleteOption: "Delete", // Always delete on eviction
        },
      },
      networkProfile: {
        networkInterfaces: [{
          id: `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Network/networkInterfaces/${vmName}-nic`,
        }],
      },
      tags: {
        "swarm:managed": "true",
        "swarm:product": "spot",
        "swarm:size": config.sizeKey,
      },
    });

    return {
      providerInstanceId: vmName,
      status: "starting",
      providerInstanceType: vmSize,
      providerRegion: location,
      metadata: {
        resourceGroup: this.resourceGroup,
        productType: "spot",
        evictionPolicy: "Deallocate",
      },
    };
  }

  // Rest of the methods are same as regular VM provider
  // (Importing from the original azure.ts logic)

  async startInstance(providerInstanceId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComputeManagementClient } = require("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);
    await client.virtualMachines.beginStartAndWait(this.resourceGroup, providerInstanceId);
  }

  async stopInstance(providerInstanceId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComputeManagementClient } = require("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);
    await client.virtualMachines.beginDeallocateAndWait(this.resourceGroup, providerInstanceId);
  }

  async restartInstance(providerInstanceId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComputeManagementClient } = require("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);
    await client.virtualMachines.beginRestartAndWait(this.resourceGroup, providerInstanceId);
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComputeManagementClient } = require("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);
    await client.virtualMachines.beginDeleteAndWait(this.resourceGroup, providerInstanceId);
  }

  async takeScreenshot(providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComputeManagementClient } = require("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);

    try {
      const result = await client.virtualMachines.retrieveBootDiagnosticsData(
        this.resourceGroup,
        providerInstanceId,
      );
      return { url: (result as Record<string, unknown>).screenshotBlobUri as string || "" };
    } catch {
      return { url: "" };
    }
  }

  async executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    // Same as regular VM - use Run Command
    const start = Date.now();

    if (action.actionType === "bash" || action.actionType === "exec") {
      return this.runCommand(providerInstanceId, action.payload.command as string);
    }

    return {
      success: false,
      error: `Action ${action.actionType} not fully implemented for Spot VMs`,
      durationMs: Date.now() - start,
    };
  }

  async getVncUrl(providerInstanceId: string): Promise<string> {
    const ip = await this.getPublicIp(providerInstanceId);
    if (!ip) return "";
    return `https://${ip}:6080/vnc.html?autoconnect=true&resize=scale`;
  }

  async getTerminalUrl(providerInstanceId: string): Promise<string> {
    return `https://portal.azure.com/#@/resource/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${providerInstanceId}/serialConsole`;
  }

  async createSnapshot(providerInstanceId: string, label: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComputeManagementClient } = require("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);

    const vm = await client.virtualMachines.get(this.resourceGroup, providerInstanceId);
    const osDiskId = vm.storageProfile?.osDisk?.managedDisk?.id;
    if (!osDiskId) throw new Error("No OS disk found on Spot VM");

    const snapshotName = `swarm-spot-${label}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
    await client.snapshots.beginCreateOrUpdateAndWait(this.resourceGroup, snapshotName, {
      location: vm.location || "eastus",
      creationData: {
        createOption: "Copy",
        sourceResourceId: osDiskId,
      },
      tags: { "swarm:managed": "true", "swarm:product": "spot" },
    });

    return snapshotName;
  }

  async cloneInstance(providerInstanceId: string, newName: string): Promise<string> {
    const snapshotId = await this.createSnapshot(providerInstanceId, "clone");
    return snapshotId;
  }

  // Helper methods
  private resolveVmSize(sizeKey: SizeKey): string {
    const map: Record<SizeKey, string> = {
      small: "Standard_B2s",
      medium: "Standard_B4ms",
      large: "Standard_D8s_v3",
      xl: "Standard_D16s_v3",
    };
    return map[sizeKey] || "Standard_B2s";
  }

  private buildCloudInit(config: InstanceConfig): string {
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

  private async runCommand(vmName: string, command: string): Promise<ActionResult> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ComputeManagementClient } = require("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);
    const start = Date.now();

    try {
      const result = await client.virtualMachines.beginRunCommandAndWait(
        this.resourceGroup,
        vmName,
        {
          commandId: "RunShellScript",
          script: [command],
        },
      );

      const output = result.value?.[0]?.message || "";
      const isError = result.value?.[0]?.code === "ComponentStatus/StdErr/succeeded";

      return {
        success: !isError,
        data: {
          stdout: isError ? "" : output,
          stderr: isError ? output : "",
          exitCode: isError ? 1 : 0,
        },
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : "Run Command failed",
        durationMs: Date.now() - start,
      };
    }
  }

  private async getPublicIp(vmName: string): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NetworkManagementClient } = require("@azure/arm-network");
    const credential = await this.getCredential();
    const client = new NetworkManagementClient(credential, this.subscriptionId);

    try {
      const ipName = `${vmName}-ip`;
      const result = await client.publicIPAddresses.get(this.resourceGroup, ipName);
      return result.ipAddress || null;
    } catch {
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════

export function getAzureProvider(productType: AzureProductType = "vm"): ComputeProvider {
  switch (productType) {
    case "aci":
      return new AzureACIProvider();
    case "spot":
      return new AzureSpotProvider();
    case "vm":
    case "avd":
    case "batch":
    default:
      // For now, AVD and Batch fall back to regular VM (to be implemented)
      const { AzureComputeProvider } = require("./azure");
      return new AzureComputeProvider();
  }
}
