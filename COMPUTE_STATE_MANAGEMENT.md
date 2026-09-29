# Compute Instance State Management

## Overview

Compute instances in Agent Guild follow a **state machine** with automatic recovery for stuck states. This document outlines the state transitions, error handling, and debugging tools.

---

## State Machine

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│                     Computer Instance                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘

                         ┌──────────┐
                         │ CREATE   │
                         └─────┬────┘
                               │
                               ▼
                    ┌──────────────────┐
                    │  provisioning    │◄───┐
                    └────────┬─────────┘    │
                             │              │
                             ▼              │
                    ┌──────────────────┐    │
                    │    stopped       │    │ Timeout
                    └────────┬─────────┘    │ (15 min)
                             │              │
                       START │              │
                             ▼              │
                    ┌──────────────────┐    │
                    │    starting      │────┘
                    └────────┬─────────┘
                             │  ┌──────────────┐
                             │  │ Timeout      │
                             │  │ (10 min)     │
                             │  └──────┬───────┘
                             ▼         ▼
                    ┌──────────────────┐
                    │    running       │
                    └────────┬─────────┘
                             │
                       STOP  │
                             ▼
                    ┌──────────────────┐
                    │    stopping      │
                    └────────┬─────────┘
                             │  ┌──────────────┐
                             │  │ Timeout      │
                             │  │ (5 min)      │
                             ▼  ▼              │
                    ┌──────────────────┐       │
                    │    stopped       │       │
                    └──────────────────┘       │
                                               │
                         ERROR ────────────────┘
                           │
                           ▼
                    ┌──────────────────┐
                    │     error        │
                    └──────────────────┘
                           │
                    FORCE RESET
                           │
                           ▼
                    ┌──────────────────┐
                    │    stopped       │
                    └──────────────────┘
```

---

## States

| State | Description | Duration | Can Start? | Can Stop? | Auto-Recovery |
|-------|-------------|----------|-----------|-----------|---------------|
| **provisioning** | Creating cloud resources | 2-15 min | ❌ | ❌ | 15 min → error |
| **stopped** | Fully stopped, no cost | Indefinite | ✅ | ❌ | N/A |
| **starting** | Booting instance | 2-10 min | ❌ | ❌ | 10 min → error |
| **running** | Active, billable | Indefinite | ❌ | ✅ | Auto-stop timer |
| **stopping** | Shutting down | 30s-5 min | ❌ | ❌ | 5 min → error |
| **error** | Failed operation | Indefinite | ✅ | ❌ | Manual reset |
| **snapshotting** | Creating snapshot | 5-30 min | ❌ | ❌ | 30 min → error |

---

## State Transitions

### Normal Flow

```typescript
// 1. Create instance
POST /api/compute/computers
  → status: "provisioning" (Azure creates VM)
  → status: "stopped" (VM created, not started)

// 2. Start instance
POST /api/compute/computers/{id}/start
  → status: "starting" (Provider boots VM)
  → status: "running" (VM active, VNC available)

// 3. Stop instance
POST /api/compute/computers/{id}/stop
  → status: "stopping" (Provider deallocates VM)
  → status: "stopped" (VM deallocated, no cost)

// 4. Delete instance
DELETE /api/compute/computers/{id}
  → Provider deletes VM
  → Firestore document deleted
```

### Error Recovery Flow

```typescript
// Scenario: Instance stuck in "starting" for 12 minutes

// Automatic recovery (after 10 min)
→ status: "error"
→ providerMetadata.autoRecovered: true
→ providerMetadata.previousStatus: "starting"

// User can now retry
POST /api/compute/computers/{id}/start
  → status: "starting" (retry)
  → status: "running" (success)
```

---

## API Endpoints

### 1. Start Instance

```bash
POST /api/compute/computers/{id}/start
```

**Success Response:**
```json
{
  "ok": true,
  "sessionId": "sess-abc123"
}
```

**Error Responses:**

**409 Conflict** (already running):
```json
{
  "error": "Computer is already running",
  "currentStatus": "running",
  "message": "The instance is already active. Refresh the page to see current status."
}
```

**409 Conflict** (currently starting):
```json
{
  "error": "Computer is currently starting",
  "currentStatus": "starting",
  "message": "Please wait for the current startup to complete (usually 2-5 minutes)."
}
```

**409 Conflict** (transitional state):
```json
{
  "error": "Cannot start computer in \"stopping\" state",
  "currentStatus": "stopping",
  "message": "The instance is stopping. Wait for it to reach a stable state."
}
```

---

### 2. Check Status (Debugging)

```bash
GET /api/compute/computers/{id}/status
```

**Response:**
```json
{
  "id": "comp-123",
  "name": "dev-environment",
  "status": "starting",
  "provider": "azure",
  "providerInstanceId": "agent-guild-dev-123",

  "timing": {
    "createdAt": "2026-03-23T10:00:00Z",
    "updatedAt": "2026-03-23T10:05:00Z",
    "lastActiveAt": "2026-03-23T10:00:00Z",
    "timeInCurrentState": "5m 23s",
    "timeSinceLastActive": "5m 23s"
  },

  "health": {
    "isStuck": false,
    "canStart": false,
    "canStop": false,
    "canRestart": false,
    "suggestedAction": null
  },

  "resources": {
    "sizeKey": "medium",
    "cpuCores": 4,
    "ramMb": 8192,
    "diskGb": 50,
    "region": "us-east"
  },

  "config": {
    "autoStopMinutes": 30,
    "persistenceEnabled": true,
    "staticIpEnabled": false,
    "controllerType": "human"
  }
}
```

**When stuck (> 10 min in "starting"):**
```json
{
  "health": {
    "isStuck": true,
    "suggestedAction": {
      "action": "force_reset",
      "description": "Instance stuck in \"starting\" for 12 minutes",
      "endpoint": "/api/compute/computers/comp-123/force-reset",
      "method": "POST"
    }
  }
}
```

---

### 3. Force Reset (Recovery)

```bash
POST /api/compute/computers/{id}/force-reset
```

**Prerequisites:**
- Instance must be in transitional state (`starting`, `stopping`, `provisioning`, `snapshotting`)
- Must be stuck for > 5 minutes

**Success Response:**
```json
{
  "ok": true,
  "message": "Instance reset to \"error\" state. You can now retry starting it.",
  "previousStatus": "starting",
  "timeInStateMinutes": 12
}
```

**Error Response (not stuck yet):**
```json
{
  "error": "Instance not stuck yet",
  "message": "Instance has only been in \"starting\" state for 3 minutes. Please wait at least 5 minutes before force-resetting.",
  "timeInStateMinutes": 3
}
```

**Error Response (wrong state):**
```json
{
  "error": "Cannot force reset instance in \"running\" state",
  "message": "Force reset is only allowed for stuck transitional states",
  "allowedStates": ["starting", "stopping", "provisioning", "snapshotting"]
}
```

---

## Auto-Recovery Logic

### 1. Stuck "starting" Detection

```typescript
// Trigger: Instance in "starting" for > 10 minutes
if (computer.status === "starting") {
  const startingDuration = Date.now() - new Date(computer.lastActiveAt).getTime();

  if (startingDuration > 10 * 60 * 1000) {
    console.warn(`Auto-recovering from stuck "starting" state`);
    await updateComputer(id, { status: "error" });
  }
}
```

**Metadata added:**
```json
{
  "providerMetadata": {
    "autoRecovered": true,
    "autoRecoveredAt": "2026-03-23T10:15:00Z",
    "autoRecoveredReason": "Stuck in \"starting\" for 10 minutes",
    "previousStatus": "starting"
  }
}
```

### 2. Auto-Stop Timer

```typescript
// Trigger: Instance idle for > autoStopMinutes
if (computer.status === "running") {
  const idleTime = Date.now() - new Date(computer.lastActiveAt).getTime();
  const autoStopTime = computer.autoStopMinutes * 60 * 1000;

  if (idleTime > autoStopTime) {
    console.log(`Auto-stopping idle instance after ${computer.autoStopMinutes} min`);
    await provider.stopInstance(computer.providerInstanceId);
    await updateComputer(id, { status: "stopped" });
  }
}
```

---

## Firestore State Tracking

### Computer Document

```typescript
{
  id: "comp-123",
  status: "starting",
  createdAt: Timestamp,
  updatedAt: Timestamp, // Last state change
  lastActiveAt: Timestamp, // Last user interaction

  providerMetadata: {
    // Auto-recovery
    autoRecovered: boolean,
    autoRecoveredAt: string,
    autoRecoveredReason: string,
    previousStatus: string,

    // Force reset
    forceResetAt: string,
    forceResetReason: string,

    // Provider-specific
    azureProduct: "vm" | "aci" | "spot",
    resourceGroup: "agent-guild-compute",
    // ... etc
  }
}
```

### State Change Audit

```typescript
// Log all state changes to subcollection (optional)
computers/{id}/stateHistory/{changeId}
{
  from: "starting",
  to: "running",
  reason: "Provider confirmed instance active",
  triggeredBy: "user" | "auto-recovery" | "force-reset",
  timestamp: Timestamp
}
```

---

## Scaling Considerations

### Multi-Instance State Consistency

When running multiple Next.js instances (per SCALING_ARCHITECTURE.md):

**Problem:** Race conditions on state updates

**Solution:** Use Firestore transactions

```typescript
// WRONG: Race condition
const computer = await getComputer(id);
if (computer.status === "stopped") {
  await updateComputer(id, { status: "starting" }); // Another instance might have started already
}

// CORRECT: Atomic transaction
await db.runTransaction(async (transaction) => {
  const ref = db.collection("computers").doc(id);
  const doc = await transaction.get(ref);
  const computer = doc.data();

  if (computer.status !== "stopped") {
    throw new Error(`Cannot start from ${computer.status} state`);
  }

  transaction.update(ref, { status: "starting", updatedAt: serverTimestamp() });
});
```

### WebSocket State Sync

When instance state changes, broadcast to all connected clients:

```typescript
// After state change
await updateComputer(id, { status: "running" });

// Broadcast via Pub/Sub (see SCALING_ARCHITECTURE.md)
await pubsub.topic("agent-guild-broadcast").publish({
  type: "computer_status_changed",
  computerId: id,
  newStatus: "running",
});

// All hub instances receive and notify connected clients
hub.on("computer_status_changed", (msg) => {
  const clients = getClientsForComputer(msg.computerId);
  clients.forEach((ws) => {
    ws.send(JSON.stringify({
      type: "status_update",
      computerId: msg.computerId,
      status: msg.newStatus,
    }));
  });
});
```

---

## Monitoring & Alerting

### Metrics to Track

```typescript
// Prometheus metrics
agent_guild_computer_state_transitions_total{from="starting", to="running"} 145
agent_guild_computer_state_transitions_total{from="starting", to="error"} 3

agent_guild_computer_auto_recoveries_total 3
agent_guild_computer_force_resets_total 1

agent_guild_computer_state_duration_seconds{state="starting"} 120 // P99
agent_guild_computer_state_duration_seconds{state="stopping"} 30  // P99

agent_guild_computer_stuck_instances{state="starting"} 0 // Current count
```

### Alerts

```yaml
# Alert: Instance stuck > 15 minutes
- alert: ComputerStuckLong
  expr: time() - agent_guild_computer_status_updated_timestamp > 900
  labels:
    severity: critical
  annotations:
    summary: "Computer {{ $labels.id }} stuck in {{ $labels.status }} for > 15 min"

# Alert: High auto-recovery rate
- alert: HighAutoRecoveryRate
  expr: rate(agent_guild_computer_auto_recoveries_total[5m]) > 0.1
  labels:
    severity: warning
  annotations:
    summary: "High auto-recovery rate (> 6/hr) - investigate provider issues"
```

---

## Testing State Transitions

### Unit Tests

```typescript
describe("Computer state machine", () => {
  it("should transition from stopped to running", async () => {
    const computer = await createComputer({ status: "stopped" });

    const result = await startComputer(computer.id);
    expect(result.ok).toBe(true);

    const updated = await getComputer(computer.id);
    expect(updated.status).toBe("running");
  });

  it("should reject start from running state", async () => {
    const computer = await createComputer({ status: "running" });

    const result = await startComputer(computer.id);
    expect(result.status).toBe(409);
    expect(result.error).toContain("already running");
  });

  it("should auto-recover from stuck starting state", async () => {
    const computer = await createComputer({
      status: "starting",
      updatedAt: new Date(Date.now() - 11 * 60 * 1000), // 11 min ago
    });

    await startComputer(computer.id); // Trigger recovery

    const updated = await getComputer(computer.id);
    expect(updated.status).toBe("error");
    expect(updated.providerMetadata.autoRecovered).toBe(true);
  });
});
```

### Integration Tests

```bash
# Scenario: Full lifecycle test
1. Create instance → status: "provisioning"
2. Wait for provision → status: "stopped"
3. Start instance → status: "starting"
4. Wait for start → status: "running"
5. Stop instance → status: "stopping"
6. Wait for stop → status: "stopped"
7. Delete instance → document removed

# Scenario: Stuck state recovery
1. Mock provider to hang on start
2. Start instance → status: "starting"
3. Wait 11 minutes
4. Retry start → triggers auto-recovery
5. Verify status: "error"
6. Retry start → status: "starting"
7. Provider succeeds → status: "running"
```

---

## Best Practices

### For Users

1. ✅ **Wait for stable state** before retrying operations
2. ✅ **Use status endpoint** to check if stuck
3. ✅ **Enable auto-stop** to avoid unnecessary costs
4. ✅ **Check provider health** if frequent errors

### For Developers

1. ✅ **Use transactions** for state changes (prevent race conditions)
2. ✅ **Log all transitions** with metadata
3. ✅ **Implement timeouts** for all provider calls
4. ✅ **Broadcast state changes** via Pub/Sub (multi-instance)
5. ✅ **Monitor stuck instances** with alerts

### For Operators

1. ✅ **Monitor auto-recovery rate** (should be < 1%)
2. ✅ **Alert on stuck instances** (> 15 min)
3. ✅ **Track provider errors** by type
4. ✅ **Review force-reset logs** for patterns

---

## Summary

Agent Guild's compute state management provides:

- ✅ **Automatic recovery** from stuck states (10 min timeout)
- ✅ **Force reset** for manual intervention
- ✅ **Status endpoint** for debugging
- ✅ **Transaction-based updates** for consistency
- ✅ **Pub/Sub broadcasting** for multi-instance sync
- ✅ **Comprehensive error messages** with actionable guidance

**State transitions are predictable, recoverable, and observable at scale.**
