/** Agent identity NFT — the three soulbound Metaplex Core copies (platform, org owner, agent). */
"use client";

import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { shortAddress } from "@/lib/chains";
import { useSolanaMessageSigner } from "@/lib/wallet";
import { walletLinkMessage } from "@/lib/solana/wallet-link";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import type { Agent } from "@/lib/firestore";

const solscan = (addr: string) => `https://solscan.io/token/${addr}?cluster=devnet`;

function CopyRow({ label, holder, asset }: { label: string; holder?: string; asset?: string }) {
    return (
        <div>
            <span className="text-xs text-muted-foreground">{label}</span>
            {asset ? (
                <p className="text-xs mt-0.5">
                    <a
                        href={solscan(asset)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono text-purple-600 dark:text-purple-400 hover:underline"
                    >
                        {shortAddress(asset)} <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                    {holder && <span className="block font-mono text-muted-foreground">→ {shortAddress(holder)}</span>}
                </p>
            ) : (
                <p className="text-xs mt-0.5 text-muted-foreground">Not minted</p>
            )}
        </div>
    );
}

export function IdentityNftCopies({
    agent,
    sessionAddress,
    isOrgOwner,
    loading,
    onMint,
    onRefresh,
}: {
    agent: Agent;
    sessionAddress: string | null | undefined;
    /** The signed-in user owns the agent's org — only they can receive copy #2. */
    isOrgOwner: boolean;
    loading: boolean;
    /** Mints whichever copies are missing (also migrates a legacy SPL token). */
    onMint: () => void;
    onRefresh: () => void;
}) {
    const signer = useSolanaMessageSigner();
    const [linkedSolana, setLinkedSolana] = useState<string | null | undefined>(undefined);
    const [linking, setLinking] = useState(false);
    const [linkError, setLinkError] = useState<string | null>(null);

    const ownerCopyMissing = !agent.nftOwnerAssetAddress;

    useEffect(() => {
        if (!isOrgOwner || !ownerCopyMissing) return;
        fetch("/api/v1/solana/link")
            .then((res) => (res.ok ? res.json() : { solanaAddress: null }))
            .then((data) => setLinkedSolana(data.solanaAddress ?? null))
            .catch(() => setLinkedSolana(null));
    }, [isOrgOwner, ownerCopyMissing]);

    const handleLink = async () => {
        if (!signer) return;
        setLinking(true);
        setLinkError(null);
        try {
            if (!sessionAddress) throw new Error("Sign in first");
            // Must match the server's view of the account (getWalletAddress canonicalizes).
            const account = canonicalizeWalletAddress(sessionAddress);
            const issuedAt = new Date().toISOString();
            const signature = await signer.signMessage(
                walletLinkMessage({ account, solanaAddress: signer.address, issuedAt }),
            );
            const res = await fetch("/api/v1/solana/link", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ solanaAddress: signer.address, issuedAt, signature }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to link Solana wallet");
            setLinkedSolana(data.solanaAddress);
            onMint();
        } catch (err) {
            setLinkError(err instanceof Error ? err.message : "Failed to link Solana wallet");
        } finally {
            setLinking(false);
        }
    };

    if (agent.nftStandard !== "mpl-core") {
        return (
            <div className="pl-2 border-l-2 border-purple-500/30 space-y-2">
                {agent.nftMintAddress && (
                    <p className="text-xs">
                        Legacy token:{" "}
                        <a href={solscan(agent.nftMintAddress)} target="_blank" rel="noopener noreferrer" className="font-mono text-purple-600 dark:text-purple-400 hover:underline">
                            {shortAddress(agent.nftMintAddress)}
                        </a>
                    </p>
                )}
                <Button onClick={onMint} disabled={loading} size="sm" className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-7">
                    {loading ? "Minting..." : "Mint Identity NFTs"}
                </Button>
            </div>
        );
    }

    const incomplete = !agent.nftPlatformAssetAddress || !agent.nftAgentAssetAddress;

    return (
        <div className="space-y-3 pl-2 border-l-2 border-purple-500/30">
            <div className="grid grid-cols-2 gap-3 text-sm">
                <CopyRow label="Collection (master)" asset={agent.nftCollectionAddress} />
                <CopyRow label="#1 Platform" asset={agent.nftPlatformAssetAddress} />
                <CopyRow label="#2 Owner" asset={agent.nftOwnerAssetAddress} holder={agent.nftOwnerSolanaAddress} />
                <CopyRow label="#3 Agent" asset={agent.nftAgentAssetAddress} holder={agent.solanaAddress} />
            </div>

            {agent.nftMintError && <p className="text-xs text-destructive">{agent.nftMintError}</p>}

            {ownerCopyMissing && isOrgOwner && linkedSolana === null && (
                signer ? (
                    <Button onClick={handleLink} disabled={linking || loading} size="sm" className="bg-purple-600 hover:bg-purple-700 text-white text-xs h-7">
                        {linking ? "Linking..." : `Link Solana wallet ${shortAddress(signer.address)} to receive copy #2`}
                    </Button>
                ) : (
                    <p className="text-xs text-muted-foreground">Connect your Solana wallet to receive copy #2.</p>
                )
            )}
            {ownerCopyMissing && !isOrgOwner && (
                <p className="text-xs text-muted-foreground">Copy #2 is minted once the org owner links a Solana wallet.</p>
            )}
            {linkError && <p className="text-xs text-destructive">{linkError}</p>}

            <div className="flex gap-3">
                {(incomplete || (ownerCopyMissing && linkedSolana)) && (
                    <button onClick={onMint} disabled={loading} className="text-xs text-purple-600 dark:text-purple-400 hover:underline disabled:opacity-50">
                        {loading ? "Minting..." : "Mint missing copies"}
                    </button>
                )}
                <button
                    onClick={onRefresh}
                    disabled={loading}
                    className="inline-flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 hover:underline disabled:opacity-50"
                >
                    Check on-chain <RefreshCw className="w-3 h-3" aria-hidden="true" />
                </button>
            </div>
        </div>
    );
}
