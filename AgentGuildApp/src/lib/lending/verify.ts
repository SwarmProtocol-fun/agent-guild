/**
 * One entry point for on-chain lending transfers, whatever the asset: USDC
 * and SOL on Solana, ETH on Ethereum. Same two-step contract as the
 * chain-specific modules — verifyLendingTransfer() is a read, and
 * claimLendingTransferInTxn() writes the replay claim inside the crediting
 * Firestore transaction.
 */
import {
    verifyUsdcTransfer,
    verifySolTransfer,
    claimUsdcTransferInTxn,
    treasuryAddress,
    type VerifyTransferInput,
    type VerifiedTransfer,
} from "@/lib/solana/lending-verify";
import { verifyEthTransfer, claimEthTransferInTxn, ethTreasuryAddress, normalizeEthTxHash } from "@/lib/ethereum/lending-verify";
import type { LendingAsset } from "./assets";

export type { VerifyTransferInput, VerifiedTransfer };

/** The treasury that holds `asset` — the Solana treasury for USDC and SOL, the Ethereum one for ETH. */
export function treasuryFor(asset: LendingAsset): string {
    return asset === "eth" ? ethTreasuryAddress() : treasuryAddress();
}

/** Canonical form of a submitted signature/hash — the claim key. */
export function normalizeTxSig(asset: LendingAsset, txSig: string): string {
    return asset === "eth" ? normalizeEthTxHash(txSig) : txSig.trim();
}

export async function verifyLendingTransfer(asset: LendingAsset, input: VerifyTransferInput): Promise<VerifiedTransfer> {
    switch (asset) {
        case "usdc":
            return verifyUsdcTransfer(input);
        case "sol":
            return verifySolTransfer(input);
        case "eth":
            return verifyEthTransfer(input);
    }
}

export function claimLendingTransferInTxn(asset: LendingAsset, txn: FirebaseFirestore.Transaction, input: VerifyTransferInput): void {
    if (asset === "eth") claimEthTransferInTxn(txn, input);
    else claimUsdcTransferInTxn(txn, input);
}
