/**
 * Hyperliquid L1 action signing, in TypeScript — a port of the official
 * hyperliquid-python-sdk's utils/signing.py (action_hash, sign_l1_action,
 * float_to_wire, order wires). An action is msgpack-encoded, suffixed with
 * the nonce and vault flag, keccak-hashed, and that hash is signed as the
 * `connectionId` of an EIP-712 "Agent" message on chain 1337.
 *
 * Field order matters: msgpack keeps insertion order and the hash covers it,
 * so every wire object below is built in exactly the SDK's key order.
 * Verified byte-for-byte against the Python SDK by
 * src/lib/mods/__tests__/hyperliquid-signing.test.ts.
 */
import { encode } from "@msgpack/msgpack";
import { keccak256, parseSignature, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Tif = "Ioc" | "Gtc" | "Alo";

export type OrderTypeWire =
  | { limit: { tif: Tif } }
  | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };

export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: OrderTypeWire;
}

export interface OrderAction {
  type: "order";
  orders: OrderWire[];
  grouping: "na" | "normalTpsl" | "positionTpsl";
}

export interface UpdateLeverageAction {
  type: "updateLeverage";
  asset: number;
  isCross: boolean;
  leverage: number;
}

export type L1Action = OrderAction | UpdateLeverageAction;

export interface Signature {
  r: Hex;
  s: Hex;
  v: number;
}

/** Same as the SDK's float_to_wire: at most 8 decimals, trailing zeros dropped, and it refuses to round silently. */
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new Error(`floatToWire would round ${x}`);
  const trimmed = rounded.replace(/\.?0+$/, "");
  return trimmed === "-0" || trimmed === "" ? "0" : trimmed;
}

export interface OrderRequest {
  asset: number;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  reduceOnly: boolean;
  orderType: { limit: { tif: Tif } } | { trigger: { triggerPx: number; isMarket: boolean; tpsl: "tp" | "sl" } };
}

export function orderWire(o: OrderRequest): OrderWire {
  const t: OrderTypeWire = "limit" in o.orderType
    ? { limit: { tif: o.orderType.limit.tif } }
    : { trigger: { isMarket: o.orderType.trigger.isMarket, triggerPx: floatToWire(o.orderType.trigger.triggerPx), tpsl: o.orderType.trigger.tpsl } };
  return { a: o.asset, b: o.isBuy, p: floatToWire(o.limitPx), s: floatToWire(o.sz), r: o.reduceOnly, t };
}

export function orderAction(orders: OrderWire[], grouping: OrderAction["grouping"] = "na"): OrderAction {
  return { type: "order", orders, grouping };
}

/** keccak(msgpack(action) ‖ nonce u64be ‖ 0x00) — no vault, no expiresAfter, as the mod never trades for a vault. */
export function actionHash(action: L1Action, nonce: number): Hex {
  const packed = encode(action);
  const data = new Uint8Array(packed.length + 9);
  data.set(packed, 0);
  new DataView(data.buffer).setBigUint64(packed.length, BigInt(nonce), false);
  data[packed.length + 8] = 0;
  return keccak256(data);
}

export async function signL1Action(privateKey: string, action: L1Action, nonce: number, mainnet: boolean): Promise<Signature> {
  const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
  const signature = await account.signTypedData({
    domain: { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: mainnet ? "a" : "b", connectionId: actionHash(action, nonce) },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  return { r, s, v: v != null ? Number(v) : 27 + yParity };
}

let lastNonce = 0;
/** Millisecond timestamp, strictly increasing within this process so back-to-back actions (an order then its SL/TP) never share a nonce. */
export function nextNonce(): number {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}
