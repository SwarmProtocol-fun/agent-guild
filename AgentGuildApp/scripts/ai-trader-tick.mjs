#!/usr/bin/env node
/**
 * Asks due Hyperliquid AI traders. The site tick never runs: local
 * INTERNAL_SERVICE_SECRET is empty, and no hub is calling /api/internal/tick.
 * This writes the same Firestore questions the tick would. The agent daemon
 * answers them through agent-guild.com.
 *
 *   node --env-file=.env.local scripts/ai-trader-tick.mjs
 *   node --env-file=.env.local scripts/ai-trader-tick.mjs --loop
 */
import { createJiti } from "jiti";
import path from "path";
import { pathToFileURL } from "url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@": path.join(root, "src"),
    "@agent-guild/sdk": path.join(root, "src/lib/mods/sdk.ts"),
  },
});

const { runAiTraderTick, runHyperliquidPaperTick } = await jiti.import(
  pathToFileURL(path.join(root, "mods/hyperliquid-trading/server.ts")).href,
);

let running = false;
async function once() {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const [ai, paper] = await Promise.all([
      runAiTraderTick(),
      runHyperliquidPaperTick().catch((err) => ({ error: err.message })),
    ]);
    console.log(`[${new Date().toISOString()}] ai ${JSON.stringify(ai)} paper ${JSON.stringify(paper)} ${Date.now() - started}ms`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] tick failed: ${err?.stack || err}`);
  } finally {
    running = false;
  }
}

await once();
if (process.argv.includes("--loop")) {
  setInterval(() => { void once(); }, 30_000);
}
