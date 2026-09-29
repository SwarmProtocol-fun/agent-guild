/**
 * Swarm Compute — Embed Token Helpers
 */

import type { EmbedMode } from "./types";
import { createEmbedToken, validateEmbedToken, getComputer } from "./firestore";

/**
 * Generate a new embed token for a computer.
 */
export async function generateEmbedToken(
  workspaceId: string,
  computerId: string,
  mode: EmbedMode,
  allowedOrigins: string[],
  createdByUserId: string,
  expiresInMs?: number,
): Promise<string> {
  const expiresAt = expiresInMs
    ? new Date(Date.now() + expiresInMs)
    : null;

  return createEmbedToken({
    workspaceId,
    computerId,
    mode,
    allowedOrigins,
    expiresAt,
    createdByUserId,
  });
}

/**
 * Validate an embed token and check origin.
 */
export async function validateEmbedAccess(
  tokenId: string,
  origin?: string,
): Promise<{ valid: boolean; computerId?: string; mode?: EmbedMode; error?: string }> {
  const token = await validateEmbedToken(tokenId);
  if (!token) return { valid: false, error: "Token not found or expired" };

  if (origin && token.allowedOrigins.length > 0) {
    let parsedOrigin: string;
    try {
      const u = new URL(origin);
      parsedOrigin = u.origin; // normalises to scheme://host(:port)
    } catch {
      return { valid: false, error: "Invalid origin" };
    }
    const allowed = token.allowedOrigins.some((o) => {
      if (o === "*") return true;
      try {
        return new URL(o).origin === parsedOrigin;
      } catch {
        return false;
      }
    });
    if (!allowed) return { valid: false, error: "Origin not allowed" };
  }

  const computer = await getComputer(token.computerId);
  if (!computer) return { valid: false, error: "Computer not found" };

  return { valid: true, computerId: token.computerId, mode: token.mode };
}
