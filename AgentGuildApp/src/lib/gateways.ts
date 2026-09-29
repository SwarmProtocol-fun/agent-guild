/**
 * Gateway Management — Connect and manage remote execution gateways
 *
 * Inspired by abhi1693/openclaw-mission-control gateways component.
 */

import {
    collection,
    doc,
    addDoc,
    updateDoc,
    deleteDoc,
    getDocs,
    query,
    where,
    serverTimestamp,
    Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type GatewayStatus = "connected" | "disconnected" | "error";
export type GatewayRegion = "us-east" | "us-west" | "eu-west" | "eu-central" | "asia-pacific" | "asia-southeast";

export interface Gateway {
    id: string;
    orgId: string;
    name: string;
    url: string;
    status: GatewayStatus;
    apiKey?: string;
    agentsConnected: number;
    lastPing: Date | null;
    createdAt: Date | null;
    // Multi-region fields
    region?: GatewayRegion;
    location?: {
        latitude: number;
        longitude: number;
        city?: string;
        country?: string;
    };
    metrics?: {
        activeConnections: number;
        avgLatencyMs: number;
        requestsPerMinute: number;
        errorRate: number;
        uptime: number; // percentage
    };
    capacity?: {
        maxConnections: number;
        cpuUsage: number;
        memoryUsage: number;
    };
    lastHeartbeat?: Date | null;
}

export interface GatewaySelectionResult {
    gateway: Gateway;
    distance: number; // km
    score: number; // 0-100, higher is better
    reason: string;
}

export const GATEWAY_STATUS: Record<GatewayStatus, { label: string; color: string; dot: string }> = {
    connected: { label: "Connected", color: "text-emerald-400", dot: "bg-emerald-400" },
    disconnected: { label: "Disconnected", color: "text-zinc-400", dot: "bg-zinc-400" },
    error: { label: "Error", color: "text-red-400", dot: "bg-red-400" },
};

export const REGION_LOCATIONS: Record<GatewayRegion, { lat: number; lon: number; name: string }> = {
    "us-east": { lat: 39.0, lon: -77.5, name: "US East (Virginia)" },
    "us-west": { lat: 37.4, lon: -122.1, name: "US West (California)" },
    "eu-west": { lat: 53.3, lon: -6.3, name: "EU West (Ireland)" },
    "eu-central": { lat: 50.1, lon: 8.7, name: "EU Central (Frankfurt)" },
    "asia-pacific": { lat: 35.7, lon: 139.7, name: "Asia Pacific (Tokyo)" },
    "asia-southeast": { lat: 1.3, lon: 103.8, name: "Asia Southeast (Singapore)" },
};

// ═══════════════════════════════════════════════════════════════
// Firestore CRUD
// ═══════════════════════════════════════════════════════════════

const GATEWAY_COLLECTION = "gateways";

export async function addGateway(
    gateway: Omit<Gateway, "id" | "createdAt" | "lastPing">,
): Promise<string> {
    const ref = await addDoc(collection(db, GATEWAY_COLLECTION), {
        ...gateway, lastPing: serverTimestamp(), createdAt: serverTimestamp(),
    });
    return ref.id;
}

export async function getGateways(orgId: string): Promise<Gateway[]> {
    const q = query(collection(db, GATEWAY_COLLECTION), where("orgId", "==", orgId));
    const snap = await getDocs(q);
    return snap.docs.map(d => {
        const data = d.data();
        return {
            id: d.id, orgId: data.orgId, name: data.name, url: data.url,
            status: data.status || "disconnected", apiKey: data.apiKey,
            agentsConnected: data.agentsConnected || 0,
            lastPing: data.lastPing instanceof Timestamp ? data.lastPing.toDate() : null,
            createdAt: data.createdAt instanceof Timestamp ? data.createdAt.toDate() : null,
        } as Gateway;
    });
}

export async function updateGateway(id: string, updates: Partial<Gateway>): Promise<void> {
    const { id: _id, createdAt, ...rest } = updates;
    await updateDoc(doc(db, GATEWAY_COLLECTION, id), rest);
}

export async function deleteGateway(id: string): Promise<void> {
    await deleteDoc(doc(db, GATEWAY_COLLECTION, id));
}

// ═══════════════════════════════════════════════════════════════
// Multi-Region Support
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate distance between two geographic points using Haversine formula
 * Returns distance in kilometers
 */
export function calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    const R = 6371; // Earth's radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function toRad(degrees: number): number {
    return degrees * (Math.PI / 180);
}

/**
 * Select the best gateway based on geographic location and health metrics
 */
export async function selectGateway(
    orgId: string,
    userLat?: number,
    userLon?: number
): Promise<GatewaySelectionResult | null> {
    const gateways = await getGateways(orgId);

    // Filter to only connected gateways
    const available = gateways.filter(
        (g) => g.status === "connected" && g.lastHeartbeat
    );

    if (available.length === 0) {
        return null;
    }

    // If no user location provided, select based on metrics only
    if (!userLat || !userLon) {
        const best = available.reduce((prev, curr) => {
            const prevScore = calculateGatewayScore(prev, 0);
            const currScore = calculateGatewayScore(curr, 0);
            return currScore > prevScore ? curr : prev;
        });

        return {
            gateway: best,
            distance: 0,
            score: calculateGatewayScore(best, 0),
            reason: "Selected based on health metrics (no location provided)",
        };
    }

    // Calculate scores for each gateway
    const scored = available.map((gateway) => {
        const gatewayLat = gateway.location?.latitude || REGION_LOCATIONS[gateway.region || "us-east"].lat;
        const gatewayLon = gateway.location?.longitude || REGION_LOCATIONS[gateway.region || "us-east"].lon;
        const distance = calculateDistance(userLat, userLon, gatewayLat, gatewayLon);
        const score = calculateGatewayScore(gateway, distance);

        return {
            gateway,
            distance,
            score,
            reason: `Distance: ${distance.toFixed(0)}km, Latency: ${gateway.metrics?.avgLatencyMs || 0}ms`,
        };
    });

    // Sort by score (highest first)
    scored.sort((a, b) => b.score - a.score);

    return scored[0] || null;
}

/**
 * Calculate gateway score (0-100)
 * Factors: distance, latency, load, error rate, uptime
 */
export function calculateGatewayScore(gateway: Gateway, distance: number): number {
    let score = 100;

    // Distance penalty (max 30 points)
    // Penalize 1 point per 1000km
    const distancePenalty = Math.min(30, distance / 1000);
    score -= distancePenalty;

    // Latency penalty (max 20 points)
    const latency = gateway.metrics?.avgLatencyMs || 0;
    const latencyPenalty = Math.min(20, latency / 10);
    score -= latencyPenalty;

    // Load penalty (max 20 points)
    if (gateway.capacity && gateway.metrics) {
        const loadPercent =
            (gateway.metrics.activeConnections / gateway.capacity.maxConnections) * 100;
        const loadPenalty = Math.min(20, loadPercent / 5);
        score -= loadPenalty;
    }

    // Error rate penalty (max 15 points)
    const errorRate = gateway.metrics?.errorRate || 0;
    const errorPenalty = Math.min(15, errorRate * 100);
    score -= errorPenalty;

    // Uptime bonus (max 15 points)
    const uptime = gateway.metrics?.uptime || 0;
    const uptimeBonus = (uptime / 100) * 15;
    score += uptimeBonus;

    return Math.max(0, Math.min(100, score));
}

/**
 * Get all gateways with health status
 */
export async function getAllGatewaysWithHealth(
    orgId: string
): Promise<Gateway[]> {
    const gateways = await getGateways(orgId);

    const STALE_HEARTBEAT_MS = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    return gateways.map((gateway) => {
        // Check if heartbeat is stale
        if (
            gateway.status === "connected" &&
            gateway.lastHeartbeat &&
            now - gateway.lastHeartbeat.getTime() > STALE_HEARTBEAT_MS
        ) {
            return {
                ...gateway,
                status: "error" as GatewayStatus,
            };
        }
        return gateway;
    });
}

/**
 * Update gateway metrics (called by gateway heartbeat)
 */
export async function updateGatewayMetrics(
    gatewayId: string,
    metrics: Gateway["metrics"],
    capacity?: Gateway["capacity"]
): Promise<void> {
    const updates: Partial<Gateway> = {
        metrics,
        lastHeartbeat: new Date(),
        status: "connected" as GatewayStatus,
    };

    if (capacity) {
        updates.capacity = capacity;
    }

    await updateGateway(gatewayId, updates);
}
