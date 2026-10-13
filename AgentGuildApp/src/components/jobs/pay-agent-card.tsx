/**
 * "Pay agent" card on an approved job — pays the agent from the poster's own
 * wallet (USDC on Base or Solana) or records a payment made off-platform.
 * The server (POST /api/jobs/:jobId/payment) checks on-chain payments before
 * recording them; this card never holds a key, it only asks the connected
 * wallet to send.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseUnits } from "viem";
import { CheckCircle2, ExternalLink, Loader2, Wallet } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useEvmSender, useSolanaSender } from "@/lib/wallet";
import { getConnection } from "@/lib/solana/client";
import { getJobPaymentOptions, recordJobPayment, type JobPaymentOptions } from "@/lib/jobs-client";
import type { JobPayment } from "@/lib/firestore";

type Method = "base-usdc" | "solana-usdc" | "offplatform";

const METHOD_LABEL: Record<Method, string> = { "base-usdc": "USDC on Base", "solana-usdc": "USDC on Solana", offplatform: "Off-platform" };
const CHANNEL_LABEL: Record<string, string> = { bank: "Bank transfer", paypal: "PayPal", card: "Card", cash: "Cash", crypto: "Other crypto", other: "Other" };
const EVM_CONFIRMATIONS = 10;
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function PaidSummary({ payment }: { payment: JobPayment }) {
  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        Paid ${payment.amountUsdc} · {payment.channel ? `${CHANNEL_LABEL[payment.channel] ?? payment.channel} (off-platform)` : METHOD_LABEL[payment.method]}
      </div>
      {payment.to && <div className="text-xs text-muted-foreground">To <span className="font-mono">{short(payment.to)}</span></div>}
      {payment.reference && <div className="text-xs text-muted-foreground">Reference: {payment.reference}</div>}
      {payment.note && <div className="text-xs text-muted-foreground whitespace-pre-wrap">{payment.note}</div>}
      {payment.explorerUrl && (
        <a href={payment.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          View transaction <ExternalLink className="h-3 w-3" />
        </a>
      )}
      <div className="text-xs text-muted-foreground">{new Date(payment.paidAt).toLocaleString()} by {short(payment.paidBy)}</div>
    </div>
  );
}

export function PayAgentCard({ jobId, onPaid }: { jobId: string; onPaid?: (payment: JobPayment) => void }) {
  const evmSender = useEvmSender();
  const solanaSender = useSolanaSender();
  const [options, setOptions] = useState<JobPaymentOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [method, setMethod] = useState<Method>("base-usdc");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [from, setFrom] = useState("");
  const [txSig, setTxSig] = useState("");
  const [channel, setChannel] = useState("bank");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<null | "wallet" | "verify">(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await getJobPaymentOptions(jobId);
      setOptions(o);
      if (o.suggestedUsdc != null) setAmount((a) => a || String(o.suggestedUsdc));
      // Start on the first rail the agent can actually receive on.
      if (!o.wallets.evm.length) setMethod(o.wallets.solana.length ? "solana-usdc" : "offplatform");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load payment options");
    }
  }, [jobId]);
  useEffect(() => { load(); }, [load]);

  const wallets = method === "base-usdc" ? options?.wallets.evm ?? [] : method === "solana-usdc" ? options?.wallets.solana ?? [] : [];
  const sender = method === "base-usdc" ? evmSender : method === "solana-usdc" ? solanaSender : null;
  const recipient = to && wallets.some((w) => w.address === to) ? to : wallets[0]?.address ?? "";
  const sentFrom = from || sender?.address || "";
  const amountNum = Number(amount);
  const amountOk = Number.isFinite(amountNum) && amountNum > 0;

  if (loadError) return null; // Not a buyer-side member, or the API is unavailable — nothing to pay from here.
  if (!options) return null;
  if (!options.payment && !options.payable && options.reason === "Approve the delivery before paying") return null;

  async function submit(sig: string, fromWallet: string) {
    setBusy("verify");
    try {
      const payment = await recordJobPayment(jobId, {
        method: method as "base-usdc" | "solana-usdc", txSig: sig, from: fromWallet, to: recipient, amountUsdc: amountNum,
      });
      setOptions((o) => (o ? { ...o, payment, payable: false } : o));
      onPaid?.(payment);
    } finally {
      setBusy(null);
    }
  }

  async function sendWithWallet() {
    if (!options || !amountOk || !recipient) return;
    setError(null);
    setBusy("wallet");
    let sig: string;
    let fromWallet: string;
    try {
      if (method === "base-usdc") {
        if (!evmSender) throw new Error("Connect an EVM wallet first");
        const base = options.rails.base;
        fromWallet = evmSender.address;
        sig = await evmSender.sendContractCall({
          to: base.usdc,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient as `0x${string}`, parseUnits(String(amountNum), 6)] }),
          chain: { chainId: base.chainId, name: base.name, rpcUrl: base.rpcUrl, nativeCurrency: base.nativeCurrency, explorerUrl: base.explorerUrl },
        });
        setTxSig(sig);
        // The server records it once it has a few confirmations.
        await createPublicClient({ transport: http(base.rpcUrl) }).waitForTransactionReceipt({ hash: sig as `0x${string}`, confirmations: EVM_CONFIRMATIONS });
      } else {
        if (!solanaSender) throw new Error("Connect a Solana wallet first");
        fromWallet = solanaSender.address;
        const connection = getConnection();
        const owner = new PublicKey(solanaSender.address);
        const dest = new PublicKey(recipient);
        const mint = new PublicKey(options.rails.solana.usdcMint);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
        const tx = new Transaction({ feePayer: owner, blockhash, lastValidBlockHeight });
        const toAta = getAssociatedTokenAddressSync(mint, dest, true);
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(owner, toAta, dest, mint),
          createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, owner), mint, toAta, owner, parseUnits(String(amountNum), 6), 6),
        );
        sig = await solanaSender.sendTransaction(tx, connection);
        setTxSig(sig);
        // The server only accepts finalized Solana transfers.
        const result = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
        if (result.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(result.value.err)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet transaction failed");
      setBusy(null);
      return;
    }
    try {
      await submit(sig, fromWallet);
    } catch (err) {
      setError(`Sent, but not recorded yet: ${err instanceof Error ? err.message : "verification failed"} — use "Verify payment" to retry.`);
    }
  }

  async function verifyPasted() {
    setError(null);
    try {
      await submit(txSig.trim(), sentFrom.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    }
  }

  async function markOffPlatform() {
    setError(null);
    setBusy("verify");
    try {
      const payment = await recordJobPayment(jobId, { method: "offplatform", channel, reference, note, amountUsdc: amountNum });
      setOptions((o) => (o ? { ...o, payment, payable: false } : o));
      onPaid?.(payment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to record payment");
    } finally {
      setBusy(null);
    }
  }

  const agentName = options.agent?.name ?? "the agent";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Wallet className="h-5 w-5" />{options.payment ? "Payment" : `Pay ${agentName}`}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {options.payment ? (
          <PaidSummary payment={options.payment} />
        ) : !options.payable ? (
          <p className="text-sm text-muted-foreground">{options.reason}</p>
        ) : !options.canPay ? (
          <p className="text-sm text-muted-foreground">Waiting for the org owner or the job&apos;s poster to pay {agentName}.</p>
        ) : (
          <>
            <div className="space-y-1">
              <Label htmlFor="pay-amount" className="text-xs">Amount (USD)</Label>
              <Input id="pay-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 50" className="max-w-[12rem]" />
              {options.suggestedUsdc == null && <p className="text-xs text-muted-foreground">The reward isn&apos;t a dollar amount, so enter what you&apos;re paying.</p>}
            </div>

            <Tabs value={method} onValueChange={(v) => { setMethod(v as Method); setError(null); setTxSig(""); setFrom(""); setTo(""); }}>
              <TabsList>
                <TabsTrigger value="base-usdc">USDC · Base</TabsTrigger>
                <TabsTrigger value="solana-usdc">USDC · Solana</TabsTrigger>
                <TabsTrigger value="offplatform">Off-platform</TabsTrigger>
              </TabsList>

              {(["base-usdc", "solana-usdc"] as const).map((m) => (
                <TabsContent key={m} value={m} className="space-y-3 pt-3">
                  {wallets.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {agentName} has no {m === "base-usdc" ? "EVM" : "Solana"} wallet to receive this. Use another method, or pay off-platform.
                    </p>
                  ) : (
                    <>
                      <div className="space-y-1">
                        <Label className="text-xs">Agent wallet</Label>
                        <Select value={recipient} onValueChange={setTo}>
                          <SelectTrigger className="font-mono text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {wallets.map((w) => (
                              <SelectItem key={w.address} value={w.address} className="font-mono text-xs">{short(w.address)} · {w.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {m === "base-usdc" && options.rails.base.chainKey !== "base" && (
                          <p className="text-xs text-amber-600">Test network: {options.rails.base.name}</p>
                        )}
                        {m === "solana-usdc" && options.rails.solana.cluster !== "mainnet-beta" && (
                          <p className="text-xs text-amber-600">Test network: Solana devnet</p>
                        )}
                      </div>

                      <Button onClick={sendWithWallet} disabled={!sender || !amountOk || busy !== null} className="w-full gap-2">
                        {busy === "wallet" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                        {busy === "wallet"
                          ? m === "base-usdc" ? "Waiting for wallet & confirmations…" : "Waiting for wallet & finalization…"
                          : sender ? `Send ${amountOk ? `$${amountNum} ` : ""}from ${short(sender.address)}` : `Connect ${m === "base-usdc" ? "an EVM" : "a Solana"} wallet to send`}
                      </Button>

                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">Already sent it another way? Paste the transaction</summary>
                        <div className="space-y-2 pt-2">
                          <Input value={txSig} onChange={(e) => setTxSig(e.target.value)} placeholder={m === "base-usdc" ? "Transaction hash (0x…)" : "Transaction signature"} className="font-mono text-xs" />
                          <Input value={sentFrom} onChange={(e) => setFrom(e.target.value)} placeholder="Wallet you sent from" className="font-mono text-xs" />
                          <Button variant="outline" size="sm" onClick={verifyPasted} disabled={!txSig.trim() || !sentFrom.trim() || !amountOk || busy !== null}>
                            {busy === "verify" && <Loader2 className="h-3 w-3 animate-spin mr-1" />}Verify payment
                          </Button>
                        </div>
                      </details>
                    </>
                  )}
                </TabsContent>
              ))}

              <TabsContent value="offplatform" className="space-y-3 pt-3">
                <p className="text-xs text-muted-foreground">Paid by bank, PayPal or anything else? Record it here so the job shows as paid. It isn&apos;t verified, but it goes on the job&apos;s audit trail.</p>
                <div className="space-y-1">
                  <Label className="text-xs">How you paid</Label>
                  <Select value={channel} onValueChange={setChannel}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {options.offplatformChannels.map((c) => <SelectItem key={c} value={c}>{CHANNEL_LABEL[c] ?? c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Reference (invoice #, PayPal ID…) — optional" maxLength={200} />
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note — optional" rows={2} maxLength={1000} />
                <Button onClick={markOffPlatform} disabled={!amountOk || busy !== null} className="w-full">
                  {busy === "verify" && <Loader2 className="h-4 w-4 animate-spin mr-1" />}Mark as paid
                </Button>
              </TabsContent>
            </Tabs>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </>
        )}
      </CardContent>
    </Card>
  );
}
