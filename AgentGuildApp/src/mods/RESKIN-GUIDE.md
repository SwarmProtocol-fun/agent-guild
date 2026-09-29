# Building a Custom Reskin Mod for Swarm

This guide walks you through creating a full-platform reskin mod that changes the entire Swarm dashboard appearance — colors, fonts, layout chrome, labels, and effects. You can sell your reskin on the Swarm Marketplace.

## Overview

A reskin mod can range from a simple CSS-only color swap to a complete layout overhaul with custom components. The Swarm skin system supports both:

| Level | What it changes | Complexity |
|-------|----------------|------------|
| **CSS-only skin** | Colors, fonts, borders, effects, backgrounds | Low — just CSS |
| **CSS + layout override** | Everything above + sidebar, header, background components | Medium |
| **Full reskin mod** | Everything above + label remapping, custom widgets, cursor | High |

**Reference implementation**: The JRPG Fantasy mod (`src/mods/jrpg-fantasy/`) is a full reskin mod you can use as a template.

---

## Step 1: Register Your Skin

### 1a. Add to the Skin Registry

Edit `src/contexts/SkinContext.tsx` — add your skin to the `SKINS` array:

```typescript
{
  id: "your-skin-id",           // Unique ID (lowercase, hyphens)
  name: "Your Skin Name",       // Display name
  description: "Short description of the visual style",
  colors: ["#primary", "#secondary", "#accent"],  // 3-color tuple for previews
  marketId: "skin-your-skin-id", // Must match SKILL_REGISTRY entry
  builtin: false,                // false = requires marketplace install
}
```

> **Tip**: Set `builtin: true` during development so you can test without installing. Change to `false` before publishing.

### 1b. Add to the Marketplace Registry

Edit `src/lib/skills.ts` — add to `SKILL_REGISTRY`:

```typescript
{
  id: "skin-your-skin-id",      // Must start with "skin-"
  name: "Your Skin Name",
  description: "Full marketplace description...",
  type: "skin",
  source: "community",          // "community" for third-party mods
  category: "Themes",
  icon: "🎨",                   // Emoji icon
  version: "1.0.0",
  author: "Your Name",
  tags: ["skin", "theme", "your-tags"],
  pricing: { model: "free" },   // or "purchase" / "subscription"
}
```

### 1c. Add Chart Palette

Edit `src/components/charts/chart-theme.ts` — add to `SKIN_PALETTES`:

```typescript
"your-skin-id": {
  primary: "#your-primary",
  secondary: "#your-secondary",
  accent: "#your-accent",
  success: "#00ff00",
  warning: "#ffaa00",
  danger: "#ff0000",
  muted: "#666666",
  grid: "rgba(r, g, b, 0.06)",
  tooltip: { bg: "rgba(0,0,0,0.9)", border: "rgba(r,g,b,0.3)", text: "#ffffff" },
  task: { done: "#green", inProgress: "#yellow", todo: "#gray" },
  agent: { online: "#green", busy: "#yellow", offline: "#gray" },
},
```

---

## Step 2: Write the CSS Skin Block

Add your skin's CSS to `src/app/globals.css`. The skin class `.skin-{id}` is applied to the `<html>` root when your skin is active.

### Required CSS Variables

```css
/* ═══════════════════════════════════
   SKIN: Your Skin Name
   ═══════════════════════════════════ */

.skin-your-skin-id {
  /* Core Tailwind theme variables */
  --primary: H S% L%;            /* HSL values (no hsl() wrapper) */
  --ring: H S% L%;               /* Focus ring color */
  --spotlight-color: rgba(r,g,b,0.06); /* SpotlightCard hover effect */

  /* Remap the amber color scale (Tailwind v4 oklch format) */
  --color-amber-50:  oklch(97% 0.04 HUE);
  --color-amber-100: oklch(93% 0.08 HUE);
  --color-amber-200: oklch(88% 0.12 HUE);
  --color-amber-300: oklch(82% 0.14 HUE);
  --color-amber-400: oklch(78% 0.16 HUE);
  --color-amber-500: oklch(75% 0.15 HUE);
  --color-amber-600: oklch(65% 0.13 HUE);
  --color-amber-700: oklch(55% 0.11 HUE);
  --color-amber-800: oklch(45% 0.09 HUE);
  --color-amber-900: oklch(38% 0.07 HUE);
  --color-amber-950: oklch(25% 0.05 HUE);
}

/* Dark mode overrides */
.skin-your-skin-id.dark {
  --primary: H S% L%;
  --ring: H S% L%;
  --background: H S% L%;        /* Page background */
  --card: H S% L%;              /* Card background */
  --border: H S% L%;            /* Border color */
}
```

### Override Categories

Each skin should override these CSS classes (see existing skins for patterns):

| Category | CSS Classes | Purpose |
|----------|-------------|---------|
| Body background | `.skin-X body` | Page background gradient/image |
| Ambient orbs | `.skin-X body::before/::after` | Floating gradient orbs (or `display:none` to suppress) |
| Text glow | `.skin-X .text-glow`, `.text-glow-gold`, `.text-glow-amber` | Text shadow effects |
| Neon glow | `.skin-X .neon-glow-gold` | Box shadow glow effects |
| Border glow | `.skin-X .border-glow-gold` | Glowing borders |
| Glass cards | `.skin-X .glass-card`, `.glass-card-enhanced` | Card backgrounds and hover effects |
| Gradient spin | `.skin-X .gradient-border-spin::before` | Animated border gradients |
| Scan line | `.skin-X .scan-line-overlay` | Horizontal scanning effect |
| Button glow | `.skin-X .btn-glow` | Button hover/after effects |
| Badge neon | `.skin-X .badge-neon-amber` | Badge styling |
| Node execution | `.skin-X .node-execution-running::before` | Workflow node animation |
| React Flow | `.skin-X .react-flow`, `.react-flow__connection-line` | Graph editor colors |
| Pulse animations | `.skin-X .animate-pulse-glow`, `.animate-icon-pulse`, `.animate-glow-pulse` | Keyframe animations |
| Accent overrides | `.skin-X .bg-amber-500`, `.text-amber-500`, `.border-amber-500` | Direct color overrides |

---

## Step 3: Custom Layout Components (Optional — Full Reskin)

If you want to go beyond CSS and replace the sidebar, header, or background with custom components:

### 3a. Create Your Components

Create a directory for your mod's components:

```
src/components/your-skin/
├── your-sidebar.tsx       ← Custom sidebar
├── your-header.tsx        ← Custom header bar
├── your-background.tsx    ← Custom background
├── index.ts               ← Barrel exports
└── your-dialog-box.tsx    ← Optional reusable widgets
```

**Sidebar**: Import `DEFAULT_SECTIONS` and `PINNED_ITEMS` from `src/components/sidebar.tsx` to get navigation data, then render with your own styling. See `jrpg-sidebar.tsx` as a template.

**Header**: Use the same hooks as the standard header (`useOrg`, `useSession`, `useSkin`, `useThirdwebAuth`). See `jrpg-header.tsx` as a template.

**Background**: Replaces `DashboardBackground`. Can be anything from a static gradient to animated canvas.

### 3b. Register in DashboardShell

Edit `src/components/dashboard-shell.tsx` to add your skin's layout:

```typescript
// Add dynamic imports for your components
const YourSidebar = dynamic(
  () => import("@/components/your-skin/your-sidebar").then((m) => ({ default: m.YourSidebar })),
  { ssr: false }
);
const YourHeader = dynamic(
  () => import("@/components/your-skin/your-header").then((m) => ({ default: m.YourHeader })),
  { ssr: false }
);
const YourBackground = dynamic(
  () => import("@/components/your-skin/your-background").then((m) => ({ default: m.YourBackground })),
  { ssr: false }
);

// In the DashboardShell component:
const isYourSkin = skin === "your-skin-id";

// Render conditionally:
{isYourSkin ? <YourBackground /> : /* existing */ }
{isYourSkin ? <YourHeader /> : /* existing */ }
{isYourSkin ? <YourSidebar /> : /* existing */ }
```

> **Important**: Use `dynamic()` with `{ ssr: false }` so your components are code-split and only loaded when your skin is active. This prevents any performance impact for users with other skins.

---

## Step 4: Label Remapping (Optional — Full Reskin)

If you want to rename UI labels (e.g., "Fleet" → "Squad", "Marketplace" → "Bazaar"):

### 4a. Create a Label Context

Create `src/contexts/YourSkinContext.tsx`:

```typescript
"use client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useSkin } from "@/contexts/SkinContext";

const YOUR_LABELS: Record<string, string> = {
  // Sidebar sections
  "Command": "Your Section Name",
  "Deploy": "Your Section Name",
  // Sidebar items
  "Dashboard": "Your Label",
  "Fleet": "Your Label",
  // ...add as many as you want
};

interface YourSkinContextValue {
  isActive: boolean;
  label: (key: string) => string;
}

const YourSkinContext = createContext<YourSkinContextValue>({
  isActive: false,
  label: (key) => key,
});

export function YourSkinProvider({ children }: { children: ReactNode }) {
  const { skin } = useSkin();
  const isActive = skin === "your-skin-id";
  const value = useMemo(() => ({
    isActive,
    label: (key: string) => (isActive ? YOUR_LABELS[key] ?? key : key),
  }), [isActive]);

  return (
    <YourSkinContext.Provider value={value}>
      {children}
    </YourSkinContext.Provider>
  );
}

export function useYourSkin() {
  return useContext(YourSkinContext);
}
```

### 4b. Wire Into Root Layout

Add your provider in `src/app/layout.tsx` inside the `<SkinProvider>`:

```tsx
<SkinProvider>
  <JrpgProvider>
    <YourSkinProvider>
      {/* ... */}
    </YourSkinProvider>
  </JrpgProvider>
</SkinProvider>
```

### 4c. Use in Components

In your custom sidebar/header, call `useYourSkin().label("Fleet")` to get remapped labels.

---

## Step 5: Custom Assets (Optional)

### Custom Cursor

Place a 16×16 or 24×24 PNG in `public/`:

```css
.skin-your-skin-id * {
  cursor: url('/your-cursor.png'), auto !important;
}
```

### Custom Fonts

Load fonts conditionally so they only download when your skin is active:

```css
@font-face {
  font-family: 'Your Font';
  font-display: swap;
  src: url('https://fonts.gstatic.com/...') format('woff2');
}

.skin-your-skin-id body {
  font-family: 'Your Font', sans-serif;
}
```

---

## Step 6: Publish to Marketplace

### 6a. Set `builtin: false`

In `SkinContext.tsx`, change your skin entry to `builtin: false` so it requires installation.

### 6b. Publish via API

Use the publisher page at `/market/publisher` or call the API directly:

```bash
curl -X POST /api/v1/marketplace/publish \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Your Skin Name",
    "type": "skin",
    "description": "...",
    "version": "1.0.0",
    "pricing": { "model": "purchase", "tiers": [{ "plan": "lifetime", "price": 9.99, "currency": "USD" }] }
  }'
```

### 6c. Submission Review

Community submissions go through review stages:
1. **Intake** — Submitted, pending review
2. **Review** — Swarm team reviews for quality and security
3. **Approved** — Live on marketplace
4. **Live** — Available for purchase/installation

---

## File Checklist

For a **complete full reskin mod**, you'll touch these files:

| File | Action | Required? |
|------|--------|-----------|
| `src/contexts/SkinContext.tsx` | Add skin entry to `SKINS` array | Yes |
| `src/lib/skills.ts` | Add entry to `SKILL_REGISTRY` | Yes |
| `src/components/charts/chart-theme.ts` | Add chart palette | Yes |
| `src/app/globals.css` | Add `.skin-{id}` CSS block (~100-300 lines) | Yes |
| `src/contexts/YourContext.tsx` | Label remapping context | Optional |
| `src/app/layout.tsx` | Add context provider | Optional |
| `src/components/your-skin/*.tsx` | Custom sidebar, header, background | Optional |
| `src/components/dashboard-shell.tsx` | Register layout override | Optional |
| `public/your-cursor.png` | Custom cursor asset | Optional |
| `src/mods/your-mod/manifest.json` | Mod metadata for extraction | Recommended |

---

## Tips

- **Start with CSS-only**: Get your colors and effects right before building custom components.
- **Use the existing skin CSS as templates**: Each skin in `globals.css` follows the same ~25 override categories.
- **Test with dark mode**: Swarm is dark-mode-first. Make sure your skin looks great in both modes.
- **Keep fonts small**: Use `font-display: swap` and `@font-face` inside your skin selector so fonts only load when active.
- **Code-split components**: Always use `dynamic()` import in `DashboardShell` so your component code only loads for users with your skin.
- **Don't modify page files**: Keep reskin changes in CSS, context providers, and layout chrome. This makes your mod non-invasive and easy to extract.
- **Test all skins**: After adding your skin, verify the other skins still work correctly by toggling through them in Settings.

## Architecture Reference

```
User selects skin in Settings
       ↓
SkinContext.setSkin("your-id")
       ↓
<html> gets class="skin-your-id"
       ↓
globals.css .skin-your-id rules activate
       ↓
DashboardShell detects skin === "your-id"
       ↓
Loads your custom sidebar/header/background via dynamic()
       ↓
YourContext provides label remapping
```
