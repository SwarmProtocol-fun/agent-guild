/**
 * Swarm Compute — AWS EC2 Provider
 *
 * Uses EC2 for VM lifecycle, SSM Run Command for remote execution,
 * and SSM Session Manager for secure interactive access.
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

export class AwsComputeProvider implements ComputeProvider {
  readonly name = "aws";

  private async ec2(region: string) {
    const { EC2Client } = await import("@aws-sdk/client-ec2");
    return new EC2Client({ region });
  }

  private async ssm(region: string) {
    const { SSMClient } = await import("@aws-sdk/client-ssm");
    return new SSMClient({ region });
  }

  private resolveRegion(region: Region): string {
    return PROVIDER_REGION_MAP.aws[region] || "us-east-1";
  }

  private resolveInstanceType(sizeKey: SizeKey): string {
    return PROVIDER_SIZE_MAP.aws[sizeKey] || "t3.medium";
  }

  async createInstance(config: InstanceConfig): Promise<ProviderResult> {
    const { RunInstancesCommand } = await import("@aws-sdk/client-ec2");
    const nativeRegion = config.providerRegion || this.resolveRegion(config.region);
    const instanceType = config.providerInstanceType || this.resolveInstanceType(config.sizeKey);
    const imageId = config.providerImage || PROVIDER_BASE_IMAGES.aws;

    // User-data script that installs the desktop stack
    const userData = Buffer.from(this.buildUserData(config)).toString("base64");

    const client = await this.ec2(nativeRegion);
    const result = await client.send(new RunInstancesCommand({
      ImageId: imageId,
      InstanceType: instanceType as import("@aws-sdk/client-ec2")._InstanceType,
      MinCount: 1,
      MaxCount: 1,
      UserData: userData,
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: [
          { Key: "Name", Value: `swarm-${config.name}` },
          { Key: "swarm:managed", Value: "true" },
          { Key: "swarm:size", Value: config.sizeKey },
        ],
      }],
      BlockDeviceMappings: [{
        DeviceName: "/dev/sda1",
        Ebs: {
          VolumeSize: config.diskGb,
          VolumeType: "gp3",
          DeleteOnTermination: !config.persistenceEnabled,
        },
      }],
      // SSM requires an IAM role — the instance profile should be pre-configured
      IamInstanceProfile: process.env.AWS_INSTANCE_PROFILE
        ? { Name: process.env.AWS_INSTANCE_PROFILE }
        : undefined,
    }));

    const instanceId = result.Instances?.[0]?.InstanceId;
    if (!instanceId) throw new Error("EC2 RunInstances returned no instance ID");

    return {
      providerInstanceId: instanceId,
      status: "starting",
      providerInstanceType: instanceType,
      providerRegion: nativeRegion,
      metadata: { imageId },
    };
  }

  async startInstance(providerInstanceId: string): Promise<void> {
    const { StartInstancesCommand } = await import("@aws-sdk/client-ec2");
    const region = await this.getInstanceRegion(providerInstanceId);
    const client = await this.ec2(region);
    await client.send(new StartInstancesCommand({ InstanceIds: [providerInstanceId] }));
  }

  async stopInstance(providerInstanceId: string): Promise<void> {
    const { StopInstancesCommand } = await import("@aws-sdk/client-ec2");
    const region = await this.getInstanceRegion(providerInstanceId);
    const client = await this.ec2(region);
    await client.send(new StopInstancesCommand({ InstanceIds: [providerInstanceId] }));
  }

  async restartInstance(providerInstanceId: string): Promise<void> {
    const { RebootInstancesCommand } = await import("@aws-sdk/client-ec2");
    const region = await this.getInstanceRegion(providerInstanceId);
    const client = await this.ec2(region);
    await client.send(new RebootInstancesCommand({ InstanceIds: [providerInstanceId] }));
  }

  async deleteInstance(providerInstanceId: string): Promise<void> {
    const { TerminateInstancesCommand } = await import("@aws-sdk/client-ec2");
    const region = await this.getInstanceRegion(providerInstanceId);
    const client = await this.ec2(region);
    await client.send(new TerminateInstancesCommand({ InstanceIds: [providerInstanceId] }));
  }

  async takeScreenshot(providerInstanceId: string): Promise<{ url: string; base64?: string }> {
    // Use SSM Run Command to capture screenshot from in-guest VNC
    const result = await this.runSsmCommand(
      providerInstanceId,
      "import -window root -quality 80 /tmp/swarm-screenshot.jpg && base64 /tmp/swarm-screenshot.jpg",
    );
    if (result.success && result.data?.stdout) {
      const base64 = result.data.stdout as string;
      return { url: `data:image/jpeg;base64,${base64}`, base64 };
    }
    return { url: "" };
  }

  async executeAction(providerInstanceId: string, action: ActionEnvelope): Promise<ActionResult> {
    const start = Date.now();

    switch (action.actionType) {
      case "bash":
      case "exec": {
        const command = action.payload.command as string;
        return this.runSsmCommand(providerInstanceId, command);
      }
      case "screenshot":
        return {
          success: true,
          data: await this.takeScreenshot(providerInstanceId),
          durationMs: Date.now() - start,
        };
      case "click":
      case "double_click":
      case "type":
      case "key":
      case "scroll":
      case "drag": {
        // Desktop actions are routed through the in-guest VNC/xdotool bridge
        const xdoCmd = this.buildXdotoolCommand(action);
        return this.runSsmCommand(providerInstanceId, xdoCmd);
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
    // Get the instance's public IP and return the noVNC URL
    const ip = await this.getPublicIp(providerInstanceId);
    if (!ip) return "";
    // noVNC runs on port 6080 inside the guest (installed via user-data)
    return `https://${ip}:6080/vnc.html?autoconnect=true&resize=scale`;
  }

  async getTerminalUrl(providerInstanceId: string): Promise<string> {
    // SSM Session Manager provides browser-based terminal
    // Return the AWS Console URL for Session Manager
    const region = await this.getInstanceRegion(providerInstanceId);
    return `https://${region}.console.aws.amazon.com/systems-manager/session-manager/${providerInstanceId}`;
  }

  async createSnapshot(providerInstanceId: string, label: string): Promise<string> {
    const { CreateImageCommand } = await import("@aws-sdk/client-ec2");
    const region = await this.getInstanceRegion(providerInstanceId);
    const client = await this.ec2(region);
    const result = await client.send(new CreateImageCommand({
      InstanceId: providerInstanceId,
      Name: `swarm-snapshot-${label}-${Date.now()}`,
      NoReboot: true,
    }));
    return result.ImageId || `snapshot-${providerInstanceId}`;
  }

  async cloneInstance(providerInstanceId: string, newName: string): Promise<string> {
    // Create AMI from source, then launch new instance from it
    const snapshotId = await this.createSnapshot(providerInstanceId, "clone");
    // We'd need the original config to create a matching instance
    // For now, return the AMI ID — the caller can use it to launch
    return snapshotId;
  }

  // ── Helpers ────────────────────────────────────────────

  private async runSsmCommand(instanceId: string, command: string): Promise<ActionResult> {
    const { SendCommandCommand, GetCommandInvocationCommand } = await import("@aws-sdk/client-ssm");
    const start = Date.now();
    const region = await this.getInstanceRegion(instanceId);
    const client = await this.ssm(region);

    const sendResult = await client.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [command] },
      TimeoutSeconds: 120,
    }));

    const commandId = sendResult.Command?.CommandId;
    if (!commandId) {
      return { success: false, error: "SSM SendCommand returned no command ID", durationMs: Date.now() - start };
    }

    // Poll for completion
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const invocation = await client.send(new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        }));
        if (invocation.Status === "Success") {
          return {
            success: true,
            data: {
              stdout: invocation.StandardOutputContent || "",
              stderr: invocation.StandardErrorContent || "",
              exitCode: invocation.ResponseCode || 0,
            },
            durationMs: Date.now() - start,
          };
        }
        if (invocation.Status === "Failed" || invocation.Status === "Cancelled" || invocation.Status === "TimedOut") {
          return {
            success: false,
            error: invocation.StandardErrorContent || `SSM command ${invocation.Status}`,
            data: { stdout: invocation.StandardOutputContent || "", exitCode: invocation.ResponseCode },
            durationMs: Date.now() - start,
          };
        }
      } catch {
        // InvocationDoesNotExist — command not yet processed
      }
    }

    return { success: false, error: "SSM command timed out", durationMs: Date.now() - start };
  }

  private async getPublicIp(instanceId: string): Promise<string | null> {
    const { DescribeInstancesCommand } = await import("@aws-sdk/client-ec2");
    const region = await this.getInstanceRegion(instanceId);
    const client = await this.ec2(region);
    const result = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    return result.Reservations?.[0]?.Instances?.[0]?.PublicIpAddress || null;
  }

  private async getInstanceRegion(_instanceId: string): Promise<string> {
    // In production, look up from Firestore computer record.
    // For now, use the default region.
    return process.env.AWS_REGION || "us-east-1";
  }

  private buildUserData(config: InstanceConfig): string {
    return `#!/bin/bash
set -e
# Install lightweight desktop + VNC + noVNC for Swarm desktop access
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y xfce4 xfce4-terminal tigervnc-standalone-server novnc websockify xdotool imagemagick
# Configure VNC
mkdir -p /root/.vnc
echo "swarmvnc" | vncpasswd -f > /root/.vnc/passwd
chmod 600 /root/.vnc/passwd
cat > /root/.vnc/xstartup << 'XSTARTUP'
#!/bin/bash
exec startxfce4
XSTARTUP
chmod +x /root/.vnc/xstartup
# Set resolution
vncserver :1 -geometry ${config.resolutionWidth}x${config.resolutionHeight} -depth 24
# Start noVNC on port 6080
websockify --web /usr/share/novnc 6080 localhost:5901 &
${config.startupScript || ""}
`;
  }

  /** Validate that a value is a safe integer for xdotool coordinates */
  private safeInt(val: unknown): number {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0 || n > 10000) throw new Error(`Invalid coordinate: ${val}`);
    return Math.round(n);
  }

  /** Escape text for safe shell single-quote interpolation */
  private shellEscape(text: string): string {
    // Replace single quotes with properly escaped version and strip control chars
    return text.replace(/[\x00-\x1f\x7f]/g, "").replace(/'/g, "'\\''");
  }

  /** Validate xdotool key name (only allow alphanumeric, underscore, plus for combos) */
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
