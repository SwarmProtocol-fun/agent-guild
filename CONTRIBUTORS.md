# Contributors

This ledger tracks all Agent Guild contributors and their tier status within the
DAO hierarchy. Contribution weights are recalculated quarterly by the Core Team.

---

## Tier 0 — Sovereign

| Contributor | Role | Since |
|-------------|------|-------|
| EcosystemNetwork | Founder / Project Lead | April 2026 |

## Tier 1 — Council

| Member | Representing | Since |
|--------|-------------|-------|
| _[Nephilim VC Representative]_ | Nephilim Venture Capital | April 2026 |

## Tier 2 — Architects

| Contributor | Focus Area | Since |
|-------------|-----------|-------|
| EcosystemNetwork | Full stack / Architecture | April 2026 |

## Tier 3 — Guardians

| Contributor | Focus Area | Since | Weight Multiplier |
|-------------|-----------|-------|-------------------|
| _None yet_ | — | — | 1.5x |

## Tier 4 — Builders

| Contributor | Merged PRs | Since | Weight Multiplier |
|-------------|-----------|-------|-------------------|
| _None yet_ | — | — | 1.0x |

## Tier 5 — Initiates

| Contributor | Joined | Probation Ends | Weight Multiplier |
|-------------|--------|----------------|-------------------|
| _None yet_ | — | — | 0.5x |

---

## Contribution Weight Calculation

Contribution weight determines each contributor's share of the 33% Community
allocation. It is calculated as:

```
weight = (merged_prs * 3) + (issues_triaged * 1) + (reviews * 2) + (docs_pages * 1)
effective_weight = weight * tier_multiplier
share = effective_weight / sum(all_effective_weights)
```

Weights are recalculated quarterly and published here. Disputes may be raised
to the Architects (Tier 2) for review.

**Last recalculation:** _Not yet performed_
**Next recalculation:** _Q3 2026_

---

_This ledger is maintained by the Core Team and is part of the Agent Guild project
governance structure._
