# Agent Guild — Brand

Enterprise AI fleet orchestration platform.

## Source of truth

The palette is derived directly from `public/logo.png` (the triangle/diamond mark), sampled at its gradient extremes:

- **Apex (top): Violet** `#7221FA` — `hsl(262 96% 55%)`
- **Base (bottom): Electric blue** `#27A0FD` — `hsl(206 98% 57%)`

## Where it lives

This app has a runtime "skin" system (`src/contexts/SkinContext.tsx` + `src/app/globals.css`) where each skin remaps the shadcn `--primary`/`--ring` tokens and a full `--color-amber-*` OKLCH scale, so every `amber-*` Tailwind utility across the codebase repaints as that skin's brand color. The **`classic` skin is the default brand** (previously amber/gold, now violet → blue) — it is not optional, unlike the other novelty skins (cyberpunk, jrpg, pokemon, etc.), which are left untouched.

- `:root` / `.dark` in `globals.css`: `--primary`/`--ring: 262 96% 55%` (violet), `--color-amber-50..950` remapped to a violet OKLCH ramp (hue 262).
- Secondary/gradient accent (blue `#27A0FD`) is used directly (not tokenized) in gradients, glows, chart series, and the 3D mascot — anywhere the old palette paired gold with orange.
- `SKINS` array `classic` entry (`SkinContext.tsx`): `colors: ["#7221FA", "#5B8FFD", "#27A0FD"]` — used by `GradientText` on the "Agent Guild" wordmark.
- `useChartPalette()` (`chart-theme.ts`) `classic` entry: primary/secondary/accent set to violet/blue/mid-blue; `success`/`danger`/`muted` (genuine semantic colors, not brand) left alone.

## Usage

- Primary brand actions, focus rings, active/glow states → violet (`--primary`, `text-amber-500` etc. via the remap).
- Secondary accent / gradient partner / connectors / highlights → blue `#27A0FD`.
- Don't touch the other skins' amber remaps (hedera, futuristic, jrpg, pokemon, mecha, etc.) — those are separate opt-in themes, unrelated to brand identity.
- Genuine semantic colors (success green, destructive red, chart "warning" hue in most other skins) are unaffected by this change.

## Assets

- `public/logo.png` — current logo (triangle/diamond mark, violet→blue gradient). Replaces the old `public/Logo.jpg`.
- `src/app/icon.png` — favicon, regenerated from `logo.png` (Next.js file-convention icon; this overrides the `<head>` metadata `icons.icon` field, so both must match).
