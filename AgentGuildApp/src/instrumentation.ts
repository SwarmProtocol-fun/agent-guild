/**
 * Next.js Instrumentation — Server Startup Hooks
 *
 * This file runs once when the Next.js server starts (or when Edge runtime initializes).
 * Use it for:
 * - Environment validation
 * - Telemetry setup
 * - Database connection pools
 * - Cache warming
 *
 * Docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import { requireValidEnv, printEnvSummary } from "@/lib/env-validation";

/**
 * Register function runs once on server startup.
 * IMPORTANT: This only runs in Node.js runtime (not Edge runtime).
 */
export async function register() {
  // Only run on server (not in client bundles or Edge runtime)
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("🚀 Swarm server starting...\n");

    // Validate environment variables — warn if critical vars missing.
    // NOTE: Do NOT call process.exit() here. In serverless environments
    // (Netlify) this kills the function container and causes 502
    // on ALL routes. Individual routes handle missing env gracefully.
    try {
      requireValidEnv();
      printEnvSummary();
      console.log("\n✅ Server instrumentation complete\n");
    } catch (err) {
      console.warn("\n⚠️  Environment validation warnings:");
      console.warn(err instanceof Error ? err.message : String(err));
      console.warn("Some features may be unavailable. Routes will return errors individually.\n");
    }
  }
}
