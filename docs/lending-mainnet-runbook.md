# Lending — Mainnet Launch Runbook

How to take the lending marketplace (pools, solo loans, offers) from devnet to a
capped mainnet beta. Code lives in `AgentGuildApp/src/lib/lending/`,
`AgentGuildApp/src/lib/solana/lending-verify.ts` and
`AgentGuildApp/src/lib/ethereum/lending-verify.ts`.

## How it works (one paragraph)

The ledger is in Firestore. No signing key is held by the app: every inbound
transfer (deposit, collateral, solo funding, repayment) is sent by the user
from their own wallet and verified on-chain at `finalized` commitment before
anything is credited, and every outbound transfer (disbursement, withdrawal,
collateral return, refund) is sent by whoever controls the source wallet and
confirmed the same way. Each verified signature is claimed in the same
Firestore transaction as the credit, so it can be used exactly once and a
failed credit never burns it. Anything the ledger owes but can't send itself
goes into the **payout queue** (`lendingPayouts`), shown at `/admin/lending`.

## Assets and pools

There is one community pool per asset, and each pool is accounted in its own
asset: deposits, loans, interest, collateral, repayments, refunds and
withdrawals are all in that asset, so the treasury never holds one asset
against a debt in another.

| Pool | Chain | Treasury | Who can use it |
|------|-------|----------|----------------|
| USDC (`Community Lending Pool`) | Solana | `SOLANA_LENDING_TREASURY_ADDRESS` | Solana logins, or EVM logins with a linked Solana wallet |
| SOL (`community-sol`) | Solana | same Solana treasury | same as USDC |
| ETH (`community-eth`) | Ethereum | `ETH_LENDING_TREASURY_ADDRESS` | Ethereum (EVM) logins only |
| USDC/ETH market (`market-usdc-eth`) | USDC on Solana, ETH collateral on Ethereum | both | lenders: as USDC; borrowers: an EVM login with a linked Solana wallet |
| USDC/SOL market (`market-usdc-sol`) | Solana | Solana treasury | as USDC |

Solo loans and loan offers stay USDC.

**Collateral markets** lend USDC against locked ETH or SOL. Lenders deposit and
withdraw USDC exactly as in the USDC pool. A borrower's collateral is sized so
the loan starts at the market's max loan-to-value (ETH 65%, SOL 55%), posted to
that asset's treasury, and returned in that asset on repayment. Market loans are
always kind `trust`. The hourly sweep starts **liquidation** when a loan's LTV
(principal + interest over collateral value, live prices) reaches the
liquidation threshold (ETH 80%, SOL 75%), or when it's overdue past the grace
period. Liquidation seizes the collateral and stops interest; see *Daily
operation* for selling it. LTV parameters live on the pool document
(`maxLtvBps`, `liquidationLtvBps`) and are copied onto each loan at request time.

Amount fields (`principal`, `availableLiquidity`, `amount`, ...) hold amounts
**in the record's `asset`** (a record without `asset` is USDC); collateral is in
`collateralAsset` when set. Fields ending in `Usd` are real dollars. See
`lib/lending/assets.ts`. USD only matters for the dollar rules — minimum
loan, tier maximum, `LENDING_MAX_*` caps — which use a live price: the median
of Coinbase, Kraken and CoinGecko. If fewer than two respond, or they disagree
by more than 3%, new SOL/ETH loans and capped deposits are refused until prices
recover. Repayments never need a price.

The ETH pool appears only once `ETH_LENDING_TREASURY_ADDRESS` is set. Pools are
created automatically the first time `/api/v1/lending/pools` is called.

**Field migration (2026-10-07).** Amount fields used to be named `...Usd`
(`principalUsd`, `availableLiquidityUsd`, `amountUsd`, ...). The code reads both
names and rewrites a document to the new names inside the same transaction
before changing it (`lib/lending/legacy-fields.ts`). To migrate the rest in
bulk — safe while the app is live, and idempotent:

    cd AgentGuildApp
    npx tsx --env-file=.env.local scripts/migrate-lending-fields.ts          # dry run
    npx tsx --env-file=.env.local scripts/migrate-lending-fields.ts --apply

Deploy the new code to **every** deployment that serves lending (Netlify *and*
Railway) before running it. An older deployment would keep writing the old
names: running totals still add up, but its other writes would be lost. API
bodies take `amount`; `amountUsd` is still accepted as a deprecated alias.

**Deploy order:** deploy the code *before* anything calls the pools endpoint
with it. A SOL/ETH pool document written by the new code would show up in an
older deployment as a USDC pool that accepts USDC deposits. Don't run the new
code locally against production Firestore; use the emulator
(`FIRESTORE_EMULATOR_HOST`).

## Before launch

1. **Treasury = multisig.** Create a Squads (or equivalent) vault and use the
   vault address as `SOLANA_LENDING_TREASURY_ADDRESS`. Fund it with SOL for
   fees and create its USDC token account. Never use a single person's wallet.
2. **Cluster config** (the app refuses to run lending on mainnet without these):
   - `SOLANA_CLUSTER=mainnet-beta` (and `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta` for UI labels)
   - `SOLANA_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
   - `SOLANA_RPC_URL=<paid mainnet RPC>` (public RPCs rate-limit `getTransaction`)
3. **Ethereum (ETH pool)** — optional; leave unset to keep the pool hidden:
   - `ETH_LENDING_TREASURY_ADDRESS=<Safe address>` — a Safe multisig is
     supported: payouts it executes are verified by balance movement.
   - `ETH_LENDING_NETWORK=mainnet` (default `sepolia`)
   - `ETH_LENDING_RPC_URL=<paid mainnet RPC>` — required on mainnet. Payouts
     sent from a Safe need balances at their block, so confirm them within
     ~20 minutes of finality or use an archive RPC.
   - Ethereum transfers verify only once **finalized** (~15 minutes). Users and
     admins keep the tx hash and retry verification after that.
4. **Launch guards** — start small:
   - `LENDING_ALLOWLIST=<invited wallets>`
   - `LENDING_MAX_POOL_TVL_USD`, `LENDING_MAX_DEPOSIT_PER_WALLET_USD`, `LENDING_MAX_LOAN_USD`
   - `LENDING_PAUSED=true` is the kill switch (blocks new risk; repayments always work).
5. **Sweep.** Set `INTERNAL_SERVICE_SECRET`. On Netlify,
   `netlify/functions/lending-sweep.mts` runs hourly. Elsewhere, schedule:
   `curl -X POST "$SITE/api/cron/lending-sweep" -H "x-service-secret: $INTERNAL_SERVICE_SECRET"`
6. **Indexes.** `firebase deploy --only firestore:indexes` (lending composite
   indexes are in `firestore.indexes.json`). Wait for them to finish building.
7. **Backfill accrual.** Click **Run Sweep** once at `/admin/lending` — it
   reconciles every pool's interest accrual, including loans disbursed before
   accrual tracking existed.
8. **Dry run on devnet** end to end: deposit → trust loan → post collateral →
   disburse → repay (with an overpayment) → confirm the collateral return and
   refund payouts → withdraw. Then a default via the sweep. Repeat a deposit,
   loan, repayment and withdrawal in the SOL pool, and in the ETH pool on
   Sepolia with the treasury Safe sending the payouts.
9. **Legal.** Pooled deposits earning yield, custodial treasury, and lending to
   agents/orgs raise securities, lending-licence and money-transmission
   questions in most jurisdictions. Get counsel sign-off before opening it to
   anyone outside the allowlist. This is not something code can resolve.

## Daily operation (`/admin/lending`)

- **Loans awaiting disbursement** — send the principal from the treasury for
  that loan's asset (amounts are shown with their symbol), paste the
  signature or tx hash. Cancel only if you have *not* sent it.
- **Pool withdrawals** — send the locked-in amount, paste the signature.
- **Liquidations** — a market loan's collateral has been seized. Sell it from
  its treasury (ETH from the Ethereum Safe, SOL from the Solana treasury), get
  the USDC into the Solana treasury (an exchange withdrawal, or a swap inside
  the treasury), then **Record Proceeds** with that transaction. Proceeds go to
  principal, then interest. A shortfall is written off and the loan becomes
  `defaulted`; a surplus is queued back to the borrower (`liquidation_surplus`).
  An admin can also start a liquidation early with
  `POST /api/v1/lending/loans/{id}/liquidate`.
- **Payout queue** — collateral returns, seized collateral owed to solo
  lenders, and refunds. Treasury payouts are yours; payouts owed by a user's
  wallet (e.g. a solo lender refunding an overpayment) are listed for
  visibility and settled by that user from their *My Positions* tab.
- **Run Sweep** — the same job the scheduler runs; safe to re-run.

## What the sweep does

1. Defaults active loans past `dueAt + LENDING_DEFAULT_GRACE_DAYS`
   (collateral applied to principal, then interest; excess queued back to the borrower).
2. Cancels trust loans still awaiting collateral after
   `LENDING_PENDING_EXPIRY_DAYS`, releasing reserved pool liquidity.
3. Reconciles each pool's accrued-interest totals against its active loans.

## Money that arrives "late" is never lost

If a verified transfer lands after its target moved on, it is claimed and a
refund is queued rather than rejected:

| Situation | Payout queued |
|---|---|
| Deposit while paused / not allowlisted / over a cap | `deposit_refund` treasury → depositor (uncredited part) |
| Collateral posted after the loan was cancelled/expired | `collateral_return` treasury → poster |
| Solo funding after another lender funded it, or for a loan reserved to another lender | `funding_refund` borrower → lender |
| Repayment after the loan closed | `repayment_refund` lender/treasury → payer |
| Repayment beyond the balance | `overpayment_refund` lender/treasury → payer |

## Known limits (accepted for the beta)

- The ledger is off-chain; lenders trust the operator and the multisig signers.
  An on-chain program (pool, shares, collateral escrow, withdrawal queue) plus
  an audit is the path to removing that trust.
- Payouts are manual. Treasury signers must work the queue promptly.
- Solo-loan refunds owed by a user (`funding_refund`, solo `overpayment_refund`)
  depend on that user sending them; the platform can't force it.
- Amounts are JS numbers rounded to each asset's ledger precision (USDC 6
  decimals, SOL 9, ETH 9 — gwei), not integer token units; on-chain checks
  convert to exact base units.
- Liquidation is checked hourly (or on **Run Sweep**), not continuously, and the
  sale is manual. A fast price drop can fall past the collateral's value before
  it's sold; that loss lands on the market's USDC lenders. The LTV buffers are
  the protection; borrowers can't top up collateral yet.
- SOL/ETH lenders take that asset's price risk themselves (they're owed SOL or
  ETH, not dollars). A borrower's SOL/ETH collateral is in the same asset as
  the loan, so a price move doesn't change how well it covers the loan.
- ETH transfers must be plain transfers, or sends executed by the sending
  contract wallet (e.g. a Safe). ETH sent by some other contract (a router or
  batcher) isn't recognised; ask the user to send directly.
