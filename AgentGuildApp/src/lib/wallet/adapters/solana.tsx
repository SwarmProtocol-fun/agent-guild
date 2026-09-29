/**
 * Solana wallet adapter (@solana/wallet-adapter-react).
 *
 * The `WalletAdapter` interface (../types.ts) was written EVM-first
 * (`chainId: number`), so this adapter reports `chainId: 0` for a connected
 * Solana wallet — the same non-EVM sentinel `chains.ts`'s `solana` entry
 * uses. Select with NEXT_PUBLIC_WALLET_PROVIDER=solana.
 */
"use client";

import { useMemo, type ReactNode } from "react";
import {
    ConnectionProvider,
    WalletProvider as SolanaWalletProviderBase,
    useWallet as useSolanaWalletAdapter,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import { Button } from "@/components/ui/button";
import { SOLANA_RPC_URL } from "@/lib/solana/client";
import type { ConnectButtonProps, WalletAdapter, WalletState } from "../types";

function Provider({ children }: { children: ReactNode }) {
    const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
    return (
        <ConnectionProvider endpoint={SOLANA_RPC_URL}>
            <SolanaWalletProviderBase wallets={wallets} autoConnect>
                <WalletModalProvider>{children}</WalletModalProvider>
            </SolanaWalletProviderBase>
        </ConnectionProvider>
    );
}

function useWallet(): WalletState {
    const { publicKey, connecting, connected } = useSolanaWalletAdapter();
    return {
        address: publicKey ? publicKey.toBase58() : null,
        chainId: 0,
        status: connected ? "connected" : connecting ? "connecting" : "disconnected",
    };
}

function useSignMessage() {
    const { signMessage, publicKey } = useSolanaWalletAdapter();
    return async (message: string) => {
        if (!signMessage || !publicKey) throw new Error("Connected Solana wallet does not support message signing");
        const signature = await signMessage(new TextEncoder().encode(message));
        return Buffer.from(signature).toString("base64");
    };
}

function useDisconnect() {
    const { disconnect } = useSolanaWalletAdapter();
    return () => disconnect();
}

function ConnectButton({ label = "Connect", className }: ConnectButtonProps) {
    const { setVisible } = useWalletModal();
    const { address } = useWallet();
    return (
        <Button className={className} variant={address ? "outline" : "default"} onClick={() => setVisible(true)}>
            {address ? `${address.slice(0, 4)}...${address.slice(-4)}` : label}
        </Button>
    );
}

export const solanaWalletAdapter: WalletAdapter = {
    id: "solana",
    name: "Solana Wallet Adapter",
    Provider,
    useWallet,
    useSignMessage,
    useDisconnect,
    ConnectButton,
    storagePrefixes: ["walletName", "solana-wallet-adapter"],
};
