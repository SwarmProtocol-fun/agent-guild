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

## Light mode ("paper")

- Canvas `--background` is a violet-tinted off-white; `--card`/`--popover` are pure white. Surfaces separate by canvas/card contrast and hairline `--border`, not heavy shadows.
- Text is deep violet-ink (`252 33% 11%`); `--muted-foreground` is `250 9% 40%` (passes AA on white and canvas).
- `--primary-foreground` is white in both themes.
- The amber→violet ramp is shifted deeper for 300–500 in `:root` so `text-amber-400/500` (written for dark) stays legible; `.dark` restates the original ramp.
- The tokens are exposed to Tailwind through `@theme inline` in `globals.css` — without it `bg-card`, `text-muted-foreground`, `border-border` etc. generate nothing. The default border color sits in `@layer base` so `border-*` utilities can override it. `src/app/__tests__/theme-tokens.test.ts` guards both.
- In components, use tokens (`text-foreground`, `text-muted-foreground`, `bg-card`, `bg-muted`, `border-border`) rather than `text-white`/`text-gray-400`/`bg-gray-900`/`border-white/10`. `text-white` is for text on saturated fills only. Terminal/log/VNC viewers stay dark in both themes on purpose.

## Usage

- Primary brand actions, focus rings, active/glow states → violet (`--primary`, `text-amber-500` etc. via the remap).
- Secondary accent / gradient partner / connectors / highlights → blue `#27A0FD`.
- Don't touch the other skins' amber remaps (futuristic, jrpg, pokemon, mecha, etc.) — those are separate opt-in themes, unrelated to brand identity.
- Genuine semantic colors (success green, destructive red, chart "warning" hue in most other skins) are unaffected by this change.

## Assets

- `public/logo.png` — current logo (triangle/diamond mark, violet→blue gradient). Replaces the old `public/Logo.jpg`.
- `src/app/icon.png` — favicon, regenerated from `logo.png` (Next.js file-convention icon; this overrides the `<head>` metadata `icons.icon` field, so both must match).
