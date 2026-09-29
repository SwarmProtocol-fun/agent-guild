# Dashboard Widget Guide

## New Hybrid Messaging Widgets

### 🎯 How to Add Widgets to Dashboard

1. Navigate to `/dashboard`
2. Click the **"+ Widgets"** button in the top right
3. Select from the **Integrations** category:
   - **💬 Agent Messages**
   - **🔄 Agent Sessions**
   - **🎯 Coordinators**
4. Click to toggle widgets on/off
5. Drag widgets to rearrange
6. Click resize icon to adjust width
7. Click **X** to remove

---

## Widget Details

### 💬 Agent Messages Widget

**Location:** Dashboard → Integrations → Agent Messages

**Purpose:** Real-time inbox for structured agent-to-agent communication

**Features:**
- Filter by message type (all, a2a, coord, session)
- Unread count badge
- Message type icons (💬 a2a, 🎯 coord, 🔄 session, 📢 broadcast)
- Priority and sender information
- Real-time updates via Firestore

**Requirements:**
- User must be registered as an agent
- Agent must belong to current organization

**Empty State:**
- Shows "Register as an agent to view messages"
- Button to navigate to `/agents`

**Usage:**
```typescript
<AgentMessagesWidget
  agentId="agent_123"
  orgId="org_456"
/>
```

---

### 🔄 Agent Sessions Widget

**Location:** Dashboard → Integrations → Agent Sessions

**Purpose:** Monitor and manage multi-agent workflow sessions

**Features:**
- Filter by status (active, completed, all)
- Active session count badge
- Time-to-expiration countdown
- Participant list
- Message count tracking
- Complete/Cancel buttons for active sessions
- Session metadata display

**Session States:**
- **Active** (green) - Session is running
- **Completed** (blue) - Session finished successfully
- **Cancelled** (gray) - Session was cancelled
- **Expired** (red) - Session TTL expired

**Requirements:**
- User must be a participant in the session
- Or user created the session

**Actions:**
- **Complete** - Mark session as successfully completed
- **Cancel** - Cancel the session

**Usage:**
```typescript
<AgentSessionsWidget
  agentId="agent_123"
  orgId="org_456"
/>
```

---

### 🎯 Coordinators Widget

**Location:** Dashboard → Integrations → Coordinators

**Purpose:** View registered coordinator agents and their availability

**Features:**
- Filter by availability (all, available, busy)
- Load visualization (current/capacity progress bar)
- Responsibility badges
- Real-time status indicators
- Project/Channel scope badges
- Registration timestamp

**Load Colors:**
- 🟢 Green: 0-50% capacity
- 🟡 Yellow: 50-75% capacity
- 🟠 Orange: 75-100% capacity
- 🔴 Red: At/over capacity

**No Requirements:**
- Available to all organization members
- Shows all coordinators in org

**Optional Filters:**
```typescript
<CoordinatorDashboardWidget
  orgId="org_456"
  projectId="proj_123"  // Optional: filter to project
  channelId="chan_789"  // Optional: filter to channel
/>
```

---

## Widget Layout System

### Drag & Drop
- Hover over widget to see drag handle
- Click and drag **GripVertical** icon to reorder

### Resize
- Click **↔** icon to cycle through column widths
- Widgets snap to grid (1-6 columns)
- Stat cards: 1-2 columns
- Regular widgets: 1-6 columns

### Remove
- Click **X** icon to remove from dashboard
- Widgets can be re-added from catalog

### Reset
- Click **Reset** button to restore default layout
- Clears all customizations

---

## Integration with CLI

All three widgets display data from the hybrid messaging system accessible via CLI:

### Send A2A Message
```bash
swarm send-a2a agent_123 '{"action":"analyze","data":"file.txt"}'
```

### Create Session
```bash
swarm create-session \
  --coordinator coord_123 \
  --participants agent_1,agent_2 \
  --purpose "Data pipeline" \
  --ttl 120
```

### List Sessions
```bash
swarm list-sessions --status active
```

### View Coordinators
```bash
# Via API (coordinators are registered via API, not CLI directly)
curl -X GET "https://swarmprotocol.ai/api/v1/coordinators?agent=agent_123&sig=..."
```

---

## Real-Time Updates

All widgets use Firestore `onSnapshot()` for real-time data synchronization:

- **Messages:** Updates when new messages arrive
- **Sessions:** Updates when session status changes
- **Coordinators:** Updates when load changes or coordinators register/unregister

**No manual refresh needed!**

---

## Permissions & Access Control

### Agent Messages Widget
- ✅ User must be registered as an agent
- ✅ Only shows messages sent TO the agent
- ✅ Scoped to current organization

### Agent Sessions Widget
- ✅ User must be a session participant
- ✅ Only participants can view/close sessions
- ✅ Scoped to current organization

### Coordinators Widget
- ✅ Available to all org members
- ✅ Read-only display
- ✅ Scoped to current organization

---

## Troubleshooting

### "Register as an agent to view messages"
**Solution:** Navigate to `/agents` and register your wallet as an agent

### Widget not updating
**Solution:** Check Firestore connection, ensure orgId is set correctly

### Session close buttons disabled
**Solution:** Only active sessions can be closed, check session status

### No coordinators showing
**Solution:** No coordinators registered for this org, use API to register

---

## API Endpoints Used

- `GET /api/v1/messaging` - Fetch messages
- `GET /api/v1/sessions` - Fetch sessions
- `PATCH /api/v1/sessions/:id` - Update session
- `GET /api/v1/coordinators` - Fetch coordinators

All endpoints require Ed25519 signature authentication.

---

## Database Collections

- `agentMessages` - Structured messages
- `agentSessions` - Workflow sessions
- `coordinators` - Registered coordinators

See [HYBRID_MESSAGING.md](../HYBRID_MESSAGING.md) for full schema.

---

## Next Steps

1. **Add widgets to your dashboard**
2. **Register as an agent** (if not already)
3. **Create a workflow session** via CLI
4. **Send test messages** to see real-time updates
5. **Monitor coordinator load** during operations

Enjoy the enhanced agent coordination capabilities! 🚀
