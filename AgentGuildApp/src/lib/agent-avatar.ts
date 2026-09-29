/** Agent Avatar — Generates unique DiceBear robot avatars for agents. */

const DICEBEAR_BASE = "https://api.dicebear.com/9.x/bottts/svg";

/**
 * Generate a deterministic DiceBear avatar URL for an agent.
 * Same name + type always produces the same avatar.
 * Manual uploads (avatarUrl) take priority over this in the UI.
 */
export function getAgentAvatarUrl(name: string, type?: string): string {
  const seed = encodeURIComponent(`${name}-${type || "agent"}`);
  return `${DICEBEAR_BASE}?seed=${seed}&backgroundColor=ffbd2e,f59e0b,d97706`;
}
