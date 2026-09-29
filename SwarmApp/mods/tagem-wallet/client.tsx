"use client";

import { useEffect, useState, useCallback } from "react";
import { defineClientMod, type PanelProps } from "@swarm/sdk";
import { useAccount, useSendTransaction, useSwitchChain, useWriteContract } from "wagmi";
import { isAddress, parseUnits } from "viem";
import { QRCodeSVG } from "qrcode.react";
import { useAppKit } from "@reown/appkit/react";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { USDC_CONTRACTS, getExplorerTxUrl, getChain, shortAddress } from "@/lib/chains";
import { useSolanaAccount, useSolanaConnection, useSolanaProvider } from "@/lib/wallet/solana";

interface ChainBalance {
  chainKey: string;
  chainId: number;
  name: string;
  logo: string;
  explorerAddressUrl: string;
  native: { symbol: string; decimals: number; balance: string };
  usdc: { balance: string } | null;
  error?: string;
}

interface ActivityEntry {
  chainKey: string;
  chainName: string;
  asset: string;
  to: string;
  amount: string;
  txHash: string;
  explorerTxUrl: string;
  at: string;
}

interface SolanaBalance {
  sol: number;
  usdc: number;
  usdcMint: string;
  explorerAddressUrl: string;
}

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function fmt(balance: string | number) {
  const n = typeof balance === "number" ? balance : Number(balance);
  if (!Number.isFinite(n)) return String(balance);
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });
}

/**
 * Solana joins the same Tangem WalletConnect session as its own namespace
 * (see src/lib/wallet/solana.ts) — a separate connect/approve step from the
 * EVM chains above, but the same card. Sends are built here and signed via
 * walletProvider.sendTransaction, never server-side.
 */
function SolanaSection({ api, onSent }: { api: PanelProps["api"]; onSent: () => void }) {
  const { address, isConnected } = useSolanaAccount();
  const connection = useSolanaConnection();
  const walletProvider = useSolanaProvider();
  const { open } = useAppKit();

  const [balance, setBalance] = useState<SolanaBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [sendAsset, setSendAsset] = useState<"sol" | "usdc">("sol");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState<{ txHash: string; explorerTxUrl: string } | null>(null);

  const loadBalance = useCallback(async () => {
    if (!address) return;
    setBalanceError(null);
    try {
      const r = await api(`solana-balance/${address}`);
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setBalance(d);
    } catch (e) {
      setBalanceError(e instanceof Error ? e.message : "Failed to load Solana balance");
    }
  }, [api, address]);

  useEffect(() => {
    if (address) loadBalance();
  }, [address, loadBalance]);

  async function handleSend() {
    if (!address || !walletProvider || !connection || !balance) return;
    setSendError(null);
    setSendOk(null);

    let recipient: PublicKey;
    try {
      recipient = new PublicKey(sendTo);
    } catch {
      setSendError("Enter a valid Solana address.");
      return;
    }
    const amountNum = Number(sendAmount);
    if (!amountNum || amountNum <= 0) {
      setSendError("Enter an amount greater than 0.");
      return;
    }

    setSending(true);
    try {
      const sender = new PublicKey(address);
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: sender, recentBlockhash: blockhash });
      let assetLabel: string;

      if (sendAsset === "usdc") {
        const mint = new PublicKey(balance.usdcMint);
        const senderAta = await getAssociatedTokenAddress(mint, sender);
        const recipientAta = await getAssociatedTokenAddress(mint, recipient);
        // Sender pays to create the recipient's associated token account if
        // it doesn't exist yet — the standard SPL pattern, one card tap
        // covers both instructions.
        const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
        if (!recipientAtaInfo) {
          tx.add(createAssociatedTokenAccountInstruction(sender, recipientAta, recipient, mint));
        }
        tx.add(createTransferInstruction(senderAta, recipientAta, sender, Math.round(amountNum * 10 ** 6)));
        assetLabel = "USDC";
      } else {
        tx.add(
          SystemProgram.transfer({
            fromPubkey: sender,
            toPubkey: recipient,
            lamports: Math.round(amountNum * LAMPORTS_PER_SOL),
          }),
        );
        assetLabel = "SOL";
      }

      const signature = await walletProvider.sendTransaction(tx, connection);
      const explorerTxUrl = getChain("solana")!.explorer.txUrl(signature);

      await api("activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainKey: "solana",
          chainName: "Solana",
          asset: assetLabel,
          to: sendTo,
          amount: sendAmount,
          txHash: signature,
          explorerTxUrl,
        }),
      });

      setSendOk({ txHash: signature, explorerTxUrl });
      setSendAmount("");
      setSendTo("");
      loadBalance();
      onSent();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Solana</h2>
        {isConnected && (
          <button className="text-xs text-blue-500 hover:underline" onClick={loadBalance}>refresh</button>
        )}
      </div>

      {!isConnected ? (
        <div className="border rounded-lg p-3 text-sm space-y-2">
          <p className="text-muted-foreground">
            Solana is a separate WalletConnect connection from the EVM chains above —
            same Tangem app, its own approval step. Add Solana as a network in the
            Tangem app first, then connect it here.
          </p>
          <button className="border rounded px-3 py-1 text-sm" onClick={() => open()}>
            Connect Solana wallet
          </button>
        </div>
      ) : (
        <div className="border rounded-lg p-3 text-sm space-y-2">
          <div className="flex justify-between items-center">
            <div className="font-medium">Solana</div>
            {balance && (
              <a href={balance.explorerAddressUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline">
                view address
              </a>
            )}
          </div>
          {balanceError && <p className="text-xs text-red-400">{balanceError}</p>}
          {balance && (
            <div className="text-muted-foreground">
              {fmt(balance.sol)} SOL · {fmt(balance.usdc)} USDC
            </div>
          )}
          <div className="flex gap-2 pt-1">
            <button className="border rounded px-2 py-1 text-xs" onClick={() => setShowReceive((v) => !v)}>Receive</button>
            <button
              className="border rounded px-2 py-1 text-xs"
              onClick={() => { setShowSend((v) => !v); setSendError(null); setSendOk(null); }}
            >
              Send
            </button>
          </div>

          {showReceive && address && (
            <div className="border-t pt-3 mt-1 flex items-center gap-4">
              <div className="bg-white p-2 rounded">
                <QRCodeSVG value={address} size={112} />
              </div>
              <div className="text-xs space-y-1">
                <p className="text-muted-foreground">Receive SOL or USDC at:</p>
                <code className="break-all">{address}</code>
                <button className="border rounded px-2 py-1 block mt-1" onClick={() => navigator.clipboard?.writeText(address)}>
                  Copy address
                </button>
              </div>
            </div>
          )}

          {showSend && (
            <div className="border-t pt-3 mt-1 space-y-2">
              <div className="flex gap-3 text-xs">
                <label className="flex items-center gap-1">
                  <input type="radio" checked={sendAsset === "sol"} onChange={() => setSendAsset("sol")} /> SOL
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" checked={sendAsset === "usdc"} onChange={() => setSendAsset("usdc")} /> USDC
                </label>
              </div>
              <input
                className="border rounded px-2 py-1 w-full text-sm"
                placeholder="recipient Solana address"
                value={sendTo}
                onChange={(e) => setSendTo(e.target.value)}
              />
              <div className="flex gap-2">
                <input
                  className="border rounded px-2 py-1 flex-1 text-sm"
                  placeholder="amount"
                  value={sendAmount}
                  onChange={(e) => setSendAmount(e.target.value)}
                />
                <button
                  className="border rounded px-2 py-1 text-xs"
                  onClick={() => balance && setSendAmount(String(sendAsset === "usdc" ? balance.usdc : balance.sol))}
                  title="Fills the full displayed balance — leave a little SOL unspent to cover fees."
                >
                  Max
                </button>
              </div>
              <button className="border rounded px-3 py-1 text-sm w-full" onClick={handleSend} disabled={sending}>
                {sending ? "Confirm on your Tangem card…" : `Send ${sendAsset === "usdc" ? "USDC" : "SOL"}`}
              </button>
              {sendError && <p className="text-xs text-red-400">{sendError}</p>}
              {sendOk && (
                <p className="text-xs text-green-500">
                  Submitted —{" "}
                  <a href={sendOk.explorerTxUrl} target="_blank" rel="noreferrer" className="underline">
                    view on explorer
                  </a>
                  . It may take a moment to confirm.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function WalletPanel({ address, api }: PanelProps) {
  const { address: connectedAddress, chainId: connectedChainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();

  const [balances, setBalances] = useState<ChainBalance[] | null>(null);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [receiveChain, setReceiveChain] = useState<ChainBalance | null>(null);

  const [sendChainKey, setSendChainKey] = useState<string | null>(null);
  const [sendAsset, setSendAsset] = useState<"native" | "usdc">("native");
  const [sendTo, setSendTo] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendOk, setSendOk] = useState<{ txHash: string; explorerTxUrl: string } | null>(null);

  const loadBalances = useCallback(async () => {
    setBalancesError(null);
    try {
      const r = await api("balances");
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setBalances(d.balances);
    } catch (e) {
      setBalancesError(e instanceof Error ? e.message : "Failed to load balances");
      setBalances([]);
    }
  }, [api]);

  const loadActivity = useCallback(async () => {
    const r = await api("activity");
    const d = await r.json();
    setActivity(d.activity ?? []);
  }, [api]);

  useEffect(() => {
    loadBalances();
    loadActivity();
  }, [loadBalances, loadActivity]);

  const sendChain = balances?.find((b) => b.chainKey === sendChainKey) ?? null;

  async function handleSend() {
    if (!sendChain) return;
    setSendError(null);
    setSendOk(null);

    if (!isAddress(sendTo)) {
      setSendError("Enter a valid recipient address.");
      return;
    }
    const amountNum = Number(sendAmount);
    if (!amountNum || amountNum <= 0) {
      setSendError("Enter an amount greater than 0.");
      return;
    }

    setSending(true);
    try {
      if (connectedChainId !== sendChain.chainId) {
        await switchChainAsync({ chainId: sendChain.chainId });
      }

      let txHash: string;
      let assetLabel: string;

      if (sendAsset === "usdc") {
        const usdcAddress = USDC_CONTRACTS[sendChain.chainKey];
        if (!usdcAddress) throw new Error("USDC isn't configured on this chain.");
        txHash = await writeContractAsync({
          address: usdcAddress as `0x${string}`,
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [sendTo as `0x${string}`, parseUnits(sendAmount, 6)],
        });
        assetLabel = "USDC";
      } else {
        txHash = await sendTransactionAsync({
          to: sendTo as `0x${string}`,
          value: parseUnits(sendAmount, sendChain.native.decimals),
        });
        assetLabel = sendChain.native.symbol;
      }

      const explorerTxUrl = getExplorerTxUrl(txHash, sendChain.chainId);
      await api("activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chainKey: sendChain.chainKey,
          chainName: sendChain.name,
          asset: assetLabel,
          to: sendTo,
          amount: sendAmount,
          txHash,
          explorerTxUrl,
        }),
      });

      setSendOk({ txHash, explorerTxUrl });
      setSendAmount("");
      setSendTo("");
      loadBalances();
      loadActivity();
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Send failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold">Tangem Wallet</h1>
        <p className="text-sm text-muted-foreground">
          Balances, send, and receive for your connected wallet. Tangem cards connect
          through WalletConnect — every send below is approved and signed by tapping
          your card in the Tangem app; this panel never sees or holds a key.
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Signed in as {address ? shortAddress(address) : "nobody"}
          {isConnected && connectedAddress && connectedAddress.toLowerCase() !== address?.toLowerCase() && (
            <span className="text-yellow-500"> — wallet connected as a different address ({shortAddress(connectedAddress)}); reconnect to match.</span>
          )}
        </p>
      </div>

      {!isConnected && (
        <div className="border rounded-lg p-3 text-sm text-yellow-500 border-yellow-500/30">
          No wallet connected in this browser session. Send/receive need an active
          WalletConnect session (Tangem: Menu → WalletConnect → scan the connect QR).
          Balances below still work from your signed-in address.
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="font-medium text-sm">Balances</h2>
          <button className="text-xs text-blue-500 hover:underline" onClick={loadBalances}>refresh</button>
        </div>
        {balancesError && <p className="text-sm text-red-400">{balancesError}</p>}
        {balances == null && !balancesError && <p className="text-sm text-muted-foreground">Loading…</p>}
        {balances?.map((b) => (
          <div key={b.chainKey} className="border rounded-lg p-3 text-sm space-y-2">
            <div className="flex justify-between items-center">
              <div className="font-medium">{b.name}</div>
              <a href={b.explorerAddressUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-500 hover:underline">
                view address
              </a>
            </div>
            {b.error ? (
              <p className="text-xs text-red-400">Couldn&apos;t read this chain: {b.error}</p>
            ) : (
              <div className="text-muted-foreground">
                {fmt(b.native.balance)} {b.native.symbol}
                {b.usdc && <span> · {fmt(b.usdc.balance)} USDC</span>}
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <button
                className="border rounded px-2 py-1 text-xs"
                onClick={() => setReceiveChain(receiveChain?.chainKey === b.chainKey ? null : b)}
              >
                Receive
              </button>
              <button
                className="border rounded px-2 py-1 text-xs"
                onClick={() => {
                  setSendChainKey(sendChainKey === b.chainKey ? null : b.chainKey);
                  setSendAsset("native");
                  setSendError(null);
                  setSendOk(null);
                }}
              >
                Send
              </button>
            </div>

            {receiveChain?.chainKey === b.chainKey && address && (
              <div className="border-t pt-3 mt-1 flex items-center gap-4">
                <div className="bg-white p-2 rounded">
                  <QRCodeSVG value={address} size={112} />
                </div>
                <div className="text-xs space-y-1">
                  <p className="text-muted-foreground">
                    Receive {b.native.symbol}{b.usdc ? " or USDC" : ""} on {b.name} at:
                  </p>
                  <code className="break-all">{address}</code>
                  <button
                    className="border rounded px-2 py-1 block mt-1"
                    onClick={() => navigator.clipboard?.writeText(address)}
                  >
                    Copy address
                  </button>
                </div>
              </div>
            )}

            {sendChainKey === b.chainKey && (
              <div className="border-t pt-3 mt-1 space-y-2">
                {b.usdc && (
                  <div className="flex gap-3 text-xs">
                    <label className="flex items-center gap-1">
                      <input type="radio" checked={sendAsset === "native"} onChange={() => setSendAsset("native")} /> {b.native.symbol}
                    </label>
                    <label className="flex items-center gap-1">
                      <input type="radio" checked={sendAsset === "usdc"} onChange={() => setSendAsset("usdc")} /> USDC
                    </label>
                  </div>
                )}
                <input
                  className="border rounded px-2 py-1 w-full text-sm"
                  placeholder="recipient address (0x…)"
                  value={sendTo}
                  onChange={(e) => setSendTo(e.target.value)}
                />
                <div className="flex gap-2">
                  <input
                    className="border rounded px-2 py-1 flex-1 text-sm"
                    placeholder="amount"
                    value={sendAmount}
                    onChange={(e) => setSendAmount(e.target.value)}
                  />
                  <button
                    className="border rounded px-2 py-1 text-xs"
                    onClick={() => setSendAmount(sendAsset === "usdc" ? b.usdc?.balance ?? "0" : b.native.balance)}
                    title="Fills the full displayed balance — leave some native balance unspent to cover gas."
                  >
                    Max
                  </button>
                </div>
                <button
                  className="border rounded px-3 py-1 text-sm w-full"
                  onClick={handleSend}
                  disabled={sending || !isConnected}
                >
                  {sending ? "Confirm on your Tangem card…" : `Send ${sendAsset === "usdc" ? "USDC" : b.native.symbol}`}
                </button>
                {sendError && <p className="text-xs text-red-400">{sendError}</p>}
                {sendOk && (
                  <p className="text-xs text-green-500">
                    Submitted —{" "}
                    <a href={sendOk.explorerTxUrl} target="_blank" rel="noreferrer" className="underline">
                      view on explorer
                    </a>
                    . It may take a moment to confirm.
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
        {balances?.length === 0 && !balancesError && (
          <p className="text-sm text-muted-foreground">No enabled EVM chains configured.</p>
        )}
      </div>

      <SolanaSection api={api} onSent={loadActivity} />

      <div className="space-y-2 border-t pt-4">
        <h2 className="font-medium text-sm">Recent activity</h2>
        {activity.length === 0 && <p className="text-sm text-muted-foreground">No sends recorded yet.</p>}
        {activity.map((a) => (
          <div key={a.txHash} className="border rounded-lg p-3 text-sm flex justify-between items-center">
            <div>
              <div className="font-medium">{fmt(a.amount)} {a.asset} on {a.chainName}</div>
              <div className="text-muted-foreground">to {shortAddress(a.to)}</div>
            </div>
            <a href={a.explorerTxUrl} target="_blank" rel="noreferrer" className="text-blue-500 hover:underline text-xs">
              view tx
            </a>
          </div>
        ))}
      </div>
    </div>
  );
}

export default defineClientMod({ panels: { wallet: WalletPanel } });
