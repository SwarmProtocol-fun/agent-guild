# OpenClaw Office Sim Studio — Business & Packaging PRD

> **Mod ID:** `openclaw-office-sim-studio`
> **Type:** Premium Swarm Marketplace Mod (Tiered)
> **Version:** 0.1.0-draft
> **Date:** 2026-03-24
> **Status:** Draft
> **Companion Doc:** `PRD-OpenClaw-Office-Sim-UX.md` (UX/UI specification)

---

## 1. Positioning

### Positioning Statement

> For AI teams and agent operators who need to monitor, explain, and showcase multi-agent systems, **OpenClaw Office Sim Studio** is a premium Swarm mod that combines real-time 2D/3D office simulation with generative environment design powered by ComfyUI and Meshy. Unlike static dashboards and log viewers, Office Sim Studio makes agent behavior *spatial*, *legible*, and *visually impressive* — turning monitoring into storytelling and operations into identity.

### One-Line Pitch

**"Your agents deserve an office. Your team deserves one that looks like theirs."**

### Category Creation

This product does not compete with dashboards. It creates a new category: **generative agent environments**. The combination of real-time spatial monitoring, a ComfyUI-powered design studio, and a Meshy-powered 3D asset factory does not exist anywhere else in the agent tooling space.

---

## 2. Customer Pain

### What teams struggle with today

| Pain Point | Impact | Who feels it most |
|---|---|---|
| **Agent behavior is invisible** — logs and metrics don't convey *what agents are doing* in a way humans can quickly parse | Slow incident response, poor situational awareness, operator fatigue | Ops, DevOps, SREs |
| **Demos fall flat** — showing a terminal or dashboard to investors/customers is technically accurate but emotionally dead | Failed fundraises, lost deals, underwhelming customer onboarding | Founders, sales engineers, solutions architects |
| **No team identity in tooling** — every monitoring dashboard looks the same; there's no way to make the workspace feel like *yours* | Low tool attachment, easy churn to competitors, no pride-of-ownership | Engineering managers, team leads |
| **Context switching is expensive** — understanding agent relationships requires reading code, configs, and separate dashboards | Longer onboarding for new team members, duplicate debugging effort | Developers, new hires |
| **Post-incident review is manual** — reconstructing "what happened" requires correlating timestamps across multiple log sources | Incomplete post-mortems, repeated incidents, compliance gaps | Ops leads, compliance officers |
| **Static environments can't express brand** — teams building agent products for customers can't customize the monitoring experience to reflect their brand | Missed white-label opportunities, generic customer experience | Platform teams, agencies |

### Why this matters commercially

Teams don't leave monitoring tools because the data is wrong — they leave because the experience is forgettable. **Retention is driven by identity**, and identity requires customization. A team that has designed their office, placed their agents at desks, and branded their environment has invested emotional equity that makes switching costs real.

---

## 3. Value Proposition

### Why pay for this instead of a plain monitoring UI?

| Capability | Free Swarm Dashboard | Office Sim (Base) | Office Sim Studio (Pro) | Studio 3D (Full) |
|---|---|---|---|---|
| Agent status & logs | Yes | Yes | Yes | Yes |
| Spatial agent visualization (2D) | No | Yes | Yes | Yes |
| 3D immersive office | No | Basic (preset themes) | Custom (ComfyUI-designed) | Full (custom 3D assets) |
| Replay & time-travel | No | 1-hour window | Unlimited, exportable | Unlimited, exportable |
| Demo mode | No | Yes | Yes + branded | Yes + branded |
| Generative concept design (ComfyUI) | No | No | Yes | Yes |
| 3D asset generation (Meshy) | No | No | No | Yes |
| Custom themes & branding | No | Limited presets | Full 2D generative control | Full 2D + 3D generative |
| Team collaboration features | No | Basic (shared view) | Multi-cursor, annotations | Multi-cursor, annotations |
| Compliance & audit trail | No | No | No | Enterprise add-on |

### The compounding value loop

```
Install mod → Agents appear in office → Team customizes layout
     ↓                                          ↓
 See agents work ← ← ← ← ← ← ← ← ←  Design custom environment
     ↓                                          ↓
 Show to stakeholders → "Wow" moment → Generate branded assets
     ↓                                          ↓
 Deepen investment → Upgrade tier → More generations → Deeper identity
```

---

## 4. Why Generative Environments Matter

### Retention

| Mechanism | How generative environments drive it |
|---|---|
| **Sunk-cost attachment** | A team that has generated 50 custom props, 3 office themes, and branded avatar portraits has invested hours of creative work. This is not exportable to Datadog |
| **Social proof loops** | Generated environments are shareable. Teams post screenshots, demo videos, and office tours — each one is free marketing for Swarm and the mod |
| **Progressive discovery** | ComfyUI workflows can be versioned and shared. Teams discover new generation techniques over time, keeping the mod fresh months after install |
| **Personalization = ownership** | A generic dashboard belongs to the vendor. A generated, customized office belongs to the team |

### Demo Appeal

| Scenario | Plain Dashboard | Office Sim Studio |
|---|---|---|
| **Investor demo** | "Here's our Grafana. These lines go up." | 8 agents visibly collaborating in a branded cyberpunk office, camera tracking the lead agent as it completes a PR review |
| **Customer onboarding** | "Here's your API key and a Postman collection." | Customer sees their agents in a co-branded office space with their logo, colors, and generated environment assets |
| **Conference talk** | Slides with screenshots | Live 3D office replay of a real multi-agent workflow, narrated in real-time |
| **Team standup** | "Agent-03 errored at 3am, here's the log" | Replay showing Agent-03 walk to the error bay, slump over, retry three times, then recover — in 15 seconds |

### Team Identity

Generative environments create **visual fingerprints** for teams:

- A fintech team generates a Wall Street trading floor with ticker boards and marble desks
- A gamedev team generates a pixel-art dungeon where agents explore rooms
- An AI safety team generates a clean lab environment with containment zones
- A startup generates a cozy cabin office with warm lighting and wood textures

**These environments become part of the team's culture.** They show up in Slack screenshots, investor decks, conference talks, and job postings. The mod becomes inseparable from the team's identity.

---

## 5. Product Split: ComfyUI as Design Brain, Meshy as 3D Factory

The two generative engines serve distinct roles in the creative pipeline. This separation is intentional: it matches how real creative teams work (concept → production) and keeps each tool focused on what it does best.

### ComfyUI — "The Design Brain"

ComfyUI is a node-based, workflow-driven image generation tool built on Stable Diffusion. It runs locally or on self-hosted infrastructure, giving teams full control over their generation pipeline.

**Role in Office Sim Studio:**

| Asset Type | ComfyUI Workflow | Output |
|---|---|---|
| **Office themes/moodboards** | Style reference → ControlNet → tiled texture | Color palette, material references, lighting direction |
| **Avatar portraits** | Character description → face model → style transfer | Deterministic agent portraits (consistent across regeneration) |
| **Iconography** | Icon prompt → pixel-art LoRA → batch generation | Skill icons, status badges, department logos |
| **Overlays & HUD elements** | UI element prompt → transparency → compositing | Glass panels, holographic overlays, speech bubble skins |
| **Shader references** | Material description → PBR reference generation | Input for 3D materials (roughness, normal, albedo maps) |
| **Animated billboards** | Frame sequence → AnimateDiff → sprite sheet | In-office animated posters, news tickers, achievement walls |
| **Environment concepts** | Room description → architectural ControlNet → composition | Concept art for approval before Meshy 3D generation |

**Why ComfyUI for this role:**
- **Workflow-driven**: Saved as JSON graphs, version-controlled, sharable between teams
- **Deterministic**: Same seed + workflow = same output, critical for brand consistency
- **Local/open**: No API costs for iteration; teams own their generation infrastructure
- **Extensible**: Custom nodes for Swarm-specific workflows (e.g., "generate avatar from agent config")
- **Batch-capable**: Generate hundreds of assets in a single run (icon sets, texture atlases)

### Meshy — "The 3D Factory"

Meshy is a cloud API for text-to-3D, image-to-3D, and model post-processing. It takes concepts (text descriptions or images from ComfyUI) and produces production-ready 3D assets.

**Role in Office Sim Studio:**

| Asset Type | Meshy API | Workflow |
|---|---|---|
| **Office props** | Text-to-3D v2 → preview → refine | "minimalist standing desk with dual monitors" → approve preview → refine to production mesh |
| **Room kits** | Text-to-3D (batch) → remesh → export | Generate 10 furniture pieces for "zen garden meeting room" → remesh to quad topology → export as GLB |
| **Agent avatars (3D)** | Image-to-3D (from ComfyUI portrait) → rig → animate | ComfyUI portrait → Meshy image-to-3D → auto-rig bipedal → apply walk/sit/type animations |
| **Mascots & decorations** | Text-to-3D → refine → remesh | "cyberpunk rubber duck mascot" → approve → refine → place on desk |
| **Themed environment pieces** | Text-to-3D (batch) | Generate all props for "space station" theme: control panels, airlocks, floating monitors |
| **Department zones** | Text-to-3D → scene assembly | Engineering: server racks, cables. Sales: presentation screens, trophy case |

**Why Meshy for this role:**
- **Preview → Refine flow**: Low-cost preview (20 credits) for geometry approval, refine (10 credits) only for approved assets — cost control built in
- **Multi-format export**: GLB, FBX, OBJ, USDZ, Blend, STL — covers all target engines
- **Remesh API**: Control polygon count (100–300K), quad or triangle topology, auto-sizing
- **Rigging & Animation API**: Auto-rig humanoid models and apply animation presets
- **API-first**: Integrates directly into the mod's asset pipeline via REST + polling/SSE
- **Retexture API**: Apply new materials/textures to existing models (theme switching without regeneration)

### The Pipeline

```
Team describes desired environment
        ↓
ComfyUI generates concept art, moodboard, color palette (5 workflow types)
        ↓
Team reviews concept board — approve, refine, or dismiss each image
        ↓
ComfyUI generates detailed assets: textures, icons, avatar portraits, PBR maps
        ↓
Meshy Text-to-3D generates prop previews from approved descriptions (20 credits)
        ↓
Team reviews 3D previews in Asset Approval Drawer — rotate, inspect, decide
        ↓
Approved props → Meshy Refine → production-quality textured meshes (10 credits)
        ↓
Meshy Remesh → optimized for web (target polycount, quad topology)
        ↓
Meshy Rigging → humanoid agents get bipedal rigs + animation presets
        ↓
Assets load into Office Sim 3D scene via React Three Fiber useGLTF
        ↓
Team arranges via Studio Placement Mode — drag to slot, transform, save
        ↓
Saved as named "Office Theme" → optionally published to Swarm marketplace
```

### Approval gates at every stage

1. **Concept approval** — ComfyUI concept board reviewed before production generation
2. **3D preview approval** — Meshy previews reviewed in Asset Approval Drawer before expensive refine
3. **Scene approval** — Assembled environment reviewed before saving as theme
4. **Publish approval** — If sharing to marketplace, reviewed by Swarm moderation pipeline

---

## 6. Packaging

### Tier 1: Office Sim Base

**Mod ID:** `openclaw-office-sim`
**Price:** Free

| Feature | Included |
|---|---|
| 2D Office view with 6 spatial zones (desk row, meeting room, queue, error bay, tool station, approval gate) | Yes |
| 5 preset office themes (default dark, cyberpunk, minimal, retro pixel, zen) | Yes |
| Agent Detail Drawer with status, task, activity, actions | Yes |
| Real-time WebSocket agent state sync from Swarm Hub | Yes |
| Agent states: idle, active, error, blocked, offline (5 of 10) | Yes |
| Hover, click, right-click, keyboard interactions | Yes |
| Filter by status, search by name | Yes |
| Demo mode (mask sensitive data) | Yes |
| 3D Office view (preset themes only, orbit + follow camera) | Yes |
| 1-hour replay window with play/pause/speed control | Yes |
| Max 10 agents | Yes |
| Home Dashboard with overview cards, agent grid, quick actions | Yes |

**Positioning:** On-ramp. Gets teams into the spatial monitoring paradigm. Free forever for small teams.

---

### Tier 2: Office Sim Studio (Pro)

**Mod ID:** `openclaw-office-sim-studio`
**Price:** $29/seat/month or $290/seat/year

| Feature | Included |
|---|---|
| Everything in Base | Yes |
| **ComfyUI integration** — local or cloud-hosted generative design workflows | Yes |
| Studio Dashboard with current theme preview, asset library, connection status | Yes |
| Concept Generator — 5 workflow types (office-theme, avatar-portrait, scene-style, vfx-concept, texture-sheet) | Yes |
| Concept Board with approve/refine/dismiss per image | Yes |
| Saved workflow library (version-controlled generation recipes) | Yes |
| Style presets (cyberpunk, minimal, retro, nature, sci-fi, cozy, industrial, vaporwave, gothic) | Yes |
| Avatar portrait generator for agent characters | Yes |
| Icon & badge generator for skills and departments | Yes |
| Overlay/HUD skin generator | Yes |
| Animated billboard generator (AnimateDiff) | Yes |
| Unlimited replay with timeline markers and event filtering | Yes |
| Full 10 agent states with 3D animations | Yes |
| Camera modes: orbit, follow, cinematic, top-down, first-person | Yes |
| Admin panel with layout editor, agent assignment, alert configuration | Yes |
| Multi-agent bulk operations | Yes |
| Unlimited agents | Yes |
| 200 ComfyUI generation credits/month (cloud mode only; self-hosted is unlimited) | Yes |

**Positioning:** The creative tool for teams who want a unique, branded monitoring experience with 2D generative control.

---

### Tier 3: Studio 3D (Full Suite)

**Mod ID:** `openclaw-office-sim-studio-3d`
**Price:** $79/seat/month or $790/seat/year

| Feature | Included |
|---|---|
| Everything in Studio (Pro) | Yes |
| **Meshy Text-to-3D integration** — generate custom 3D props from text prompts | Yes |
| **Meshy Image-to-3D integration** — generate 3D models from ComfyUI concept images | Yes |
| **Meshy Multi-Image-to-3D** — multi-view input for complex props | Yes |
| **Meshy Remesh** — optimize generated models for web (target polycount, topology control) | Yes |
| **Meshy Rigging & Animation** — auto-rig humanoid agents, apply walk/sit/type animations | Yes |
| **Meshy Retexture** — swap materials/skins on existing models without regeneration | Yes |
| Asset Generator UI with category picker, reference image selector, Meshy job queue | Yes |
| Asset Approval Drawer with interactive 3D preview, polygon stats, revision history | Yes |
| Asset Placement Mode with slot system, transform controls, undo/redo | Yes |
| Team asset library (shared 3D props across org) | Yes |
| Custom room kit generator (batch furniture generation per theme) | Yes |
| Agent 3D avatar generator (portrait → 3D model → rig → animate pipeline) | Yes |
| Theme Manager — save, import, export, reset themes | Yes |
| Theme marketplace: publish and sell custom themes to the Swarm community | Yes |
| 500 Meshy generation credits/month | Yes |
| Export scenes as GLB/USDZ for external use | Yes |

**Positioning:** Full creative suite. For teams that want to build, brand, and ship custom 3D agent environments.

---

### Tier 4: Enterprise / Private Deployment

**Mod ID:** `openclaw-office-sim-enterprise`
**Price:** Custom (starting $499/month flat + per-seat)

| Feature | Included |
|---|---|
| Everything in Studio 3D | Yes |
| **Private ComfyUI deployment** — runs on your infrastructure, no data leaves your network | Yes |
| **Private Meshy endpoint** — dedicated API capacity, SLA-backed | Yes |
| SSO / SAML / OIDC integration | Yes |
| Role-based access control (viewer, operator, admin, designer) | Yes |
| Audit trail with compliance export (SOC 2, ISO 27001 evidence packages) | Yes |
| Replay certification (tamper-proof, cryptographically signed playback) | Yes |
| Multi-floor / multi-org view | Yes |
| White-label mode (remove Swarm branding, apply customer brand) | Yes |
| Custom SLA (uptime, response time, generation throughput) | Yes |
| Dedicated success manager | Yes |
| Priority feature requests | Yes |
| Unlimited generation credits (ComfyUI + Meshy) | Yes |
| On-premises deployment option (air-gapped) | Yes |
| API access for programmatic environment generation | Yes |

**Positioning:** For regulated industries, large enterprises, and platform teams building on top of Swarm.

---

## 7. Pricing

### Seat-Based Pricing

| Tier | Monthly/Seat | Annual/Seat (save 17%) | Notes |
|---|---|---|---|
| **Base** | Free | Free | Max 10 agents, preset themes only |
| **Studio Pro** | $29 | $290 | ComfyUI integration, unlimited agents |
| **Studio 3D** | $79 | $790 | Meshy integration, full 3D pipeline |
| **Enterprise** | Custom | Custom | Starting $499/mo flat + $49/seat |

### Workspace Licenses (Alternative)

For teams that prefer per-workspace rather than per-seat:

| Tier | Monthly/Workspace | Includes |
|---|---|---|
| **Team** (up to 10 seats) | $199 | Studio Pro features |
| **Growth** (up to 25 seats) | $499 | Studio 3D features |
| **Scale** (up to 100 seats) | $999 | Studio 3D + priority support |
| **Enterprise** (unlimited) | Custom | Full enterprise features |

### Generation Credits

Credits are consumed when using cloud-hosted ComfyUI or the Meshy API. Self-hosted ComfyUI instances consume zero credits.

| Action | Credits | Notes |
|---|---|---|
| ComfyUI image generation (cloud) | 1 | Per image in concept board |
| ComfyUI AnimateDiff sequence (cloud) | 5 | Per animated billboard |
| Meshy Text-to-3D preview | 20 | Geometry only, Meshy-6 model |
| Meshy Text-to-3D refine (texture) | 10 | Textures approved preview |
| Meshy Image-to-3D (mesh only) | 20 | Meshy-6, no texture |
| Meshy Image-to-3D (with texture) | 30 | Meshy-6, full pipeline |
| Meshy Multi-Image-to-3D | 25 | Multi-view input |
| Meshy Remesh | 5 | Re-topology + format conversion |
| Meshy Rigging & Animation | 10 | Auto-rig + animation presets |
| Meshy Retexture | 10 | Material swap on existing model |

| Credit Pack | Price | Credits | Per-Credit |
|---|---|---|---|
| Included in Studio Pro | $0 | 200/mo | — |
| Included in Studio 3D | $0 | 700/mo | — |
| Top-Up Small | $19 | 500 | $0.038 |
| Top-Up Medium | $49 | 1,500 | $0.033 |
| Top-Up Large | $99 | 4,000 | $0.025 |
| Enterprise | Custom | Unlimited | — |

Credits roll over for 90 days. Unused credits after 90 days expire.

### Premium Scene Packs (One-Time Purchase)

Pre-designed, high-quality office themes with matched 3D assets. Available at any paid tier.

| Pack | Price | Contents |
|---|---|---|
| **Cyberpunk Neon** | $14.99 | Full 3D office theme, 20+ props, neon lighting profiles, holographic overlays |
| **Zen Garden** | $14.99 | Japanese garden office, bamboo desks, water features, stone floors, ambient audio config |
| **Space Station** | $19.99 | Zero-G office, floating monitors, airlocks, planetary viewport, animated star field |
| **Pixel Retro** | $9.99 | 8-bit pixel art office, CRT monitors, chiptune-ready, lo-fi props |
| **Corporate Clean** | $9.99 | Professional office, glass walls, conference rooms, minimal palette |
| **Dungeon Ops** | $14.99 | Fantasy dungeon, stone desks, torch lighting, treasure chest error bay |
| **Seasonal Bundle** (4 packs) | $29.99 | Spring garden, summer beach, autumn forest, winter cabin |

### Branded/Custom Environments (Service)

| Service | Price | Deliverable |
|---|---|---|
| **Custom theme design** | $499 one-time | Brand-matched office theme with 30+ props, approved by customer |
| **Custom avatar set** | $199 one-time | 20 branded agent avatars matching customer style guide |
| **Full white-label environment** | $2,499 one-time | Complete custom office, avatars, icons, overlays, branded replay |
| **Ongoing design retainer** | $299/month | 5 new asset batches/month, seasonal refreshes, priority requests |

---

## 8. Licensing

### License Types

| License | Scope | Generated Assets | Modification |
|---|---|---|---|
| **Base (Free)** | Individual/team use | N/A (no generation) | Preset themes only |
| **Studio Pro** | Per-user, one org | ComfyUI outputs owned by customer, unrestricted use | Full modification of generated 2D assets |
| **Studio 3D** | Per-user, one org | ComfyUI + Meshy outputs owned by customer, exportable | Full modification, re-export, external use |
| **Enterprise** | Org-wide, custom terms | Full IP ownership of all generated assets | Unrestricted, including sublicensing |

### Generated Asset Ownership

- **ComfyUI outputs**: Customer owns all generated images, textures, sprites, and concept art. No usage restrictions. Self-hosted generation means outputs never touch Swarm infrastructure.
- **Meshy outputs**: Customer owns generated 3D models per Meshy's commercial license terms. Models can be exported (GLB, FBX, OBJ, USDZ, Blend, STL) and used outside Office Sim Studio.
- **Preset theme assets** (included in base/packs): Licensed for use within Office Sim Studio only. Not exportable for other projects.
- **Scene pack assets**: Licensed for use within Office Sim Studio and customer presentations. Not resalable.
- **Custom service deliverables**: Full IP transfer upon payment completion.

### Open Source Components

| Component | License | Our Usage |
|---|---|---|
| ComfyUI | GPL-3.0 | Integration via REST API / WebSocket, not linked |
| Stable Diffusion models | CreativeML Open RAIL-M | Used for generation, outputs owned by user |
| React Three Fiber | MIT | Direct dependency |
| Three.js | MIT | Transitive dependency |
| Zustand | MIT | State management |

---

## 9. Deployment Models

### Model A: Local Everything (Solo Dev / Small Team)

```
┌───────────────────────────────────────┐
│          User's Machine / VPS          │
│                                        │
│  ┌──────────────┐  ┌───────────────┐  │
│  │  Swarm Hub   │  │  Office Sim   │  │
│  │  (agents)    │──│  (Next.js)    │  │
│  └──────────────┘  └───────┬───────┘  │
│                            │           │
│  ┌──────────────┐          │           │
│  │  ComfyUI     │──────────┘           │
│  │  (local GPU) │                      │
│  └──────────────┘                      │
│                                        │
│  Meshy API ← ← cloud calls → →        │
└───────────────────────────────────────┘
```

- ComfyUI runs locally on the user's GPU — zero credit cost for 2D generation
- Meshy calls go to cloud API (credits consumed per the schedule above)
- Best for: solo developers, small teams with GPU-equipped machines
- Latency: ComfyUI ~5–30s per image (local), Meshy ~30–120s per 3D model (cloud)

### Model B: Cloud / Self-Hosted Hybrid (Growth Team)

```
┌────────────────────┐     ┌─────────────────────┐
│   Team Machines     │     │   Cloud / VPS        │
│                     │     │                      │
│  Browser → Office  ─┼────▶│  Swarm Hub (hosted)  │
│            Sim UI   │     │  ComfyUI (GPU VPS)   │
│                     │     │  Office Sim (Netlify) │
└────────────────────┘     │                      │
                            │  Meshy API → → →     │
                            └─────────────────────┘
```

- Swarm Hub and Office Sim deployed to cloud (Netlify or VPS)
- ComfyUI on a dedicated GPU VPS (RunPod, Lambda, vast.ai) — runs headless, triggered by Studio API routes
- Meshy API called from server-side (API key secured, never exposed to client)
- Best for: distributed teams, CI/CD-integrated environments

### Model C: Private Enterprise (Air-Gapped Option)

```
┌─────────────────────────────────────────────────┐
│              Customer's Private Cloud             │
│                                                   │
│  ┌────────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ Swarm Hub  │  │ Office   │  │ ComfyUI      │ │
│  │ (private)  │──│ Sim      │──│ (private GPU)│ │
│  └────────────┘  └────┬─────┘  └──────────────┘ │
│                       │                           │
│  ┌────────────────────┴─────────────────────┐    │
│  │  Meshy Enterprise API (dedicated endpoint)│    │
│  │  OR self-hosted 3D pipeline               │    │
│  └──────────────────────────────────────────┘    │
│                                                   │
│  SSO ← Okta / Azure AD / Auth0                   │
│  Audit → compliance export, replay certification  │
└─────────────────────────────────────────────────┘
```

- Everything runs within the customer's network perimeter
- No data leaves — critical for regulated industries (finance, healthcare, defense)
- Meshy enterprise endpoint with dedicated capacity, or customer provides their own 3D pipeline
- SSO integration via SAML/OIDC
- Best for: enterprises with strict data governance requirements

### Model D: Swarm Cloud Managed (Future)

```
┌───────────────┐     ┌──────────────────────────┐
│  Browser       │────▶│  swarmprotocol.fun           │
│                │     │                            │
│                │     │  Swarm Hub (managed)       │
│                │     │  Office Sim (managed)      │
│                │     │  ComfyUI (managed GPU)     │
│                │     │  Meshy API (pooled credits) │
└───────────────┘     └──────────────────────────┘
```

- Fully managed SaaS — zero infrastructure management
- Teams sign up, install mod, start generating
- Best for: teams who want instant setup with no DevOps overhead
- Revenue model: subscription + credits + scene pack purchases

---

## 10. Marketplace Strategy

### Swarm Marketplace Integration

Office Sim Studio is distributed through the existing Swarm marketplace infrastructure, following established patterns from existing mods (JRPG Fantasy, Pokemon Trainer, Mecha LaunchPad).

**Manifest registration:**

```json
{
  "id": "openclaw-office-sim-studio",
  "name": "OpenClaw Office Sim Studio",
  "version": "1.0.0",
  "type": "mod",
  "author": "Swarm Core",
  "description": "Living 2D/3D office simulation with generative environment design. Monitor agents spatially, design custom offices with ComfyUI, build 3D assets with Meshy.",
  "category": "Monitoring & Visualization",
  "icon": "🏢",
  "pricing": {
    "model": "subscription",
    "tiers": [
      { "plan": "base", "price": 0, "currency": "USD", "interval": "forever" },
      { "plan": "studio-pro", "price": 29, "currency": "USD", "interval": "month" },
      { "plan": "studio-3d", "price": 79, "currency": "USD", "interval": "month" },
      { "plan": "enterprise", "price": null, "currency": "USD", "interval": "custom" }
    ]
  },
  "tags": ["monitoring", "3d", "office", "simulation", "comfyui", "meshy", "generative", "visualization"],
  "features": {
    "spatial_monitoring": true,
    "generative_design": true,
    "3d_asset_generation": true,
    "replay": true,
    "demo_mode": true,
    "layout_override": true,
    "enterprise_sso": true
  },
  "files": {
    "skin_css": "globals-office-sim.css",
    "components": ["office-sim-sidebar.tsx", "office-sim-header.tsx"],
    "context": "OfficeSimContext.tsx"
  },
  "sidebarConfig": {
    "sectionId": "modifications",
    "label": "Office Sim",
    "href": "/office-sim",
    "iconName": "Building2"
  },
  "dependencies": {
    "swarm-hub": ">=1.0.0"
  }
}
```

### SKILL_REGISTRY Entry

```typescript
{
  id: "openclaw-office-sim-studio",
  name: "OpenClaw Office Sim Studio",
  type: "mod",
  source: "verified",
  category: "Monitoring & Visualization",
  icon: "🏢",
  version: "1.0.0",
  author: "Swarm Core",
  pricing: {
    model: "subscription",
    tiers: [
      { plan: "base", price: 0, currency: "USD" },
      { plan: "studio-pro", price: 29, currency: "USD" },
      { plan: "studio-3d", price: 79, currency: "USD" }
    ]
  },
  tags: ["monitoring", "3d", "office", "simulation", "comfyui", "meshy"],
  sidebarConfig: {
    sectionId: "modifications",
    label: "Office Sim",
    href: "/office-sim",
    iconName: "Building2"
  }
}
```

### Marketplace Revenue Sharing

Following the existing Swarm marketplace platform fee structure (15% per `marketplace-settings.ts`):

| Revenue Stream | Platform Fee | Creator Revenue |
|---|---|---|
| Mod subscriptions (first-party) | 100% to Swarm | — |
| Scene pack purchases (first-party) | 100% to Swarm | — |
| Community-created themes | 15% platform fee | 85% to creator |
| Community-created asset packs | 15% platform fee | 85% to creator |
| Credit top-ups | 100% to Swarm (pass-through to Meshy at cost) | — |
| Custom service engagements | 0% (direct) | 100% to provider |

### Community Theme Marketplace

Studio 3D tier users can publish their generated environments as purchasable themes:

1. **Create** — User generates an office theme using ComfyUI + Meshy via Studio mode
2. **Package** — User bundles theme (3D assets, textures, lighting config, concept references) via Theme Manager export
3. **Submit** — Published through `POST /api/v1/marketplace/publish` with type `office-theme`
4. **Review** — Swarm team reviews for quality, performance (max polycount, asset count), and IP compliance via the existing submission pipeline (intake → security scan → tier-based routing)
5. **List** — Approved themes appear in Office Sim's Community Theme Browser and the main marketplace
6. **Purchase** — Other users buy the theme; revenue split 85/15

This creates a **creator economy** within the mod. The same publisher tier system (Tier 0–3) and submission quotas apply.

---

## 11. Proprietary vs Open Components

### What Remains Open in the Ecosystem

| Component | Status | License | Rationale |
|---|---|---|---|
| **2D Office renderer** (SVG/Canvas) | Open source | MIT | Commoditized rendering, benefits from community contributions |
| **WebSocket state protocol** | Open source | MIT | Interoperability with custom frontends and third-party tools |
| **Agent state schema** (10-state vocabulary) | Open source | MIT | Standardization benefits the ecosystem |
| **ComfyUI workflow templates** | Open source | CC-BY-4.0 | Community workflow sharing drives adoption and ComfyUI ecosystem growth |
| **Swarm Hub integration layer** | Open source | MIT | Allows other community mods to integrate with the same agent data |
| **Base office theme** (2D only, 5 presets) | Open source | MIT | Entry point, proves value, drives upgrades |
| **Replay event format** | Open source | MIT | Enables ecosystem tool compatibility and third-party replay viewers |

### What Stays Proprietary in the Premium Mod

| Component | Status | Rationale |
|---|---|---|
| **3D Office renderer** (R3F scene, LOD system, instanced meshes, portal effects) | Proprietary | Core differentiation; significant engineering investment in performance optimization |
| **Generative pipeline orchestrator** (ComfyUI ↔ approval gates ↔ Meshy ↔ asset library ↔ scene assembly) | Proprietary | The "glue" that makes the creative pipeline seamless — this is the product |
| **Studio UI** (concept board, asset generator, placement mode, theme manager) | Proprietary | UX innovation that prevents wasted generation credits through approval gates |
| **Theme packaging system** (bundle, optimize, validate, distribute) | Proprietary | Marketplace enabler, quality control enforcement |
| **Cinematic camera system** (auto-camera with AI attention, first-person WASD, follow-agent) | Proprietary | Demo/storytelling differentiator |
| **Replay certification** (tamper-proof, cryptographically signed event streams) | Proprietary | Enterprise compliance requirement |
| **Multi-floor / multi-org view** | Proprietary | Enterprise architecture feature |
| **White-label mode** | Proprietary | Enterprise customization |
| **SSO / RBAC integration** | Proprietary | Enterprise security requirement |
| **Premium scene packs** (bundled 3D assets, lighting profiles, audio configs) | Proprietary | Monetized content |

### The Strategic Balance

**Open enough to build an ecosystem.** The 2D renderer, state protocol, ComfyUI workflows, and base theme ensure that community contributors can build complementary tools. A healthy open-source layer drives adoption and makes Swarm the standard for spatial agent visualization.

**Proprietary enough to monetize.** The 3D renderer, generative pipeline orchestrator, and Studio UI represent the engineering and design investment that justifies premium pricing. These components are hard to replicate and deeply integrated.

**The moat:** Even if someone open-sources a basic 3D office, the *generative pipeline* (concept → approve → generate → optimize → place → save → publish → sell) is the defensible value. It's not a single feature — it's a system with approval gates, a community marketplace, and a credit economy.

---

## 12. Expansion Opportunities

### Add-On: Industry Theme Packs

Pre-built office environments tailored to specific verticals:

| Industry | Theme | Key Props |
|---|---|---|
| **Finance** | Trading Floor | Ticker boards, Bloomberg terminals, glass offices, trading desk clusters |
| **Healthcare** | Medical Lab | Clean room partitions, patient monitors, specimen stations, surgical lighting |
| **Legal** | Law Firm | Mahogany desks, bookshelves, conference table, evidence boards |
| **Gaming** | Game Studio | Dual-monitor setups, arcade cabinets, motion capture stage, art walls |
| **E-commerce** | Warehouse Ops | Conveyor belts, packing stations, inventory shelves, shipping docks |
| **Education** | University Lab | Lecture podiums, whiteboards, student desks, research stations |
| **Government** | Operations Center | Large displays, situation room, secure terminals, map walls |

**Pricing:** $24.99/pack or $99.99 for full industry bundle.

### Add-On: Enterprise SSO / Admin

Extended enterprise administration sold as a bolt-on to Studio 3D tier:

- SAML / OIDC SSO integration
- Role-based access control (viewer, operator, admin, designer)
- IP allowlisting for Office Sim access
- Audit log export (JSON, CSV, SIEM integration)
- Custom data retention policies
- Multi-tenancy (org isolation)

**Included in Enterprise tier. Available as $99/month add-on for Studio 3D.**

### Add-On: Replay Analytics

Deep analytics on agent behavior over time, derived from replay data:

| Feature | Description |
|---|---|
| Agent productivity heatmaps | Time spent in each state, by agent, over time |
| Error pattern detection | Recurring failure signatures, cascading error identification |
| Collaboration graph | Which agents work together most frequently |
| Cost attribution | Dollar cost per agent per task (inspired by tenacitOS) |
| SLA compliance dashboard | Percentage of time agents spend in healthy states |

**Pricing:** $29/seat/month as a bundle, or $9/seat/month per individual feature.

### Add-On: Compliance Package

For regulated industries that need provable audit trails:

| Feature | Description |
|---|---|
| Tamper-proof replay | Cryptographically signed event streams with chain-of-custody |
| Compliance export | SOC 2, ISO 27001 evidence packages auto-generated from replay data |
| Data residency controls | Configure storage regions (EU, US, APAC) |
| Automated incident reports | Generate post-incident reports from replay sessions |

**Pricing:** $49/seat/month as a bundle, or $19/seat/month per individual feature.

### Add-On: Branded Customer Demo Worlds

For teams building agent products who want to show their customers a branded experience:

| Feature | Price |
|---|---|
| Customer-facing demo environment (white-labeled) | $299/environment (one-time) |
| Dynamic customer branding (logo, colors injected from API) | $99/month |
| Embeddable `<iframe>` widget for customer portals | $49/month |
| Self-service demo builder (customer creates their own view) | $199/month |
| Full demo world bundle | $399/month |

---

## 13. Launch Plan

### Phase 0: Foundation (Weeks 1–4)

**Goal:** Core mod infrastructure and 2D office

| Milestone | Deliverable |
|---|---|
| Mod registration | Manifest in `src/mods/openclaw-office-sim/`, SKILL_REGISTRY entry, SkinContext entry, sidebar routing |
| WebSocket integration | Real-time agent state consumption from Swarm Hub via existing WebSocket protocol |
| 2D Office renderer | SVG/Canvas floor plan with 6 spatial zones (desk row, meeting room, queue, error bay, tool station, approval gate) |
| Agent Detail Drawer | Status, current task, recent activity feed, context-sensitive actions |
| Home Dashboard | Overview cards (active/tasks/errors/cost/uptime), agent status grid, quick actions, activity feed |
| 5 core agent states | Idle, active, error, blocked, offline — with triple-encoded visual semantics |
| Base theme (dark) | Default visual design matching Swarm design system, registered in chart-theme.ts |

**Launch:** Internal alpha. Swarm team and select partners.

### Phase 1: 3D & Replay (Weeks 5–8)

**Goal:** 3D Office view and time-travel replay

| Milestone | Deliverable |
|---|---|
| 3D Office renderer | React Three Fiber scene with instanced desk geometry, agent character models, LOD system |
| Camera modes | Orbit + follow (cinematic and first-person deferred) |
| Speech bubbles | Floating 3D billboards above agents showing streaming text |
| Collaboration lines | Glowing arcs between communicating agents |
| Portal effects | Spawn/despawn animations |
| Replay engine | 1-hour window, timeline scrubber with event markers, play/pause/speed, 2D/3D switchable |
| Demo mode | Mask sensitive data, apply sample labels |
| 4 additional preset themes | Cyberpunk, minimal, retro pixel, zen |

**Launch:** Closed beta. 50 teams, free access, feedback collection.

### Phase 2: ComfyUI Integration — Studio Pro (Weeks 9–14)

**Goal:** Generative design pipeline for 2D assets

| Milestone | Deliverable |
|---|---|
| ComfyUI connection layer | Auto-detect running instance, connect via REST + WebSocket, fallback with setup guide |
| Studio Dashboard | Current theme preview, asset library, ComfyUI/Meshy connection status, credit counter |
| Concept Generator | Prompt input, workflow selector (5 types), concept board with approve/refine/dismiss |
| Style presets | 9 built-in style presets that pre-fill prompts |
| Avatar portrait workflow | Agent config → ComfyUI → deterministic portrait |
| Workflow library | Save, load, share ComfyUI workflow JSONs within team |
| Cloud ComfyUI option | Hosted GPU for teams without local GPU, credit-metered |
| Credit system | Usage tracking, balance display, top-up flow, 90-day rollover |
| Unlimited replay | Remove 1-hour cap, add export as shareable link |
| Full 10 agent states | All states with 3D animations |
| Admin panel v1 | Layout editor, agent assignment, alert configuration, theme selector |

**Launch:** Public beta. Studio Pro tier at $29/seat/month. Free Base tier available.

### Phase 3: Meshy Integration — Studio 3D (Weeks 15–20)

**Goal:** Full 3D generative pipeline

| Milestone | Deliverable |
|---|---|
| Meshy Text-to-3D | Prompt → preview → approve → refine → deploy, polled via REST |
| Meshy Image-to-3D | ComfyUI concept image → 3D model, integrated with concept approval flow |
| Asset Generator UI | Category picker, reference image selector, job queue with progress, 3D preview panel |
| Asset Approval Drawer | Interactive 3D model viewer, polygon stats, revision history, approve/revise/dismiss |
| Remesh integration | Auto-optimize for web (target polycount, quad/triangle topology, auto-size) |
| Rigging & animation | Auto-rig humanoid agents, walking/sitting/typing animation presets |
| Team asset library | Shared 3D props across organization, stored in Firestore + CDN |
| Room kit generator | Batch-generate furniture sets for themed rooms |
| Asset Placement Mode | Slot system, drag-and-drop from library, transform controls, undo/redo |

**Launch:** GA. Studio 3D tier at $79/seat/month.

### Phase 4: Marketplace & Community (Weeks 21–26)

**Goal:** Creator economy and community themes

| Milestone | Deliverable |
|---|---|
| Theme Manager | Save, import/export, reset to default |
| Theme export/packaging | Bundle theme as distributable package with validation |
| Community Theme Browser | Browse, preview (rotating 3D), purchase community themes |
| Marketplace publishing | Submit via existing `/api/v1/marketplace/publish` with type `office-theme` |
| Revenue sharing | 85/15 split, creator dashboards via existing publisher page |
| Scene pack production | Launch first 4 premium scene packs (Cyberpunk Neon, Zen Garden, Space Station, Pixel Retro) |
| Replay export | MP4 video export, shareable links with embedded player |
| Cinematic camera | Auto-pilot camera mode for demos |

**Launch:** Marketplace opens. Scene packs available for purchase.

### Phase 5: Enterprise (Weeks 27–36)

**Goal:** Enterprise readiness

| Milestone | Deliverable |
|---|---|
| SSO / SAML / OIDC | Enterprise identity provider support |
| RBAC | Viewer, operator, admin, designer roles |
| Audit trail | Compliance export (SOC 2, ISO 27001 evidence packages) |
| Replay certification | Tamper-proof cryptographically signed playback |
| Multi-floor / multi-org | Enterprise-scale visualization |
| White-label mode | Remove Swarm branding, apply customer brand |
| Private deployment playbook | Documentation and automation for on-prem deployment |
| Replay analytics add-on | Heatmaps, error patterns, collaboration graphs, cost attribution |
| Compliance add-on | Tamper-proof replay, data residency, automated incident reports |

**Launch:** Enterprise tier. Sales-led motion.

### Phase 6: Expansion (Ongoing)

| Milestone | Deliverable |
|---|---|
| Industry theme packs | Finance, healthcare, legal, gaming, e-commerce, education, government |
| AI narrator | LLM-generated voiceover for replay walkthroughs |
| VR mode (WebXR) | Immersive agent observation in VR headsets |
| Plugin API | Third-party widgets within office zones (charts, Kanban, terminals) |
| Embedded mode | `<iframe>` widget for external dashboards |
| Multi-cursor collaboration | See who else is viewing the office, shared annotations |
| AI-assisted placement | "Auto-furnish" office from a single theme prompt |
| Collaborative editing | Multiple team members editing themes simultaneously |

---

## 14. Competitive Differentiators

### vs. Plain Dashboards (Grafana, Datadog, custom)

| Dimension | Plain Dashboard | Office Sim Studio |
|---|---|---|
| **Agent representation** | Line on a chart, row in a table | Visible character at a desk, with behavior animations |
| **Spatial awareness** | None — data is tabular | Full spatial layout: desks, rooms, zones, meeting areas |
| **Incident comprehension** | Read timestamps, correlate logs | Watch the cascade unfold in replay, see agents walk to error bay |
| **Demo capability** | Screenshot a dashboard | Cinematic 3D walkthrough with camera tracking and branded environment |
| **Customization** | Change colors, maybe a logo | Generate entire office environments, 3D props, avatar portraits, themes |
| **Team identity** | Everyone's Grafana looks the same | Every team's office looks different — designed by them, for them |
| **Switching cost** | Export dashboards in minutes | Can't take your generated office, themes, assets, replays to another tool |
| **Emotional engagement** | Functional, forgettable | Agents feel like teammates — teams name them, care about their desks |

### vs. Static Agent UIs (LangSmith, AgentOps, CrewAI dashboard)

| Dimension | Static Agent UI | Office Sim Studio |
|---|---|---|
| **Visualization model** | Trace trees, message logs, flow charts | Living office simulation — movement, state, spatial relationships |
| **Time dimension** | Scroll through logs | Replay with time-travel scrubber, watch events unfold spatially |
| **Multi-agent awareness** | List of agents, maybe a graph | See all agents simultaneously, their locations, and their real-time interactions |
| **Generative capability** | None | Full ComfyUI + Meshy pipeline for custom environments |
| **Extensibility** | Fixed views | Layout editor, theme designer, 3D asset generator, community marketplace |
| **Marketplace** | None | Community themes, scene packs, creator revenue sharing |
| **Enterprise readiness** | Basic auth, maybe SSO | Full SSO/RBAC, compliance, replay certification, white-label, audit trail |

### vs. Building Your Own

| Factor | Build In-House | Buy Office Sim Studio |
|---|---|---|
| **Time to first value** | 3–6 months for basic 2D, 6–12 months for 3D + generation | Install mod, see agents in minutes |
| **Generative pipeline** | Build ComfyUI + Meshy integration, approval flows, asset management from scratch | Included, tested, optimized with approval gates at every stage |
| **Maintenance** | Your team maintains rendering, WebSocket sync, 3D performance, generation pipeline | Swarm team maintains; updates via marketplace |
| **Cost** | 2–4 FTE for 6+ months ($200K–$500K+ fully loaded) | $29–$79/seat/month |
| **Community** | Isolated, no shared themes or assets | Marketplace, community themes, shared ComfyUI workflows |
| **Enterprise features** | Build SSO, RBAC, compliance, replay certification from scratch | Included in Enterprise tier |

### The Unfair Advantage

**No other agent monitoring tool has a generative creative pipeline.** ComfyUI for 2D concept design and Meshy for 3D asset production, connected by an approval-gated workflow, wrapped in a Studio UI, and distributed through a community marketplace with revenue sharing — this capability stack does not exist anywhere else in the agent tooling space.

The combination creates three interlocking moats:

1. **Creative investment** — Generated environments represent irreplaceable creative work
2. **Community marketplace** — Network effects from community-created themes
3. **Ecosystem lock-in** — ComfyUI workflows, Meshy assets, replay history, and team customizations all live within the Swarm ecosystem

---

*This document is a companion to `PRD-OpenClaw-Office-Sim-UX.md`. Together they form the complete product specification for OpenClaw Office Sim Studio.*
