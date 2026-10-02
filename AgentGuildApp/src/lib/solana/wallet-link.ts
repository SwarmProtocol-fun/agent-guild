/**
 * Solana wallet link message — shared by the client (which asks the user's
 * Solana wallet to sign it) and /api/v1/solana/link (which rebuilds and
 * verifies it). Binds the user's login account to a Solana address they
 * control, so identity NFT copies are only ever minted to a proven wallet.
 */

/** How long a signed link message stays valid. */
export const WALLET_LINK_MAX_AGE_MS = 10 * 60 * 1000;

export function walletLinkMessage(args: { account: string; solanaAddress: string; issuedAt: string }): string {
    return [
        "Agent Guild: link this Solana wallet to my account",
        "",
        `Account: ${args.account}`,
        `Solana wallet: ${args.solanaAddress}`,
        `Issued At: ${args.issuedAt}`,
    ].join("\n");
}
