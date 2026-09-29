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
};

export default nextConfig;
