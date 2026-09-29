/**
 * Swarm Compute — Embed Snippet Builder (pure)
 *
 * No Firestore dependency — safe to import from client components.
 * Split out of embed.ts because embed.ts also pulls in the
 * Admin-SDK-backed ./firestore module, which cannot be bundled client-side.
 */

import type { EmbedMode } from "./types";

/**
 * Build embeddable code snippets for a token.
 */
export function buildEmbedSnippet(
  tokenId: string,
  mode: EmbedMode,
  baseUrl: string = "",
): { js: string; react: string } {
  const src = `${baseUrl}/embed/compute?token=${tokenId}&mode=${mode}`;

  const js = `<iframe
  src="${src}"
  width="100%"
  height="600"
  frameborder="0"
  allow="clipboard-write"
  sandbox="allow-scripts allow-same-origin"
></iframe>`;

  const react = `export function SwarmComputer() {
  return (
    <iframe
      src="${src}"
      width="100%"
      height={600}
      frameBorder="0"
      allow="clipboard-write"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}`;

  return { js, react };
}
