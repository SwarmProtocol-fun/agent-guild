
## 2026-10-01 — agent-guild
- Mode: Comprehensive
- Findings: 37 (C: 3, H: 7, M: 14, L: 13)
- New: 37 | Resolved: 0 | Persistent: 0
- Confidence gate: 2/10

## 2026-10-01 — agent-guild (remediation, same day)
- Fixed same-session: C1-C3 (3/3), H4, H6, H7 (3/7), M1-M4/M6-M10/M12-M14 (12/14)
- Needs your decision (not code fixes): H1, H2, H3, H5, M5, M11
- Needs deliberate major-version review (not auto-forced): H6 remainder — AgentGuildConnect/contracts/solana-program's @solana/web3.js + Hardhat bumps
- Verified via: tsc (AgentGuildApp, matches pre-fix baseline), 240/240 vitest, 25/25 hub tests, 9/9 Solana tests against a real deploy, detect_changes() final risk: low, 0 affected processes
