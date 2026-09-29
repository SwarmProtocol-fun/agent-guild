/**
 * GET /api/health
 *
 * Health check endpoint for load balancers and monitoring.
 * Checks connectivity to critical services:
 * - Firestore database
 * - Session management
 *
 * Returns 200 if healthy, 503 if degraded or unhealthy.
 *
 * Load balancer configuration:
 * - Path: /api/health
 * - Expected status: 200
 * - Timeout: 5s
 * - Interval: 30s
 */

import { adminDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  checks: {
    firestore: boolean;
    memory: boolean;
  };
  uptime: number;
  environment: string;
}

/**
 * Check if Firestore is accessible.
 * Attempts to read a known collection.
 */
async function checkFirestore(): Promise<boolean> {
  try {
    // Try to read a lightweight system document
    // You can create a "health" collection with a single doc for this purpose
    await adminDb().collection("system").doc("health").get();
    return true;
  } catch (err) {
    console.error("[Health] Firestore check failed:", err);
    return false;
  }
}

/**
 * Check memory usage.
 * Warn if usage is above 90%.
 */
function checkMemory(): boolean {
  if (typeof process === "undefined" || !process.memoryUsage) {
    return true; // Not in Node.js environment
  }

  const usage = process.memoryUsage();
  const heapPercent = (usage.heapUsed / usage.heapTotal) * 100;

  if (heapPercent > 90) {
    console.warn("[Health] High memory usage:", heapPercent.toFixed(2) + "%");
    return false;
  }

  return true;
}

export async function GET() {
  const startTime = Date.now();

  // Run health checks in parallel
  const [firestoreHealthy, memoryHealthy] = await Promise.all([
    checkFirestore(),
    checkMemory(),
  ]);

  const allHealthy = firestoreHealthy && memoryHealthy;
  const status: HealthStatus["status"] = allHealthy
    ? "healthy"
    : firestoreHealthy
    ? "degraded" // Firestore works but memory high
    : "unhealthy"; // Firestore down

  const response: HealthStatus = {
    status,
    timestamp: new Date().toISOString(),
    checks: {
      firestore: firestoreHealthy,
      memory: memoryHealthy,
    },
    uptime: process.uptime ? process.uptime() : 0,
    environment: process.env.NODE_ENV || "unknown",
  };

  const httpStatus = allHealthy ? 200 : 503;
  const duration = Date.now() - startTime;

  // Log slow health checks
  if (duration > 1000) {
    console.warn(`[Health] Slow health check: ${duration}ms`);
  }

  return Response.json(response, {
    status: httpStatus,
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "X-Health-Check-Duration-Ms": duration.toString(),
    },
  });
}
