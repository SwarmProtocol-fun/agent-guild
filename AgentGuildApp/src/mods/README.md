> **Note:** installable runtime mods now live in `AgentGuildApp/mods/` and are documented in [`docs/mod-sdk.md`](../../../docs/mod-sdk.md). This directory holds legacy reskin/theme material.

# Agent Guild Mods

This directory contains all first-party mods organized for eventual extraction into standalone repositories.

## Directory Structure

Each mod lives in its own directory with a consistent structure:

```
src/mods/
├── README.md                    ← This file
├── RESKIN-GUIDE.md              ← How to build a custom reskin/theme mod
├── jrpg-fantasy/                ← Example: JRPG Fantasy full reskin mod
│   ├── README.md                ← Mod-specific docs
│   ├── manifest.json            ← Mod metadata (for marketplace publishing)
│   └── ...                      ← Mod source files
├── gemini/                      ← Future: Extract from src/lib/mods/gemini/
├── nova/                        ← Future: Extract from src/lib/mods/nova/
└── ...
```

## Creating a New Mod

See [RESKIN-GUIDE.md](./RESKIN-GUIDE.md) for a complete walkthrough of building a full-platform reskin mod.

## Mod Types

| Type | Description | Example |
|------|-------------|---------|
| `skin` | CSS-only theme (colors, fonts, effects) | Cyberpunk, Midnight |
| `mod` | Full feature mod with UI components | Gemini Live Agent |
| `plugin` | Lightweight integration | GitHub Tools |
| `skill` | Agent capability | Web Search |

## Extracting to Standalone Repos

Each mod directory is designed to be self-contained. To extract:

1. Copy the mod directory to a new repo
2. Add the shared types from `src/lib/skills.ts` (Skill, MarketPricing, etc.)
3. Publish the mod package
4. Register via the marketplace API (`POST /api/v1/mods/register`)
