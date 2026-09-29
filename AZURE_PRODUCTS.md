# Azure Product Offerings - Complete Guide

Agent Guild now supports **5 different Azure compute products**, each optimized for specific workloads. Choose the right product based on your needs, budget, and performance requirements.

## Product Overview

| Product | Startup Time | Persistence | VNC Access | Cost Savings | Best For |
|---------|--------------|-------------|------------|--------------|----------|
| **Virtual Machines** | 2-5 min | ✅ Full disk | ✅ Yes | Baseline | Long-running, persistent work |
| **Container Instances** | 2-5 sec | ❌ Ephemeral | ✅ Limited | 40-60% cheaper | Short tasks, batch jobs |
| **Spot VMs** | 2-5 min | ⚠️ Can be evicted | ✅ Yes | **90% cheaper** | Fault-tolerant workloads |
| **Virtual Desktop** | 1-3 min | ✅ FSLogix profiles | ✅ Full RDP | 2-3x more expensive | Enterprise VDI, Windows |
| **Azure Batch** | Auto-scaled | ❌ Job-based | ❌ No | 20-30% cheaper | Parallel/HPC workloads |

---

## 1. Virtual Machines (Default)

**Use Azure VMs when:** You need full control, persistent storage, and guaranteed availability.

### Features
- Full Ubuntu 22.04 LTS desktop with XFCE4
- Persistent managed disks (survive stop/start)
- VNC desktop access via noVNC (browser-based)
- Snapshots supported for backups
- Custom cloud-init scripts on startup
- Boot diagnostics with screenshot capability

### Pricing (per hour)
- **Small** (2 vCPU, 4 GB): $0.05
- **Medium** (4 vCPU, 8 GB): $0.18
- **Large** (8 vCPU, 16 GB): $0.40
- **XL** (16 vCPU, 32 GB): $0.79

### VM Series Options
- **B-series**: Burstable CPU, cost-effective for dev/test
- **D-series**: General purpose, consistent performance
- **E-series**: Memory-optimized (up to 672 GB RAM)
- **F-series**: Compute-optimized (high CPU:RAM ratio)
- **NC/ND-series**: GPU-accelerated (NVIDIA Tesla)

### When to Choose VMs
✅ Development environments that run 24/7
✅ Applications requiring persistent state
✅ Workloads needing custom kernel modules
✅ Tasks that can't tolerate interruptions
✅ Production workloads with SLA requirements

### Configuration Example
```typescript
{
  provider: "azure",
  azureProduct: "vm", // default
  sizeKey: "medium",
  persistenceEnabled: true,
  region: "us-east",
}
```

---

## 2. Azure Container Instances (ACI)

**Use ACI when:** You need fast startup, pay-per-second billing, and don't need persistent storage.

### Features
- **2-5 second startup** (vs 2-5 minutes for VMs)
- Per-second billing (minimum 1 second)
- No VM management required
- Integrated with Azure Container Registry
- Public IP with DNS name (FQDN)
- Container group orchestration
- Integrated logging to Azure Monitor

### Pricing (per hour)
- **Small** (2 vCPU, 4 GB): $0.03 **(-40%)**
- **Medium** (4 vCPU, 8 GB): $0.10 **(-44%)**
- **Large** (8 vCPU, 16 GB): $0.22 **(-45%)**
- **XL** (16 vCPU, 32 GB): $0.50 **(-37%)**

### Limitations
❌ **No VNC desktop** (container-based, use exec for shell)
❌ **No snapshots** (ephemeral by design)
❌ **Ephemeral storage** (data lost on stop)
❌ **No custom kernel modules**

### When to Choose ACI
✅ CI/CD pipelines and build jobs
✅ Batch processing that completes in < 1 hour
✅ Event-driven workloads (webhooks, queues)
✅ Microservices and API workers
✅ Data processing jobs (ETL, transforms)
✅ Short-lived AI agent tasks

### Configuration Example
```typescript
{
  provider: "azure",
  azureProduct: "aci",
  sizeKey: "small",
  containerImage: "ubuntu:22.04",
  region: "us-east",
}
```

### ACI vs VMs: Cost Comparison

**Scenario: Run a 10-minute batch job 100 times/day**

| Product | Cost per run | Daily cost | Monthly cost |
|---------|--------------|------------|--------------|
| VM (medium) | $0.03 | $3.00 | $90.00 |
| ACI (medium) | $0.017 | $1.67 | $50.00 |
| **Savings** | **-43%** | **-43%** | **$40/month** |

---

## 3. Spot Virtual Machines

**Use Spot VMs when:** You can tolerate interruptions and want massive cost savings.

### Features
- **Same VM SKUs as on-demand** (B, D, E, F-series)
- **Up to 90% discount** on compute costs
- 30-second eviction warning via Azure Metadata Service
- Eviction policy: Deallocate (stop) or Delete
- Can set max price to control costs
- Best-effort availability (no SLA)

### Pricing (per hour)
- **Small** (2 vCPU, 4 GB): $0.01 **(-80%)**
- **Medium** (4 vCPU, 8 GB): $0.03 **(-83%)**
- **Large** (8 vCPU, 16 GB): $0.06 **(-85%)**
- **XL** (16 vCPU, 32 GB): $0.12 **(-85%)**

### Eviction Scenarios
Spot VMs can be evicted when:
1. Azure needs capacity for on-demand customers
2. The spot price exceeds your max price bid
3. Regional capacity constraints

**Eviction notification**: 30 seconds before termination via:
- Azure Metadata Service (HTTP endpoint in VM)
- Azure Event Grid (external notification)
- Scheduled Events API

### When to Choose Spot VMs
✅ **Dev/test environments** (non-production)
✅ **Batch processing** with checkpointing
✅ **Stateless microservices** behind load balancer
✅ **Machine learning training** (save checkpoints)
✅ **Video rendering** (resumable jobs)
✅ **Scientific simulations** (fault-tolerant)

### When NOT to Use Spot VMs
❌ Production databases
❌ Critical real-time services
❌ Long-running tasks without checkpoints
❌ Workloads requiring guaranteed uptime

### Configuration Example
```typescript
{
  provider: "azure",
  azureProduct: "spot",
  sizeKey: "large",
  persistenceEnabled: false, // evicted VMs lose state
  maxPrice: -1, // pay up to on-demand price
  region: "us-west", // pick regions with high spot availability
}
```

### Handling Evictions in Your Code

```bash
# Inside the VM, poll for eviction notice every 5 seconds
while true; do
  EVICTION=$(curl -H "Metadata:true" \
    "http://169.254.169.254/metadata/scheduledevents?api-version=2020-07-01" -s \
    | jq -r '.Events[] | select(.EventType == "Preempt")')

  if [ -n "$EVICTION" ]; then
    echo "Eviction in 30s! Saving state..."
    # Save checkpoints, upload results, graceful shutdown
    exit 0
  fi

  sleep 5
done &
```

### Spot Availability by Region

| Region | Typical Availability | Recommended Use |
|--------|---------------------|-----------------|
| US East | 85-95% | ✅ Best for prod |
| US West | 80-90% | ✅ Good |
| EU West | 75-85% | ⚠️ Moderate |
| AP Southeast | 60-75% | ⚠️ Lower capacity |

**Tip:** Enable eviction notifications and build retry logic for mission-critical spot workloads.

---

## 4. Azure Virtual Desktop (AVD)

**Use AVD when:** You need enterprise VDI, Windows desktops, or multi-user sessions.

### Features
- **Windows 11 or Ubuntu Desktop**
- Multi-session support (up to 20 users per VM)
- FSLogix profile containers (persistent user data)
- Active Directory / Entra ID integration
- Auto-scaling based on usage
- Azure Monitor integration
- GPU support for graphics workloads

### Pricing (per hour)
- **Small** (2 vCPU, 4 GB): $0.12
- **Medium** (4 vCPU, 8 GB): $0.25
- **Large** (8 vCPU, 16 GB): $0.55
- **XL** (16 vCPU, 32 GB): $1.10

**Note:** AVD is 2-3x more expensive than VMs due to Windows licensing + management layer.

### When to Choose AVD
✅ **Enterprise users** needing Windows desktops
✅ **Regulated industries** (HIPAA, SOC 2, FedRAMP)
✅ **Remote workforce** with centralized management
✅ **Multi-tenant scenarios** (MSPs, consulting firms)
✅ **GPU-accelerated graphics** (CAD, video editing)
✅ **Legacy Windows apps** requiring full desktop

### AVD vs Standard VMs

| Feature | Standard VM | AVD |
|---------|-------------|-----|
| Multi-session | ❌ 1 user | ✅ Up to 20 users |
| Windows licensing | Extra cost | Included |
| Profile management | Manual | FSLogix built-in |
| Auto-scaling | Manual | Automatic |
| AD integration | Manual | Native |
| Cost | Lower | 2-3x higher |

### Configuration Example
```typescript
{
  provider: "azure",
  azureProduct: "avd",
  sizeKey: "medium",
  os: "Windows 11",
  multiSession: true,
  maxUsersPerVM: 5,
  region: "us-east",
}
```

---

## 5. Azure Batch

**Use Azure Batch when:** You need to run parallel workloads across hundreds of VMs.

### Features
- **Auto-scaling node pools** (0 to 1000s of VMs)
- Job scheduling and task orchestration
- Task dependencies and workflows
- Low-priority VMs (spot-like pricing)
- HPC-optimized VM series (H, HB, HC)
- Integrated with Azure Storage
- Built-in job monitoring and logging

### Pricing (per hour, per VM)
- **Small** (2 vCPU, 4 GB): $0.04
- **Medium** (4 vCPU, 8 GB): $0.15
- **Large** (8 vCPU, 16 GB): $0.35
- **XL** (16 vCPU, 32 GB): $0.70

**No management fee** — you only pay for the VMs.

### When to Choose Azure Batch
✅ **Parallel simulations** (Monte Carlo, physics)
✅ **Video rendering** (Blender, 3D animation)
✅ **Scientific computing** (genomics, climate models)
✅ **Data processing pipelines** (ETL at scale)
✅ **Machine learning training** (distributed training)
✅ **Financial modeling** (risk analysis, backtesting)

### Configuration Example
```typescript
{
  provider: "azure",
  azureProduct: "batch",
  poolSize: "auto", // scale from 0 to 100 VMs
  taskCount: 1000,
  vmSize: "Standard_F8s_v2", // compute-optimized
  lowPriority: true, // use spot pricing
}
```

### Batch Job Example

```javascript
// Create a batch job with 1000 tasks
const job = {
  id: "my-simulation",
  poolId: "compute-pool",
  tasks: Array.from({ length: 1000 }, (_, i) => ({
    id: `task-${i}`,
    commandLine: `/bin/bash -c "python simulate.py --run ${i}"`,
    resourceFiles: [
      { httpUrl: "https://myblob.blob.core.windows.net/data/simulate.py" }
    ],
    outputFiles: [
      { destination: { container: { containerUrl: "https://myblob.blob.core.windows.net/results" } } }
    ]
  }))
};
```

---

## Product Comparison Matrix

### By Use Case

| Use Case | Best Product | Runner-Up | Avoid |
|----------|--------------|-----------|-------|
| **AI agent tasks (< 1 hr)** | ACI | Spot VM | AVD |
| **Development environment** | Spot VM | VM | Batch |
| **CI/CD pipelines** | ACI | Batch | AVD |
| **Windows desktop** | AVD | VM (with Windows) | ACI |
| **Parallel simulations** | Batch | Spot VMs | ACI |
| **24/7 production** | VM | (none) | Spot VM |
| **Enterprise VDI** | AVD | (none) | VM |
| **Cost-sensitive dev** | Spot VM | ACI | VM |

### By Cost (Medium size, 1 month 24/7)

| Product | Hourly | Monthly (730 hrs) |
|---------|--------|-------------------|
| **Spot VM** | $0.03 | $21.90 **🏆 Cheapest** |
| **ACI** | $0.10 | $73.00 |
| **Batch** | $0.15 | $109.50 |
| **VM** | $0.18 | $131.40 |
| **AVD** | $0.25 | $182.50 |

### By Startup Time

| Product | Typical Startup |
|---------|-----------------|
| **ACI** | 2-5 seconds ⚡ |
| **VM** | 2-5 minutes |
| **Spot VM** | 2-5 minutes |
| **AVD** | 1-3 minutes |
| **Batch** | Auto-scaled (0-10 min) |

---

## Choosing the Right Product

### Decision Tree

```
Do you need Windows or enterprise VDI?
├─ Yes → AVD
└─ No ↓

Is your workload interruptible?
├─ Yes → Spot VM (save 90%)
└─ No ↓

Does it run < 1 hour and need fast startup?
├─ Yes → ACI (2-5s startup, per-second billing)
└─ No ↓

Is it a parallel/HPC workload?
├─ Yes → Azure Batch
└─ No → VM (full control, persistent)
```

### Example Recommendations

**Scenario: Daily ML training job (2 hours/day)**
- **Best:** Spot VM ($0.03/hr × 2hr × 30 days = $1.80/month)
- **Why:** Interruptible, save checkpoints every 10 min

**Scenario: Microservice API (24/7 uptime)**
- **Best:** VM ($0.18/hr × 730hr = $131.40/month)
- **Why:** Requires guaranteed availability

**Scenario: Webhook handler (triggered 50x/day, 30s each)**
- **Best:** ACI ($0.10/hr × 0.42hr = $0.042/month)
- **Why:** Per-second billing for short tasks

**Scenario: Video rendering farm (1000 videos)**
- **Best:** Azure Batch with low-priority VMs
- **Why:** Parallel processing, auto-scaling

---

## Configuration Guide

### Environment Variables

```bash
# Required for all Azure products
export AZURE_SUBSCRIPTION_ID="your-subscription-id"
export AZURE_RESOURCE_GROUP="agent-guild-compute"

# Authentication (choose one)
export AZURE_CLIENT_ID="your-client-id"
export AZURE_CLIENT_SECRET="your-client-secret"
export AZURE_TENANT_ID="your-tenant-id"

# Or use Azure CLI login
az login
```

### Terraform Setup

```hcl
# main.tf
provider "azurerm" {
  features {}
}

resource "azurerm_resource_group" "agent-guild" {
  name     = "agent-guild-compute"
  location = "eastus"
}

# Pre-create VNet for VMs (optional)
resource "azurerm_virtual_network" "agent-guild" {
  name                = "agent-guild-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = azurerm_resource_group.agent-guild.location
  resource_group_name = azurerm_resource_group.agent-guild.name
}
```

### Firestore Setup

Store Azure product type in `providerMetadata`:

```typescript
// Computer document
{
  id: "comp-123",
  provider: "azure",
  providerMetadata: {
    azureProduct: "aci", // vm, aci, spot, avd, batch
    resourceGroup: "agent-guild-compute",
    subscription: "abc-123",
  }
}
```

---

## Cost Optimization Tips

### 1. Right-size Your Instances
- Start with **small** size for prototyping
- Monitor CPU/RAM usage, scale up if needed
- Most AI agents use < 2 CPU cores

### 2. Use Spot VMs for Dev/Test
- **90% savings** vs on-demand
- Set up auto-restart on eviction
- Use Deallocate policy to preserve disk

### 3. Auto-stop Idle Instances
```typescript
{
  autoStopMinutes: 30, // stop after 30 min idle
}
```

### 4. ACI for Short Tasks
- Per-second billing saves money on < 1 hour jobs
- No VM overhead or startup costs

### 5. Azure Reservations
- Commit to 1-year or 3-year for 40-60% discount
- Best for 24/7 production workloads
- Not compatible with Spot VMs

### 6. Use Burstable B-series
- Cheapest VM series
- Accumulates CPU credits when idle
- Perfect for bursty dev workloads

---

## Monitoring & Observability

### Azure Monitor Integration

All products send metrics to Azure Monitor:

```typescript
// Query CPU usage
az monitor metrics list \
  --resource /subscriptions/{sub}/resourceGroups/agent-guild-compute/providers/Microsoft.Compute/virtualMachines/{vmName} \
  --metric "Percentage CPU" \
  --start-time 2025-01-01T00:00:00Z \
  --end-time 2025-01-01T23:59:59Z
```

### Cost Tracking

```typescript
// Get daily cost by product
az consumption usage list \
  --start-date 2025-01-01 \
  --end-date 2025-01-31 \
  --query "[?contains(tags.'agent-guild:product', 'aci')]"
```

### Alerts

Set up alerts for:
- Spot VM eviction warnings
- Cost threshold exceeded
- ACI container failures
- Batch job completion

---

## Roadmap

### Coming Soon
- ✅ Virtual Machines (complete)
- ✅ Container Instances (complete)
- ✅ Spot VMs (complete)
- ⏳ Azure Virtual Desktop (Q2 2026)
- ⏳ Azure Batch (Q2 2026)

### Future Enhancements
- Azure Kubernetes Service (AKS) integration
- Azure Functions serverless compute
- GPU-accelerated VMs (NC/ND-series)
- Azure DevTest Labs for sandbox environments
- Regional failover and multi-region deployments

---

## Support & Troubleshooting

### Common Issues

**Q: My ACI container won't start**
- Check container image is public or ACR credentials are set
- Verify CPU/RAM limits are within ACI quotas
- Check Azure Monitor logs for startup errors

**Q: Spot VM was evicted, how do I recover?**
- If using Deallocate policy, disk is preserved
- Restart the VM when capacity is available
- Consider using Azure Batch with retry logic

**Q: AVD session host not joining pool**
- Verify AD domain join credentials
- Check network connectivity to Azure AD
- Ensure FSLogix profile share is accessible

### Getting Help
- Azure Support: portal.azure.com
- Agent Guild Discord: discord.gg/agent-guild
- Documentation: docs.agent-guild.com

---

**Ready to deploy?** Start with **Spot VMs** for dev, **ACI** for batch jobs, and **VMs** for production. Save up to 90% on compute costs while maintaining full Azure enterprise features.
