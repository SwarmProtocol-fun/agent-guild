/**
 * Chain-agnostic settlement types.
 *
 * One agent job (or trade) completion can settle on several chains at once —
 * see registry.ts's settleOnChains(). Each adapter turns the same
 * SettleJobParams into a chain-native transaction and returns a
 * SettlementReceipt in the same shape, so callers never branch on chain.
 */

export interface SettleJobParams {
  agentId: string;
  /** Chain-specific address or pubkey that receives payment / reputation credit */
  agentWallet: string;
  taskId: string;
  /** sha256 of the job's result (see registry.ts's hashJobResult) */
  resultHash: string;
  amountUsdc: number;
  creditScore: number;
  trustScore: number;
}

export interface SettlementReceipt {
  chain: string;
  txSig: string;
  receiptHash: string;
  explorerUrl: string;
  /** Set when the chain has no AgentRegistry deployed yet and this receipt
   *  only committed the memo + payment, not an on-chain reputation update. */
  reputationUpdated: boolean;
}

export interface VerifyResult {
  found: boolean;
  /** Whether the on-chain data actually contains the receipt hash we're
   *  checking for — false on the AgentRegistry path, which has no field
   *  for it (only credit/trust score), so it can only confirm the tx landed. */
  hashVerified: boolean;
  confirmedAt?: string;
}

export interface SettlementAdapter {
  settleJob(params: SettleJobParams): Promise<SettlementReceipt>;
  /** Read-only balance check — no signing key needed. */
  getBalance(wallet: string): Promise<{ usdc: number }>;
  /** Reads the transaction back from-chain and checks whether it actually
   *  carries resultHash, instead of trusting the receipt settleJob returned. */
  verifyReceipt(txSig: string, resultHash: string): Promise<VerifyResult>;
}
