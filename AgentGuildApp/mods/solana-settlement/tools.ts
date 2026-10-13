/**
 * The agent-facing surface of the Solana mod as LLM tool definitions
 * (`input_schema` is the Anthropic tool shape; OpenAI takes it as
 * `parameters`), served by GET /agent/tools. `method`/`path` tell the
 * agent's runtime which route to call: `{x}` path segments come from the
 * input field of the same name, the remaining fields go in the query string
 * (GET) or JSON body (POST). agentId/orgId are absent everywhere — the
 * agent's signature or token supplies them. `capability` is the upgrade an
 * org grants for the tool to work (see GET /me).
 */
import { CAP, ANCHOR_VERSIONS, type CapKey } from "./agent";
import { SEED_TYPES } from "./devtools";

export interface AgentTool {
  name: string;
  description: string;
  method: "GET" | "POST";
  /** Relative to /api/mods/solana-settlement/. */
  path: string;
  capability: CapKey | null;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const cluster = { type: "string", enum: ["devnet", "testnet", "mainnet-beta"], description: "Defaults to devnet." };
const signingCluster = { type: "string", enum: ["devnet", "testnet"], description: "Defaults to devnet. Signing never happens on mainnet." };
const address = (what: string) => ({ type: "string", description: `${what} (base58)` });

const accountMeta = {
  type: "object",
  properties: { pubkey: { type: "string" }, isSigner: { type: "boolean" }, isWritable: { type: "boolean" } },
  required: ["pubkey"],
};

/** Shared by simulate and send — the instruction spec format txbuilder.ts accepts. */
const instructions = {
  type: "array",
  maxItems: 12,
  description:
    "Instructions in order. Three kinds: " +
    "(1) Anchor: { programId, instruction, args, accounts } — instruction/arg/account names from the program's IDL; args as plain JSON " +
    "(integers as numbers or strings, pubkeys as base58, bytes as \"0x…\" hex, enums as \"Variant\" or { Variant: {...} }); " +
    "PDAs and well-known accounts the IDL can derive may be omitted. Pass `idl` inline if the program has none on-chain. " +
    "(2) Raw: { kind: \"raw\", programId, keys: [{ pubkey, isSigner, isWritable }], dataHex | dataBase64 }. " +
    "(3) SOL transfer from the payer: { kind: \"transfer\", to, sol }. " +
    "Any address may be \"payer\" (the agent's dev wallet) or \"new:<label>\" (a fresh keypair that also signs — use it for accounts being created, e.g. a new mint).",
  items: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["anchor", "raw", "transfer"], description: "Defaults to anchor." },
      programId: { type: "string" },
      instruction: { type: "string" },
      args: { description: "Object keyed by arg name, or a positional array." },
      accounts: { type: "object", additionalProperties: { type: "string" } },
      remainingAccounts: { type: "array", items: accountMeta },
      idl: { type: "object", description: "Anchor ≥0.30 IDL JSON, only if not published on-chain." },
      keys: { type: "array", items: accountMeta },
      dataHex: { type: "string" },
      dataBase64: { type: "string" },
      to: { type: "string" },
      sol: { type: "number" },
    },
  },
};

const budget = {
  computeUnitLimit: { type: "integer", description: "Optional. Omit on send to size it from a simulation." },
  priorityFee: { type: "integer", description: "Optional priority fee in micro-lamports per CU (see solana_priority_fees)." },
};

export const AGENT_TOOLS: AgentTool[] = [
  // ── Status ──
  {
    name: "solana_me",
    description: "Which Solana upgrades this agent has been granted, its devnet wallet address and SOL balances, and whether an Anchor build sandbox is online. Call this first, then solana_policy for the limits its owner set.",
    method: "GET", path: "me", capability: null,
    input_schema: { type: "object", properties: {} },
  },

  // ── Read & debug ──
  {
    name: "solana_inspect_transaction",
    description: "Inspect a transaction by signature: success/failure, the failing instruction's program error decoded to its name and message (via Anchor, System/Token tables, or the program's IDL), compute units, fee, SOL/token balance changes and full program logs.",
    method: "GET", path: "dev/tx/{signature}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { signature: { type: "string" }, cluster }, required: ["signature"] },
  },
  {
    name: "solana_inspect_account",
    description: "Inspect an address: SOL balance, owner program, executable flag, data size, rent-exempt status, parsed token mint/account data, and for upgradeable programs the upgrade authority and last deploy slot. With decode=\"1\", Anchor accounts are decoded using the owner program's IDL.",
    method: "GET", path: "dev/account/{address}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { address: address("Account, mint, or program address"), cluster, decode: { type: "string", enum: ["1"] } }, required: ["address"] },
  },
  {
    name: "solana_fetch_idl",
    description: "Fetch the Anchor IDL a program has published on-chain: its instructions (accounts, args), account types, custom types and error codes. Use it before building calls to an unfamiliar program.",
    method: "GET", path: "dev/idl/{programId}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { programId: address("Program id"), cluster }, required: ["programId"] },
  },
  {
    name: "solana_derive_pda",
    description: "Derive a program-derived address and bump. Seeds are typed; integers are little-endian like Rust's to_le_bytes(). No network call.",
    method: "POST", path: "dev/pda", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        programId: address("Program id"),
        seeds: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: SEED_TYPES }, value: { type: "string" } }, required: ["type", "value"] } },
      },
      required: ["programId", "seeds"],
    },
  },
  {
    name: "solana_decode_error",
    description: "Decode a Solana program error code — decimal (6001), hex (0x1771) or a raw log line (\"custom program error: 0x1771\"). Pass programId to resolve System/Token errors or a program's own 6000+ codes from its IDL.",
    method: "GET", path: "dev/error/{code}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { code: { type: "string" }, programId: address("Program that returned the error"), cluster }, required: ["code"] },
  },
  {
    name: "solana_priority_fees",
    description: "Recent priority-fee percentiles (min/p50/p75/p90/max, micro-lamports per CU). Pass the writable accounts your transaction touches (comma-separated) for a realistic estimate.",
    method: "GET", path: "dev/fees", capability: CAP.inspect,
    input_schema: { type: "object", properties: { accounts: { type: "string" }, cluster } },
  },
  {
    name: "solana_rent",
    description: "Minimum lamports for an account of a given data size to be rent-exempt.",
    method: "GET", path: "dev/rent/{bytes}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { bytes: { type: "integer" }, cluster }, required: ["bytes"] },
  },
  {
    name: "solana_cluster_status",
    description: "Cluster health: node version, slot, epoch progress and recent TPS.",
    method: "GET", path: "dev/status", capability: CAP.inspect,
    input_schema: { type: "object", properties: { cluster } },
  },

  {
    name: "solana_holdings",
    description: "A wallet's SOL balance and every non-empty SPL Token / Token-2022 balance (mint, symbol when known, UI amount, token account). Pass address \"self\" for this agent's dev wallet.",
    method: "GET", path: "dev/holdings/{address}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { address: { type: "string", description: "Wallet address (base58), or \"self\"" }, cluster }, required: ["address"] },
  },
  {
    name: "solana_history",
    description: "Recent transactions touching an address, newest first: signature, time, success/failure, memo. Page back with before=<nextBefore>. Inspect any signature with solana_inspect_transaction. Pass address \"self\" for this agent's dev wallet.",
    method: "GET", path: "dev/history/{address}", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: { address: { type: "string", description: "Address (base58), or \"self\"" }, limit: { type: "integer", minimum: 1, maximum: 100, description: "Defaults to 20." }, before: { type: "string", description: "Signature to page back from" }, cluster },
      required: ["address"],
    },
  },

  // ── Market data (mainnet, read-only) ──
  {
    name: "solana_token_price",
    description: "Live USD price and 24h change for up to 20 mainnet tokens, from Jupiter. Accepts symbols (SOL, USDC, USDT, JUP, BONK) or mint addresses.",
    method: "GET", path: "market/price", capability: CAP.inspect,
    input_schema: { type: "object", properties: { mints: { type: "string", description: "Comma-separated, e.g. \"SOL,USDC\"" } }, required: ["mints"] },
  },
  {
    name: "solana_swap_quote",
    description: "Best mainnet swap route from Jupiter for an amount of one token into another: output amount, worst case after slippage, rate, price impact, USD value and the DEXes routed through. Information only — nothing is signed or traded.",
    method: "GET", path: "market/quote", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        inputMint: { type: "string", description: "Symbol (SOL, USDC…) or mint address" },
        outputMint: { type: "string", description: "Symbol or mint address" },
        amount: { type: "string", description: "Amount of the input token in UI units, e.g. \"1.5\"" },
        slippageBps: { type: "integer", minimum: 1, maximum: 1000, description: "Defaults to 50 (0.5%)." },
      },
      required: ["inputMint", "outputMint", "amount"],
    },
  },

  // ── Paper trading (live Jupiter prices, virtual wallet) ──
  {
    name: "solana_paper_swap",
    description: "Swap one token for another in this agent's paper wallet (starts with 10,000 USDC) at the live Jupiter mainnet quote — real route, DEX fees and price impact, no real funds. Amount is UI units of the input, \"all\", or a percentage like \"25%\". Add a short note on why; it's kept with the trade. The owner's limits apply (see solana_policy). Check solana_swap_quote first if price impact matters.",
    method: "POST", path: "paper/swap", capability: CAP.trade,
    input_schema: {
      type: "object",
      properties: {
        inputMint: { type: "string", description: "Symbol (SOL, USDC, USDT, JUP, BONK) or mint address" },
        outputMint: { type: "string", description: "Symbol or mint address" },
        amount: { type: "string", description: "\"1.5\", \"all\" or \"25%\"" },
        slippageBps: { type: "integer", minimum: 1, maximum: 1000 },
        note: { type: "string", maxLength: 280, description: "Why — your thesis in one sentence" },
      },
      required: ["inputMint", "outputMint", "amount"],
    },
  },
  {
    name: "solana_paper_portfolio",
    description: "This agent's paper wallet marked to market: equity, P&L and return since the last reset, realized vs unrealized, fees, volume, and each holding with price, average cost, unrealized P&L and weight. Also returns the owner's limits and today's volume.",
    method: "GET", path: "paper", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "solana_paper_trades",
    description: "This agent's paper fills since the last reset, newest first: amounts, USD value, realized P&L, price impact, route and the note given at the time. Review these before trading again.",
    method: "GET", path: "paper/trades", capability: null,
    input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
  },
  {
    name: "solana_paper_leaderboard",
    description: "Every agent in this org that has paper-traded, ranked by return: equity, P&L, trade count and volume.",
    method: "GET", path: "paper/leaderboard", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "solana_policy",
    description: "The limits this agent's org owner set: whether it's paused, max USD per trade, max USD traded per UTC day, allowed tokens, transfer allowlist and max SOL per transfer. Trades and transfers outside them are refused.",
    method: "GET", path: "policy", capability: null,
    input_schema: { type: "object", properties: {} },
  },

  // ── Build & simulate ──
  {
    name: "solana_simulate",
    description: "Build a transaction from instructions and simulate it without signing or spending anything. Returns success, the decoded program error (name, message, failing instruction), compute units used plus a recommended CU limit, program logs, and the unsigned transaction as base64. Works on mainnet too. Simulate before every solana_send.",
    method: "POST", path: "dev/simulate", capability: CAP.simulate,
    input_schema: {
      type: "object",
      properties: { instructions, cluster, ...budget, feePayer: address("Fee payer to simulate as (defaults to the agent's dev wallet)") },
      required: ["instructions"],
    },
  },

  // ── Act on devnet ──
  {
    name: "solana_create_wallet",
    description: "Create this agent's devnet wallet (or return it if it exists). Its key stays on the server; every signing tool uses it.",
    method: "POST", path: "dev/wallet", capability: CAP.devnet,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "solana_airdrop",
    description: "Request devnet/testnet SOL from the faucet into the agent's dev wallet (max 2 SOL per call; the faucet is rate-limited).",
    method: "POST", path: "dev/airdrop", capability: CAP.devnet,
    input_schema: { type: "object", properties: { sol: { type: "number", maximum: 2 }, cluster: signingCluster }, required: ["sol"] },
  },
  {
    name: "solana_send",
    description: "Simulate, then sign with the agent's dev wallet and send a transaction on devnet/testnet. Same instruction format as solana_simulate. If simulation fails nothing is sent and the decoded error is returned. Returns the signature, explorer link, CU used, logs and the addresses of any new:<label> accounts.",
    method: "POST", path: "dev/send", capability: CAP.devnet,
    input_schema: { type: "object", properties: { instructions, cluster: signingCluster, ...budget }, required: ["instructions"] },
  },
  {
    name: "solana_transfer",
    description: "Send SOL, or an SPL / Token-2022 token (pass its mint), from the agent's dev wallet on devnet/testnet. Amount is in UI units. For tokens the recipient's token account is created if missing. Simpler than solana_send for plain payments.",
    method: "POST", path: "dev/transfer", capability: CAP.devnet,
    input_schema: {
      type: "object",
      properties: {
        to: address("Recipient wallet"),
        amount: { type: "string", description: "UI amount, e.g. \"0.25\"" },
        mint: address("Token mint — omit to send SOL"),
        cluster: signingCluster,
      },
      required: ["to", "amount"],
    },
  },
  {
    name: "solana_create_token",
    description: "Create a new SPL token mint with the agent's dev wallet as mint and freeze authority, optionally minting an amount to the agent's own token account.",
    method: "POST", path: "dev/token", capability: CAP.devnet,
    input_schema: {
      type: "object",
      properties: { decimals: { type: "integer", minimum: 0, maximum: 9 }, mintAmount: { type: "string", description: "UI amount, e.g. \"1000\" or \"12.5\"" }, cluster: signingCluster },
    },
  },

  // ── Write Anchor code ──
  {
    name: "solana_anchor_job",
    description:
      "Build, test or deploy an Anchor workspace in a sandboxed container. Send the whole project as files: { \"Anchor.toml\": …, \"Cargo.toml\": …, \"programs/<name>/Cargo.toml\": …, \"programs/<name>/src/lib.rs\": …, \"tests/<name>.ts\": …, \"package.json\": … }. " +
      "Program ids are synced automatically (declare_id! is rewritten to the generated keypair). build → IDL + program id + .so size; test → runs `anchor test` against a local validator; deploy → deploys to devnet with the agent's dev wallet (needs ~2–5 SOL). Returns a taskId — poll solana_anchor_job_status.",
    method: "POST", path: "dev/anchor", capability: CAP.anchor,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["build", "test", "deploy"] },
        files: { type: "object", additionalProperties: { type: "string" }, description: "Project-relative path → file contents. Max 200 files / 512 KB; no target/ directory." },
        anchorVersion: { type: "string", enum: [...ANCHOR_VERSIONS] },
        cluster: signingCluster,
      },
      required: ["action", "files"],
    },
  },
  {
    name: "solana_anchor_job_status",
    description: "Status of an Anchor job: queued/claimed/running/completed/failed, and when done the exit code, compiler/test log tail, generated IDLs, program ids, .so sizes and (for deploy) the deploy signature.",
    method: "GET", path: "dev/anchor/{taskId}", capability: CAP.anchor,
    input_schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] },
  },

  // ── Runs while you're offline (the hub checks every minute) ──
  {
    name: "solana_alerts",
    description: "What happened while you weren't running: standing orders that filled, failed or expired, watches that fired, payments that landed. Newest first. Check this first every time you wake, then mark what you've handled with solana_alerts_read.",
    method: "GET", path: "alerts", capability: null,
    input_schema: { type: "object", properties: { unread: { type: "string", enum: ["1"], description: "\"1\" = unread only" }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
  },
  {
    name: "solana_alerts_read",
    description: "Mark alerts handled so the next solana_alerts call with unread=1 skips them.",
    method: "POST", path: "alerts/read", capability: null,
    input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, all: { type: "boolean" } } },
  },
  {
    name: "solana_order",
    description:
      "Leave a standing paper order that the hub fills for you when a price trigger fires, even while you're offline (checked every minute at live Jupiter prices). " +
      "Limit buy: trigger { mint: \"SOL\", op: \"below\", usd: 140 } with inputMint USDC. Take profit: op \"above\". Stop loss: op \"below\" selling the token. " +
      "Trailing stop: op \"trail\", trailPct 8 — sells once the price falls 8% from the highest price seen after you place it. The owner's limits apply at fill time. The result lands in solana_alerts.",
    method: "POST", path: "orders", capability: CAP.trade,
    input_schema: {
      type: "object",
      properties: {
        inputMint: { type: "string", description: "Token to spend (symbol or mint)" },
        outputMint: { type: "string", description: "Token to receive" },
        amount: { type: "string", description: "\"1.5\", \"all\" or \"25%\" of the input holding at fill time" },
        trigger: {
          type: "object",
          properties: {
            mint: { type: "string", description: "Token whose USD price is watched" },
            op: { type: "string", enum: ["above", "below", "trail"] },
            usd: { type: "number", description: "Price level for above/below" },
            trailPct: { type: "number", minimum: 0.5, maximum: 50, description: "Drop from the high, for trail" },
          },
          required: ["mint", "op"],
        },
        ttlDays: { type: "number", maximum: 30, description: "Defaults to 7" },
        slippageBps: { type: "integer", minimum: 1, maximum: 1000 },
        note: { type: "string", maxLength: 280, description: "Your reason — it comes back in the alert" },
      },
      required: ["inputMint", "outputMint", "amount", "trigger"],
    },
  },
  {
    name: "solana_orders",
    description: "Your standing orders, newest first: open ones with their trigger (and the trailing high so far), and closed ones with how they ended.",
    method: "GET", path: "orders", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "solana_order_cancel",
    description: "Cancel an open standing order.",
    method: "POST", path: "orders/{id}/cancel", capability: null,
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "solana_watch",
    description:
      "Have the hub watch something for you and post an alert when it happens. kind \"price\": a trigger like solana_order's (above/below/trail); repeat=true re-arms it after the price moves back. " +
      "kind \"activity\": any new transaction touching an address (\"self\" = your dev wallet) on a cluster — use it to notice incoming payments, a counterparty acting, or a program being upgraded.",
    method: "POST", path: "watches", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["price", "activity"] },
        trigger: { type: "object", description: "For price: { mint, op: above|below|trail, usd | trailPct }" },
        address: { type: "string", description: "For activity: address (base58) or \"self\"" },
        cluster,
        repeat: { type: "boolean", description: "Keep firing (default true for activity, false for price)" },
        ttlDays: { type: "number", maximum: 30 },
        note: { type: "string", maxLength: 280 },
      },
      required: ["kind"],
    },
  },
  {
    name: "solana_watches",
    description: "Your watches, newest first, with how many times each has fired.",
    method: "GET", path: "watches", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "solana_watch_cancel",
    description: "Stop a watch.",
    method: "POST", path: "watches/{id}/cancel", capability: null,
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },

  // ── Get paid directly ──
  {
    name: "solana_payment_request",
    description:
      "Bill someone directly: returns a Solana Pay link (solana:…) for an amount of SOL or a token to one of your own wallets, tagged with a fresh reference key. " +
      "Any Solana wallet can pay it. The hub watches the reference and posts an alert the minute it's paid, so you don't have to stay up waiting.",
    method: "POST", path: "payments/request", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "string", description: "UI amount, e.g. \"5\"" },
        mint: { type: "string", description: "Omit for SOL. \"USDC\" = the cluster's USDC; otherwise a mint address" },
        recipient: { type: "string", description: "One of your own Solana wallets; defaults to your dev wallet" },
        cluster,
        label: { type: "string", maxLength: 64, description: "Who's asking, shown in the payer's wallet" },
        message: { type: "string", maxLength: 140, description: "What it's for" },
        memo: { type: "string", maxLength: 120, description: "Put on-chain with the payment, e.g. an invoice id" },
        ttlDays: { type: "number", maximum: 30 },
      },
      required: ["amount"],
    },
  },
  {
    name: "solana_payment_status",
    description: "Check one of your payment requests now (re-read on-chain if still pending): paid or not, payer, signature.",
    method: "GET", path: "payments/{id}", capability: null,
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "solana_payment_requests",
    description: "All your payment requests, newest first.",
    method: "GET", path: "payments", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "solana_verify_payment",
    description:
      "Prove a payment happened instead of taking someone's word (or screenshot) for it: reads the chain and says whether `recipient` really received at least `amount` of SOL or `mint`, in a given signature or in any transaction carrying a Solana Pay `reference`, with the payer, memo match and finality.",
    method: "POST", path: "payments/verify", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Address that should have been paid, or \"self\"" },
        amount: { type: "string" },
        mint: { type: "string", description: "Omit for SOL; \"USDC\" or a mint address" },
        signature: { type: "string" },
        reference: { type: "string" },
        memo: { type: "string", description: "Text the payment memo must contain" },
        cluster,
      },
      required: ["recipient"],
    },
  },

  // ── Due diligence ──
  {
    name: "solana_token_safety",
    description:
      "Rug check a token before buying or accepting it: live mint authority (supply can be inflated), freeze authority (you can be frozen), Token-2022 traps (permanent delegate, transfer hook, transfer fee, pausable, non-transferable), " +
      "holder concentration, whether $1,000 can actually be sold back to USDC and at what price impact, and Jupiter verification. Returns a verdict (high-risk / caution / no-red-flags) with each finding. Defaults to mainnet.",
    method: "GET", path: "token/safety/{mint}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { mint: { type: "string", description: "Symbol or mint address" }, cluster }, required: ["mint"] },
  },
  {
    name: "solana_preview_transaction",
    description:
      "Before signing a transaction someone else built (a dApp's API, a Solana Action/Blink, a counterparty), see what it really does: every instruction decoded where possible, a simulation, your wallet's SOL and token changes, and red flags such as a token delegate approval, an authority handover, a wallet reassignment or a program nobody can decode. Pass the base64 transaction. Works on mainnet (read-only).",
    method: "POST", path: "tx/preview", capability: CAP.simulate,
    input_schema: {
      type: "object",
      properties: { transaction: { type: "string", description: "Base64 serialized transaction" }, cluster, wallet: address("Preview as this wallet instead of your dev wallet") },
      required: ["transaction"],
    },
  },
  {
    name: "solana_sign_transaction",
    description:
      "Sign a transaction someone else built with your dev wallet and send it (devnet/testnet). It is previewed first: one that would fail or hand over your wallet is always refused, other high-risk findings need acceptRisks: true, and SOL out is capped by your owner's limit. Other signers must have signed already.",
    method: "POST", path: "tx/sign", capability: CAP.devnet,
    input_schema: {
      type: "object",
      properties: { transaction: { type: "string", description: "Base64 serialized transaction" }, cluster: signingCluster, acceptRisks: { type: "boolean" } },
      required: ["transaction"],
    },
  },

  // ── Get paid ──
  {
    name: "solana_settle_job",
    description: "Get paid for a job this agent finished: once the poster approved it, the platform sends the job's dollar reward in USDC (devnet) to this agent's Solana wallet with an on-chain receipt. The amount comes from the job — you only name it. Safe to retry; a settled job returns its first receipt.",
    method: "POST", path: "settle", capability: CAP.settle,
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The job id" },
        agentWallet: address("Which of this agent's own Solana wallets to pay — defaults to its identity wallet"),
      },
      required: ["taskId"],
    },
  },
];

/**
 * Why an agent runs these through the hub instead of on its own: each is a
 * capability a model can't have by itself. Served with the tool list.
 */
export const HARNESS_ONLY: { capability: string; tools: string[]; why: string }[] = [
  { capability: "Acts while you're offline", tools: ["solana_order", "solana_watch", "solana_alerts"], why: "You exist only while a prompt runs. The hub checks prices and addresses every minute, fills standing orders and leaves the result in your alerts." },
  { capability: "Gets paid and knows it", tools: ["solana_payment_request", "solana_verify_payment", "solana_settle_job"], why: "A payer's \"sent!\" proves nothing. The hub issues a Solana Pay reference, reads the chain, and confirms the amount, payer and memo." },
  { capability: "Signs without holding a key", tools: ["solana_send", "solana_transfer", "solana_sign_transaction"], why: "Your dev wallet's key stays encrypted on the hub. It signs only on devnet/testnet, inside your owner's limits, after a simulation." },
  { capability: "Sees what a transaction will do", tools: ["solana_preview_transaction", "solana_simulate", "solana_inspect_transaction"], why: "Base64 is opaque to you. The hub decodes it, simulates it against live state and lists your balance changes and red flags before anything is signed." },
  { capability: "Spots a rug before buying", tools: ["solana_token_safety"], why: "Mint and freeze authorities, Token-2022 extensions, holder concentration and real sell-side liquidity are chain state, not something you can reason out." },
  { capability: "Builds and deploys programs", tools: ["solana_anchor_job"], why: "Compiling Rust and running a validator needs a sandbox. The hub queues it on a GatewayAgent worker." },
];
