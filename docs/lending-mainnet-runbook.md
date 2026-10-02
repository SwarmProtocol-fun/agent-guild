# Lending — Mainnet Launch Runbook

How to take the lending marketplace (pools, solo loans, offers) from devnet to a
capped mainnet beta. Code lives in `AgentGuildApp/src/lib/lending/` and
`AgentGuildApp/src/lib/solana/lending-verify.ts`.

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

## Before launch

1. **Treasury = multisig.** Create a Squads (or equivalent) vault and use the
   vault address as `SOLANA_LENDING_TREASURY_ADDRESS`. Fund it with SOL for
   fees and create its USDC token account. Never use a single person's wallet.
2. **Cluster config** (the app refuses to run lending on mainnet without these):
   - `SOLANA_CLUSTER=mainnet-beta` (and `NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta` for UI labels)
   - `SOLANA_USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
   - `SOLANA_RPC_URL=<paid mainnet RPC>` (public RPCs rate-limit `getTransaction`)
3. **Launch guards** — start small:
   - `LENDING_ALLOWLIST=<invited wallets>`
   - `LENDING_MAX_POOL_TVL_USD`, `LENDING_MAX_DEPOSIT_PER_WALLET_USD`, `LENDING_MAX_LOAN_USD`
   - `LENDING_PAUSED=true` is the kill switch (blocks new risk; repayments always work).
4. **Sweep.** Set `INTERNAL_SERVICE_SECRET`. On Netlify,
   `netlify/functions/lending-sweep.mts` runs hourly. Elsewhere, schedule:
   `curl -X POST "$SITE/api/cron/lending-sweep" -H "x-service-secret: $INTERNAL_SERVICE_SECRET"`
5. **Indexes.** `firebase deploy --only firestore:indexes` (lending composite
   indexes are in `firestore.indexes.json`). Wait for them to finish building.
6. **Backfill accrual.** Click **Run Sweep** once at `/admin/lending` — it
   reconciles every pool's interest accrual, including loans disbursed before
   accrual tracking existed.
7. **Dry run on devnet** end to end: deposit → trust loan → post collateral →
   disburse → repay (with an overpayment) → confirm the collateral return and
   refund payouts → withdraw. Then a default via the sweep.
8. **Legal.** Pooled deposits earning yield, custodial treasury, and lending to
   agents/orgs raise securities, lending-licence and money-transmission
   questions in most jurisdictions. Get counsel sign-off before opening it to
   anyone outside the allowlist. This is not something code can resolve.

## Daily operation (`/admin/lending`)

- **Loans awaiting disbursement** — send the principal from the treasury, paste
  the signature. Cancel only if you have *not* sent it.
- **Pool withdrawals** — send the locked-in amount, paste the signature.
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
- Amounts are JS numbers rounded to micro-USDC, not integer token units.
