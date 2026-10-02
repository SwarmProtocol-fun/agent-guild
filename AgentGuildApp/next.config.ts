import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile React Flow to ensure proper bundling (avoids SES lockdown conflicts
  // where the bundler wraps Map/Set in module namespaces that SES can corrupt).
  transpilePackages: ["@xyflow/react", "@xyflow/system"],
  // Keep heavy packages out of the serverless function bundle.
  // Netlify will resolve them from node_modules at runtime,
  // preventing cold-start timeouts and 502s from oversized bundles.
  serverExternalPackages: [
    "ethers",
    // mppx optionally imports @modelcontextprotocol/sdk/types.js at runtime
    // (for MCP-flavored 402 challenges) behind a `'code' in first` check we
    // never hit — that package isn't a dependency here. Bundled, webpack
    // statically resolves the dynamic import and fails the build; external,
    // it's a plain Node require that's only reached (and only matters) if
    // the unused code path ever runs.
    "mppx",
    "@azure/arm-compute",
    "@azure/arm-network",
    "@azure/arm-containerinstance",
    "@azure/identity",
    "firebase-admin",
    "@google-cloud/compute",
    "@google-cloud/firestore",
    "google-auth-library",
    "google-gax",
    "gcp-metadata",
  ],
  // Skip TS type checking during build to avoid OOM on Netlify.
  // Run `npx tsc --noEmit` locally or in CI for type safety.
  typescript: {
    ignoreBuildErrors: true,
  },
  // Disable source maps in production to reduce memory during build.
  productionBrowserSourceMaps: false,
  // Tree-shake per-icon/per-component instead of pulling in the whole module
  // graph — lucide-react alone is imported in 140+ files.
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
  },
  // Pin Turbopack root to this project directory so it doesn't infer
  // /home/god and exceed the OS inotify watch limit.
  turbopack: {
    root: __dirname,
  },
  // PRD-GROK-JOIN FR-1: GET /agent-guild.mjs must serve the Connect CLI
  // (a static copy of AgentGuildConnect/scripts/agent-guild.mjs under
  // public/) with an explicit script content-type and a short cache TTL —
  // Next's default static-asset headers don't guarantee either.
  async headers() {
    return [
      {
        source: "/agent-guild.mjs",
        headers: [
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=60" },
        ],
      },
      // Agent-facing docs (llms.txt convention + the agent skill). Explicit
      // charset so non-ASCII punctuation survives for fetchers that don't sniff.
      {
        source: "/llms.txt",
        headers: [
          { key: "Content-Type", value: "text/plain; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
      {
        source: "/skill.md",
        headers: [
          { key: "Content-Type", value: "text/markdown; charset=utf-8" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
    ];
  },
};

export default nextConfig;
