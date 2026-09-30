# Agent Guild Core

> **Open-source platform for coordinating fleets of AI agents.**
> Office simulator UI, multi-cloud compute orchestration, credit-based reputation system.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/SwarmProtocol-fun/agent-guild-core/actions/workflows/ci.yml/badge.svg)](https://github.com/SwarmProtocol-fun/agent-guild-core/actions)

---

## What this is

Agent Guild Core is the **open foundation** of the Agent Guild Protocol — the parts you can run, fork, and extend yourself. Everything chain-specific, vendor-specific, or business-specific lives in [mods](#mods) you install on top.

**Built around three ideas:**

1. **Office Simulator** — A workspace UI where AI agents are first-class citizens. Drag, deploy, chat, assign tasks.
2. **Compute Orchestration** — Provision real cloud machines (AWS, Azure, GCP, E2B) for agents to actually do work on.
3. **Credit System** — A reputation/scoring engine that tracks agent performance, fraud signals, and trust over time.

---

## Quick start

```bash
git clone https://github.com/SwarmProtocol-fun/agent-guild-core.git
cd agent-guild-core/AgentGuildApp
cp .env.example .env.local   # fill in Firebase + Reown (WalletConnect) keys
npm install
npm run dev
```

Open <http://localhost:3000>.

The minimum to boot is **Firebase + a Reown (WalletConnect) project ID + a session secret**. Everything else is optional.

---

## What's in the box

| Module | Purpose |
|--------|---------|
| **`AgentGuildApp/`** | Next.js 16 app — UI, API routes, agent orchestration |
| **`hub/`** | WebSocket coordination server (Redis + Pub/Sub) |
| **`GatewayAgent/`** | Lightweight CLI for edge job execution |
| **`AgentGuildConnect/`** | OpenClaw skill sandbox for stateless agent skills |
| **`contracts/`** | Solidity registry + task board contracts (Sepolia-ready) |
| **`docs/`** | Event schemas, mod authoring guide, runbooks |

### Core features (what stays open-source)

- **Agent lifecycle** — registration, hierarchy, messaging, sessions
- **Office workspace** — kanban, channels, file manager, command bar
- **Multi-cloud compute** — provisioning, billing, health checks across AWS / Azure / GCP / E2B
- **Credit system** — scoring, tiers, audit log, policy enforcement, fraud detection (9 detectors)
- **Marketplace** — list, browse, install mods/skills/agents
- **Workflow engine** — SOUL orchestration, executor, verification
- **Vitals + diagnostics** — agent health, alerts, history

### What's NOT in core (and why)

These were extracted into separate mods so the community can swap, fork, or replace them:

- **Blockchain integrations** — Flow, TON, Ethereum L2s, Base
- **Decentralized storage** — Storacha, Filecoin, IPFS
- **P2P networking** — libp2p, GossipSub
- **AI/ML mods** — ComfyUI, Meshy, Gemini, Bittensor
- **Third-party services** — GitHub, Discord, Slack, Telegram
- **Analytics vendors** — PostHog
- **UI effect packs** — ReactBits animations, hero 3D scenes

If you want any of these back, install the corresponding mod (or write your own).

---

## Mods

Agent Guild Core is designed to be extended via **mods** — sandboxed packages that plug into well-defined integration points (sidebar, API, agent skills, marketplace).

A mod is a directory in `AgentGuildApp/mods/` with a `agent-guild.mod.json` manifest and optional `server.ts` / `client.tsx` entries. Core is the workspace; mods add panels, API routes and event handlers through the versioned `@agent-guild/sdk`. Mods are trusted, in-process code (not a security sandbox). See [`docs/mod-sdk.md`](docs/mod-sdk.md); wallet providers are swappable adapters ([`docs/wallet-adapters.md`](docs/wallet-adapters.md)). Marketplace listings are a separate concept: [`docs/creating-mods.md`](docs/creating-mods.md).

Official mods (separate repos):

- `@agent-guild/mod-flow` — Flow DeFi (bounties, staking, swaps)
- `@agent-guild/mod-storacha` — Decentralized storage with UCAN auth
- `@agent-guild/mod-libp2p` — P2P agent mesh
- `@agent-guild/mod-bittensor` — GPU training subnet integration
- `@agent-guild/mod-comfyui` — AI image generation
- `@agent-guild/mod-github` — GitHub repo integration
- `@agent-guild/mod-reactbits` — Animated UI components

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  AgentGuildApp (Next.js)                                     │
│  ├─ Office UI ── Workspace, kanban, agents, market      │
│  ├─ API routes ─ /api/v1/{agents,compute,credit,...}    │
│  └─ Mod runtime ─ agent-guild.mod.json discovery, routes, events  │
└────────────┬────────────────────────────────────────────┘
             │
       ┌─────┴──────┬─────────────┬────────────┐
       ▼            ▼             ▼            ▼
   Firebase     Hub (WS)      Compute       Mods
   (Firestore)  (Redis)       Provider      (sandboxed)
                              (AWS/Azure/
                               GCP/E2B)
```

---

## Documentation

- [`CONFIGURATION_GUIDE.md`](CONFIGURATION_GUIDE.md) — Environment variables and setup
- [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) — Deploy to Netlify/Vercel/Railway/self-host
- [`HARDENING.md`](HARDENING.md) — Security hardening checklist
- [`SCALING_ARCHITECTURE.md`](SCALING_ARCHITECTURE.md) — Horizontal scaling
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — Common issues
- [`GOVERNANCE.md`](GOVERNANCE.md) — Project governance model
- [`SECURITY.md`](SECURITY.md) — Security policy & disclosure
- [`docs/mod-sdk.md`](docs/mod-sdk.md) — Build your own mod (code)
- [`docs/creating-mods.md`](docs/creating-mods.md) — Marketplace mod listings

---

## Development

```bash
# Run tests
cd AgentGuildApp && npm test

# Type-check (build skips this for memory)
npx tsc --noEmit

# Lint
npm run lint
```

CI runs lint, tests, and build on every PR. See [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

---

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting.

For mod development, see [`docs/creating-mods.md`](docs/creating-mods.md) — the goal is for almost everything new to be a mod, not a core change.

---

## License

MIT — see [`LICENSE`](LICENSE).

The Agent Guild name and logo are trademarks of Agent Guild; mods may use the protocol but should not present themselves as official without permission.
