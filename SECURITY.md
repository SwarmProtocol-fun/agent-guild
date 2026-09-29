# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |
| < Latest | Case-by-case |

---

## Reporting a Vulnerability

**DO NOT open a public GitHub issue for security vulnerabilities.**

### Responsible Disclosure Process

1. Email: **ecosystemnetworkbayarea@gmail.com**
   - Subject line: `[SECURITY] Brief description`
2. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact assessment
   - Suggested fix (if any)
3. You will receive an acknowledgment within **48 hours**
4. The team will provide a timeline for resolution within **7 days**
5. You will be credited (unless you request anonymity) once the fix is released

### What to Expect

- We take all reports seriously and will investigate promptly
- We will not pursue legal action against researchers who follow this process
- We will credit researchers in the release notes and CONTRIBUTORS.md

---

## Bounty Program

The Agent Guild project allocates **1% of all project proceeds** to the Security
Bounty Reserve, as defined in the LICENSE and GOVERNANCE.md.

### Bounty Tiers

| Severity | Description | Bounty Range |
|----------|-------------|--------------|
| **Critical** | Remote code execution, key/credential exposure, full system compromise | $5,000 — $50,000 |
| **High** | Authentication bypass, privilege escalation, significant data exposure | $2,000 — $10,000 |
| **Medium** | Cross-site scripting, injection attacks, logic flaws with limited impact | $500 — $2,000 |
| **Low** | Information disclosure, denial of service, minor misconfigurations | $100 — $500 |
| **Informational** | Best practice violations, hardening suggestions | Recognition + swag |

Bounty amounts scale with the Security Bounty Reserve balance. The ranges
above are targets — actual payouts are determined by the Core Team (Tier 2+)
based on severity, impact, and quality of the report.

### Eligibility

- You must follow the responsible disclosure process above
- The vulnerability must be in Agent Guild project code (not third-party dependencies)
- The vulnerability must not already be known or reported
- You must not exploit the vulnerability beyond what is necessary to demonstrate it
- You must not violate the privacy of users or disrupt production systems
- Participants in the DAO at Tier 3 (Guardian) and above are eligible but
  payouts may be adjusted to avoid conflicts of interest

### Scope

**In scope:**
- All code in the Agent Guild repository (excluding vendored/node_modules)
- Smart contracts and blockchain integrations
- API endpoints and authentication systems
- Data storage and encryption implementations
- Infrastructure-as-code configurations

**Out of scope:**
- Third-party dependencies (report upstream, notify us)
- Social engineering attacks
- Physical security
- Denial of service via brute force / volumetric attacks
- Issues in development/staging environments only

---

## Security Practices

### For Contributors

- Never commit secrets, API keys, or credentials
- Use environment variables for sensitive configuration
- Follow the principle of least privilege in all code
- Validate all inputs at system boundaries
- Keep dependencies updated and audit regularly

### For the Core Team

- Review all PRs for security implications
- Run automated security scanning on all merges
- Conduct quarterly security reviews
- Maintain an incident response plan
- Publish security advisories for resolved vulnerabilities

---

## Past Advisories

_No security advisories have been issued to date._

---

## Contact

Security team: **ecosystemnetworkbayarea@gmail.com**

For non-security issues, use GitHub Issues.

---

_This policy is part of the Agent Guild project and is subject to the terms of
the Agent Guild Open Source License v1.0._
