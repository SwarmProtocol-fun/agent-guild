/**
 * The position-size limit, checked against the whole position rather than
 * one order: ten $100 orders on one coin are a $1,000 position, and a
 * maxPositionUsd of $100 has to stop the second one. Live and paper both
 * call this, so the two accounts enforce the same rule.
 */

/** Signed USD notional of a position: positive long, negative short. */
export function signedNotional(szi: number, px: number): number {
  return szi * px;
}

/**
 * Null when an order keeps the coin's position within maxPositionUsd,
 * else the reason it doesn't. An order that shrinks the position is always
 * allowed, even if the position is already over the limit (the limit was
 * lowered, or the price moved), so the agent can always trade its way back down.
 */
export function positionLimitError(
  coin: string,
  currentUsd: number,
  isBuy: boolean,
  sizeUsd: number,
  maxPositionUsd: number,
): string | null {
  const after = currentUsd + (isBuy ? sizeUsd : -sizeUsd);
  if (Math.abs(after) <= maxPositionUsd + 1e-9) return null;
  if (Math.abs(after) < Math.abs(currentUsd)) return null;
  const held = Math.abs(currentUsd) > 0.005
    ? ` on top of the $${Math.abs(currentUsd).toFixed(2)} ${currentUsd > 0 ? "long" : "short"} already open`
    : "";
  return `$${sizeUsd} ${coin} order${held} would make a $${Math.abs(after).toFixed(2)} position, over maxPositionUsd ${maxPositionUsd}`;
}
