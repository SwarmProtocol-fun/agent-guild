/**
 * Send a lending transfer (USDC or SOL on Solana, ETH on Ethereum) from the
 * user's connected wallet, resolving to its signature once it's final enough
 * for the server to verify. Shared by every "send with wallet" button so the
 * transaction is built the same way everywhere.
 */
"use client";

import { useCallback } from "react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
    createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useSolanaSender, useEvmSender } from "@/lib/wallet";
import { getConnection } from "@/lib/solana/client";
import { assetInfo, toBaseUnits, type LendingAsset } from "@/lib/lending/assets";
import { ETH_CHAIN_IDS, type LendingTreasuryInfo } from "@/lib/lending/client";

export function useWalletTransfer(treasuryInfo: LendingTreasuryInfo | null) {
    const solanaSender = useSolanaSender();
    const evmSender = useEvmSender();

    /**
     * Whether the connected wallet can send `asset` as `payer`. With no payer,
     * any connected wallet on the right chain (the server checks it's the
     * signed-in account's).
     */
    const canSend = useCallback((asset: LendingAsset, payer?: string | null): boolean => {
        if (!treasuryInfo) return false;
        if (assetInfo(asset).chain === "ethereum") {
            return !!evmSender && !!treasuryInfo.assets.eth && (!payer || evmSender.address.toLowerCase() === payer.toLowerCase());
        }
        return !!solanaSender && (!payer || solanaSender.address === payer);
    }, [treasuryInfo, solanaSender, evmSender]);

    const send = useCallback(async (asset: LendingAsset, to: string, amount: number): Promise<string> => {
        if (!treasuryInfo) throw new Error("Lending config not loaded yet");
        if (asset === "eth") {
            if (!evmSender || !treasuryInfo.assets.eth) throw new Error("Connect an Ethereum wallet first");
            return evmSender.sendNativeTransfer({
                to,
                valueWei: toBaseUnits("eth", amount),
                chainId: ETH_CHAIN_IDS[treasuryInfo.assets.eth.network],
            });
        }
        if (!solanaSender) throw new Error("Connect a Solana wallet first");
        const connection = getConnection();
        const owner = new PublicKey(solanaSender.address);
        const recipient = new PublicKey(to);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight });
        if (asset === "sol") {
            tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: recipient, lamports: Number(toBaseUnits("sol", amount)) }));
        } else {
            const mint = new PublicKey(treasuryInfo.usdcMint);
            const from = getAssociatedTokenAddressSync(mint, owner);
            const toAta = getAssociatedTokenAddressSync(mint, recipient, true);
            tx.add(
                createAssociatedTokenAccountIdempotentInstruction(owner, toAta, recipient, mint),
                createTransferCheckedInstruction(from, mint, toAta, owner, toBaseUnits("usdc", amount), 6),
            );
        }
        const sig = await solanaSender.sendTransaction(tx, connection);
        // The server only credits finalized transfers.
        const result = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
        if (result.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
        return sig;
    }, [treasuryInfo, solanaSender, evmSender]);

    return { canSend, send };
}
