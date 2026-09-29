/**
 * Swarm Compute — Azure Virtual Machines Provider
 *
 * Uses Azure VMs for lifecycle, Run Command for script execution,
 * and Boot Diagnostics as a fallback screenshot source.
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

export class AzureComputeProvider implements ComputeProvider {
  readonly name = "azure";

  private get subscriptionId(): string {
    return process.env.AZURE_SUBSCRIPTION_ID || "";
  }

  private get resourceGroup(): string {
    return process.env.AZURE_RESOURCE_GROUP || "swarm-compute";
  }

  private resolveLocation(region: Region): string {
    return PROVIDER_REGION_MAP.azure[region] || "eastus";
  }

  private resolveVmSize(sizeKey: SizeKey): string {
    return PROVIDER_SIZE_MAP.azure[sizeKey] || "Standard_B2s";
  }

  private async getCredential() {
    const { DefaultAzureCredential } = await import("@azure/identity");
    return new DefaultAzureCredential();
  }

  async createInstance(config: InstanceConfig): Promise<ProviderResult> {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const { NetworkManagementClient } = await import("@azure/arm-network");
    const credential = await this.getCredential();
    const computeClient = new ComputeManagementClient(credential, this.subscriptionId);
    const networkClient = new NetworkManagementClient(credential, this.subscriptionId);

    const location = config.providerRegion || this.resolveLocation(config.region);
    const vmSize = config.providerInstanceType || this.resolveVmSize(config.sizeKey);
    const vmName = `swarm-${config.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);

    // Parse image reference (publisher:offer:sku:version)
    const imageRef = (config.providerImage || PROVIDER_BASE_IMAGES.azure).split(":");

    // Create networking resources dynamically
    const vnetName = "swarm-vnet";
    const subnetName = "swarm-subnet";
    const nsgName = `${vmName}-nsg`;
    const publicIpName = `${vmName}-ip`;
    const nicName = `${vmName}-nic`;

    // 1. Ensure VNet and subnet exist (or create)
    try {
      await networkClient.virtualNetworks.get(this.resourceGroup, vnetName);
    } catch {
      console.log(`[azure] Creating VNet ${vnetName}`);
      await networkClient.virtualNetworks.beginCreateOrUpdateAndWait(this.resourceGroup, vnetName, {
        location,
        addressSpace: { addressPrefixes: ["10.0.0.0/16"] },
        subnets: [{
          name: subnetName,
          addressPrefix: "10.0.0.0/24",
        }],
        tags: { "swarm:managed": "true" },
      });
    }

    // 2. Create NSG (Network Security Group) with VNC and SSH rules
    console.log(`[azure] Creating NSG ${nsgName}`);
    await networkClient.networkSecurityGroups.beginCreateOrUpdateAndWait(this.resourceGroup, nsgName, {
      location,
      securityRules: [
        {
          name: "AllowVNC",
          protocol: "Tcp",
          sourcePortRange: "*",
          destinationPortRange: "6080",
          sourceAddressPrefix: "*",
          destinationAddressPrefix: "*",
          access: "Allow",
          priority: 100,
          direction: "Inbound",
        },
        {
          name: "AllowSSH",
          protocol: "Tcp",
          sourcePortRange: "*",
          destinationPortRange: "22",
          sourceAddressPrefix: "*",
          destinationAddressPrefix: "*",
          access: "Allow",
          priority: 110,
          direction: "Inbound",
        },
        {
          name: "AllowVNCDirect",
          protocol: "Tcp",
          sourcePortRange: "*",
          destinationPortRange: "5901",
          sourceAddressPrefix: "*",
          destinationAddressPrefix: "*",
          access: "Allow",
          priority: 120,
          direction: "Inbound",
        },
      ],
      tags: { "swarm:managed": "true", "swarm:vm": vmName },
    });

    // 3. Create Public IP
    console.log(`[azure] Creating Public IP ${publicIpName}`);
    const publicIpResult = await networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      publicIpName,
      {
        location,
        publicIPAllocationMethod: "Dynamic", // Static IPs require reserved IP addresses
        sku: { name: "Standard" },
        tags: { "swarm:managed": "true", "swarm:vm": vmName },
      }
    );

    // 4. Get subnet reference
    const subnet = await networkClient.subnets.get(this.resourceGroup, vnetName, subnetName);

    // 5. Create NIC with Public IP and NSG
    console.log(`[azure] Creating NIC ${nicName}`);
    const nicResult = await networkClient.networkInterfaces.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      nicName,
      {
        location,
        ipConfigurations: [{
          name: "ipconfig1",
          subnet: { id: subnet.id },
          publicIPAddress: { id: publicIpResult.id },
          privateIPAllocationMethod: "Dynamic",
        }],
        networkSecurityGroup: {
          id: `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Network/networkSecurityGroups/${nsgName}`,
        },
        tags: { "swarm:managed": "true", "swarm:vm": vmName },
      }
    );

    // 6. Create VM with the newly created NIC
    console.log(`[azure] Creating VM ${vmName}`);
    await computeClient.virtualMachines.beginCreateOrUpdateAndWait(this.resourceGroup, vmName, {
      location,
      hardwareProfile: { vmSize },
      osProfile: {
        computerName: vmName.slice(0, 15),
        adminUsername: "swarm",
        adminPassword: `Swarm${Date.now()}!`, // Auto-generated, access via Run Command
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
          managedDisk: { storageAccountType: "Premium_LRS" },
          diskSizeGB: config.diskGb,
          deleteOption: config.persistenceEnabled ? "Detach" : "Delete",
        },
      },
      networkProfile: {
        networkInterfaces: [{
          id: nicResult.id,
          primary: true,
        }],
      },
      diagnosticsProfile: {
        bootDiagnostics: { enabled: true },
      },
      tags: {
        "swarm:managed": "true",
        "swarm:size": config.sizeKey,
        "swarm:nic": nicName,
        "swarm:nsg": nsgName,
        "swarm:ip": publicIpName,
      },
    });

    return {
      providerInstanceId: vmName,
      status: "starting",
      providerInstanceType: vmSize,
      providerRegion: location,
      metadata: {
        resourceGroup: this.resourceGroup,
        nicName,
        nsgName,
        publicIpName,
      },
    };
  }

  async startInstance(providerInstanceId: string): Promise<void> {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);
    await client.virtualMachines.beginStartAndWait(this.resourceGroup, providerInstanceId);
  }

  async stopInstance(providerInstanceId: string): Promise<void> {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);
    await client.virtualMachines.beginDeallocateAndWait(this.resourceGroup, providerInstanceId);
  }

  async restartInstance(providerInstanceId: string): Promise<void> {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);
    await client.virtualMachines.beginRestartAndWait(this.resourceGroup, providerInstanceId);
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const { NetworkManagementClient } = await import("@azure/arm-network");
    const credential = await this.getCredential();
    const computeClient = new ComputeManagementClient(credential, this.subscriptionId);
    const networkClient = new NetworkManagementClient(credential, this.subscriptionId);

    // Get VM to retrieve associated resource names from tags
    let nicName: string | undefined;
    let nsgName: string | undefined;
    let publicIpName: string | undefined;

    try {
      const vm = await computeClient.virtualMachines.get(this.resourceGroup, providerInstanceId);
      nicName = vm.tags?.["swarm:nic"];
      nsgName = vm.tags?.["swarm:nsg"];
      publicIpName = vm.tags?.["swarm:ip"];
    } catch {
      // VM might already be deleted, continue with cleanup based on naming convention
      nicName = `${providerInstanceId}-nic`;
      nsgName = `${providerInstanceId}-nsg`;
      publicIpName = `${providerInstanceId}-ip`;
    }

    // Delete VM first
    console.log(`[azure] Deleting VM ${providerInstanceId}`);
    try {
      await computeClient.virtualMachines.beginDeleteAndWait(this.resourceGroup, providerInstanceId);
    } catch (err) {
      console.warn(`[azure] Failed to delete VM: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Delete NIC
    if (nicName) {
      console.log(`[azure] Deleting NIC ${nicName}`);
      try {
        await networkClient.networkInterfaces.beginDeleteAndWait(this.resourceGroup, nicName);
      } catch (err) {
        console.warn(`[azure] Failed to delete NIC: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Delete NSG
    if (nsgName) {
      console.log(`[azure] Deleting NSG ${nsgName}`);
      try {
        await networkClient.networkSecurityGroups.beginDeleteAndWait(this.resourceGroup, nsgName);
      } catch (err) {
        console.warn(`[azure] Failed to delete NSG: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Delete Public IP (unless static and should be preserved)
    if (publicIpName) {
      console.log(`[azure] Deleting Public IP ${publicIpName}`);
      try {
        const ip = await networkClient.publicIPAddresses.get(this.resourceGroup, publicIpName);
        // Only delete dynamic IPs or if explicitly tagged for deletion
        if (ip.publicIPAllocationMethod === "Dynamic" || ip.tags?.["swarm:delete-with-vm"] === "true") {
          await networkClient.publicIPAddresses.beginDeleteAndWait(this.resourceGroup, publicIpName);
        } else {
          console.log(`[azure] Preserving static IP ${publicIpName}`);
        }
      } catch (err) {
        console.warn(`[azure] Failed to delete Public IP: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  async takeScreenshot(providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    // Azure Boot Diagnostics provides screenshots as a debug/fallback feature
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);

    try {
      const result = await client.virtualMachines.retrieveBootDiagnosticsData(
        this.resourceGroup,
        providerInstanceId,
      );
      // Boot diagnostics returns a SAS URL for the screenshot
      return { url: (result as Record<string, unknown>).screenshotBlobUri as string || "" };
    } catch {
      // Fallback: use Run Command to capture from in-guest VNC
      const cmdResult = await this.runCommand(
        providerInstanceId,
        "DISPLAY=:1 import -window root -quality 80 /tmp/ss.jpg && base64 /tmp/ss.jpg",
      );
      if (cmdResult.success && cmdResult.data?.stdout) {
        const base64 = cmdResult.data.stdout as string;
        return { url: `data:image/jpeg;base64,${base64}`, base64 };
      }
      return { url: "" };
    }
  }

  async executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    const start = Date.now();

    switch (action.actionType) {
      case "bash":
      case "exec": {
        const command = action.payload.command as string;
        return this.runCommand(providerInstanceId, command);
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
        return this.runCommand(providerInstanceId, xdoCmd);
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
    return `https://portal.azure.com/#@/resource/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Compute/virtualMachines/${providerInstanceId}/serialConsole`;
  }

  async createSnapshot(providerInstanceId: string, label: string): Promise<string> {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const credential = await this.getCredential();
    const client = new ComputeManagementClient(credential, this.subscriptionId);

    // Get the OS disk ID
    const vm = await client.virtualMachines.get(this.resourceGroup, providerInstanceId);
    const osDiskId = vm.storageProfile?.osDisk?.managedDisk?.id;
    if (!osDiskId) throw new Error("No OS disk found on VM");

    const snapshotName = `swarm-${label}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 80);
    await client.snapshots.beginCreateOrUpdateAndWait(this.resourceGroup, snapshotName, {
      location: vm.location || "eastus",
      creationData: {
        createOption: "Copy",
        sourceResourceId: osDiskId,
      },
      tags: { "swarm:managed": "true" },
    });

    return snapshotName;
  }

  async cloneInstance(providerInstanceId: string, newName: string): Promise<string> {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
    const { NetworkManagementClient } = await import("@azure/arm-network");
    const credential = await this.getCredential();
    const computeClient = new ComputeManagementClient(credential, this.subscriptionId);
    const networkClient = new NetworkManagementClient(credential, this.subscriptionId);

    // Get source VM details
    const sourceVm = await computeClient.virtualMachines.get(this.resourceGroup, providerInstanceId);
    const location = sourceVm.location || "eastus";
    const vmSize = sourceVm.hardwareProfile?.vmSize || "Standard_B2s";

    // Generate new VM name
    const newVmName = `swarm-${newName}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 64);

    // Step 1: Create snapshot of source VM's OS disk
    console.log(`[azure] Creating snapshot for clone`);
    const snapshotName = await this.createSnapshot(providerInstanceId, "clone");

    // Step 2: Create networking resources for new VM
    const vnetName = "swarm-vnet";
    const subnetName = "swarm-subnet";
    const nsgName = `${newVmName}-nsg`;
    const publicIpName = `${newVmName}-ip`;
    const nicName = `${newVmName}-nic`;

    // Create NSG
    console.log(`[azure] Creating NSG for clone`);
    await networkClient.networkSecurityGroups.beginCreateOrUpdateAndWait(this.resourceGroup, nsgName, {
      location,
      securityRules: [
        {
          name: "AllowVNC",
          protocol: "Tcp",
          sourcePortRange: "*",
          destinationPortRange: "6080",
          sourceAddressPrefix: "*",
          destinationAddressPrefix: "*",
          access: "Allow",
          priority: 100,
          direction: "Inbound",
        },
        {
          name: "AllowSSH",
          protocol: "Tcp",
          sourcePortRange: "*",
          destinationPortRange: "22",
          sourceAddressPrefix: "*",
          destinationAddressPrefix: "*",
          access: "Allow",
          priority: 110,
          direction: "Inbound",
        },
        {
          name: "AllowVNCDirect",
          protocol: "Tcp",
          sourcePortRange: "*",
          destinationPortRange: "5901",
          sourceAddressPrefix: "*",
          destinationAddressPrefix: "*",
          access: "Allow",
          priority: 120,
          direction: "Inbound",
        },
      ],
      tags: { "swarm:managed": "true", "swarm:vm": newVmName },
    });

    // Create Public IP
    console.log(`[azure] Creating Public IP for clone`);
    const publicIpResult = await networkClient.publicIPAddresses.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      publicIpName,
      {
        location,
        publicIPAllocationMethod: "Dynamic",
        sku: { name: "Standard" },
        tags: { "swarm:managed": "true", "swarm:vm": newVmName },
      }
    );

    // Get subnet reference
    const subnet = await networkClient.subnets.get(this.resourceGroup, vnetName, subnetName);

    // Create NIC
    console.log(`[azure] Creating NIC for clone`);
    const nicResult = await networkClient.networkInterfaces.beginCreateOrUpdateAndWait(
      this.resourceGroup,
      nicName,
      {
        location,
        ipConfigurations: [{
          name: "ipconfig1",
          subnet: { id: subnet.id },
          publicIPAddress: { id: publicIpResult.id },
          privateIPAllocationMethod: "Dynamic",
        }],
        networkSecurityGroup: {
          id: `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Network/networkSecurityGroups/${nsgName}`,
        },
        tags: { "swarm:managed": "true", "swarm:vm": newVmName },
      }
    );

    // Step 3: Create managed disk from snapshot
    console.log(`[azure] Creating disk from snapshot`);
    const diskName = `${newVmName}-osdisk`;
    const snapshot = await computeClient.snapshots.get(this.resourceGroup, snapshotName);

    await computeClient.disks.beginCreateOrUpdateAndWait(this.resourceGroup, diskName, {
      location,
      creationData: {
        createOption: "Copy",
        sourceResourceId: snapshot.id,
      },
      sku: { name: "Premium_LRS" },
      tags: { "swarm:managed": "true", "swarm:vm": newVmName },
    });

    // Step 4: Create new VM from the disk
    console.log(`[azure] Creating cloned VM ${newVmName}`);
    await computeClient.virtualMachines.beginCreateOrUpdateAndWait(this.resourceGroup, newVmName, {
      location,
      hardwareProfile: { vmSize },
      osProfile: {
        computerName: newVmName.slice(0, 15),
        adminUsername: "swarm",
        adminPassword: `Swarm${Date.now()}!`,
        linuxConfiguration: {
          disablePasswordAuthentication: false,
        },
      },
      storageProfile: {
        osDisk: {
          createOption: "Attach",
          managedDisk: {
            id: `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/providers/Microsoft.Compute/disks/${diskName}`,
          },
          osType: "Linux",
          deleteOption: "Delete",
        },
      },
      networkProfile: {
        networkInterfaces: [{
          id: nicResult.id,
          primary: true,
        }],
      },
      diagnosticsProfile: {
        bootDiagnostics: { enabled: true },
      },
      tags: {
        "swarm:managed": "true",
        "swarm:cloned-from": providerInstanceId,
        "swarm:nic": nicName,
        "swarm:nsg": nsgName,
        "swarm:ip": publicIpName,
      },
    });

    // Step 5: Clean up temporary snapshot
    console.log(`[azure] Cleaning up clone snapshot ${snapshotName}`);
    try {
      await computeClient.snapshots.beginDeleteAndWait(this.resourceGroup, snapshotName);
    } catch (err) {
      console.warn(`[azure] Failed to delete clone snapshot: ${err instanceof Error ? err.message : String(err)}`);
    }

    return newVmName;
  }

  // ── Helpers ────────────────────────────────────────────

  private async runCommand(vmName: string, command: string): Promise<ActionResult> {
    const { ComputeManagementClient } = await import("@azure/arm-compute");
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
    const { NetworkManagementClient } = await import("@azure/arm-network");
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
