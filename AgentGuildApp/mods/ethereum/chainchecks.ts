/**
 * Chain checks an agent can't do from its own context:
 *
 *  - payments: did `recipient` really receive this amount? (by tx hash, or
 *    by scanning for a payment request's exact tagged amount)
 *  - previewExternalTx: what a transaction someone else built will do to
 *    the agent's wallet — decoded call, asset changes from eth_simulateV1,
 *    and red flags (unlimited approvals, operator grants, value drains)
 *  - assessToken: an ERC-20 due-diligence report (verified source,
 *    upgradeable proxy, owner powers in the ABI, real sell-side liquidity)
 *
 * The analysis functions (approvalFlags, externalSignRefusal, tokenVerdict)
 * are pure; the rest read through a viem PublicClient.
 */
import {
  decodeEventLog, formatEther, formatUnits, getAddress, isAddressEqual, maxUint160, maxUint256, parseAbiItem,
  type Hex, type PublicClient,
} from "viem";
import { DevtoolsInputError, decodeCalldata, shortError, type DecodedCall } from "./devtools";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
/** Allowances at or above this are treated as unlimited (half of max: many UIs use max - 1 or 2^255). */
const UNLIMITED = maxUint256 / 2n;

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && isAddressEqual(a as Hex, b as Hex);

// ── Payments ─────────────────────────────────────────────────────────────

export interface PaymentVerdict {
  verified: boolean;
  reason: string | null;
  hash: string | null;
  payer: string | null;
  /** UI amount received by the recipient in this tx (ETH or the token). */
  received: string;
  block: string | null;
  confirmations: number | null;
}

const NOT_FOUND = (reason: string): PaymentVerdict => ({ verified: false, reason, hash: null, payer: null, received: "0", block: null, confirmations: null });

/**
 * Checks one transaction: it succeeded and moved at least `minRaw` of ETH
 * (token null) or the ERC-20 to `recipient`. Internal ETH transfers (a
 * contract forwarding ETH) aren't visible without tracing, so ETH counts
 * only as the tx's own value.
 */
export async function verifyPaymentTx(
  client: PublicClient,
  p: { hash: Hex; recipient: string; token: string | null; decimals: number; minRaw: bigint | null },
): Promise<PaymentVerdict> {
  const [tx, receipt, latest] = await Promise.all([
    client.getTransaction({ hash: p.hash }).catch(() => null),
    client.getTransactionReceipt({ hash: p.hash }).catch(() => null),
    client.getBlockNumber(),
  ]);
  if (!tx) return NOT_FOUND("No such transaction on this network");
  if (!receipt) return { ...NOT_FOUND("The transaction is still pending"), hash: p.hash, payer: tx.from };
  const confirmations = Number(latest - receipt.blockNumber + 1n);
  const base = { hash: p.hash, payer: tx.from, block: receipt.blockNumber.toString(), confirmations };
  if (receipt.status !== "success") return { ...base, verified: false, reason: "The transaction reverted, so nothing was paid", received: "0" };

  let raw = 0n;
  if (!p.token) {
    if (same(tx.to, p.recipient)) raw = tx.value;
  } else {
    for (const log of receipt.logs) {
      if (!same(log.address, p.token)) continue;
      try {
        const ev = decodeEventLog({ abi: [TRANSFER], data: log.data, topics: log.topics });
        if (same(ev.args.to, p.recipient)) raw += ev.args.value;
      } catch { /* not a Transfer */ }
    }
  }
  const received = formatUnits(raw, p.decimals);
  if (raw === 0n) return { ...base, verified: false, reason: `This transaction sent no ${p.token ? "tokens" : "ETH"} to ${p.recipient}`, received };
  if (p.minRaw != null && raw < p.minRaw) return { ...base, verified: false, reason: `Received ${received}, less than the ${formatUnits(p.minRaw, p.decimals)} expected`, received };
  return { ...base, verified: true, reason: null, received };
}

/** An ERC-20 Transfer of exactly `amountRaw` to `recipient` in [fromBlock, toBlock]. */
export async function findTokenPayment(
  client: PublicClient,
  p: { token: string; recipient: string; amountRaw: bigint; fromBlock: bigint; toBlock: bigint },
): Promise<{ hash: Hex; payer: string; block: bigint } | null> {
  const logs = await client.getLogs({
    address: getAddress(p.token), event: TRANSFER, args: { to: getAddress(p.recipient) }, fromBlock: p.fromBlock, toBlock: p.toBlock,
  });
  const hit = logs.find((l) => l.args.value === p.amountRaw);
  return hit?.transactionHash && hit.blockNumber != null ? { hash: hit.transactionHash, payer: hit.args.from!, block: hit.blockNumber } : null;
}

/**
 * A plain ETH transfer of exactly `amountRaw` to `recipient` in the given
 * blocks. Native transfers emit no log, so this reads whole blocks; the
 * caller passes a cache so several requests on one network share them.
 */
export async function findEthPayment(
  client: PublicClient,
  p: { recipient: string; amountRaw: bigint; fromBlock: bigint; toBlock: bigint },
  cache: Map<bigint, { hash: Hex; from: string; to: string | null; value: bigint }[]> = new Map(),
): Promise<{ hash: Hex; payer: string; block: bigint } | null> {
  for (let n = p.fromBlock; n <= p.toBlock; n++) {
    let txs = cache.get(n);
    if (!txs) {
      const block = await client.getBlock({ blockNumber: n, includeTransactions: true });
      txs = block.transactions.map((t) => ({ hash: t.hash, from: t.from, to: t.to ?? null, value: t.value }));
      cache.set(n, txs);
    }
    const hit = txs.find((t) => t.value === p.amountRaw && same(t.to, p.recipient));
    if (hit) {
      // A transfer that reverted still sits in the block; only a successful one counts.
      const receipt = await client.getTransactionReceipt({ hash: hit.hash }).catch(() => null);
      if (receipt?.status === "success") return { hash: hit.hash, payer: hit.from, block: n };
    }
  }
  return null;
}

// ── Previewing someone else's transaction ────────────────────────────────

export type Severity = "high" | "medium" | "info";
export interface Flag { severity: Severity; code: string; message: string }

/** Selectors whose arguments hand control of the caller's assets to someone else. */
const APPROVAL_SELECTORS: Record<string, string> = {
  "0x095ea7b3": "approve(address spender, uint256 amount)",
  "0x39509351": "increaseAllowance(address spender, uint256 addedValue)",
  "0xa22cb465": "setApprovalForAll(address operator, bool approved)",
  "0x87517c45": "approve(address token, address spender, uint160 amount, uint48 expiration)", // Permit2
  "0x23b872dd": "transferFrom(address from, address to, uint256 amount)",
  "0xa9059cbb": "transfer(address to, uint256 amount)",
};

/**
 * Red flags from what the call does, read from its calldata. `spenderInfo`
 * says whether the address being trusted is a contract and has verified
 * source, which separates "approve the Uniswap router" from "approve a
 * fresh EOA".
 */
export function approvalFlags(
  call: { to: string | null; data: Hex; valueEth: number; from: string },
  decoded: DecodedCall | null,
  spenderInfo: { address: string; isContract: boolean; verified: boolean } | null,
): Flag[] {
  const flags: Flag[] = [];
  const fn = decoded?.functionName;
  const args = decoded?.args ?? [];
  const who = spenderInfo ? `${spenderInfo.address} (${spenderInfo.isContract ? (spenderInfo.verified ? "verified contract" : "unverified contract") : "a plain wallet, not a contract"})` : "the spender";
  const untrusted = spenderInfo != null && (!spenderInfo.isContract || !spenderInfo.verified);

  if (call.to == null) flags.push({ severity: "info", code: "deploys-contract", message: "Deploys a new contract" });
  if ((fn === "approve" && args.length === 2) || fn === "increaseAllowance") {
    const amount = BigInt(String(args[1]));
    if (amount >= UNLIMITED) flags.push({ severity: untrusted ? "high" : "medium", code: "unlimited-approval", message: `Grants an UNLIMITED token allowance to ${who}. It can move every token of this kind the wallet ever holds` });
    else if (amount > 0n) flags.push({ severity: untrusted ? "medium" : "info", code: "approval", message: `Grants a token allowance of ${amount} base units to ${who}` });
  }
  if (fn === "approve" && args.length === 4) {
    const amount = BigInt(String(args[2]));
    flags.push({ severity: amount >= maxUint160 / 2n ? (untrusted ? "high" : "medium") : "medium", code: "permit2-approval", message: `Permit2 allowance on token ${String(args[0])} to ${who}${amount >= maxUint160 / 2n ? " (unlimited)" : ""}` });
  }
  if (fn === "setApprovalForAll" && args[1] === true) {
    flags.push({ severity: untrusted ? "high" : "medium", code: "operator-approval", message: `Makes ${who} an operator over EVERY token in this collection the wallet holds` });
  }
  if (fn === "transferFrom" && args.length === 3 && same(String(args[0]), call.from)) {
    flags.push({ severity: "medium", code: "transfer-from-self", message: `Moves tokens out of this wallet to ${String(args[1])}` });
  }
  if (call.valueEth > 0 && spenderInfo && !spenderInfo.isContract && call.data !== "0x") {
    flags.push({ severity: "medium", code: "value-to-eoa-with-data", message: "Sends ETH with calldata to an address that isn't a contract — the data does nothing" });
  }
  if (decoded && !decoded.functionName && call.data.length >= 10) {
    flags.push({ severity: "medium", code: "unknown-function", message: `Calls an unknown function ${decoded.selector}; nothing could decode it` });
  }
  return flags;
}

export interface AssetChange { token: string; symbol: string; decimals: number; diffRaw: string; diff: string }

export interface TxPreview {
  call: { from: string; to: string | null; valueEth: string; data: Hex };
  decoded: DecodedCall | null;
  target: { address: string; isContract: boolean; verified: boolean; name: string | null } | null;
  simulation: { success: boolean; error: string | null; gasUsed: string | null };
  /** Net balance changes for `from`, ETH and every token the call touched. */
  assetChanges: AssetChange[];
  flags: Flag[];
  verdict: "high-risk" | "caution" | "no-red-flags" | "would-fail";
}

const ETH_PLACEHOLDER = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

/** Decodes and simulates `call` as `from` and lists what it does to `from`. Nothing is signed. */
export async function previewExternalTx(
  client: PublicClient,
  call: { from: `0x${string}`; to: `0x${string}` | null; data: Hex; value: bigint },
  lookup: { contract: (address: string) => Promise<{ isContract: boolean; verified: boolean; name: string | null }> },
): Promise<TxPreview> {
  const decoded = call.data.length >= 10 && call.to ? await decodeCalldata(call.data).catch(() => null) : null;
  const known = APPROVAL_SELECTORS[call.data.slice(0, 10).toLowerCase()];
  // A signature from the table beats the public DB's first candidate for the selectors that matter most.
  const exact = known && call.to ? await decodeCalldata(call.data, { signature: known }).catch(() => null) : null;
  const best = exact?.functionName ? exact : decoded;

  const target = call.to ? { address: call.to, ...(await lookup.contract(call.to)) } : null;
  // The address being trusted: the spender/operator for approvals, else the target.
  const trusted = best?.functionName && ["approve", "increaseAllowance", "setApprovalForAll"].includes(best.functionName)
    ? String(best.args?.[best.args.length === 4 ? 1 : 0])
    : null;
  const spender = trusted ? { address: trusted, ...(await lookup.contract(trusted)) } : target;

  let simulation: TxPreview["simulation"] = { success: false, error: null, gasUsed: null };
  let assetChanges: AssetChange[] = [];
  try {
    const out = await client.simulateCalls({
      account: call.from,
      calls: [{ to: call.to ?? undefined, data: call.data, value: call.value } as never],
      traceAssetChanges: true,
    });
    const r = out.results[0];
    simulation = { success: r.status === "success", error: r.status === "success" ? null : shortError(r.error), gasUsed: r.gasUsed?.toString() ?? null };
    assetChanges = out.assetChanges
      .filter((c) => c.value.diff !== 0n)
      .map((c) => ({
        token: c.token.address.toLowerCase() === ETH_PLACEHOLDER ? "ETH" : c.token.address,
        symbol: c.token.symbol ?? "?", decimals: c.token.decimals ?? 18,
        diffRaw: c.value.diff.toString(), diff: formatUnits(c.value.diff, c.token.decimals ?? 18),
      }));
  } catch (err) {
    simulation = { success: false, error: shortError(err), gasUsed: null };
  }

  const flags = approvalFlags({ to: call.to, data: call.data, valueEth: Number(formatEther(call.value)), from: call.from }, best, spender ? { address: spender.address, isContract: spender.isContract, verified: spender.verified } : null);
  const losses = assetChanges.filter((c) => BigInt(c.diffRaw) < 0n);
  if (losses.length) flags.push({ severity: "info", code: "balance-out", message: `Wallet pays out ${losses.map((c) => `${c.diff.replace("-", "")} ${c.symbol}`).join(", ")}` });
  if (target && !target.isContract && call.data !== "0x" && call.to) {
    // Covered by value-to-eoa when value > 0; calldata to a wallet alone is just odd.
    if (!flags.some((f) => f.code === "value-to-eoa-with-data")) flags.push({ severity: "info", code: "data-to-eoa", message: "Sends calldata to a plain wallet, which ignores it" });
  }
  if (target?.isContract && !target.verified) flags.push({ severity: "medium", code: "unverified-target", message: `${target.address} has no verified source on Sourcify or Etherscan` });

  const verdict: TxPreview["verdict"] = !simulation.success ? "would-fail"
    : flags.some((f) => f.severity === "high") ? "high-risk"
    : flags.some((f) => f.severity === "medium") ? "caution" : "no-red-flags";
  return { call: { from: call.from, to: call.to, valueEth: formatEther(call.value), data: call.data }, decoded: best, target: target && { ...target, name: target.name }, simulation, assetChanges, flags, verdict };
}

/** Why the hub won't sign a previewed tx, or null. High risk needs acceptRisks; a failing tx never goes. */
export function externalSignRefusal(preview: TxPreview, policy: { maxTransferEth: number | null }, acceptRisks: boolean): string | null {
  if (!preview.simulation.success) return `The transaction fails in simulation (${preview.simulation.error ?? "unknown error"}), so it wasn't sent`;
  const eth = Number(preview.call.valueEth);
  if (policy.maxTransferEth != null && eth > policy.maxTransferEth) return `It sends ${eth} ETH, over this agent's ${policy.maxTransferEth} ETH limit`;
  const ethOut = preview.assetChanges.find((c) => c.token === "ETH" && BigInt(c.diffRaw) < 0n);
  if (ethOut && policy.maxTransferEth != null && -Number(ethOut.diff) > policy.maxTransferEth + 0.05) {
    return `It moves ${ethOut.diff.replace("-", "")} ETH out of the wallet, over this agent's ${policy.maxTransferEth} ETH limit`;
  }
  const high = preview.flags.filter((f) => f.severity === "high");
  if (high.length && !acceptRisks) return `High risk: ${high.map((f) => f.message).join("; ")}. Pass acceptRisks: true to sign anyway`;
  return null;
}

// ── Token due diligence ──────────────────────────────────────────────────

/** Functions in a token's ABI that let someone change balances or block transfers. */
const POWER_FUNCTIONS: { re: RegExp; code: string; what: string; severity: Severity }[] = [
  { re: /^mint/i, code: "mintable", what: "mint new tokens", severity: "medium" },
  { re: /^(blacklist|addToBlacklist|blockAddress|setBlacklist|addBot|setBots?|freeze)/i, code: "blacklist", what: "block specific holders from selling", severity: "high" },
  { re: /^(pause|unpause|setPaused|setTrading|enableTrading|openTrading)/i, code: "pausable", what: "pause or switch on trading", severity: "medium" },
  { re: /^(set.*(Fee|Tax)|update.*(Fee|Tax))/i, code: "adjustable-fee", what: "change the transfer tax", severity: "high" },
  { re: /^(setMaxTx|setMaxWallet|setMaxTransaction|updateMaxTx)/i, code: "tx-limits", what: "cap how much a wallet can buy or sell", severity: "medium" },
];

export interface TokenFacts {
  address: string;
  isContract: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  verified: boolean;
  /** EIP-1967 implementation when the token is an upgradeable proxy. */
  implementation: string | null;
  proxyAdmin: string | null;
  /** owner() result; null when there's no owner() or it's the zero address. */
  owner: string | null;
  ownerRenounced: boolean;
  functions: string[];
}

export interface TokenMarket { priceUsd: number | null; buyImpactPct: number | null; sellImpactPct: number | null; roundTripLossPct: number | null }

export interface TokenReport {
  token: string;
  name: string | null;
  symbol: string | null;
  verdict: "high-risk" | "caution" | "no-red-flags";
  findings: Flag[];
  facts: TokenFacts;
  market: TokenMarket | null;
}

/** Pure: facts + market probes → findings and a verdict. */
export function tokenVerdict(facts: TokenFacts, market: TokenMarket | null): TokenReport {
  const f: Flag[] = [];
  if (!facts.isContract) f.push({ severity: "high", code: "not-a-contract", message: "There's no contract at this address" });
  else if (facts.decimals == null) f.push({ severity: "high", code: "not-erc20", message: "It doesn't answer ERC-20 decimals()/symbol(), so it isn't a standard token" });
  if (facts.isContract && !facts.verified) f.push({ severity: "medium", code: "unverified", message: "Source isn't verified, so nobody can read what transfer() really does" });
  if (facts.implementation) f.push({ severity: "medium", code: "upgradeable", message: `Upgradeable proxy: whoever controls ${facts.proxyAdmin ?? "the proxy admin"} can replace the token's code at any time` });
  const ownerActive = !!facts.owner && !facts.ownerRenounced;
  for (const p of POWER_FUNCTIONS) {
    const hits = facts.functions.filter((fn) => p.re.test(fn));
    if (!hits.length) continue;
    const by = ownerActive ? `the owner (${facts.owner})` : facts.owner == null ? "a privileged role" : "nobody — ownership is renounced";
    const severity = facts.ownerRenounced ? "info" : p.severity;
    f.push({ severity, code: p.code, message: `${hits.slice(0, 3).map((h) => h.split("(")[0]).join(", ")} lets ${by} ${p.what}` });
  }
  if (market) {
    if (market.priceUsd == null) f.push({ severity: "medium", code: "no-price", message: "No price listing, so it can't be valued" });
    if (market.sellImpactPct != null && market.sellImpactPct >= 10) f.push({ severity: "high", code: "illiquid", message: `Selling $1,000 moves the price ${market.sellImpactPct.toFixed(1)}%: there's barely any liquidity` });
    else if (market.sellImpactPct != null && market.sellImpactPct >= 2) f.push({ severity: "medium", code: "thin-liquidity", message: `Selling $1,000 moves the price ${market.sellImpactPct.toFixed(1)}%` });
    if (market.roundTripLossPct != null && market.roundTripLossPct >= 15) f.push({ severity: "high", code: "round-trip-loss", message: `Buying $1,000 and selling it straight back loses ${market.roundTripLossPct.toFixed(1)}%. Likely a transfer tax or a trap` });
    else if (market.roundTripLossPct != null && market.roundTripLossPct >= 3) f.push({ severity: "medium", code: "round-trip-cost", message: `A $1,000 round trip loses ${market.roundTripLossPct.toFixed(1)}%` });
    if (market.sellImpactPct == null && market.priceUsd != null) f.push({ severity: "high", code: "no-sell-route", message: "No aggregator route sells it back to USDC" });
  }
  const verdict = f.some((x) => x.severity === "high") ? "high-risk" : f.some((x) => x.severity === "medium") ? "caution" : "no-red-flags";
  return { token: facts.address, name: facts.name, symbol: facts.symbol, verdict, findings: f, facts, market };
}

/** A wallet-style tx request ({ to, data, value in wei }) → validated parts. */
export function parseTxCall(input: Record<string, unknown>): { to: `0x${string}` | null; data: Hex; valueWei: bigint } {
  const to = input.to == null || input.to === "" ? null : String(input.to);
  if (to && !/^0x[0-9a-fA-F]{40}$/.test(to)) throw new DevtoolsInputError("to must be a 0x address");
  const data = (input.data ?? input.input ?? "0x") as string;
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new DevtoolsInputError("data must be 0x-prefixed hex");
  const raw = input.value ?? "0";
  let valueWei: bigint;
  try {
    // Wallet-style requests carry value in wei (decimal or 0x hex).
    valueWei = BigInt(String(raw));
  } catch {
    throw new DevtoolsInputError("value must be wei, as a decimal or 0x hex integer");
  }
  if (valueWei < 0n) throw new DevtoolsInputError("value can't be negative");
  if (!to && data === "0x") throw new DevtoolsInputError("A transaction needs a `to` or deployment data");
  return { to: to ? getAddress(to) : null, data: data as Hex, valueWei };
}

