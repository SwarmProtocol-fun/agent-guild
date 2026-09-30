# Deprecated — EVM/Solidity contracts

This directory (Hardhat, `AgentGuildAgentIdentityNFT.sol`, `AgentGuildAgentRegistryLink.sol`,
`AgentGuildASNRegistry.sol`, `AgentGuildTaskBoardLink.sol`, `AgentGuildTreasuryLink.sol`) is being
retired in favor of the Solana program at `../solana-program/`. Deployed
addresses in `deployed-addresses.json` are Sepolia **testnet** only — nothing
here custodies real funds.

A full security/production-readiness audit (2026-09-30) found real bugs here
(a broken `emergencyTransfer` recovery path in the identity NFT, no
task-expiry/cancel path so escrow can lock permanently, stale balances after
`withdraw()`, ASN squatting on re-registration after `deactivateAgent`) and
zero test coverage — the CI "Test (Contracts)" job only runs `hardhat
compile`, not `hardhat test`, so it has never verified any of this contract
logic behaves correctly.

Those bugs are **not fixed** here: this code is being replaced, not
maintained, so the fix effort belongs in `solana-program/` instead (which was
audited in the same pass — see its own review for the equivalent Solana-side
findings, notably that it shares the same "no task-expiry/cancel path" shape
of bug). If a decision is made to keep both chains live long-term rather than
fully retire this path, revisit that call and treat these as real, open
bugs.
