# OpenClaw Office Sim Studio — UX/UI PRD

> **Mod ID:** `openclaw-office-sim`
> **Type:** Premium Agent Guild Marketplace Mod
> **Version:** 0.1.0-draft
> **Date:** 2026-03-24
> **Status:** Draft

---

## 1. Vision

OpenClaw Office Sim Studio transforms the Agent Guild agent monitoring experience from static dashboards and log streams into a living, breathing virtual headquarters. Every agent becomes a visible employee — sitting at a desk, walking to a meeting, blocked at a whiteboard, or sprinting through a tool call. Two synchronized views serve distinct purposes: a **2D command-center map** for operational clarity, and a **3D immersive simulation** for cinematic explainability and agent storytelling.

Beyond observation, the mod introduces a **generative design studio** where users create custom office environments. ComfyUI powers visual concept generation — office themes, avatar portraits, scene styles, VFX concepts, and texture ideation. Meshy converts approved concepts into production-ready 3D assets — agent avatars, furniture, office decorations, themed rooms, props, and environmental set pieces. The result is an office that looks the way _you_ designed it.

The result is a mod that makes multi-agent systems *legible* to operators, *impressive* to investors, *intuitive* to developers, and *customizable* to creative users.

### Inspirations (Cited by Name)

| Repository | What We Borrow |
|---|---|
| **[WW-AI-Lab/openclaw-office](https://github.com/WW-AI-Lab/openclaw-office)** | Dual 2D/3D rendering model (SVG isometric + React Three Fiber), deterministic agent avatars, speech bubbles with streaming Markdown, real-time WebSocket state, Zustand store pattern |
| **[iamlukethedev/Claw3D](https://github.com/iamlukethedev/Claw3D)** | Retro-styled walkable 3D office concept, Phaser-based layout editor, gateway-first architecture (Browser → Studio → Gateway), separation of visualization from intelligence layer |
| **[carlosazaustre/tenacitOS](https://github.com/carlosazaustre/tenacitOS)** | OS-style desktop metaphor (topbar, dock, status bar), voxel agent avatars at individual desks, cost analytics pulled from agent databases, heatmap activity feeds |
| **[GreenSheep01201/claw-empire](https://github.com/GreenSheep01201/claw-empire)** | Pixel-art animated agents walking between departments, Kanban task lifecycle, department-based spatial organization, workflow packs, CEO oversight metaphor |
| **[ComfyUI](https://docs.comfy.org/)** | Node-based generative image workflow engine. Powers concept generation, style exploration, avatar portraits, VFX reference sheets, and texture ideation within Studio mode |
| **[Meshy API](https://docs.meshy.ai/)** | Text-to-3D and image-to-3D model generation. Converts approved ComfyUI concept art into production 3D assets (GLB/GLTF) for placement in the office scene |

---

## 2. User Personas

### P1 — Solo Developer ("The Builder")
- Runs 3–10 agents locally or on a single VPS
- Wants to **see** what each agent is doing without reading logs
- Needs quick context switches: "which agent is stuck?" → click → inspect → unblock
- Cares about speed, keyboard shortcuts, and minimal chrome
- Likely discovers the mod from the Agent Guild marketplace, installs via one click

### P2 — Ops/Admin ("The Operator")
- Manages 10–50+ agents across an organization
- Needs filtering, search, batch operations, and alerting
- Uses the 2D view as a command center — multiple monitors, always-on
- Cares about uptime, error rates, cost attribution, and SLA compliance
- Wants replay capability for post-incident review

### P3 — Demo/Pitch Presenter ("The Storyteller")
- Showing the system to investors, customers, or executives
- Needs the 3D view to create a "wow" moment — agents visibly collaborating
- Wants a curated, cinematic experience: smooth camera, clean UI, no clutter
- May use replay mode to walk through a completed workflow step by step
- Needs one-click "demo mode" that hides sensitive data and shows representative activity

### P4 — Creative Designer ("The Worldbuilder")
- Wants the office to reflect a unique brand, theme, or aesthetic
- Uses Studio mode to generate concept art via ComfyUI and convert to 3D assets via Meshy
- Explores multiple style directions before committing (cyberpunk, cozy startup, space station)
- May be a designer on the team, or a solo dev with visual ambitions
- Values rapid iteration: prompt → generate → preview → approve → place
- Shares custom themes with the team or publishes them to the Agent Guild marketplace

---

## 3. User Flows

### Flow 1: Solo Developer — Morning Check-in
```
1. Opens Agent Guild dashboard → clicks "Office Sim" in sidebar (Modifications section)
2. Lands on Home Dashboard (overview cards: agents active, tasks in flight, errors)
3. Clicks "Open 2D Office" → sees floor plan with 5 agent desks
4. Notices Agent-03 desk is flashing red (error state)
5. Clicks Agent-03 → Agent Detail Drawer slides in from right
6. Reads error: "Rate limited by OpenAI API" — sees retry countdown
7. Clicks "View Logs" → scrollable log panel within drawer
8. Clicks "Reassign Task" → task moves to Agent-02's queue
9. Closes drawer → Agent-03 goes to idle animation, Agent-02 starts working
```

### Flow 2: Ops/Admin — Incident Investigation
```
1. Receives alert: "3 agents blocked for >5 min"
2. Opens 2D Office → applies filter: status = "blocked"
3. Non-blocked agents dim to 20% opacity — blocked agents pulse
4. Clicks first blocked agent → sees it's waiting on approval gate
5. Bulk-selects all 3 blocked agents → "Approve All" action
6. Agents transition to "active" — watches them resume in real-time
7. Opens Replay View → scrubs timeline back 30 minutes
8. Watches the cascade: API failure → retry storm → rate limit → block
9. Exports replay clip as shareable link for team post-mortem
```

### Flow 3: Demo/Pitch — Investor Walkthrough
```
1. Clicks "Demo Mode" toggle in header → sensitive data masked, sample labels applied
2. Switches to 3D Office → camera auto-orbits the office
3. Narrator describes: "Here you see 8 agents collaborating on a code review"
4. Clicks Agent-01 (lead) → camera zooms to desk, speech bubble shows activity
5. Shows collaboration lines: Agent-01 → Agent-04 (code review handoff)
6. Switches to Replay → plays back a completed 20-minute workflow in 60 seconds
7. Time scrubber shows key moments highlighted: task start, meeting, PR merge
8. Exits demo mode → returns to live view
```

### Flow 4: Creative Designer — Custom Cyberpunk Office Theme
```
 1. Opens Studio mode from sidebar or "Customize Office" button in 3D view
 2. Lands on Studio Dashboard showing current theme (Default Dark) and asset library
 3. Types prompt: "Neon cyberpunk hacker den with holographic displays and rain outside"
 4. Clicks "Generate Concepts" → request dispatched to ComfyUI workflow
 5. Waits 15–30s → concept board returns: 4 images (exterior, desk detail, mood lighting, overview)
 6. Reviews concept board → likes images 1 and 3, dismisses 2 and 4
 7. Clicks "Refine" on image 1 → adjusts prompt: "add more purple neon, less rain"
 8. ComfyUI returns 4 new variations → approves image 1B
 9. Switches to "Generate 3D Assets" tab
10. Selects approved concept images as reference
11. Picks asset category: "Desk" → types: "Cyberpunk hacker desk with embedded screens"
12. Clicks "Generate 3D" → request sent to Meshy API (text-to-3D with reference image)
13. Waits 60–120s → Meshy returns GLB model with preview thumbnail
14. 3D preview panel shows rotating model → user approves or requests revision
15. Clicks "Add to Asset Library" → asset saved to user's collection
16. Repeats for: chair, monitor, wall panel, floor tile, ceiling light
17. Opens "Place Assets" mode → 3D office loads with grid overlay
18. Drags custom desk from asset library onto agent desk slot → replaces default
19. Saves theme → applies globally to their office, or publishes to marketplace
```

---

## 4. Information Architecture

```
OpenClaw Office Sim Studio (sidebar entry: "Office Sim")
├── Home Dashboard .......................... /office-sim
│   ├── Overview Cards (agents, tasks, errors, cost)
│   ├── Recent Activity Feed
│   ├── Quick Actions (open 2D, open 3D, replay, studio)
│   └── Agent Status Grid (compact table view)
│
├── 2D Office .............................. /office-sim/2d
│   ├── Floor Plan Canvas (SVG/Canvas)
│   ├── Agent Nodes (desks, stations)
│   ├── Rooms (meeting rooms, queues, error bay)
│   ├── Toolbar (filter, search, zoom, layers)
│   └── Agent Detail Drawer (slide-in panel)
│
├── 3D Office .............................. /office-sim/3d
│   ├── Scene (React Three Fiber)
│   ├── Agent Characters (animated models)
│   ├── Environment (desks, rooms, effects)
│   ├── Camera Controls (orbit, follow, cinematic)
│   ├── HUD Overlay (agent names, status badges)
│   └── "Customize" entry point to Studio
│
├── Replay View ............................ /office-sim/replay
│   ├── Timeline Scrubber
│   ├── Playback Controls (play, pause, speed)
│   ├── Event Markers (errors, meetings, completions)
│   ├── 2D or 3D render target (switchable)
│   └── Export/Share controls
│
├── Studio Mode ............................ /office-sim/studio
│   ├── Studio Dashboard .................. /office-sim/studio
│   │   ├── Current Theme Preview
│   │   ├── Asset Library (generated + built-in)
│   │   └── Quick Actions (new concept, new asset, place assets)
│   │
│   ├── Concept Generator ................. /office-sim/studio/concepts
│   │   ├── Prompt Input (text + style presets)
│   │   ├── ComfyUI Workflow Selector
│   │   ├── Concept Board (generated image grid)
│   │   ├── Refinement Panel (adjust prompt per image)
│   │   └── Approval Actions (approve, refine, dismiss)
│   │
│   ├── Asset Generator ................... /office-sim/studio/assets
│   │   ├── Category Picker (desk, chair, wall, floor, prop, avatar, room)
│   │   ├── Reference Image Selector (from approved concepts)
│   │   ├── Text Prompt Input
│   │   ├── Meshy Job Queue (pending, generating, complete)
│   │   ├── 3D Preview Panel (rotate, zoom, inspect)
│   │   └── Asset Approval Drawer
│   │
│   ├── Asset Placement ................... /office-sim/studio/place
│   │   ├── 3D Office with Edit Grid Overlay
│   │   ├── Asset Library Sidebar (drag source)
│   │   ├── Slot System (desk, wall, ceiling, floor, prop zones)
│   │   ├── Transform Controls (position, rotation, scale)
│   │   └── Save / Publish Theme
│   │
│   └── Theme Manager ..................... /office-sim/studio/themes
│       ├── Saved Themes List
│       ├── Import / Export
│       ├── Publish to Marketplace
│       └── Community Theme Browser
│
└── Admin Panel ............................ /office-sim/admin
    ├── Office Layout Editor
    ├── Agent Assignment (desk ↔ agent mapping)
    ├── Alert Configuration
    ├── Theme/Skin Selector
    └── Performance & Usage Metrics
```

---

## 5. 2D vs. 3D — Comparative Design Philosophy

The 2D and 3D views are not redundant. They serve fundamentally different cognitive purposes and are designed for different moments in the user's workflow.

### Design Intent

| Dimension | 2D Office | 3D Office |
|---|---|---|
| **Purpose** | Operational clarity | Cinematic explainability |
| **Metaphor** | Command center, control room | Headquarters walk-through |
| **Primary user** | Ops/Admin (P2), Solo Dev (P1) | Storyteller (P3), Worldbuilder (P4) |
| **Information density** | High — see 50 agents at once | Medium — see 10–20 comfortably |
| **Interaction model** | Click, filter, bulk select | Explore, follow, observe |
| **Always-on suitability** | Yes — low GPU, static layout | No — GPU-intensive, cinematic |
| **Key strength** | "Where is the problem?" | "What does our system _look like_?" |

### Feature Availability Matrix

| Feature | 2D | 3D |
|---|---|---|
| Agent status badges | Color ring + icon | Color ring + icon + animation |
| Agent positions | Fixed desk grid | Animated movement between zones |
| Speech bubbles | Tooltip on hover | Floating 3D billboard, always visible |
| Collaboration lines | Dashed SVG lines | Glowing arc particles |
| Tool call visualization | Gear icon pulse | Holographic icon + particle burst |
| Meeting rooms | Zone with agent icons inside | Glass room, agents sitting, gesturing |
| Error bay | Red-tinted zone | Red ambient lighting, slump animation |
| Portal spawn/despawn | Fade-in/out | Swirling vortex effect |
| Approval gate | Barrier graphic + button | Semi-transparent energy wall |
| Queue/inbox | Stacked card icons | Floating holographic task queue |
| Camera | Pan + zoom | Orbit, follow, cinematic, first-person, top-down |
| Filtering | Toolbar controls | HUD overlay controls |
| Custom assets (Studio) | N/A — 2D uses theme colors only | Full 3D asset placement from Meshy |
| Performance floor | 60 FPS at 50 agents | 30 FPS at 20 agents |

### Synchronized State

Both views share the same state store (Zustand). Switching between 2D and 3D preserves:
- Selected agent (drawer stays open)
- Active filters
- Replay scrubber position
- Zoom level maps to equivalent framing

The `[2D ↔ 3D]` toggle button is present in the toolbar of both views. Transition is a 300ms crossfade.

---

## 6. Studio Mode UX

Studio mode is the generative design workspace. It bridges two external tools — **ComfyUI** (image generation) and **Meshy** (3D model generation) — into a unified creative pipeline within the Agent Guild UI.

### 6.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    STUDIO MODE                           │
│                                                          │
│   ┌──────────┐   approve    ┌──────────┐   approve      │
│   │ CONCEPT  │ ──────────→  │  ASSET   │ ──────────→    │
│   │ GENERATOR│              │ GENERATOR│              ┌──┴──┐
│   │          │   refine ↺   │          │   revise ↺   │PLACE│
│   │ ComfyUI  │              │  Meshy   │              │MODE │
│   └──────────┘              └──────────┘              └─────┘
│        ↑                         ↑                       │
│    text prompt              text prompt +             save as
│    style preset             reference image            theme
│    workflow ID              asset category               │
│                                                          ↓
│                                              ┌──────────────┐
│                                              │ THEME MANAGER │
│                                              │ save/publish  │
│                                              └──────────────┘
└─────────────────────────────────────────────────────────┘
```

### 6.2 Concept Generator (ComfyUI Integration)

**Purpose:** Generate visual concepts that define the office aesthetic before committing to 3D assets.

**ComfyUI Workflow Types:**

| Workflow | Output | Use Case |
|---|---|---|
| `office-theme` | 4 concept images (exterior, interior, detail, mood) | Overall office aesthetic exploration |
| `avatar-portrait` | 1 portrait per agent, consistent style | Agent character design |
| `scene-style` | 2 environment images (day/night or warm/cool) | Lighting and atmosphere definition |
| `vfx-concept` | 4 effect reference images (particles, glows, portals) | Visual effects direction |
| `texture-sheet` | 4 tileable texture samples (wall, floor, desk, accent) | Material ideation |

**Screen Layout — Concept Generator:**

```
┌─────────────────────────────────────────────────────────┐
│  STUDIO > CONCEPTS                          [← Back]    │
├──────────────────────────┬──────────────────────────────┤
│                          │                               │
│  PROMPT                  │  CONCEPT BOARD                │
│  ┌────────────────────┐  │                               │
│  │ "Neon cyberpunk     │  │  ┌──────────┐ ┌──────────┐  │
│  │  hacker den with    │  │  │          │ │          │  │
│  │  holographic..."    │  │  │  img 1   │ │  img 2   │  │
│  └────────────────────┘  │  │  ✅ approved│ │  ❌ dismiss│  │
│                          │  │          │ │          │  │
│  WORKFLOW                │  └──────────┘ └──────────┘  │
│  ● Office Theme          │                               │
│  ○ Avatar Portrait       │  ┌──────────┐ ┌──────────┐  │
│  ○ Scene Style           │  │          │ │          │  │
│  ○ VFX Concept           │  │  img 3   │ │  img 4   │  │
│  ○ Texture Sheet         │  │  🔄 refine │ │  ❌ dismiss│  │
│                          │  │          │ │          │  │
│  STYLE PRESETS           │  └──────────┘ └──────────┘  │
│  [Cyberpunk] [Minimal]   │                               │
│  [Retro] [Nature] [Sci-Fi│  GENERATION STATUS            │
│  [Cozy] [Industrial]     │  ████████████░░ 78%           │
│  [Vaporwave] [Gothic]    │  Estimated: ~12s remaining    │
│                          │                               │
│  NEGATIVE PROMPT         │  ────────────────────────     │
│  ┌────────────────────┐  │  HISTORY                      │
│  │ "blurry, low res"  │  │  ▸ Batch #3 — 2 approved     │
│  └────────────────────┘  │  ▸ Batch #2 — 0 approved     │
│                          │  ▸ Batch #1 — 1 approved     │
│  [Generate Concepts]     │                               │
│                          │                               │
├──────────────────────────┴──────────────────────────────┤
│  APPROVED CONCEPTS: [img1] [img3_v2]  → [Send to Assets]│
└─────────────────────────────────────────────────────────┘
```

**Interaction Model:**
- Type a prompt or select a style preset (which pre-fills the prompt)
- Select a ComfyUI workflow type
- Click "Generate Concepts" → fires POST to ComfyUI API with selected workflow
- Concept board fills in as images return (progressive loading)
- Per-image actions: **Approve** (adds to approved pool), **Refine** (re-prompts with this image as reference + adjusted text), **Dismiss** (grays out)
- Approved concepts accumulate in the bottom tray
- "Send to Assets" button forwards approved images to the Asset Generator as references

**ComfyUI Connection:**
- Self-hosted ComfyUI instance, URL configured in mod settings
- REST API: `POST /prompt` to queue, `GET /history/{prompt_id}` to poll
- WebSocket: `ws://{host}/ws` for real-time progress updates
- Workflows stored as JSON templates in the mod's asset directory
- Fallback: if ComfyUI unavailable, show connection error with setup guide link

### 6.3 Asset Generator (Meshy Integration)

**Purpose:** Convert approved 2D concepts into 3D models suitable for the office scene.

**Asset Categories:**

| Category | Examples | Meshy Mode |
|---|---|---|
| **Agent Avatar** | Character model, robot, animal mascot | Image-to-3D (from portrait concept) |
| **Desk** | Standing desk, hacker station, holodesk | Text-to-3D + reference image |
| **Chair** | Ergonomic, throne, hover seat | Text-to-3D + reference image |
| **Wall/Partition** | Glass wall, neon panel, brick, holographic | Text-to-3D |
| **Floor Tile** | Metal grating, marble, circuit board | Text-to-texture (tiled) |
| **Ceiling/Lighting** | LED strips, chandelier, floating orb | Text-to-3D |
| **Prop** | Plant, coffee mug, server rack, trophy | Text-to-3D |
| **Room Set** | Meeting room bundle, error bay theme | Text-to-3D (larger scale) |

**Screen Layout — Asset Generator:**

```
┌─────────────────────────────────────────────────────────┐
│  STUDIO > ASSETS                            [← Back]    │
├────────────────┬────────────────────────────────────────┤
│                │                                         │
│  CATEGORY      │  3D PREVIEW                            │
│  ┌──────────┐  │  ┌─────────────────────────────────┐   │
│  │● Desk    │  │  │                                 │   │
│  │○ Chair   │  │  │     (rotating 3D model)         │   │
│  │○ Avatar  │  │  │                                 │   │
│  │○ Wall    │  │  │         ┌───────┐               │   │
│  │○ Prop    │  │  │         │  🪑   │               │   │
│  │○ Room    │  │  │         │       │               │   │
│  └──────────┘  │  │         └───────┘               │   │
│                │  │                                 │   │
│  REFERENCE     │  │  poly: 12.4k  ·  format: GLB   │   │
│  ┌──────────┐  │  └─────────────────────────────────┘   │
│  │ [img1]   │  │                                         │
│  │ (from    │  │  ──────────────────────────────────     │
│  │ concepts)│  │                                         │
│  └──────────┘  │  JOB QUEUE                              │
│                │  ┌─────────────────────────────────┐   │
│  PROMPT        │  │ ✅ Cyber Desk v2   — 12.4k poly  │   │
│  ┌──────────┐  │  │ ⏳ Neon Chair      — generating   │   │
│  │"Cyberpunk│  │  │ ⏳ Holo Monitor    — queued       │   │
│  │ desk..." │  │  │ ❌ Wall Panel v1   — failed       │   │
│  └──────────┘  │  └─────────────────────────────────┘   │
│                │                                         │
│  [Generate 3D] │  [Approve] [Revise] [Dismiss] [→ Place]│
│                │                                         │
└────────────────┴────────────────────────────────────────┘
```

**Meshy API Integration:**
- `POST /openapi/v2/text-to-3d` — text prompt + optional reference image → 3D GLB
- `POST /openapi/v2/image-to-3d` — concept image → 3D GLB (used for avatars)
- `GET /openapi/v2/text-to-3d/{taskId}` — poll job status
- Webhook callback when generation completes
- API key configured in mod settings (user provides their own Meshy key)
- Rate limiting: queue UI shows position, estimated wait time
- Output format: GLB (compatible with React Three Fiber / Three.js `useGLTF`)

**Interaction Model:**
- Select category → choose reference image (optional) → type prompt → generate
- Job enters queue with progress indicator
- On completion: 3D preview auto-loads with orbit camera
- User can rotate, zoom, inspect polygon count and texture quality
- Actions: **Approve** (adds to Asset Library), **Revise** (re-prompt with adjustments), **Dismiss** (delete)
- Approved assets flow to the Asset Library for placement

### 6.4 Asset Placement Mode

**Purpose:** Place generated (or built-in) 3D assets into the office scene.

**Screen Layout — Placement Mode:**

```
┌─────────────────────────────────────────────────────────┐
│  STUDIO > PLACE ASSETS          [Save] [Cancel] [Undo]  │
├───────────┬─────────────────────────────────────────────┤
│           │                                              │
│  LIBRARY  │           3D OFFICE WITH EDIT GRID           │
│           │                                              │
│  Filter:  │      ┌──────────────────────────────┐       │
│  [All ▾]  │      │                              │       │
│           │      │   ┌─ ─ ─ ─ ─ ─ ┐            │       │
│  ┌─────┐  │      │   ╎ DESK SLOT  ╎  ← drag    │       │
│  │ 🪑  │  │      │   ╎  (empty)   ╎    here     │       │
│  │Cyber│←─┤──drag│   └─ ─ ─ ─ ─ ─ ┘            │       │
│  │Desk │  │      │                              │       │
│  └─────┘  │      │   ┌───────────┐              │       │
│  ┌─────┐  │      │   │ CUSTOM    │  ← placed   │       │
│  │ 💡  │  │      │   │  DESK v2  │              │       │
│  │Neon │  │      │   └───────────┘              │       │
│  │Light│  │      │                              │       │
│  └─────┘  │      └──────────────────────────────┘       │
│  ┌─────┐  │                                              │
│  │ 🌿  │  │  TRANSFORM                                   │
│  │Holo │  │  Position: X [0.0] Y [0.0] Z [0.0]          │
│  │Plant│  │  Rotation: [0°]  Scale: [100%]               │
│  └─────┘  │  [Reset Transform] [Delete Asset]            │
│           │                                              │
└───────────┴─────────────────────────────────────────────┘
```

**Slot System:**
- The office has predefined **slots**: desk positions, wall mounts, ceiling fixtures, floor zones, prop spots
- Slots appear as dashed outlines when in edit mode
- Dragging an asset onto a slot snaps it into position with correct orientation
- Users can also free-place props outside slots with manual transform controls
- Each slot type accepts only compatible asset categories (desk slot accepts desks, not chairs)

**Interaction Model:**
- Drag from library sidebar → drop onto slot or free position
- Click placed asset → selection gizmo appears (translate, rotate, scale)
- Undo/Redo stack (Ctrl+Z/Ctrl+Y) for all placement operations
- "Save" persists the theme to user storage (Firestore)
- "Publish" opens a dialog to submit the theme to the Agent Guild marketplace

---

## 7. Screen-by-Screen Requirements

### 7.1 Home Dashboard (`/office-sim`)

**Purpose:** Entry point. Fast orientation — what's happening right now?

**Wireframe:**

```
┌─────────────────────────────────────────────────────────┐
│  HEADER: "Office Sim" title + Demo Mode toggle + ⚙      │
├──────────┬──────────┬──────────┬──────────┬─────────────┤
│ 🟢 Active │ 📋 Tasks  │ 🔴 Errors │ 💰 Cost   │ ⏱ Uptime   │
│    7/10   │   23     │    2     │  $4.12   │   99.7%    │
├──────────┴──────────┴──────────┴──────────┴─────────────┤
│                                                          │
│  ┌─────────────────────┐  ┌──────────────────────────┐  │
│  │   QUICK ACTIONS     │  │   RECENT ACTIVITY        │  │
│  │                     │  │                          │  │
│  │  [Open 2D Office]   │  │  10:42 Agent-03 error    │  │
│  │  [Open 3D Office]   │  │  10:41 Agent-01 completed│  │
│  │  [Open Replay]      │  │  10:39 Meeting started   │  │
│  │  [Open Studio]      │  │  10:38 Agent-05 idle     │  │
│  │  [Admin Panel]      │  │  10:35 Task assigned     │  │
│  └─────────────────────┘  └──────────────────────────┘  │
│                                                          │
│  AGENT STATUS GRID                                       │
│  ┌────────┬────────┬──────────┬─────────┬──────────────┐│
│  │ Agent  │ Status │ Task     │ Runtime │ Actions      ││
│  ├────────┼────────┼──────────┼─────────┼──────────────┤│
│  │ 🤖 A-01│ 🟢 Active│ PR Review│ 4m 12s │ [Inspect]   ││
│  │ 🤖 A-02│ 🟡 Busy │ Code Gen │ 12m 3s │ [Inspect]   ││
│  │ 🤖 A-03│ 🔴 Error│ —blocked—│ 8m 45s │ [Fix][Skip] ││
│  │ 🤖 A-04│ ⚪ Idle │ —        │ —      │ [Assign]    ││
│  └────────┴────────┴──────────┴─────────┴──────────────┘│
└─────────────────────────────────────────────────────────┘
```

**Key Requirements:**
- Cards are clickable — clicking "Errors" filters to error agents
- Activity feed updates in real-time via WebSocket
- Agent grid supports sort, filter, and bulk selection
- Responsive: cards stack on mobile, grid collapses to list

---

### 7.2 2D Office (`/office-sim/2d`)

**Purpose:** Operational command center. Spatial awareness of all agents at a glance. Optimized for always-on monitoring.

**Wireframe:**

```
┌─────────────────────────────────────────────────────────┐
│  TOOLBAR: [Filter▾] [Search🔍] [Zoom±] [Layers▾] [2D↔3D] [⛶]│
├─────────────────────────────────────────────────────────┤
│                                                          │
│        ┌──────────┐    ┌──────────┐                     │
│        │ MEETING  │    │ MEETING  │                     │
│        │ ROOM A   │    │ ROOM B   │                     │
│        │  🤖🤖    │    │  (empty) │                     │
│        └──────────┘    └──────────┘                     │
│                                                          │
│   ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐            │
│   │ 🤖  │ │ 🤖  │ │ 🤖  │ │ 🤖  │ │ 🤖  │            │
│   │ A-01│ │ A-02│ │ A-03│ │ A-04│ │ A-05│            │
│   │ 🟢  │ │ 🟡  │ │ 🔴  │ │ ⚪  │ │ 🟢  │            │
│   │ desk│ │ desk│ │ desk│ │ desk│ │ desk│            │
│   └─────┘ └─────┘ └─────┘ └─────┘ └─────┘            │
│                                                          │
│        ┌──────────────────────┐                         │
│        │   QUEUE / INBOX      │                         │
│        │  📋📋📋📋 (4 tasks)    │                         │
│        └──────────────────────┘                         │
│                                                          │
│   ┌────────────────┐  ┌──────────────────┐             │
│   │  ERROR BAY     │  │  TOOL STATION    │             │
│   │  🤖 A-03 ⚠     │  │  🔧 API calls    │             │
│   └────────────────┘  └──────────────────┘             │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  STATUS BAR: 7 active · 2 errors · 23 tasks · ws:🟢     │
└─────────────────────────────────────────────────────────┘
```

**Spatial Zones:**

| Zone | Purpose | Visual Treatment |
|---|---|---|
| **Desk Row** | Primary workspace. One desk per agent | Isometric desks with avatar, name label, status ring |
| **Meeting Room** | Agents in collaborative tasks/handoffs | Glass-walled room, agents inside show speech bubbles |
| **Queue/Inbox** | Unassigned or pending tasks | Stack of task cards, glow when overflowing |
| **Error Bay** | Agents in error/blocked state move here | Red-tinted zone, pulsing border, alert icon |
| **Tool Station** | Visualizes active tool calls (API, file I/O) | Animated gear/wrench icons, throughput counter |
| **Approval Gate** | Agents waiting for human approval | Barrier graphic, "Approve" button inline |

**Interaction Model:**
- **Hover** any agent → tooltip: name, current task, duration, status
- **Click** agent → opens Agent Detail Drawer (right panel)
- **Right-click** agent → context menu: inspect, reassign, pause, restart
- **Drag** agent to meeting room → initiate collaborative task
- **Click** empty desk → assign agent from dropdown
- **Scroll wheel** → zoom in/out on floor plan
- **Ctrl+F** → search agents by name, task, or status
- **Arrow keys** → pan the floor plan
- **Shift+click** → multi-select agents for bulk actions

**Toolbar Controls:**
- **Filter**: status (all/active/idle/error/blocked), agent type, department
- **Search**: fuzzy match on agent name, task description, skill name
- **Zoom**: fit-all, zoom-to-selection, percentage slider
- **Layers**: toggle labels, collaboration lines, task queues, alerts
- **Fullscreen**: expand to fill viewport (for always-on monitors)

---

### 7.3 3D Office (`/office-sim/3d`)

**Purpose:** Cinematic, immersive view. Best for demos, storytelling, and understanding complex multi-agent workflows visually. Displays custom assets from Studio mode.

**Wireframe:**

```
┌─────────────────────────────────────────────────────────┐
│  HUD: Agent count · Active tasks · [Camera▾] · [2D↔3D] · [✏ Studio]│
├─────────────────────────────────────────────────────────┤
│                                                          │
│          ╔═══════════════════════════════╗               │
│         ╱            3D SCENE            ╲              │
│        ╱                                  ╲             │
│       │     🏢 Office Environment          │             │
│       │                                    │             │
│       │   ┌─────┐  Agent-01 at desk       │             │
│       │   │ 🧑‍💻 │  Speech: "Reviewing PR" │             │
│       │   └─────┘                          │             │
│       │          ↗ collab line             │             │
│       │   ┌─────┐  Agent-04 walking       │             │
│       │   │ 🚶  │  → Meeting Room A       │             │
│       │   └─────┘                          │             │
│       │                                    │             │
│       │   ✨ Tool call particle effect     │             │
│       │   📡 API orb pulsing               │             │
│       │                                    │             │
│        ╲                                  ╱             │
│         ╲________________________________╱              │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  BOTTOM TRAY: [▶ Follow Agent-01] [🎬 Cinematic] [📷]   │
└─────────────────────────────────────────────────────────┘
```

**3D-Specific Features (Beyond 2D):**

| Feature | Description |
|---|---|
| **Agent Animation** | Walk cycles between zones, typing at desk, gesturing in meetings, slumping when idle |
| **Speech Bubbles** | Floating 3D billboards above agents showing streaming text/tool invocations |
| **Collaboration Lines** | Glowing arcs between agents when they exchange messages |
| **Tool Call Effects** | Particle bursts for API calls, file I/O sparkles, database query ripples |
| **Environment Mood** | Ambient lighting shifts: warm (all healthy), cool blue (high load), red tint (errors) |
| **Portal Effects** | Swirling portal when agent spawns/despawns (inspired by openclaw-office) |
| **Skill Holograms** | Holographic icons above agent desks showing their active skills |
| **Custom Assets** | User-generated 3D models from Meshy placed via Studio asset placement |

**Camera Modes:**
- **Orbit** — default. Mouse drag rotates, scroll zooms, middle-click pans
- **Follow** — camera tracks a selected agent. Smooth lerp. Click another agent to switch
- **Cinematic** — auto-pilot camera that slowly orbits, zooms to action, pulls back for overview
- **Top-Down** — overhead orthographic view (bridge between 2D and 3D)
- **First-Person** — WASD walkthrough. Approach any desk to inspect

**HUD Overlay:**
- Semi-transparent name tags floating above each agent
- Status badges (color-coded dots matching 2D semantics)
- Mini-map in corner showing 2D floor plan with camera frustum indicator
- Click-through: clicking any agent in 3D opens the same Agent Detail Drawer

---

### 7.4 Replay View (`/office-sim/replay`)

**Purpose:** Time-travel through past agent activity. Post-incident review, onboarding demos, audit trails.

**Wireframe:**

```
┌─────────────────────────────────────────────────────────┐
│  HEADER: "Replay" · Session selector▾ · [2D][3D] toggle │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │                                                   │  │
│  │           2D or 3D RENDER TARGET                  │  │
│  │        (shows office state at scrubber time)      │  │
│  │                                                   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  TIMELINE                                                │
│  ┌───────────────────────────────────────────────────┐  │
│  │ |----⚠---------🤝--------✅-----------🔴------| │  │
│  │  10:00       10:15      10:30      10:45   11:00  │  │
│  │              ▲ scrubber position                   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  CONTROLS: [⏮] [⏪] [▶/⏸] [⏩] [⏭] · Speed: [1x▾]    │
│                                                          │
│  EVENT LOG (synced to scrubber)                          │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 10:15  ⚠  Agent-03 hit rate limit                │  │
│  │ 10:22  🤝  Agent-01 + Agent-04 entered meeting    │  │
│  │ 10:31  ✅  Task "PR-142" completed                │  │
│  │ 10:44  🔴  Agent-03 moved to error bay            │  │
│  └───────────────────────────────────────────────────┘  │
│                                                          │
│  [Export as Link] [Export as Video] [Download Events]    │
└─────────────────────────────────────────────────────────┘
```

**Timeline Event Markers:**
- ⚠ Warning (amber) — rate limits, retries, degraded performance
- 🔴 Error (red) — failures, blocked agents, crashes
- 🤝 Meeting (blue) — collaborative tasks, handoffs
- ✅ Completion (green) — task finished, PR merged, output delivered
- 🟢 Spawn (green outline) — agent came online
- ⚪ Despawn (gray) — agent went offline

**Key Interactions:**
- Click any event marker → scrubber jumps to that moment
- Drag scrubber → office state updates in real-time
- Speed: 0.25x, 0.5x, 1x, 2x, 4x, 8x
- Filter events by agent or event type
- Click agent in replay → drawer shows that agent's state at that moment

---

### 7.5 Studio Dashboard (`/office-sim/studio`)

**Purpose:** Entry point for the creative pipeline. Shows current theme, asset library, and generation actions.

**Wireframe:**

```
┌─────────────────────────────────────────────────────────┐
│  STUDIO                                      [← Office] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  CURRENT THEME                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │  ┌───────────────────────┐  "Cyberpunk Hacker"  │    │
│  │  │                       │                      │    │
│  │  │   (3D preview of      │  Assets: 12 custom   │    │
│  │  │    current office)    │  Last edited: 2h ago │    │
│  │  │                       │  Status: Applied     │    │
│  │  └───────────────────────┘                      │    │
│  │  [Edit Theme] [Reset to Default] [Publish]       │    │
│  └─────────────────────────────────────────────────┘    │
│                                                          │
│  QUICK ACTIONS                                           │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ 🎨          │ │ 📦          │ │ 🏗           │       │
│  │ New Concept │ │ New 3D      │ │ Place       │       │
│  │ Board       │ │ Asset       │ │ Assets      │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
│                                                          │
│  ASSET LIBRARY                          [View All →]     │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐         │
│  │ desk │ │chair │ │light │ │plant │ │wall  │         │
│  │ GLB  │ │ GLB  │ │ GLB  │ │ GLB  │ │ GLB  │         │
│  │12.4k │ │ 8.1k │ │ 3.2k │ │ 5.7k │ │ 4.0k │         │
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘         │
│                                                          │
│  COMFYUI: 🟢 Connected    MESHY: 🟢 Connected (14 credits)│
└─────────────────────────────────────────────────────────┘
```

**Key Requirements:**
- 3D preview of current office theme rotates slowly on autoplay
- Asset library shows thumbnail + polygon count for each generated asset
- Connection status indicators for ComfyUI and Meshy
- Meshy credit counter warns when running low (< 5 credits → amber)
- "Publish" creates a marketplace submission with theme name, description, preview images

---

### 7.6 Asset Approval Drawer

**Purpose:** Review, approve, or reject generated assets (both 2D concepts and 3D models) without leaving the current screen. Slides in from the right, similar to Agent Detail Drawer.

**Wireframe:**

```
┌──────────────────────────────┐
│  ← Back     ASSET REVIEW     │
├──────────────────────────────┤
│                              │
│  ASSET: "Cyber Desk v2"     │
│  Type: Desk · Generated     │
│  Source: Meshy text-to-3D   │
│  Created: 12 min ago        │
│                              │
│  ─── 3D PREVIEW ──────────  │
│  ┌──────────────────────┐   │
│  │                      │   │
│  │   (interactive 3D    │   │
│  │    model viewer)     │   │
│  │                      │   │
│  │   drag to rotate     │   │
│  │   scroll to zoom     │   │
│  │                      │   │
│  └──────────────────────┘   │
│                              │
│  ─── DETAILS ────────────── │
│  Polygons: 12,412           │
│  Textures: 3 (diffuse,     │
│    normal, metallic)        │
│  Format: GLB                │
│  File size: 2.4 MB          │
│  Dimensions: 1.2m × 0.8m   │
│                              │
│  ─── REFERENCE IMAGE ────── │
│  ┌──────────────────────┐   │
│  │ (ComfyUI concept     │   │
│  │  used as reference)  │   │
│  └──────────────────────┘   │
│                              │
│  ─── PROMPT USED ────────── │
│  "Cyberpunk hacker desk     │
│   with embedded holographic │
│   displays, dark metal"     │
│                              │
│  ─── ACTIONS ────────────── │
│  [✅ Approve & Add to Library]│
│  [🔄 Revise (Edit Prompt)]   │
│  [❌ Dismiss]                 │
│  [📥 Download GLB]           │
│                              │
│  ─── REVISION HISTORY ───── │
│  ▸ v2 (current) — approved  │
│  ▸ v1 — dismissed "too low  │
│    poly, missing screens"   │
│                              │
└──────────────────────────────┘
```

**Key Requirements:**
- Drawer width: 420px (desktop), full-screen (mobile)
- 3D preview uses a lightweight R3F canvas with orbit controls
- "Revise" opens an inline prompt editor pre-filled with the original prompt
- Revision history shows all attempts with dismiss reasons
- "Approve & Add" triggers a success animation and adds to the Asset Library
- Drawer can also display 2D concept images (from ComfyUI) with the same approve/refine/dismiss actions

---

### 7.7 Agent Detail Panel

**Purpose:** Deep inspection of a single agent without leaving the office view. Slides in from the right edge. Shared across 2D, 3D, and Replay views.

**Wireframe:**

```
┌──────────────────────────────┐
│  ← Back     AGENT DETAIL     │
├──────────────────────────────┤
│                              │
│  🤖 Agent-03 "Cipher"        │
│  Role: Security Auditor      │
│  Status: 🔴 Error             │
│  Uptime: 2h 14m              │
│  Desk: B-03                  │
│                              │
│  ─── CURRENT TASK ────────── │
│  Task: Audit auth middleware │
│  Started: 10:22 AM           │
│  Status: Blocked — rate limit│
│  Retry in: 42s               │
│                              │
│  ─── RECENT ACTIVITY ─────── │
│  10:44 Error: 429 Too Many   │
│  10:42 Tool: fetch(api/v2)   │
│  10:41 Output: "Found 3..."  │
│  10:39 Tool: read(auth.ts)   │
│                              │
│  ─── ACTIVE SKILLS ──────── │
│  [Code Analysis] [Web Fetch] │
│  [File Reader] [Git Ops]     │
│                              │
│  ─── SOUL CONFIG ─────────── │
│  Personality: Reserved       │
│  Decision: Data-driven       │
│  Comm Style: Technical       │
│                              │
│  ─── ACTIONS ────────────── │
│  [Retry Now] [Reassign Task] │
│  [Pause Agent] [View Logs]   │
│  [Restart] [Remove from Desk]│
│                              │
└──────────────────────────────┘
```

**Key Requirements:**
- Drawer width: 400px (desktop), full-screen (mobile)
- Activity feed auto-scrolls, with scroll lock toggle
- SOUL Config section only shows if persona is applied
- Actions are context-sensitive: "Retry" only shows in error state, "Approve" only when waiting
- Drawer state persists when switching between 2D and 3D views
- Keyboard: `Esc` closes, `Tab` cycles through agents, `↑↓` scrolls activity

---

### 7.8 Admin Panel (`/office-sim/admin`)

**Purpose:** Configuration and customization. Office layout, alerts, themes, and usage metrics.

**Wireframe:**

```
┌─────────────────────────────────────────────────────────┐
│  TABS: [Layout] [Assignments] [Alerts] [Themes] [Usage] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  LAYOUT TAB (active)                                     │
│  ┌─────────────────────────────┬────────────────────┐   │
│  │                             │  PALETTE           │   │
│  │   FLOOR PLAN EDITOR        │  ┌──────────────┐  │   │
│  │                             │  │ 🪑 Desk       │  │   │
│  │   (drag-and-drop zones,    │  │ 🚪 Meeting Rm │  │   │
│  │    resize rooms,           │  │ 📋 Queue       │  │   │
│  │    place furniture)        │  │ ⚠ Error Bay    │  │   │
│  │                             │  │ 🔧 Tool Stn   │  │   │
│  │                             │  │ 🚧 Gate        │  │   │
│  │                             │  └──────────────┘  │   │
│  │                             │                    │   │
│  │                             │  PROPERTIES        │   │
│  │                             │  Name: [........]  │   │
│  │                             │  Capacity: [4]     │   │
│  │                             │  Color: [🎨]       │   │
│  └─────────────────────────────┴────────────────────┘   │
│                                                          │
│  [Save Layout] [Reset to Default] [Import] [Export]      │
└─────────────────────────────────────────────────────────┘
```

**Admin Tabs:**

| Tab | Content |
|---|---|
| **Layout** | Drag-and-drop floor plan editor. Place desks, rooms, zones. Inspired by Claw3D's Phaser-based layout editor |
| **Assignments** | Map agents to desks. Auto-assign toggle. Department grouping |
| **Alerts** | Configure rules: "alert if >N agents blocked for >M minutes", webhook/Slack targets |
| **Themes** | Select built-in office skin or apply a Studio-generated custom theme |
| **Usage** | Mod performance metrics: render FPS, WebSocket latency, memory footprint, session count |

---

## 8. Interaction Design

### 8.1 Core Interaction Patterns

| Interaction | Context | Behavior |
|---|---|---|
| **Hover** | Any agent (2D or 3D) | Show tooltip: name, task summary, duration, status badge |
| **Click** | Agent | Open Agent Detail Drawer. In 3D, camera also smoothly zooms to agent |
| **Double-click** | Agent | Follow mode (3D) or center-and-zoom (2D) |
| **Right-click** | Agent | Context menu: Inspect, Reassign, Pause, Restart, Copy ID |
| **Shift+click** | Multiple agents | Multi-select for bulk operations |
| **Ctrl+F / Cmd+F** | Anywhere | Global search — agents, tasks, events |
| **Scroll** | Floor plan / 3D scene | Zoom |
| **Drag** | Floor plan background | Pan (2D); Rotate (3D orbit mode) |
| **Spacebar** | Replay view | Toggle play/pause |
| **[ and ]** | Replay view | Decrease / increase playback speed |
| **Esc** | Drawer, modal, search | Close/dismiss |
| **?** | Anywhere | Show keyboard shortcut overlay |
| **Ctrl+Z / Cmd+Z** | Studio placement mode | Undo last placement action |

### 8.2 Studio-Specific Interactions

| Interaction | Context | Behavior |
|---|---|---|
| **Enter** | Concept prompt field | Submit prompt to ComfyUI |
| **Click image** | Concept board | Select/deselect for approval |
| **Drag asset** | Asset Library → 3D scene | Place asset into slot or free position |
| **Click placed asset** | Placement mode | Show transform gizmo (translate, rotate, scale) |
| **Delete / Backspace** | Selected placed asset | Remove from scene (with confirmation) |
| **G / R / S** | Selected placed asset | Switch gizmo: Grab, Rotate, Scale (Blender convention) |
| **Right-click asset** | Asset Library | Context menu: Preview, Edit, Delete, Download |

### 8.3 Real-Time Visual Feedback

When an event occurs on the WebSocket, the UI reacts within one frame:

| Event | 2D Reaction | 3D Reaction |
|---|---|---|
| Agent starts task | Status ring → green, desk lamp turns on | Agent sits down, starts typing animation |
| Agent completes task | Brief green flash, checkmark overlay | Confetti particle burst, agent stands and stretches |
| Agent error | Red pulse ring, moves to error bay | Red tint on agent, slump animation, warning particle |
| Agent enters meeting | Walks to meeting room zone | Walking animation to room, sits in chair |
| Tool call fired | Gear icon animates on desk | Holographic tool icon appears, sparkle particles |
| Agent blocked | Amber barrier graphic appears | Semi-transparent wall materializes in front of agent |
| Agent goes offline | Desk grays out, avatar fades | Agent fades to ghost, desk light turns off |
| New agent spawns | Fade-in at empty desk | Portal swirl effect, agent materializes |
| Agent waiting approval | Purple hourglass overlay | Agent raises hand, purple aura pulses |
| Collaboration initiated | Dashed line between agents | Glowing arc with data-stream particles |

### 8.4 Interaction Objects Glossary

| Object | Where | Interaction |
|---|---|---|
| **Desk** | 2D/3D | Click → inspect agent. Drag → reassign (admin). Empty desk shows "Assign" dropdown |
| **Room** | 2D/3D | Click → list agents inside. Rooms have capacity limits and types (meeting, war room, focus) |
| **Queue** | 2D/3D | Click → expand task list. Tasks can be dragged to agent desks |
| **Alert** | 2D/3D | Click → opens Agent Detail Drawer for the affected agent. Bell icon pulses |
| **Hologram** | 3D only | Floating skill/tool icon above desk. Click → tool call detail in drawer |
| **Tool-Call Effect** | 3D only | Particle burst for API calls. Hover → tooltip: "POST /api/v2/auth, 200ms" |
| **Portal** | 3D only | Swirl effect on spawn/despawn. Hover → "Agent-07 spawning, ETA 3s" |
| **Meeting** | 2D/3D | Visual grouping of agents in collaboration. Click room → see conversation thread |
| **Collaboration Arc** | 3D only | Glowing line between agents. Hover → "Agent-01 → Agent-04: code review handoff" |
| **Timeline Scrubber** | Replay | Drag → scrub through time. Click event marker → jump to moment |
| **Asset Slot** | Studio placement | Dashed outline in edit mode. Drag asset to fill. Glow when compatible asset hovers |

---

## 9. Visual Semantics — Agent States

A unified state vocabulary used across 2D, 3D, dashboard, and drawer:

| State | Color | 2D Icon | 3D Animation | Ring/Badge |
|---|---|---|---|---|
| **Idle** | Gray `#6b7280` | Static avatar, dim desk | Standing by desk, arms at sides | Thin gray ring |
| **Active** | Green `#22c55e` | Bright avatar, lamp on | Typing at keyboard | Solid green ring |
| **Coding** | Emerald `#10b981` | Code brackets overlay | Fast typing, code hologram | Green ring + `</>` badge |
| **Blocked** | Amber `#f59e0b` | Barrier icon, pulsing | Arms crossed, barrier wall | Pulsing amber ring |
| **Error** | Red `#ef4444` | Error triangle, red desk | Slumped, red particles | Thick red ring |
| **Waiting Approval** | Purple `#a855f7` | Hourglass + hand icon | Looking at camera, hand raised | Purple ring + clock |
| **In Meeting** | Blue `#3b82f6` | In meeting room zone | Sitting in meeting room, gesturing | Blue ring |
| **Offline** | Dark gray `#374151` | Ghosted/faded avatar | Transparent ghost, desk dark | Dashed gray ring |
| **Spawning** | Cyan `#06b6d4` | Fade-in animation | Portal swirl effect | Expanding cyan ring |
| **Tool Calling** | Gold `#eab308` | Gear icon on desk | Holographic tool icon | Gold ring + tool icon |

Every state uses **triple encoding**: color + icon + label. Color is never the sole differentiator.

---

## 10. Visual Language & Design System

### 10.1 Design Principles

1. **Dark-first**: Dark mode is the default and primary experience. Light mode is supported but secondary
2. **Premium cinematic feel**: Glass morphism, subtle gradients, smooth 60fps animations. No janky transitions
3. **Information density without clutter**: Show everything that matters, hide everything that doesn't. Progressive disclosure
4. **AI company headquarters vibe**: The office should feel like a premium tech HQ — sleek, organized, impressive. Not a toy or a game
5. **Consistent with Agent Guild**: Inherits Agent Guild's amber primary (`#fbbf24`), dark blue backgrounds (`hsl(222, 84%, 5%)`), and shadcn/ui component patterns
6. **Modular panels**: Every section of the UI is a resizable, collapsible panel. Users control information density
7. **Multiplayer feel**: The office should feel like a shared space — activity feed, presence indicators, and real-time updates reinforce this

### 10.2 Color Palette

```
Primary:       hsl(48, 100%, 50%)   — Amber/Gold (Agent Guild accent)
Background:    hsl(222, 84%, 5%)    — Deep navy
Card:          hsl(222, 50%, 10%)   — Dark blue card
Border:        hsl(217, 33%, 18%)   — Subtle edge
Text Primary:  hsl(210, 40%, 98%)   — Off-white
Text Muted:    hsl(215, 20%, 65%)   — Gray text
Success:       hsl(142, 71%, 45%)   — Green
Warning:       hsl(38, 92%, 50%)    — Amber
Error:         hsl(0, 84%, 60%)     — Red
Info:          hsl(217, 91%, 60%)   — Blue
Premium:       hsl(270, 50%, 60%)   — Purple (Studio accent)
Studio:        hsl(280, 65%, 55%)   — Violet (Studio mode indicator)
```

### 10.3 Typography

- **Font**: Inter (matches Agent Guild app)
- **Headers**: `font-bold`, `text-lg` to `text-2xl`
- **Body**: `text-sm` (14px)
- **Labels/badges**: `text-xs` (12px) or `text-[10px]`
- **Monospace** (logs, IDs, prompts): `font-mono text-xs`

### 10.4 Component Patterns

- **Cards**: Glass-morphism with `backdrop-blur-xl`, `bg-card/80`, `border-border`, hover glow
- **Badges**: Colored backgrounds at 10% opacity, matching text color, `text-[10px]` with icon
- **Buttons**: Primary amber (`bg-amber-500 text-black`), secondary outline (`border-amber-500/30`), Studio actions use purple variant
- **Drawer**: `w-[400px]` slide from right, backdrop blur, `z-50`
- **Tabs**: Bottom-border style matching Agent Guild marketplace tabs
- **Modular Panels**: Every section of the office view is a resizable panel. Users can collapse/expand side panels, bottom trays, and the toolbar
- **Generation Progress**: Indeterminate shimmer bar for ComfyUI, percentage bar for Meshy (API provides progress)
- **Concept Board**: 2x2 image grid with rounded corners, hover-to-enlarge, action buttons on overlay
- **3D Preview Card**: Inline R3F canvas with orbit controls, dark background, subtle floor plane

### 10.5 Motion & Animation

- All transitions: `200ms ease-out` (CSS) or `lerp(0.08)` (3D camera)
- Agent movement: smooth interpolation between positions, never teleport
- Status changes: 300ms color transition with brief scale pulse (1.0 → 1.05 → 1.0)
- Drawer: slide in 250ms with spring easing
- 3D particles: GPU-instanced, max 500 particles per effect, auto-recycle pool
- Concept board image loading: skeleton shimmer → fade-in on load
- Asset placement: snap-to-slot with 100ms magnetic pull animation

---

## 11. Accessibility

### 11.1 WCAG 2.1 AA Compliance

| Requirement | Implementation |
|---|---|
| **Color contrast** | All text meets 4.5:1 ratio. Status colors paired with icons, never color-alone |
| **Keyboard navigation** | Full keyboard support: Tab through agents, Enter to inspect, Esc to close |
| **Screen reader** | `aria-label` on all agent nodes, `aria-live="polite"` on activity feeds |
| **Reduced motion** | `prefers-reduced-motion` disables all animations, 3D falls back to static positions |
| **Focus indicators** | Visible focus ring (amber) on all interactive elements |
| **Alt text** | Agent avatars include descriptive alt: "Agent Cipher, status: error, task: audit middleware" |

### 11.2 Cognitive Accessibility

- Agent states use **icon + color + label** (triple encoding) — never color alone
- Tooltips explain every icon and abbreviation
- Demo mode strips away advanced controls for simplified presentation
- Admin can configure "simplified view" that shows only desk + status, hiding effects
- Studio mode uses plain-language labels: "Generate Concepts" not "Run ComfyUI Pipeline"

### 11.3 Studio Accessibility

- Concept board images have alt text derived from the generation prompt
- 3D asset preview includes text description: "Desk, 12,412 polygons, cyberpunk style"
- Placement mode supports keyboard: arrow keys for position, `[`/`]` for rotation, `+`/`-` for scale
- All generation status updates announced via `aria-live` regions
- Color-blind safe: approved/dismissed assets use checkmark/X icons, not just green/red

### 11.4 Device Fallbacks

- On mobile or devices with `prefers-reduced-motion`, default to 2D view
- 3D view requires WebGL2 support — graceful fallback message with link to 2D
- Low-end device detection: if `navigator.hardwareConcurrency < 4`, suggest 2D
- Studio 3D preview uses a lower-complexity renderer than the full office scene
- Concept generation and asset generation work regardless of GPU capability (server-side)

---

## 12. Performance Constraints

### 12.1 Targets

| Metric | Target | Measurement |
|---|---|---|
| **2D render** | 60 FPS with 50 agents | Chrome DevTools Performance panel |
| **3D render** | 30 FPS with 20 agents, 60 FPS with 10 | R3F performance monitor |
| **First paint** | < 1.5s (2D), < 3s (3D) | Lighthouse |
| **WebSocket latency** | < 100ms state update reflection | Timestamp diff |
| **Memory** | < 200MB (2D), < 500MB (3D) | Chrome Task Manager |
| **Bundle size** | < 150KB initial (2D), 3D lazy-loaded | Webpack analyzer |
| **Time to interactive** | < 2s (2D), < 4s (3D) | Lighthouse TTI |
| **ComfyUI concept generation** | < 30s for 4 images | Client-side timer |
| **Meshy 3D generation** | < 120s per asset | API progress polling |
| **Studio 3D preview** | 60 FPS single asset | R3F performance monitor |
| **Custom asset load** | < 2s per GLB file | Network + parse time |

### 12.2 Optimization Strategies

- **3D lazy-loading**: The entire React Three Fiber scene is code-split. Only loaded when user navigates to 3D view
- **Agent LOD (Level of Detail)**: Agents far from camera render as simple sprites. Full model only when close
- **Frustum culling**: Agents outside camera view are not rendered
- **Instanced meshes**: Desk geometry is instanced — one draw call for all desks
- **WebSocket batching**: Updates batched into 16ms frames, not per-event
- **Virtualized lists**: Activity feeds and event logs use virtual scrolling (only render visible rows)
- **SVG optimization**: 2D floor plan uses CSS transforms, not SVG re-renders, for animation
- **Replay**: Events stored as deltas, reconstructed on scrub. Not full snapshots per frame
- **Custom asset caching**: Generated GLB files cached in IndexedDB after first load
- **Texture compression**: Custom assets auto-compressed to KTX2 on import for GPU efficiency
- **Concept image caching**: ComfyUI outputs cached locally with prompt hash as key

### 12.3 Degradation Tiers

| Tier | Trigger | Response |
|---|---|---|
| **Full** | Desktop, WebGL2, >4 cores | All features, 3D enabled, particles, post-processing, Studio 3D preview |
| **Reduced** | Laptop, integrated GPU | 3D available but no post-processing, reduced particles, simpler Studio preview |
| **Minimal** | Mobile, no WebGL, `prefers-reduced-motion` | 2D only, no animation, static positions, Studio concept-only (no 3D preview) |
| **Server-rendered** | SSR/bot crawl | Static HTML summary dashboard, no interactive office, no Studio |

### 12.4 Studio-Specific Performance

- ComfyUI and Meshy calls are server-side proxied — no direct client-to-external API calls
- Generation jobs are queued and polled, not blocking the UI thread
- 3D asset preview canvas is separate from the main office canvas — isolated WebGL context
- Maximum 50 custom assets per theme (to prevent scene overload)
- Assets exceeding 100k polygons trigger a warning with "simplify" option
- Concept board images stored as WebP, max 1024x1024, lazy-loaded thumbnails

---

## 13. MVP UX Scope

### Must Have (v1.0)

- [ ] Home Dashboard with overview cards and agent status grid
- [ ] 2D Office view with desk zones, meeting rooms, queue, and error bay
- [ ] Agent states: idle, active, error, blocked, offline (5 of 10)
- [ ] Agent Detail Drawer with current task, recent activity, and basic actions
- [ ] Real-time WebSocket updates from Agent Guild hub
- [ ] Hover tooltips and click-to-inspect on all agents
- [ ] Filter by status
- [ ] Search agents by name
- [ ] Dark mode (default)
- [ ] Responsive: 2D works on tablet, dashboard works on mobile
- [ ] Sidebar registration under "Modifications" section

### Should Have (v1.0 stretch)

- [ ] 3D Office view with basic agent models and desk scene
- [ ] Camera modes: orbit and follow
- [ ] Speech bubbles showing current agent output
- [ ] Collaboration lines between agents
- [ ] Basic replay: scrubber + play/pause over last 1 hour
- [ ] Demo mode toggle (mask sensitive data)
- [ ] Keyboard navigation for 2D view
- [ ] Studio mode — Concept Generator only (ComfyUI integration, no Meshy yet)

### Deferred from MVP (v1.0 cut)

- Admin Panel layout editor
- Custom office themes/skins
- Replay export (video/link)
- 3D cinematic camera and first-person mode
- Tool-call particle effects
- Multi-org "floor" support
- Studio Asset Generator (Meshy integration)
- Studio Asset Placement mode
- Studio Theme Manager and marketplace publishing

---

## 14. Future UX Scope

### v1.1 — Polish & Power User

- Full 10-state visual vocabulary with 3D animations
- Admin Panel with layout editor (Phaser-based, inspired by Claw3D)
- Alert configuration with Slack/webhook integration
- Replay export as shareable link or MP4
- Keyboard shortcut cheat sheet (`?` key)
- Agent drag-and-drop assignment in 2D
- Cost overlay per agent (inspired by tenacitOS)
- Studio: Meshy Asset Generator integration (text-to-3D, image-to-3D)
- Studio: Asset Approval Drawer with revision history

### v1.2 — Cinematic & Creative

- 3D cinematic auto-camera mode
- First-person walkthrough (WASD)
- Multi-user cursors (see who else is viewing the office)
- Annotation mode: pin notes to agents or rooms
- Department grouping (inspired by claw-empire's 6-department model)
- Workflow pack visualizations: different office layouts per pack type
- Studio: Asset Placement mode with slot system
- Studio: Theme save, import/export, reset to default
- Studio: All 5 ComfyUI workflow types (office-theme, avatar-portrait, scene-style, vfx-concept, texture-sheet)

### v1.3 — Studio Maturity

- Studio: Theme Manager with local library
- Studio: Publish custom themes to Agent Guild marketplace
- Studio: Community theme browser (install one-click)
- Studio: Avatar Generator — per-agent character models from portrait concepts
- Studio: VFX Generator — custom particle effects from vfx-concept references
- Studio: Batch generation — queue multiple assets at once
- Studio: Style transfer — apply one concept's aesthetic to all asset categories

### v2.0 — Enterprise & Ecosystem

- Multi-floor view for multi-org deployments
- Compliance audit trail with replay certification
- AI narrator: LLM-generated voiceover for replay walkthroughs
- Embedded mode: `<iframe>` widget for external dashboards
- Plugin API: third-party widgets within office zones (charts, Kanban, terminals)
- VR headset support (WebXR) for fully immersive agent observation
- Studio: Collaborative editing — multiple team members editing themes simultaneously
- Studio: AI-assisted placement — "auto-furnish" office from a single theme prompt

---

*This document is a living specification. All wireframes are structural — final visual design will follow the Agent Guild design system with adaptations for spatial rendering and generative design.*
