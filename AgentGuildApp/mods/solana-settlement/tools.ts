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
    description: "Which Solana upgrades this agent has been granted, its devnet wallet address and SOL balances, and whether an Anchor build sandbox is online. Call this first.",
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
];
