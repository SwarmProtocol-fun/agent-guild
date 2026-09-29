/**
 * Chain-agnostic Agent Social Number (ASN) identity minting.
 *
 * At agent "birth" (registration), the agent gets a soulbound identity NFT
 * encoding its ASN — minted on whichever chain(s) the caller chooses. See
 * registry.ts's mintIdentityOnChains(). Mirrors the settlement/ adapter
 * shape so callers never branch on chain.
 */

export interface MintIdentityParams {
  agentAddress: string;
  asn: string;
  agentName: string;
  creditScore: number;
  trustScore: number;
}

export interface IdentityMintReceipt {
  chain: string;
  txSig: string;
  /** On-chain token id, when the chain's identity primitive has one (EVM). */
  tokenId?: string;
  explorerUrl: string;
}

export interface IdentityAdapter {
  /** Idempotent — resolves to null if the agent already has an identity on this chain. */
  mintIdentity(params: MintIdentityParams): Promise<IdentityMintReceipt | null>;
  hasIdentity(agentAddress: string): Promise<boolean>;
  /**
   * Re-home an agent's identity onto a new wallet (e.g. a reinstall that
   * lost its keypair and generated a fresh one) — `params.agentAddress` is
   * the new wallet. Where the chain can actually move the credential (an
   * owner-gated on-chain transfer), it moves it; where it can't (a
   * soulbound token with no admin override), this issues a fresh one on
   * the new wallet instead and leaves the old one orphaned. Resolves to
   * null if the new wallet already has an identity on this chain.
   */
  reissueIdentity(oldAgentAddress: string, params: MintIdentityParams): Promise<IdentityMintReceipt | null>;
}
