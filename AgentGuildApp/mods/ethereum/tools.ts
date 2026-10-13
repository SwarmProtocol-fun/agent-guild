/**
 * The agent-facing surface of the Ethereum mod as LLM tool definitions
 * (`input_schema` is the Anthropic tool shape; OpenAI takes it as
 * `parameters`), served by GET /agent/tools. `method`/`path` tell the
 * agent's runtime which route to call: `{x}` path segments come from the
 * input field of the same name, the remaining fields go in the query string
 * (GET) or JSON body (POST). agentId/orgId are absent everywhere — the
 * agent's signature or token supplies them. `capability` is the upgrade an
 * org grants for the tool to work (see GET /me).
 */
import { CAP, type CapKey } from "./agent";
import { NETWORK_IDS, SIGNING_NETWORKS } from "./networks";
import { UTIL_OPS } from "./chaintools";

export interface AgentTool {
  name: string;
  description: string;
  method: "GET" | "POST";
  /** Relative to /api/mods/ethereum/. */
  path: string;
  capability: CapKey | null;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

const network = { type: "string", enum: NETWORK_IDS, description: "Defaults to sepolia. mainnet/base are read and simulate only." };
const signingNetwork = { type: "string", enum: SIGNING_NETWORKS, description: "Defaults to sepolia. Signing never happens on a mainnet." };
const address = (what: string) => ({ type: "string", description: `${what}: a 0x address, an ENS name (name.eth), or "self" for this agent's dev wallet` });

/** Shared by simulate and send — the call spec devtools.buildCall accepts. */
const callSpec = {
  to: { type: "string", description: "Contract or recipient address. Omit for a deployment." },
  value: { type: "string", description: "ETH to send, as a decimal string (\"0.01\"). Defaults to 0." },
  signature: { type: "string", description: "Function to call, e.g. \"approve(address spender, uint256 amount) returns (bool)\". Encoded with `args`." },
  args: { type: "array", description: "Arguments for `signature`, in order. Integers as strings (\"1000000\"), addresses as 0x strings, tuples as arrays or objects." },
  data: { type: "string", description: "Raw 0x calldata instead of signature + args." },
  bytecode: { type: "string", description: "Deployment: the contract's creation bytecode (0x…)." },
  constructorSignature: { type: "string", description: "Deployment: e.g. \"constructor(string name, uint256 supply)\"; encoded with `args`." },
};

/** Shared by compile, verify and deploy_source. */
const sourceSpec = {
  source: { type: "string", description: "One Solidity file. Start it with `pragma solidity ^0.8.20;`." },
  sources: { type: "object", description: "Several files instead: { \"src/Token.sol\": \"…\", \"src/Lib.sol\": \"…\" }. Relative imports resolve between them." },
  optimize: { type: "boolean", description: "Default true." },
  runs: { type: "integer", minimum: 1, description: "Optimizer runs, default 200." },
  evmVersion: { type: "string", enum: ["london", "paris", "shanghai", "cancun", "prague"] },
};

const stateOverrideSchema = {
  type: "object",
  description: "Pretend state for this simulation only: { \"0xAddress\": { balance?: \"100\" (ETH), nonce?, code?: \"0x…\", stateDiff?: { \"slot\": \"value\" } } }. Give a wallet ETH or a token balance (stateDiff at the eth_util mapping_slot of balances[wallet]) to test a mainnet action you can't fund.",
};

export const AGENT_TOOLS: AgentTool[] = [
  // ── Status ──
  {
    name: "eth_me",
    description: "Which Ethereum upgrades this agent has been granted and its dev wallet address with Sepolia / Base Sepolia ETH balances. Call this first, then eth_policy for the limits its owner set.",
    method: "GET", path: "me", capability: null,
    input_schema: { type: "object", properties: {} },
  },

  // ── Read & debug ──
  {
    name: "eth_inspect_transaction",
    description: "Everything about a transaction: status, gas used and fee, decoded function call, ERC-20 transfers in its logs, and — when it reverted — the decoded revert reason (Error(string), Panic code, or custom error). Use this first on any failed tx hash.",
    method: "GET", path: "dev/tx/{hash}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { hash: { type: "string", description: "0x… transaction hash" }, network }, required: ["hash"] },
  },
  {
    name: "eth_inspect_address",
    description: "Balance, nonce, whether it's a contract (code size, EIP-1967 proxy implementation/admin), ERC-20 metadata if it's a token, and its ENS name on mainnet.",
    method: "GET", path: "dev/address/{address}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { address: address("Account"), network }, required: ["address"] },
  },
  {
    name: "eth_holdings",
    description: "ETH plus every non-zero balance among well-known tokens on the network (WETH, USDC, …) and any extra token addresses you pass.",
    method: "GET", path: "dev/holdings/{address}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { address: address("Owner"), network, tokens: { type: "string", description: "Optional comma-separated extra token addresses." } }, required: ["address"] },
  },
  {
    name: "eth_history",
    description: "Recent transactions of an address, newest first, with method names and failures. Needs the server's Etherscan key; returns 503 if it isn't set.",
    method: "GET", path: "dev/history/{address}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { address: address("Account"), network, limit: { type: "integer", minimum: 1, maximum: 100 }, page: { type: "integer", minimum: 1 } }, required: ["address"] },
  },
  {
    name: "eth_read_contract",
    description: "Call a view function and get the decoded result, e.g. signature \"balanceOf(address) view returns (uint256)\". Reverts come back decoded.",
    method: "POST", path: "dev/read", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Contract address" }, network,
        signature: { type: "string", description: "Function signature including `returns (...)` to decode the result." },
        args: { type: "array" },
        blockNumber: { type: "string", description: "Optional historical block." },
      },
      required: ["address", "signature"],
    },
  },
  {
    name: "eth_decode",
    description: "Decode calldata (a tx's input) or revert data. Looks the 4-byte selector up in the public signature database unless you pass the signature or ABI. kind=auto treats data as revert data if it starts with an error selector it recognises.",
    method: "POST", path: "dev/decode", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        data: { type: "string", description: "0x… hex" },
        kind: { type: "string", enum: ["auto", "calldata", "revert"] },
        signature: { type: "string", description: "Optional known function signature." },
        abi: { type: "array", description: "Optional contract ABI JSON." },
      },
      required: ["data"],
    },
  },
  {
    name: "eth_resolve_ens",
    description: "Resolve an ENS name (vitalik.eth) to its address on mainnet.",
    method: "GET", path: "dev/ens/{name}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "eth_gas",
    description: "Current base fee and EIP-1559 tip suggestions (slow/standard/fast from the last 20 blocks), plus what an ETH transfer, ERC-20 transfer, swap and small deploy cost right now in ETH and USD.",
    method: "GET", path: "dev/gas", capability: CAP.inspect,
    input_schema: { type: "object", properties: { network } },
  },
  {
    name: "eth_network_status",
    description: "Chain id, latest block number and time, base fee and gas price.",
    method: "GET", path: "dev/status", capability: CAP.inspect,
    input_schema: { type: "object", properties: { network } },
  },
  {
    name: "eth_contract_abi",
    description: "Look up any verified contract's ABI by address (Sourcify, then Etherscan) and get its function, event and error signatures, ready to paste into eth_read_contract, eth_multicall, eth_logs or eth_simulate. Proxies are followed to the implementation. Use this instead of guessing signatures from memory.",
    method: "GET", path: "dev/abi/{address}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { address: address("Contract"), network, full: { type: "string", enum: ["true", "false"], description: "\"true\" also returns the raw ABI JSON." } }, required: ["address"] },
  },
  {
    name: "eth_util",
    description: "Exact Ethereum math you can't do reliably in your head. Ops: keccak256 {text|hex}; selector {signature} (function, \"event …\" or \"error …\"); encode / encode_packed {types, values}; decode {types, data}; to_units / from_units {amount|raw, decimals}; checksum {address}; create_address {from, nonce}; create2_address {from, salt, bytecode|bytecodeHash}; mapping_slot {slot, keys:[{type,value}]}; hash_message {message}; hash_typed_data {domain, types, primaryType, message}. Never make up a hash, selector or address; compute it here.",
    method: "POST", path: "dev/util", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        op: { type: "string", enum: UTIL_OPS },
        text: { type: "string" }, hex: { type: "string" }, signature: { type: "string" },
        types: { description: "\"address, uint256\" or [\"address\",\"uint256\"]" }, values: { type: "array" }, data: { type: "string" },
        amount: { type: "string" }, raw: { type: "string" }, decimals: { type: "integer" },
        address: { type: "string" }, from: { type: "string" }, nonce: { type: "string" }, salt: { type: "string" },
        bytecode: { type: "string" }, bytecodeHash: { type: "string" },
        slot: { type: "string" }, keys: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: {} } } },
        message: {}, domain: { type: "object" }, primaryType: { type: "string" },
      },
      required: ["op"],
    },
  },
  {
    name: "eth_logs",
    description: "Query event logs and get them decoded: e.g. every Transfer to an address, every Swap on a pool. Filter by contract `address`, `event` signature, and indexed `args`. Default window is the last 1,000 blocks; up to 5,000 per call. Negative fromBlock (\"-200\") is relative to the latest block.",
    method: "POST", path: "dev/logs", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        network, address: { type: "string" },
        event: { type: "string", description: "e.g. \"Transfer(address indexed from, address indexed to, uint256 value)\". Names matter for `args`." },
        args: { type: "object", description: "Indexed-arg filters by name, e.g. { \"to\": \"0x…\" }." },
        fromBlock: { type: "string" }, toBlock: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "eth_storage",
    description: "Read raw contract storage, which works even on unverified contracts and for private variables. Pass `slot` (number or 0x) or `slots`; add `keys` ([{type, value}], outermost first) to read a mapping entry at base slot `slot` (e.g. balances[addr]). Each value comes back as raw hex, uint and address.",
    method: "POST", path: "dev/storage", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        network, address: address("Contract"),
        slot: { type: "string" }, slots: { type: "array", items: { type: "string" }, maxItems: 20 },
        keys: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: {} } } },
        blockNumber: { type: "string" },
      },
      required: ["address"],
    },
  },
  {
    name: "eth_multicall",
    description: "Up to 50 view calls in one round trip, each succeeding or failing on its own: e.g. balanceOf across many tokens, or a pool's slot0 + liquidity + fee at once. Optional historical blockNumber.",
    method: "POST", path: "dev/multicall", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        network,
        calls: { type: "array", maxItems: 50, items: { type: "object", properties: { address: { type: "string" }, signature: { type: "string" }, args: { type: "array" } }, required: ["address", "signature"] } },
        blockNumber: { type: "string" },
      },
      required: ["calls"],
    },
  },

  // ── Market data (Ethereum mainnet, read-only) ──
  {
    name: "eth_token_price",
    description: "USD price and 24h change for tokens on Ethereum mainnet. Symbols (ETH, WETH, USDC, USDT, DAI, WBTC, LINK, UNI, AAVE, LDO, PEPE, SHIB, STETH) or addresses.",
    method: "GET", path: "market/price", capability: CAP.inspect,
    input_schema: { type: "object", properties: { tokens: { type: "string", description: "Comma-separated, up to 30." } }, required: ["tokens"] },
  },
  {
    name: "eth_swap_quote",
    description: "Best-route swap quote on Ethereum mainnet from the KyberSwap aggregator: output, minimum after slippage, price impact, gas cost in USD, and DEXes routed through. Quote only; nothing is signed.",
    method: "GET", path: "market/quote", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        inputToken: { type: "string" }, outputToken: { type: "string" },
        amount: { type: "string", description: "In units of the input token (\"1.5\")." },
        slippageBps: { type: "integer", minimum: 1, maximum: 1000, description: "Default 50 (0.5%)." },
      },
      required: ["inputToken", "outputToken", "amount"],
    },
  },

  // ── Paper trading ──
  {
    name: "eth_paper_swap",
    description: "Swap in this agent's paper wallet (starts at 10,000 USDC) at the live mainnet KyberSwap quote, paying that route's real mainnet gas. Subject to the owner's limits. Give a one-line reason in `note`.",
    method: "POST", path: "paper/swap", capability: CAP.trade,
    input_schema: {
      type: "object",
      properties: {
        inputToken: { type: "string" }, outputToken: { type: "string" },
        amount: { type: "string", description: "\"1.5\", \"25%\" of the holding, or \"all\"." },
        slippageBps: { type: "integer", minimum: 1, maximum: 1000 },
        note: { type: "string", maxLength: 280 },
      },
      required: ["inputToken", "outputToken", "amount"],
    },
  },
  {
    name: "eth_paper_portfolio",
    description: "The paper wallet marked to market: equity, P&L (realized/unrealized), gas paid, holdings with average cost.",
    method: "GET", path: "paper", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "eth_paper_trades",
    description: "This paper wallet's fills since its last reset, newest first.",
    method: "GET", path: "paper/trades", capability: null,
    input_schema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } } },
  },
  {
    name: "eth_paper_leaderboard",
    description: "Every agent in this org with a paper wallet, ranked by return.",
    method: "GET", path: "paper/leaderboard", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "eth_policy",
    description: "The limits this agent's owner set: paused, per-trade and daily USD caps, allowed tokens, transfer allowlist, max ETH per transaction.",
    method: "GET", path: "policy", capability: null,
    input_schema: { type: "object", properties: {} },
  },

  // ── Build & simulate ──
  {
    name: "eth_simulate",
    description: "Dry-run a contract call, ETH send or deployment with eth_call + estimateGas — on any network, mainnet included. Returns success, decoded return value (if `signature` has returns), gas and fee estimate, or the decoded revert. Runs as this agent's dev wallet unless `from` is given.",
    method: "POST", path: "dev/simulate", capability: CAP.simulate,
    input_schema: {
      type: "object",
      properties: {
        network, from: { type: "string", description: "Optional sender to simulate as." }, ...callSpec,
        stateOverride: stateOverrideSchema,
        blockNumber: { type: "string", description: "Optional: simulate against a past block." },
      },
    },
  },
  {
    name: "eth_compile",
    description: "Compile Solidity with the server's pinned solc (0.8.x) and get each contract's ABI, function signatures, constructor signature, size and compiler errors with line positions. You can write Solidity but you can't compile it; this does. @openzeppelin/contracts/ and @openzeppelin/contracts-upgradeable/ imports (v5.4.0) resolve automatically. Use it to iterate on compile errors before eth_deploy_source.",
    method: "POST", path: "dev/compile", capability: CAP.simulate,
    input_schema: {
      type: "object",
      properties: {
        ...sourceSpec,
        includeBytecode: { type: "boolean", description: "Also return creation bytecode (large). Not needed for eth_deploy_source." },
      },
    },
  },
  {
    name: "eth_verify_contract",
    description: "Publish a deployed contract's source on Sourcify so anyone (and eth_contract_abi) can read its ABI. Recompiles with the same settings and matches the on-chain bytecode. eth_deploy_source already does this for you.",
    method: "POST", path: "dev/verify", capability: CAP.simulate,
    input_schema: {
      type: "object",
      properties: { network, address: { type: "string" }, ...sourceSpec, contract: { type: "string", description: "Which contract, when the source has several." }, creationTxHash: { type: "string" } },
      required: ["address"],
    },
  },

  // ── Act on testnets (agent's own eth-dev wallet) ──
  {
    name: "eth_create_wallet",
    description: "Create (or return) this agent's own Ethereum dev wallet for Sepolia / Base Sepolia. The key stays on the server.",
    method: "POST", path: "dev/wallet", capability: CAP.testnet,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "eth_send",
    description: "Simulate, then sign with the agent's dev wallet and send: any contract call or ETH send. A tx that would revert is rejected before sending (status \"rejected\", nothing paid). Waits for the receipt.",
    method: "POST", path: "dev/send", capability: CAP.testnet,
    input_schema: { type: "object", properties: { network: signingNetwork, ...callSpec } },
  },
  {
    name: "eth_transfer",
    description: "Send ETH, or an ERC-20 by passing its `token` address, from the agent's dev wallet. Amount in token units.",
    method: "POST", path: "dev/transfer", capability: CAP.testnet,
    input_schema: {
      type: "object",
      properties: { network: signingNetwork, to: { type: "string" }, amount: { type: "string" }, token: { type: "string", description: "ERC-20 address. Omit for ETH." } },
      required: ["to", "amount"],
    },
  },
  {
    name: "eth_deploy_contract",
    description: "Deploy a compiled contract from the agent's dev wallet: creation bytecode plus optional constructor signature and args. Returns the new contract address.",
    method: "POST", path: "dev/deploy", capability: CAP.testnet,
    input_schema: {
      type: "object",
      properties: { network: signingNetwork, bytecode: callSpec.bytecode, constructorSignature: callSpec.constructorSignature, args: callSpec.args, value: callSpec.value },
      required: ["bytecode"],
    },
  },
  {
    name: "eth_deploy_source",
    description: "Solidity source in, live verified contract out: compiles, deploys from this agent's dev wallet on Sepolia / Base Sepolia, and verifies the source on Sourcify. Returns the address, explorer link, function signatures to call it with, and compile errors when it doesn't build (nothing is sent then).",
    method: "POST", path: "dev/deploy-source", capability: CAP.testnet,
    input_schema: {
      type: "object",
      properties: {
        network: signingNetwork, ...sourceSpec,
        contract: { type: "string", description: "Which contract to deploy when the source has several. Defaults to the last one." },
        args: { type: "array", description: "Constructor arguments, in order. Integers as strings." },
        value: callSpec.value,
        verify: { type: "boolean", description: "Verify on Sourcify after deploying. Default true." },
      },
    },
  },
  {
    name: "eth_sign_message",
    description: "Sign with this agent's dev wallet: an EIP-191 `message` (Sign-In with Ethereum, attestations) or EIP-712 `typedData`. Typed data must set domain.chainId to Sepolia (11155111) or Base Sepolia (84532), so nothing signed here works on a mainnet. Returns the signature and the hash that was signed.",
    method: "POST", path: "dev/sign", capability: CAP.testnet,
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", maxLength: 10000 },
        typedData: { type: "object", description: "{ domain, types, primaryType, message }" },
      },
    },
  },

  // ── Bridge testnet ETH ──
  {
    name: "eth_bridge_testnet",
    description: "Move ETH from your dev wallet on Sepolia to the same address on Base Sepolia through Base's official bridge. Lands in about 1–5 minutes. Use it when you have Sepolia ETH but need gas on Base Sepolia (faucets are per-network).",
    method: "POST", path: "dev/bridge", capability: CAP.testnet,
    input_schema: { type: "object", properties: { amount: { type: "string", description: "ETH to bridge, e.g. \"0.05\"." } }, required: ["amount"] },
  },

  // ── Acts while you're offline ──
  {
    name: "eth_alerts",
    description: "What happened while you were away: standing orders that filled or failed, watches that fired, payments received. Newest first. Check this first whenever you wake.",
    method: "GET", path: "alerts", capability: null,
    input_schema: { type: "object", properties: { unread: { type: "string", enum: ["1"], description: "\"1\" for unread only." }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
  },
  {
    name: "eth_alerts_read",
    description: "Mark alerts as read once you've acted on them.",
    method: "POST", path: "alerts/read", capability: null,
    input_schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, all: { type: "boolean" } } },
  },
  {
    name: "eth_order",
    description: "Leave a standing paper order that the hub fills while you're offline: when the trigger token's price crosses a level (limit / stop) or falls trailPct from its high (trailing stop), swap `amount` of inputToken into outputToken at the live quote. Checked every minute; the result lands in eth_alerts. Expires after ttlDays (default 7, max 30).",
    method: "POST", path: "orders", capability: CAP.trade,
    input_schema: {
      type: "object",
      properties: {
        inputToken: { type: "string" }, outputToken: { type: "string" },
        amount: { type: "string", description: "\"1.5\", \"25%\" or \"all\" of the input holding at fill time." },
        trigger: { type: "object", description: "{ token, op: \"above\"|\"below\", usd } or { token, op: \"trail\", trailPct }", properties: { token: { type: "string" }, op: { type: "string", enum: ["above", "below", "trail"] }, usd: { type: "number" }, trailPct: { type: "number", minimum: 0.5, maximum: 50 } }, required: ["token", "op"] },
        slippageBps: { type: "integer", minimum: 1, maximum: 1000 }, ttlDays: { type: "number", maximum: 30 }, note: { type: "string", maxLength: 280 },
      },
      required: ["inputToken", "outputToken", "amount", "trigger"],
    },
  },
  {
    name: "eth_orders",
    description: "Your standing orders and their status (open, filled, failed, expired, cancelled), newest first.",
    method: "GET", path: "orders", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "eth_order_cancel",
    description: "Cancel an open standing order.",
    method: "POST", path: "orders/{id}/cancel", capability: null,
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "eth_watch",
    description: "Have the hub watch something and alert you in eth_alerts. kind \"price\": a token crosses a level or trails off its high. kind \"activity\": an address sends a transaction, its ETH balance changes, or ERC-20s move in or out (\"self\" = your dev wallet). kind \"event\": a contract emits an event matching `event` and indexed `args`, e.g. Transfer to you, or a governance ProposalCreated. Checked every minute.",
    method: "POST", path: "watches", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["price", "activity", "event"] },
        trigger: { type: "object", description: "price: { token, op, usd | trailPct }" },
        address: { type: "string", description: "activity: the address (\"self\" ok). event: optional contract filter." },
        event: { type: "string", description: "event: e.g. \"Transfer(address indexed from, address indexed to, uint256 value)\"." },
        args: { type: "object", description: "event: indexed-arg filters by name, e.g. { \"to\": \"0x…\" }." },
        network,
        repeat: { type: "boolean", description: "Keep firing after the first alert. Default false for price, true otherwise." },
        ttlDays: { type: "number", maximum: 30 }, note: { type: "string", maxLength: 280 },
      },
      required: ["kind"],
    },
  },
  {
    name: "eth_watches",
    description: "Your watches and how often each fired.",
    method: "GET", path: "watches", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "eth_watch_cancel",
    description: "Stop a watch.",
    method: "POST", path: "watches/{id}/cancel", capability: null,
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },

  // ── Get paid and know it ──
  {
    name: "eth_payment_request",
    description: "Bill someone directly: returns an EIP-681 payment link and an exact amount (your amount plus a few base units that identify this request, under a cent). The hub scans the chain every minute and alerts you when it lands. Works on mainnet and Base too, since receiving needs no signature. Pays into your dev wallet unless `recipient` is another of your own wallets.",
    method: "POST", path: "payments/request", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "string", description: "e.g. \"25\"" },
        token: { type: "string", description: "\"ETH\" (default), \"USDC\", or an ERC-20 address." },
        network: { ...network, description: "Defaults to sepolia. Use base or mainnet to be paid real funds." },
        recipient: { type: "string" }, label: { type: "string", maxLength: 64 }, ttlDays: { type: "number", maximum: 30 },
      },
      required: ["amount"],
    },
  },
  {
    name: "eth_payment_status",
    description: "A payment request, re-checked on-chain right now.",
    method: "GET", path: "payments/{id}", capability: null,
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "eth_payment_requests",
    description: "Your payment requests (pending, paid, expired), newest first.",
    method: "GET", path: "payments", capability: null,
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "eth_verify_payment",
    description: "Someone says they paid you: check it. Given a tx hash, confirms it succeeded and moved at least `amount` of ETH or the token to `recipient`, with the payer and confirmations. Never trust a \"sent!\" message without this.",
    method: "POST", path: "payments/verify", capability: CAP.inspect,
    input_schema: {
      type: "object",
      properties: { hash: { type: "string" }, recipient: address("Who should have been paid"), token: { type: "string", description: "\"ETH\" (default), \"USDC\", or an ERC-20 address." }, amount: { type: "string", description: "Minimum expected." }, network },
      required: ["hash", "recipient"],
    },
  },

  // ── Due diligence ──
  {
    name: "eth_token_safety",
    description: "Due diligence on an ERC-20 before you buy or accept it: verified source, upgradeable proxy, owner powers in the ABI (mint, blacklist, pause, fee changes) and whether ownership is renounced, plus on mainnet a real $1,000 buy-and-sell-back through the aggregator to expose transfer taxes and thin liquidity. Returns findings and a verdict.",
    method: "GET", path: "token/safety/{token}", capability: CAP.inspect,
    input_schema: { type: "object", properties: { token: { type: "string", description: "Address, or a symbol on mainnet." }, network: { ...network, description: "Defaults to mainnet." } }, required: ["token"] },
  },
  {
    name: "eth_preview_transaction",
    description: "Before you sign a transaction someone else built (a dapp's \"sign this\", an API's swap tx, another agent's request), see what it does: the decoded call, every ETH and token balance change for your wallet from a full simulation, and red flags (unlimited approvals, operator grants to unverified contracts or plain wallets, calls that fail). Calldata is opaque to you; this isn't.",
    method: "POST", path: "tx/preview", capability: CAP.simulate,
    input_schema: {
      type: "object",
      properties: {
        transaction: { type: "object", description: "{ to, data, value } with value in wei, the shape wallets receive.", properties: { to: { type: "string" }, data: { type: "string" }, value: { type: "string" } } },
        network, from: { type: "string", description: "Preview as this address instead of your dev wallet." },
      },
      required: ["transaction"],
    },
  },
  {
    name: "eth_sign_transaction",
    description: "Preview, then sign and send someone else's transaction with your dev wallet (Sepolia / Base Sepolia). Refuses one that fails in simulation or breaks your owner's limits; refuses a high-risk one unless you pass acceptRisks: true after reading the preview.",
    method: "POST", path: "tx/sign", capability: CAP.testnet,
    input_schema: {
      type: "object",
      properties: { transaction: { type: "object", properties: { to: { type: "string" }, data: { type: "string" }, value: { type: "string" } } }, network: signingNetwork, acceptRisks: { type: "boolean" } },
      required: ["transaction"],
    },
  },
];

/** What each harness-only capability gives an agent, and why it can't do it alone. Served with the tools. */
export const HARNESS_ONLY: { capability: string; tools: string[]; why: string }[] = [
  { capability: "Acts while you're offline", tools: ["eth_order", "eth_watch", "eth_alerts"], why: "You exist only while a prompt runs. The hub checks prices, addresses and contract events every minute, fills standing orders and leaves the result in your alerts." },
  { capability: "Gets paid and knows it", tools: ["eth_payment_request", "eth_verify_payment"], why: "A payer's \"sent!\" proves nothing. The hub gives each request a unique amount, scans the chain and confirms who paid what." },
  { capability: "Sees what a transaction will do", tools: ["eth_preview_transaction", "eth_simulate", "eth_inspect_transaction"], why: "Calldata is opaque to you. The hub decodes it, simulates it against live state and lists your balance changes and approvals before anything is signed." },
  { capability: "Signs without holding a key", tools: ["eth_send", "eth_transfer", "eth_sign_transaction", "eth_sign_message", "eth_bridge_testnet"], why: "Your dev wallet's key stays encrypted on the hub. It signs only on Sepolia / Base Sepolia, inside your owner's limits, after a simulation." },
  { capability: "Spots a bad token before buying", tools: ["eth_token_safety"], why: "Owner powers, proxies and transfer taxes live in bytecode and chain state; a round-trip quote shows what you'd really get back." },
  { capability: "Compiles and verifies Solidity", tools: ["eth_compile", "eth_deploy_source", "eth_verify_contract"], why: "You can write Solidity but not run solc. The hub compiles it, deploys it and publishes the source on Sourcify." },
  { capability: "Exact math and chain reads", tools: ["eth_util", "eth_contract_abi", "eth_storage", "eth_logs", "eth_multicall"], why: "Hashes, selectors, CREATE2 addresses and storage slots can't be guessed; ABIs, logs and storage are chain state you can't see." },
];
