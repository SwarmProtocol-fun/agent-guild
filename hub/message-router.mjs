/**
 * Structured Message Router for WebSocket Hub
 *
 * Routes typed agent messages (a2a, coord, broadcast, session)
 * with guaranteed delivery and coordinator pattern support.
 */

import admin from "firebase-admin";

/**
 * Route a structured agent message through the hub
 *
 * @param {object} db - Firestore instance
 * @param {object} message - Agent message (a2a, coord, broadcast, session)
 * @param {Function} broadcastToAgent - Function to send to specific agent
 * @param {Function} broadcastToChannel - Function to send to channel
 * @param {Function} log - Logging function
 * @returns {Promise<{ success: boolean, deliveredVia: string }>}
 */
export async function routeMessage(db, message, broadcastToAgent, broadcastToChannel, log) {
  const { type, id, from, timestamp, orgId } = message;

  // Validate message structure
  if (!type || !id || !from || !timestamp) {
    throw new Error("Invalid message structure");
  }

  try {
    switch (type) {
      case "a2a":
        return await routeA2A(db, message, broadcastToAgent, log);

      case "coord":
        return await routeCoord(db, message, broadcastToAgent, log);

      case "broadcast":
        return await routeBroadcast(db, message, broadcastToChannel, log);

      case "session":
        return await routeSession(db, message, broadcastToAgent, log);

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (err) {
    log("error", "Message routing failed", {
      messageId: id,
      type,
      from,
      error: err.message,
    });
    return { success: false, deliveredVia: "error", error: err.message };
  }
}

/**
 * Route agent-to-agent (a2a) direct message
 * Attempts WebSocket delivery, falls back to Firestore
 */
async function routeA2A(db, message, broadcastToAgent, log) {
  const { id, from, fromName, to, toName, payload, metadata, orgId } = message;

  // `to` is client-supplied — without this check a sender in one org could
  // address (and get persisted comms logged to/visible from) an agent that
  // belongs to a different org entirely.
  const toDoc = await db.collection("agents").doc(to).get();
  if (!toDoc.exists || toDoc.data().orgId !== orgId) {
    throw new Error(`Target agent not found in this org: ${to}`);
  }

  // Attempt WebSocket delivery
  const delivered = broadcastToAgent(to, message);

  // Persist to Firestore for offline agents
  const messageRef = await db.collection("agentMessages").add({
    id,
    type: "a2a",
    from,
    fromName,
    to,
    toName,
    payload,
    metadata,
    deliveryStatus: delivered ? "delivered" : "pending",
    deliveredAt: delivered ? admin.firestore.FieldValue.serverTimestamp() : null,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    orgId: message.orgId || "",
  });

  // Also log to agentComms for dashboard visibility
  await db.collection("agentComms").add({
    orgId: message.orgId || "",
    fromAgentId: from,
    fromAgentName: fromName,
    toAgentId: to,
    toAgentName: toName || to,
    type: "a2a",
    content: JSON.stringify(payload),
    metadata: { messageId: id, ...metadata },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  log("info", "A2A message routed", {
    messageId: id,
    from,
    to,
    deliveredVia: delivered ? "websocket" : "firestore",
  });

  return {
    success: true,
    deliveredVia: delivered ? "websocket" : "firestore",
    messageRef: messageRef.id,
  };
}

/**
 * Route coordinator message
 * First sends to coordinator, who then routes to target
 */
async function routeCoord(db, message, broadcastToAgent, log) {
  const { id, from, fromName, coordinatorId, targetId, action, payload, priority, orgId } = message;

  // Find coordinator info — scoped to the sender's org, otherwise a sender
  // could route (and increment load on) another org's coordinator.
  const coordQuery = db.collection("coordinators")
    .where("agentId", "==", coordinatorId)
    .where("orgId", "==", orgId)
    .where("active", "==", true);

  const coordSnap = await coordQuery.get();
  if (coordSnap.empty) {
    throw new Error(`No active coordinator found with ID: ${coordinatorId}`);
  }

  const coordinator = coordSnap.docs[0].data();

  // Check coordinator load
  if (coordinator.currentLoad >= coordinator.maxConcurrentTasks) {
    log("warn", "Coordinator at capacity", {
      coordinatorId,
      load: coordinator.currentLoad,
      max: coordinator.maxConcurrentTasks,
    });
    // Still deliver but warn
  }

  // Deliver to coordinator
  const delivered = broadcastToAgent(coordinatorId, message);

  // Persist message
  await db.collection("agentMessages").add({
    id,
    type: "coord",
    from,
    fromName,
    coordinatorId,
    targetId: targetId || null,
    action,
    priority: priority || "medium",
    payload,
    deliveryStatus: delivered ? "delivered" : "pending",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    orgId: message.orgId || "",
  });

  // Log to agentComms
  await db.collection("agentComms").add({
    orgId: message.orgId || "",
    fromAgentId: from,
    fromAgentName: fromName,
    toAgentId: coordinatorId,
    toAgentName: coordinator.agentName,
    type: "coord",
    content: `[${action.toUpperCase()}] ${JSON.stringify(payload)}`,
    metadata: { messageId: id, action, priority, targetId },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Increment coordinator load atomically — a plain read-then-write here
  // (coordinator.currentLoad + 1) races when two concurrent coord messages
  // hit the same coordinator: both read the same stale value, both write
  // old+1, and one increment is lost, undercounting currentLoad below the
  // true value (which the capacity check above relies on).
  await coordSnap.docs[0].ref.update({
    currentLoad: admin.firestore.FieldValue.increment(1),
  });

  log("info", "Coord message routed", {
    messageId: id,
    from,
    coordinatorId,
    action,
    deliveredVia: delivered ? "websocket" : "firestore",
  });

  return {
    success: true,
    deliveredVia: delivered ? "websocket" : "firestore",
    coordinatorId,
  };
}

/**
 * Route broadcast message
 * Sends to all channel subscribers
 */
async function routeBroadcast(db, message, broadcastToChannel, log) {
  const { id, from, fromName, channelId, payload, mentions, orgId } = message;

  // channelId is client-supplied — without this check a sender could
  // broadcast into (and have their message persisted/delivered to) a
  // channel belonging to a different org.
  const channelDoc = await db.collection("channels").doc(channelId).get();
  if (!channelDoc.exists || channelDoc.data().orgId !== orgId) {
    throw new Error(`Target channel not found in this org: ${channelId}`);
  }

  // Broadcast to channel
  broadcastToChannel(channelId, message);

  // Persist to messages collection (existing)
  await db.collection("messages").add({
    channelId,
    senderId: from,
    senderName: fromName,
    senderType: "agent",
    content: typeof payload === "string" ? payload : JSON.stringify(payload),
    verified: true,
    // Already pushed live via broadcastToChannel above — see streamChannel
    // in index.mjs, which skips docs carrying this marker.
    deliveredViaHub: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // If mentions, send direct notifications
  if (mentions && mentions.length > 0) {
    for (const mentionedId of mentions) {
      await db.collection("notifications").add({
        orgId: message.orgId || "",
        agentId: mentionedId,
        type: "mention",
        message: `${fromName} mentioned you in ${message.channelName || channelId}`,
        channelId,
        messageId: id,
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }

  log("info", "Broadcast message routed", {
    messageId: id,
    from,
    channelId,
    mentions: mentions?.length || 0,
  });

  return {
    success: true,
    deliveredVia: "channel",
    channelId,
  };
}

/**
 * Route session message
 * Sends to all session participants
 */
async function routeSession(db, message, broadcastToAgent, log) {
  const { id, from, fromName, sessionId, participants, payload, step, orgId } = message;

  // Verify session exists and is active
  const sessionDoc = await db.collection("agentSessions").doc(sessionId).get();
  if (!sessionDoc.exists) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const session = sessionDoc.data();
  if (session.status !== "active") {
    throw new Error(`Session ${sessionId} is not active (status: ${session.status})`);
  }
  // Cross-org isolation, and the sender must actually be a participant —
  // otherwise any agent could join/observe another org's session by guessing
  // its sessionId and supplying its own participants list.
  if (session.orgId !== orgId) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  if (!Array.isArray(session.participants) || !session.participants.includes(from)) {
    throw new Error(`${from} is not a participant in session ${sessionId}`);
  }

  // Deliver to the session's actual (DB-recorded) participant list, not the
  // client-supplied `participants` field — otherwise a sender could smuggle
  // in arbitrary agentIds as fake "session" delivery targets.
  let deliveredCount = 0;
  for (const participantId of session.participants) {
    if (participantId === from) continue; // Don't send to self

    const delivered = broadcastToAgent(participantId, message);
    if (delivered) deliveredCount++;
  }

  // Persist message
  await db.collection("agentMessages").add({
    id,
    type: "session",
    from,
    fromName,
    sessionId,
    participants: session.participants,
    step: step || session.currentStep,
    payload,
    deliveryStatus: deliveredCount > 0 ? "delivered" : "pending",
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    orgId,
  });

  // Update session step if provided. Unlike routeCoord's plain +1 counter,
  // currentStep is set to an explicit client-supplied value (not incremented
  // by a fixed amount), so FieldValue.increment doesn't apply here — instead
  // wrap the read-compare-write in a transaction so two concurrent session
  // messages can't both race off the same stale `session.currentStep`
  // snapshot and have the higher step silently overwritten by the lower one.
  if (step) {
    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(sessionDoc.ref);
      const freshStep = freshSnap.exists ? freshSnap.data().currentStep : undefined;
      if (step > freshStep) {
        tx.update(sessionDoc.ref, { currentStep: step });
      }
    });
  }

  log("info", "Session message routed", {
    messageId: id,
    from,
    sessionId,
    participants: participants.length,
    delivered: deliveredCount,
  });

  return {
    success: true,
    deliveredVia: "session",
    sessionId,
    participantsReached: deliveredCount,
  };
}

/**
 * Get active coordinator for a project or channel
 */
export async function getCoordinator(db, options) {
  const { orgId, projectId, channelId } = options;

  let q = db.collection("coordinators")
    .where("orgId", "==", orgId)
    .where("active", "==", true);

  if (projectId) {
    q = q.where("projectId", "==", projectId);
  } else if (channelId) {
    q = q.where("channelId", "==", channelId);
  }

  const snap = await q.get();
  if (snap.empty) return null;

  // Return coordinator with lowest load
  const coordinators = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  coordinators.sort((a, b) => a.currentLoad - b.currentLoad);

  return coordinators[0];
}

/**
 * Register an agent as a coordinator
 */
export async function registerCoordinator(db, coordinator) {
  const { agentId, agentName, orgId, projectId, channelId, responsibilities, maxConcurrentTasks } =
    coordinator;

  const coordRef = await db.collection("coordinators").add({
    agentId,
    agentName,
    orgId,
    projectId: projectId || null,
    channelId: channelId || null,
    responsibilities: responsibilities || [],
    active: true,
    maxConcurrentTasks: maxConcurrentTasks || 10,
    currentLoad: 0,
    registeredAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return coordRef.id;
}

/**
 * Create a new agent session
 */
export async function createSession(db, session) {
  const { name, orgId, createdBy, participants, coordinatorId, metadata, totalSteps } = session;

  const sessionRef = await db.collection("agentSessions").add({
    id: crypto.randomUUID(),
    name,
    orgId,
    createdBy,
    participants: participants || [],
    coordinatorId: coordinatorId || null,
    status: "active",
    currentStep: 0,
    totalSteps: totalSteps || null,
    metadata: metadata || {},
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return sessionRef.id;
}
