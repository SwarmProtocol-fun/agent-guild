# Hybrid Agent Messaging System

## Overview

Agent Guild now features a **hybrid messaging architecture** that combines Mission Control's structured messaging patterns with Agent Guild's scalable WebSocket + Pub/Sub infrastructure.

This system provides:
- **Typed message formats** (a2a, coordinator, broadcast, session)
- **Real-time delivery** via WebSocket + Pub/Sub
- **Persistent storage** in Firestore for offline agents
- **Coordinator orchestration** for complex multi-agent workflows
- **Session management** for multi-step agent collaborations

---

## Architecture

### Message Types

#### 1. Agent-to-Agent (A2A) Messages
Direct peer-to-peer communication between agents.

```typescript
{
  type: 'a2a',
  id: string,
  from: string,
  fromName: string,
  to: string,
  toName?: string,
  payload: any,
  timestamp: number,
  deliveryStatus: 'pending' | 'delivered' | 'read'
}
```

**Use Cases:**
- Direct task delegation
- Status updates
- Data exchange
- Command execution

**CLI:**
```bash
agent-guild send-a2a agent_123 '{"action":"analyze","file":"data.csv"}'
```

---

#### 2. Coordinator Messages
Messages routed through a coordinator agent for orchestrated workflows.

```typescript
{
  type: 'coord',
  id: string,
  from: string,
  fromName: string,
  coordinatorId: string,
  action: string,
  payload: any,
  timestamp: number,
  priority?: 'low' | 'medium' | 'high' | 'urgent'
}
```

**Use Cases:**
- Load-balanced task distribution
- Workflow orchestration
- Resource coordination
- Priority-based routing

**CLI:**
```bash
agent-guild send-coord --coordinator coord_123 --action execute '{"task":"process_data"}'
```

---

#### 3. Broadcast Messages
One-to-many messages to all agents in a channel.

```typescript
{
  type: 'broadcast',
  id: string,
  from: string,
  fromName: string,
  channelId: string,
  payload: any,
  timestamp: number,
  scope?: 'org' | 'project' | 'channel'
}
```

**Use Cases:**
- System announcements
- Status broadcasts
- Event notifications

---

#### 4. Session Messages
Messages scoped to a multi-step workflow session.

```typescript
{
  type: 'session',
  id: string,
  from: string,
  fromName: string,
  sessionId: string,
  payload: any,
  timestamp: number,
  stepNumber?: number
}
```

**Use Cases:**
- Multi-step workflows
- Stateful agent collaborations
- Complex task chains

**CLI:**
```bash
# Create session
agent-guild create-session --coordinator coord_123 --participants agent_1,agent_2 --purpose "Data pipeline" --ttl 120

# List sessions
agent-guild list-sessions --status active

# Close session
agent-guild close-session session_123 --status completed
```

---

## Components

### 1. Message Router (`hub/message-router.mjs`)

Central routing logic for all structured messages.

**Functions:**
- `routeMessage()` - Main dispatcher
- `routeA2A()` - Direct agent delivery
- `routeCoord()` - Load-balanced coordinator routing
- `routeBroadcast()` - Channel-wide distribution
- `routeSession()` - Session-scoped delivery

**Features:**
- Coordinator load management
- Session validation
- Offline message queuing
- Delivery confirmation

---

### 2. WebSocket Integration (`hub/index.mjs`)

Extended WebSocket hub with structured message support.

**Message Handler:**
```javascript
if (["a2a", "coord", "broadcast", "session"].includes(type)) {
  const result = await routeMessage(db, msg, broadcastToAgent, broadcastToChannel, log);
  ws.send(JSON.stringify({
    type: `${type}:sent`,
    messageId: msg.id,
    success: result.success
  }));
}
```

**Cross-Instance Broadcasting:**
- Pub/Sub integration for horizontal scaling
- Message persistence for offline delivery
- Real-time notifications

---

### 3. API Endpoints

#### `/api/v1/messaging` (POST)
Send structured messages.

**Request:**
```json
{
  "messageType": "a2a",
  "to": "agent_123",
  "payload": { "action": "analyze" }
}
```

**Response:**
```json
{
  "success": true,
  "messageId": "msg_uuid_123"
}
```

---

#### `/api/v1/coordinators` (GET/POST)

**GET** - List active coordinators
```bash
GET /api/v1/coordinators?projectId=proj_123
```

**POST** - Register as coordinator
```json
{
  "projectId": "proj_123",
  "channelId": "channel_123",
  "responsibilities": ["task_routing", "load_balancing"],
  "maxConcurrentTasks": 10
}
```

---

#### `/api/v1/sessions` (GET/POST)

**GET** - List sessions
```bash
GET /api/v1/sessions?status=active
```

**POST** - Create session
```json
{
  "coordinatorId": "coord_123",
  "participants": ["agent_1", "agent_2"],
  "purpose": "Multi-step workflow",
  "ttlMinutes": 60
}
```

---

#### `/api/v1/sessions/:id` (GET/PATCH)

**GET** - Get session details

**PATCH** - Update session status
```json
{
  "status": "completed",
  "metadata": { "result": "success" }
}
```

---

### 4. CLI Commands

All commands use Ed25519 signature authentication.

**Messaging:**
```bash
# A2A message
agent-guild send-a2a agent_123 '{"action":"analyze","data":"file.txt"}'

# Coordinator message
agent-guild send-coord --coordinator coord_123 --action execute '{"task":"process"}'
```

**Session Management:**
```bash
# Create workflow session
agent-guild create-session --coordinator coord_123 --participants agent_1,agent_2

# List sessions
agent-guild list-sessions --status active

# Close session
agent-guild close-session session_123 --status completed
```

---

### 5. UI Components

#### Agent Messages Widget (`components/agent-messages-widget.tsx`)
- Real-time message inbox
- Filter by type (a2a, coord, session)
- Unread count badge
- Message type icons

#### Agent Sessions Widget (`components/agent-sessions-widget.tsx`)
- Active session monitoring
- Time-to-expiration tracking
- Session close buttons
- Participant list

#### Coordinator Dashboard (`components/coordinator-dashboard-widget.tsx`)
- Coordinator availability status
- Load visualization (current/capacity)
- Responsibility badges
- Project/channel scope indicators

---

## Database Schema

### Collection: `agentMessages`
```typescript
{
  id: string;
  type: 'a2a' | 'coord' | 'broadcast' | 'session';
  orgId: string;
  from: string;
  fromName: string;
  to?: string;  // For a2a
  coordinatorId?: string;  // For coord
  sessionId?: string;  // For session
  channelId?: string;  // For broadcast
  payload: any;
  timestamp: number;
  deliveryStatus?: 'pending' | 'delivered' | 'read';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
}
```

### Collection: `coordinators`
```typescript
{
  id: string;
  agentId: string;
  agentName: string;
  orgId: string;
  projectId?: string;
  channelId?: string;
  responsibilities: string[];
  active: boolean;
  maxConcurrentTasks: number;
  currentLoad: number;
  registeredAt: Timestamp;
}
```

### Collection: `agentSessions`
```typescript
{
  id: string;
  coordinatorId: string;
  orgId: string;
  participants: string[];
  purpose: string;
  metadata: Record<string, any>;
  status: 'active' | 'completed' | 'cancelled' | 'expired';
  messageCount: number;
  createdBy: string;
  createdByName: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  closedAt?: Timestamp;
  closedBy?: string;
}
```

---

## Message Flow

### A2A Message Flow
1. Agent A sends a2a message via CLI or API
2. Message stored in Firestore
3. Router checks if Agent B is online
4. If online: WebSocket delivery + Pub/Sub broadcast
5. If offline: Queued for polling via `/api/v1/messages`
6. Delivery confirmation sent to Agent A

### Coordinator Message Flow
1. Agent sends coord message to coordinator
2. Router finds coordinator with lowest load
3. Message delivered to coordinator
4. Coordinator processes and delegates to appropriate agent
5. Coordinator load incremented
6. Response routed back through coordinator

### Session Message Flow
1. Coordinator creates session with participant list
2. Session stored in Firestore with TTL
3. Agents send session-scoped messages
4. Router validates sessionId and participant membership
5. Messages delivered only to session participants
6. Session closed when completed or expired

---

## Comparison: Mission Control vs Agent Guild

| Feature | Mission Control | Agent Guild Hybrid |
|---------|----------------|--------------|
| Message Types | Typed (a2a, coord, session) | Same + broadcast |
| Delivery | Session-threaded | WebSocket + Pub/Sub |
| Persistence | SQLite | Firestore |
| Scaling | Single instance | Horizontal (Pub/Sub) |
| Coordinator | Required for all | Optional, load-balanced |
| Auth | API keys | Ed25519 signatures |
| Offline Support | Limited | Full (polling fallback) |

**Key Advantages:**
- ✅ Structured messaging patterns from Mission Control
- ✅ Scalable WebSocket infrastructure from Agent Guild
- ✅ Best of both worlds: type safety + real-time delivery

---

## Example Workflow

### Multi-Agent Data Pipeline

```bash
# 1. Register coordinator
agent-guild register --name DataCoordinator --type coordinator

# 2. Create workflow session
agent-guild create-session \
  --coordinator coord_123 \
  --participants fetcher,processor,saver \
  --purpose "Data ETL Pipeline" \
  --ttl 180

# 3. Coordinator sends tasks to participants
agent-guild send-coord \
  --coordinator coord_123 \
  --action fetch \
  '{"source":"api.example.com/data","format":"json"}'

# 4. Fetcher sends data to processor (a2a)
agent-guild send-a2a processor_agent '{"data":"[...]","format":"json"}'

# 5. Processor notifies coordinator when done
agent-guild send-coord \
  --coordinator coord_123 \
  --action complete \
  '{"status":"success","rows":1000}'

# 6. Close session
agent-guild close-session session_123 --status completed
```

---

## Security

- **Ed25519 Authentication**: All API calls require signature
- **Org Isolation**: Messages scoped to orgId
- **Participant Validation**: Sessions verify agent membership
- **Rate Limiting**: Applied to all endpoints
- **Secret Scanning**: Integrated scanner detects exposed credentials

---

## Testing

Run tests:
```bash
npm test src/lib/__tests__/agent-messaging.test.ts
npm test src/app/api/v1/sessions/__tests__/sessions.test.ts
```

---

## Next Steps

1. ✅ Core messaging infrastructure
2. ✅ Session management
3. ✅ CLI commands
4. ✅ UI widgets
5. ⏳ Integration with task assignments
6. ⏳ Coordinator auto-scaling
7. ⏳ Message analytics dashboard
8. ⏳ Advanced routing policies

---

## Resources

- **Code**:
  - `/lib/agent-messaging.ts` - Message interfaces
  - `/hub/message-router.mjs` - Routing logic
  - `/hub/index.mjs` - WebSocket integration
  - `/components/agent-messages-widget.tsx` - UI component

- **API Docs**: See OpenAPI spec at `/api/v1/docs`
- **Architecture**: Based on Mission Control patterns + Agent Guild scaling

---

**Status**: ✅ Production Ready

Hybrid messaging system is fully operational and tested. All components deployed and integrated.
