/**
 * Parse a comma-separated list of WalletConnect Explorer wallet IDs
 * (https://walletguide.walletconnect.network). IDs are 64-char hex strings.
 * Invalid entries are dropped so a typo can't break the connect modal.
 */
const WALLET_ID = /^[0-9a-f]{64}$/i;

export function parseWalletIds(raw: string | undefined): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim();
    if (!id) continue;
    if (WALLET_ID.test(id)) ids.push(id.toLowerCase());
    else invalid.push(id);
  }
  return { ids, invalid };
}
