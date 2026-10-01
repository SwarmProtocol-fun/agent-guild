#!/usr/bin/env python3
"""
Places one order on Hyperliquid via the official hyperliquid-python-sdk and
prints a single JSON line with the fill so GatewayAgent's hyperliquid.mjs
executor can parse it as the task result.

A "market" order is implemented as an IOC limit order priced a small
slippage percent through the current mid, per the SDK's own recommended
pattern for market-like fills (Hyperliquid has no distinct market-order type).
"""
import argparse
import json
import os
import sys

from eth_account import Account
from hyperliquid.exchange import Exchange
from hyperliquid.info import Info
from hyperliquid.utils import constants

MARKET_SLIPPAGE = 0.01  # 1% — wide enough to fill IOC on typical testnet depth


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--coin", required=True)
    parser.add_argument("--side", required=True, choices=["buy", "sell"])
    parser.add_argument("--size-usd", required=True, type=float)
    parser.add_argument("--order-type", default="market", choices=["market", "limit"])
    parser.add_argument("--limit-price", type=float)
    parser.add_argument("--reduce-only", action="store_true")
    parser.add_argument("--leverage", type=int)
    parser.add_argument("--stop-loss-pct", type=float)
    parser.add_argument("--take-profit-pct", type=float)
    args = parser.parse_args()

    private_key = os.environ.get("HYPERLIQUID_PRIVATE_KEY")
    if not private_key:
        print(json.dumps({"error": "HYPERLIQUID_PRIVATE_KEY not set"}), file=sys.stderr)
        sys.exit(1)

    network = os.environ.get("HYPERLIQUID_NETWORK", "testnet")
    base_url = constants.TESTNET_API_URL if network == "testnet" else constants.MAINNET_API_URL

    wallet = Account.from_key(private_key)
    info = Info(base_url, skip_ws=True)
    exchange = Exchange(wallet, base_url)

    if args.leverage:
        exchange.update_leverage(args.leverage, args.coin, is_cross=True)

    is_buy = args.side == "buy"
    mids = info.all_mids()
    mid_price = float(mids[args.coin])

    if args.order_type == "market":
        # IOC limit priced through the mid so it fills like a market order.
        limit_px = mid_price * (1 + MARKET_SLIPPAGE) if is_buy else mid_price * (1 - MARKET_SLIPPAGE)
        tif = "Ioc"
    else:
        if args.limit_price is None:
            print(json.dumps({"error": "--limit-price required for limit orders"}), file=sys.stderr)
            sys.exit(1)
        limit_px = args.limit_price
        tif = "Gtc"

    size = round(args.size_usd / mid_price, 4)

    result = exchange.order(
        args.coin,
        is_buy,
        size,
        limit_px,
        {"limit": {"tif": tif}},
        reduce_only=args.reduce_only,
    )

    statuses = result.get("response", {}).get("data", {}).get("statuses", [{}])
    fill = statuses[0].get("filled") or statuses[0].get("resting") or statuses[0]

    # SL/TP attach as separate reduce-only trigger orders on the opposite
    # side of the position, priced a fixed percent through the fill/mid —
    # only makes sense for an order that opens/adds to a position.
    triggers = {}
    if not args.reduce_only and (args.stop_loss_pct or args.take_profit_pct):
        entry_px = float(fill.get("avgPx", limit_px)) if isinstance(fill, dict) else limit_px
        if args.stop_loss_pct:
            trigger_px = entry_px * (1 - args.stop_loss_pct / 100) if is_buy else entry_px * (1 + args.stop_loss_pct / 100)
            sl_result = exchange.order(
                args.coin, not is_buy, size, trigger_px,
                {"trigger": {"triggerPx": trigger_px, "isMarket": True, "tpsl": "sl"}},
                reduce_only=True,
            )
            triggers["stopLoss"] = {"triggerPx": trigger_px, "raw": sl_result}
        if args.take_profit_pct:
            trigger_px = entry_px * (1 + args.take_profit_pct / 100) if is_buy else entry_px * (1 - args.take_profit_pct / 100)
            tp_result = exchange.order(
                args.coin, not is_buy, size, trigger_px,
                {"trigger": {"triggerPx": trigger_px, "isMarket": True, "tpsl": "tp"}},
                reduce_only=True,
            )
            triggers["takeProfit"] = {"triggerPx": trigger_px, "raw": tp_result}

    print(json.dumps({
        "coin": args.coin,
        "isBuy": is_buy,
        "sizeUsd": args.size_usd,
        "sz": size,
        "midPriceAtOrder": mid_price,
        "limitPx": limit_px,
        "reduceOnly": args.reduce_only,
        "leverage": args.leverage,
        "raw": fill,
        "triggers": triggers or None,
    }))


if __name__ == "__main__":
    main()
