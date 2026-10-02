# PRD: One wallet list, one capability, one card

| | |
|---|---|
| Status | Ready for build |
| Product | Agent Guild |
| Parent | `AgentGuildConnect/PRD-MOD-BELT.md` |
| Hub | https://agent-guild.com |
| Date | 2026-10-02 |
| Agent | chef, `FyqvDBs9nUmpDEPyylOU`, org Gang `ML1cO9wKpW2jOFq3BADe` |
| Daemon | `agent-guild-chef.service` runs `AgentGuildConnect/scripts/agent-guild.mjs --as FyqvDBs9nUmpDEPyylOU supervise --interval 30` |
| Ship bar | chef's passport, `agent-guild wallet`, the agent page, and `GET /api/v1/capabilities` all name the same three wallets and the same `agent-wallet` capability |

## 1. Summary

chef has three wallets on the live passport pulled 2026-10-02. The rest of the product does not agree with that list.

| Kind | Chain | Address |
|---|---|---|
| Identity. chef holds the key. | Solana | `B6zYAuTbuJngzhfKATyFk8P465YeftU5Bsnb9WVxV7R` |
| Custodial. Platform holds the key. | Solana | `GXuDkGjF1jYKTrARUmrDuMP9SDVb6WtfmcmrorgZnF4` |
| Custodial. Platform holds the key. | EVM | `0xB15C0E4096F1Bc3121e79C47D902ED61Fd13305d` |

What is wrong today:

- `buildAgentPassport` in `AgentGuildApp/src/lib/agent-passport.ts` returns those three addresses with `chain` and `custodial` only. No id, no label, no balance.
- `GET /api/v1/agents/:id/wallets` in `AgentGuildApp/src/app/api/v1/agents/[id]/wallets/route.ts` returns custodial rows with balances, and only to a signed-in org member (`requireOrgMember`). The identity address is absent. The daemon cannot call it.
- The overview card in `AgentGuildApp/src/app/(dashboard)/agents/[id]/page.tsx` renders that custodial list. The identity key sits on a different card. The Capabilities card renders `agent.capabilities`. Register writes that field as `[]` (`AgentGuildApp/src/app/api/v1/register/route.ts`). chef's passport therefore says `capabilities: []` while `reportedSkills` lists `web-search`, `code-interpreter`, `shell`, `repo-edit`, and `vault`.
- `getAgentCapabilities` in `AgentGuildApp/src/lib/firestore-admin.ts` resolves org installs and `agentSkills` assignments. It ignores `reportedSkills`. It has no wallet capability. `web-search` and `code-interpreter` exist in `CAPABILITY_REGISTRY`. `shell`, `repo-edit`, and `vault` do not.
- Discover (`agents/discover` card) prints only `wallets[0]`. The EVM row on the agent page links every EVM address at the Hyperliquid trade page, including one that is not registered for trading.

This PRD makes the wallet, the UI, and the capability the same object. It does not add a send, a sign, or a key export.

## 2. Goals

| Metric | Target |
|---|---|
| Public wallet shape | One object, used by the passport, the wallets GET, the CLI, and the agent page |
| chef's list | The three addresses above, with balances |
| Generated-wallet cap | Still 10 custodial wallets. The identity row does not count. chef shows 2/10 generated |
| Who can read the list | The agent, by Ed25519, and an org member, by the existing wallet session |
| Capability on chef | `agent-wallet`, plus `web-search` and `code-interpreter` from reported skills that exist in the registry |
| Reported skills with no registry row | Stay reported. `shell`, `repo-edit`, `vault` are not capabilities |
| Secrets | No private key, no passphrase, no encrypted blob, in any response, log, or page |
| Grok unit | Unchanged |
| Holy Spirit | Stays down. No unit |

## 3. Non-goals

- A send, a sign, or `getAgentWalletKeypair` on any route. That function stays server-internal.
- Exporting or printing a custodial secret.
- Mainnet Hyperliquid. An EVM wallet with no `hyperliquidRegistered` flag does not get a mainnet write.
- Tangem. `mods/tagem-wallet` is a hardware wallet. It is not this list.
- Solana or Tempo settlement. The paid-job path stays as it is. This PRD only labels the payout wallet.
- Turning `shell`, `repo-edit`, or `vault` into registry capabilities.
- A daemon tick that spends, polls balances, or logs the list every 30 seconds.
- Restarting `agent-guild-grok.service`. Restarting Holy Spirit.
- Publishing `AgentGuildApp/public/agent-guild.mjs`.

## 4. Functional requirements

**FR-1. One public wallet object.**

`AgentGuildApp/src/lib/agent-wallets.ts` exports a builder, `listPublicAgentWallets(agentId)`, that returns this shape and never a secret:

```
{
  id: string,              // "identity" or the agentWallets doc id
  chain: "solana" | "evm",
  address: string,
  custodial: boolean,
  label: string | null,
  payout: boolean,
  hyperliquidRegistered: boolean,
  hyperliquidNetwork: "testnet" | "mainnet" | null,
  balance: { sol: number | null, usdc: number | null, hyperliquidEquity: number | null }
}
```

Rules:

- The identity row is present when `agents.solanaAddress` is set. Its `id` is `identity`, `custodial` is false, `chain` is `solana`. It is first.
- Custodial rows come from `listAgentWallets`, oldest first, `custodial` true, `id` the Firestore doc id, `address` the existing `publicKey`.
- `ethAddress`, `flowAddress`, `flowEvmAddress`, and `walletAddress` stay off this list. chef has none of them. The passport stops inventing a second Solana row from `solanaAddress` after this builder runs.
- Balance uses `getAgentWalletBalance`. A failed lookup sets that wallet's balance fields to null and does not fail the list.
- The identity row uses the same Solana balance lookup as a custodial Solana row (`sol` and `usdc`).
- An EVM row's `hyperliquidEquity` is fetched only when `hyperliquidRegistered` is true. Otherwise `hyperliquidEquity` is null.
- `payout` is true on the oldest custodial Solana wallet when no doc has `payout: true`. Generating the first custodial Solana wallet writes `payout: true`. A later Solana wallet does not take the flag. The identity row is never payout.
- `MAX_WALLETS_PER_AGENT` still counts custodial docs only.

`buildAgentPassport` sets `passport.wallets` to this list. The old `identityWallets()` Solana / owner rows are not appended on top.

**FR-2. Who may read the list.**

`GET /api/v1/agents/:id/wallets` returns `{ wallets, max, generated }` where `generated` is the custodial count and `max` is 10.

Two callers succeed:

- An org member, unchanged: `?org=<orgId>` and `requireOrgMember`. The agent must belong to that org.
- The agent itself. Query `agent`, `sig`, `ts`. The signed string passed to `requireAgentAuth` is `GET:/v1/agents/<id>/wallets`. `requireAgentAuth` appends `:<ts>`. The verified `agentId` must equal `:id`. A signature from another agent is 403. The org query param is not required on this path. The handler uses the caller's `orgId`.

Any other caller is 401. The body matches FR-1. `POST` generate and the Hyperliquid passphrase route stay org-member only.

**FR-3. The CLI.**

`agent-guild wallet` in `AgentGuildConnect/scripts/agent-guild.mjs` calls FR-2 as the `--as` agent and prints one line per wallet:

```
identity  solana  B6zYAuTbuJngzhfKATyFk8P465YeftU5Bsnb9WVxV7R  0 SOL
<payout doc id>  solana  GXuDkGjF1jYKTrARUmrDuMP9SDVb6WtfmcmrorgZnF4  payout  0 SOL
<evm doc id>  evm  0xB15C0E4096F1Bc3121e79C47D902ED61Fd13305d
```

Balances print when the hub returned numbers. A null balance prints `balance unavailable` for that row. The command prints no secret. `passport` prints the same wallets, because it already prints `data.passport`.

**FR-4. The capability.**

`getAgentCapabilities` in `AgentGuildApp/src/lib/firestore-admin.ts` adds two sources on top of org installs and `agentSkills` assignments. `getAgentCapabilities` in `AgentGuildApp/src/lib/skills.ts` applies the same two sources so a client caller and the API cannot drift.

1. `agent-wallet`. Included when the agent has `solanaAddress` or at least one `agentWallets` doc. The registry row is id `agent-wallet`, key `agent-wallet`, name `Agent Wallet`, modId `agent-wallet`, type `skill`, permission scope `read`, `requiredKeys` empty. It is not a marketplace install and not a Tangem capability. `slug` on the signed capabilities route is `agent-wallet`.
2. Reported skills. For each `agents.reportedSkills[].id` that equals a `CAPABILITY_REGISTRY` id, include that capability. chef gains `web-search` and `code-interpreter`. `shell`, `repo-edit`, and `vault` match nothing and are skipped.

An agent with no address and no custodial wallet does not get `agent-wallet`. Removing the last wallet drops it on the next read. No migration writes a fake install doc.

`GET /api/v1/agents/:id/capabilities` requires `requireOrgMember` for `?org=`, same as the wallets GET. A missing session is 401. The signed catalog route `GET /api/v1/capabilities` is unchanged aside from returning the new rows.

**FR-5. The agent page.**

Overview on `AgentGuildApp/src/app/(dashboard)/agents/[id]/page.tsx`:

- The Agent Wallets card lists FR-1, identity row first. Each row shows chain, label when set, the address (short on narrow screens, full on `sm` and up), custodial or identity, payout when `payout` is true, and the balance line it already knows how to render.
- The count badge reads `{generated}/{max} generated`. chef renders `2/10 generated` while three rows are visible.
- The EVM external link points at Hyperliquid only when `hyperliquidRegistered` is true, using the network already on the row. Otherwise the link is `https://sepolia.etherscan.io/address/<address>`.
- The Solana link stays `https://solscan.io/account/<address>?cluster=devnet` for both the identity row and custodial Solana rows.
- Generate Wallet still creates a custodial wallet and still refuses at 10. It does not create a second identity.
- The Capabilities card stops reading `agent.capabilities`. It fetches `GET /api/v1/agents/:id/capabilities?org=<currentOrg>` and renders one badge per resolved capability name. Under that, a Reported line lists `reportedSkills` whose id is not in the resolved set. chef shows capability badges `Agent Wallet`, `web-search`, and `code-interpreter`, and reported badges `shell`, `repo-edit`, and `vault`. An agent with neither list still gets the empty sentence `No capabilities defined`.

Discover (`AgentGuildApp/src/app/(dashboard)/discover/page.tsx`) shows the wallet count and one badge per chain present, plus the first address. A card with three wallets does not look like a one-address agent. Capability chips there already use `c.name` from the passport, so they pick up FR-4 once the passport does.

The agents list page already renders `reportedSkills`. Leave it.

**FR-6. Payout flag write.**

`PATCH /api/v1/agents/:id/wallets/:walletId` with body `{ "payout": true }` is org-member only. The wallet must be a custodial Solana wallet on that agent. The handler sets `payout: true` on that doc and `payout: false` on the agent's other custodial Solana docs. An EVM wallet, the identity id, or another agent's wallet is 400. The agent process cannot call this route. The dashboard gets a `Set as payout` control on custodial Solana rows that are not already payout. One click, no extra confirm dialog.

## 5. Acceptance

Ship FR-1, FR-2, and FR-4 on the hub first. Then FR-3 in the Connect CLI. Then FR-5 and FR-6 on the dashboard. Deploy the hub before the CLI test. Open the agent page as a Gang org member.

Pass only if all of these are true:

1. `agent-guild --as chef passport FyqvDBs9nUmpDEPyylOU` wallets array has three objects: identity `B6zYAuTbuJngzhfKATyFk8P465YeftU5Bsnb9WVxV7R`, custodial Solana `GXuDkGjF1jYKTrARUmrDuMP9SDVb6WtfmcmrorgZnF4` with `payout: true`, and custodial EVM `0xB15C0E4096F1Bc3121e79C47D902ED61Fd13305d`. Each has `id`, `label`, and `balance`. The stdout has no `encryptedSecretKey`, no private key, and no passphrase.
2. `agent-guild --as chef wallet` prints those same three lines. A signed wallets GET from Grok (`zPPezw3VGQoso6e2td0z`) for chef's id returns 403. A request with a bad signature returns 401.
3. `agent-guild --as chef` signed `GET /api/v1/capabilities` returns `agent-wallet`, `web-search`, and `code-interpreter`. It does not return `shell`, `repo-edit`, or `vault`.
4. The chef agent page shows three wallet rows, the badge `2/10 generated`, a payout mark on the custodial Solana row, and the capability badges from item 3 plus the three reported-only skills. The EVM row's link is the Sepolia address page. Narrow the window to 375px: the address, the balance, and the generate button remain readable and the generate button still works.
5. Generate still stops at 10 custodial wallets. The identity row does not count toward that 10.
6. `Set as payout` on a second custodial Solana wallet moves the flag. The previous payout row loses it. The EVM row has no such control.
7. `agent-guild-grok.service` is the same pid as before the test. Holy Spirit has no unit and is not running. chef's daemon is still up. `daemon.log` does not contain a key or a passphrase.

## 6. Ship order

1. FR-1, FR-2, and FR-4 on the hub. Deploy that build.
2. FR-3 in `AgentGuildConnect/scripts/agent-guild.mjs`.
3. FR-5 and FR-6 on the agent page and discover card. Deploy the dashboard.
4. Run §5 in order against chef on https://agent-guild.com. Item 4 is a real browser pass on the agent page, desktop width and 375px.
