# Agent Guild Project Governance

**Effective Date:** April 7, 2026

---

## 1. Overview

Agent Guild is an open-source project with structured ownership and guided development.
This document defines how decisions are made, who holds authority, and how
proceeds from the project are distributed.

---

## 2. Ownership Structure

| Stakeholder               | Share | Role                                      |
|----------------------------|-------|-------------------------------------------|
| Nephilim Venture Capital   | 33%   | Strategic partner, IP co-owner            |
| Core Team                  | 33%   | Lead developers, architecture decisions   |
| Community Contributors     | 33%   | All non-core contributors (pro-rata)      |
| Security Bounty Reserve    |  1%   | Vulnerability rewards and security audits |

These shares apply to:
- Proceeds from any IP Disposition (as defined in LICENSE)
- Revenue distributions, if and when the project generates revenue
- Voting weight on major project decisions

---

## 3. DAO Hierarchy & Ranking System

The Agent Guild DAO operates under a tiered hierarchy designed to preserve proper
conduct, reward merit, and maintain operational integrity. The DAO reserves
the right to define, modify, and enforce this ranking system at its sole
discretion.

### 3.1 Hierarchy Tiers

```
Tier 0  ─  Sovereign          Project Lead / Founder
Tier 1  ─  Council            Nephilim VC + Senior Core Team
Tier 2  ─  Architects         Core Team members
Tier 3  ─  Guardians          Trusted long-term contributors
Tier 4  ─  Builders           Active contributors with merged work
Tier 5  ─  Initiates          New contributors (probationary)
```

Each tier carries specific privileges, responsibilities, and conduct
expectations. Movement between tiers is merit-based and subject to review.

### 3.2 Tier Definitions

#### Tier 0 — Sovereign (Project Lead)

The Sovereign has final authority on:
- Technical direction and roadmap
- Release schedules
- All tier promotions and demotions
- Day-to-day merge decisions
- DAO policy and conduct enforcement

**Current Sovereign:** EcosystemNetwork

The Sovereign may delegate authority but retains veto power on any decision
except IP Disposition (which requires the approval process defined in the LICENSE).

#### Tier 1 — Council

The Council consists of Nephilim Venture Capital representatives and Senior
Core Team members elevated by the Sovereign. The Council:
- Advises on strategic direction
- Holds approval rights over IP Disposition
- May propose governance amendments
- Oversees conduct review for Tier 2 and below

#### Tier 2 — Architects (Core Team)

Architects are recognized for sustained, significant contributions.
They have:
- Commit access to the main repository
- Voting rights on governance changes
- A share of the 33% Core Team allocation (divided equally among active
  Architects unless otherwise agreed)
- Authority to review and merge contributions
- Responsibility to mentor lower tiers

**Becoming an Architect:**
- Nominated by a Council member or the Sovereign
- Approved by the Sovereign
- Demonstrated track record of quality contributions over at least 6 months
- No active conduct violations

**Architects (initial):**
- EcosystemNetwork (Sovereign + Architect)

#### Tier 3 — Guardians

Guardians are trusted long-term contributors who have demonstrated consistent
quality and good conduct. They have:
- Priority review on their pull requests
- Eligibility for Core Team nomination
- Increased contribution weight (1.5x multiplier)
- May participate in conduct review panels

**Becoming a Guardian:**
- Minimum 3 months of active contribution
- At least 10 merged pull requests
- No conduct violations
- Nominated by an Architect, approved by the Sovereign

#### Tier 4 — Builders

Builders are active contributors with at least one merged contribution.
They have:
- Standard contribution weight for revenue share
- Ability to open issues, submit PRs, and participate in discussions
- Eligibility for Guardian promotion after sustained contribution

#### Tier 5 — Initiates

New contributors in a probationary period. They have:
- Ability to submit pull requests (subject to review)
- Reduced contribution weight (0.5x multiplier) during probation
- 30-day probationary period before promotion to Builder

Initiates are automatically promoted to Builder after their first merged
contribution and completion of the probation period with no conduct issues.

### 3.3 Conduct & Enforcement

The DAO hierarchy exists to preserve proper conduct. All participants,
regardless of tier, are bound by the following:

**Standards of Conduct:**
- Act in good faith and in the best interest of the project
- Respect the hierarchy and decision-making authority of higher tiers
- Do not misrepresent contributions, credentials, or tier status
- Do not attempt to manipulate contribution metrics
- Disclose conflicts of interest
- Follow responsible disclosure for security issues

**Enforcement Powers:**
- The Sovereign may demote, suspend, or remove any participant at any tier
- The Council may recommend demotions or removals to the Sovereign
- Architects may flag conduct violations for Council review
- Guardians may report concerns to Architects

**Consequences:**
- **Warning** — First minor violation; documented, no tier change
- **Probation** — Repeated minor or first major violation; tier frozen,
  increased review scrutiny for 90 days
- **Demotion** — Serious violation; dropped one or more tiers
- **Removal** — Egregious violation or pattern of misconduct; permanently
  removed from the DAO, forfeiture of unvested contribution weight

**Appeals:**
- Any participant may appeal an enforcement action to the Council
- Council review requires simple majority
- Sovereign's decision on appeal is final

### 3.4 Reserved Rights

The DAO expressly reserves the right to:
- Modify the ranking system, tier definitions, and promotion criteria
- Create new tiers or merge existing ones
- Adjust contribution weight multipliers
- Establish specialized roles within or across tiers
- Define additional conduct standards as the project evolves

These modifications follow the governance amendment process in Section 4.2.

### 3.5 Nephilim Venture Capital

Nephilim Venture Capital holds a 33% stake and permanent Council (Tier 1)
status. Nephilim VC has:
- Approval rights over any IP Disposition
- Advisory input on strategic direction
- Council-level participation in governance
- No unilateral authority over technical decisions

---

## 4. Decision-Making

### 4.1 Technical Decisions

- Day-to-day: Project Lead or delegated Core Team members
- Architecture changes: Core Team consensus (simple majority)
- Project Lead has final say in case of deadlock

### 4.2 Governance Changes

- Requires 2/3 supermajority of the Core Team, AND
- Approval from Nephilim Venture Capital for changes affecting ownership
  or IP terms

### 4.3 IP Disposition

As defined in the LICENSE, any sale or exclusive transfer of IP requires:
- Approval from Nephilim Venture Capital
- 2/3 supermajority of the Core Team
- Compliance with the minimum valuation floor

---

## 5. Revenue & Proceeds

### 5.1 Non-Sale Revenue

Revenue from non-exclusive licensing, SaaS, consulting, support contracts,
or other commercial activities is distributed according to the ownership
percentages above, after deducting operational costs.

### 5.2 IP Disposition Proceeds

Distributed per the LICENSE:
- 33% Nephilim Venture Capital
- 33% Core Team (divided per Core Team agreement)
- 33% Community Contributors (pro-rata by contribution weight)
-  1% Security Bounty Reserve

### 5.3 Security Bounty Reserve

The 1% Security Bounty Reserve funds:
- Bug bounty payouts for responsibly disclosed vulnerabilities
- Security audits by third parties
- Security tooling and infrastructure

The reserve is administered by the Core Team. Bounty amounts are published
in `SECURITY.md`.

---

## 6. Amendments

This governance document may be amended following the process in Section 4.2.
All amendments must be documented with an effective date and rationale.

---

## 7. Dispute Resolution

Disputes between stakeholders that cannot be resolved through the governance
process shall be submitted to binding arbitration under the rules of the
American Arbitration Association (or equivalent in the relevant jurisdiction).

---

_This document is part of the Agent Guild project and is subject to the terms of
the Agent Guild Open Source License v1.0._
