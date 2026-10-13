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
    input_schema: { type: "object", properties: { network, from: { type: "string", description: "Optional sender to simulate as." }, ...callSpec } },
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
];
