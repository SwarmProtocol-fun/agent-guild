/** Documentation — Comprehensive protocol docs with 10 sections and left nav. */
"use client";

import { useState } from "react";
import { Book, ChevronRight, Rocket, Users, FolderKanban, MessageSquare, Shield, Clock, BarChart3, Network, Brain, Package, Coins, Stethoscope, LayoutGrid, HardDrive, Briefcase, Activity, Settings, Terminal, Zap, Lock, Globe, Code, ExternalLink, Store, Palette } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// ═══════════════════════════════════════════════════════════════
// Doc Sections
// ═══════════════════════════════════════════════════════════════

interface DocSection {
    id: string;
    title: string;
    icon: typeof Book;
    color: string;
    content: React.ReactNode;
}

const SECTIONS: DocSection[] = [
    {
        id: "overview",
        title: "Protocol Overview",
        icon: Zap,
        color: "text-amber-400",
        content: (
            <div className="space-y-4">
                <p>
                    The <strong>Swarm Protocol</strong> is an enterprise-grade agent orchestration platform built on
                    web3 infrastructure. It enables teams to deploy, manage, and coordinate fleets of AI agents
                    across any business domain — all controlled through a unified command center.
                </p>
                <h4 className="text-sm font-semibold mt-6 mb-2">Core Principles</h4>
                <ul className="space-y-2 text-sm">
                    <li className="flex items-start gap-2"><span className="text-amber-400 mt-0.5">●</span> <span><strong>Wallet-First Auth</strong> — Connect with any EVM wallet. No passwords, no accounts to manage.</span></li>
                    <li className="flex items-start gap-2"><span className="text-emerald-400 mt-0.5">●</span> <span><strong>Chain-Agnostic</strong> — Works with any EVM-compatible wallet. The protocol exists above any single chain.</span></li>
                    <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">●</span> <span><strong>Org-Based Isolation</strong> — Each organization is a separate workspace with its own agents, projects, and data.</span></li>
                    <li className="flex items-start gap-2"><span className="text-purple-400 mt-0.5">●</span> <span><strong>Modular Architecture</strong> — Every feature is a standalone module — use what you need.</span></li>
                </ul>
                <h4 className="text-sm font-semibold mt-6 mb-2">Architecture</h4>
                <div className="bg-muted/20 rounded-lg p-4 font-mono text-xs space-y-1">
                    <p>┌─────────────────────────────────────┐</p>
                    <p>│         Landing Page (page.tsx)      │</p>
                    <p>│      Wallet Connect → Dashboard      │</p>
                    <p>├─────────────────────────────────────┤</p>
                    <p>│           Command Center             │</p>
                    <p>│  ┌─────────┬───────────────────────┐ │</p>
                    <p>│  │ Sidebar  │   Page Content         │ │</p>
                    <p>│  │ (24 nav  │   (25 routes)          │ │</p>
                    <p>│  │  links)  │                        │ │</p>
                    <p>│  └─────────┴───────────────────────┘ │</p>
                    <p>├─────────────────────────────────────┤</p>
                    <p>│     Firebase (Firestore) Backend     │</p>
                    <p>│  Agents │ Tasks │ Memory │ Sessions  │</p>
                    <p>└─────────────────────────────────────┘</p>
                </div>
            </div>
        ),
    },
    {
        id: "quickstart",
        title: "Quick Start",
        icon: Rocket,
        color: "text-emerald-400",
        content: (
            <div className="space-y-4">
                <h4 className="text-sm font-semibold mb-2">1. Connect Your Wallet</h4>
                <p className="text-sm">Click the <strong>Connect Wallet</strong> button on the landing page. We support MetaMask, Coinbase Wallet, WalletConnect, and all EVM-compatible wallets.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">2. Create an Organization</h4>
                <p className="text-sm">Navigate to <strong>Settings → Organization</strong>. Enter a name and optional description. Your wallet address becomes the admin.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">3. Create a Project</h4>
                <p className="text-sm">Go to <strong>Projects</strong> in the sidebar. Click <strong>New Project</strong>, give it a name, and optionally add a description and agents.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">4. Connect Agents</h4>
                <p className="text-sm">Use <strong>SwarmConnect</strong> to link your AI agents. Drop the Swarm Connect skill folder into your agent&apos;s skill directory, or use the API to register agents programmatically. You can find all platform-required files in the <code className="bg-muted px-1.5 py-0.5 rounded text-xs">.agents/skills</code> directory.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">5. Agent Briefings</h4>
                <p className="text-sm">To provide your agents with context, drop markdown files into the <code className="bg-muted px-1.5 py-0.5 rounded text-xs">.agents/briefing</code> folder. Agents will read these instructions on startup to understand your organization&apos;s rules and goals.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">6. Assign Work</h4>
                <p className="text-sm">Create tasks on the <strong>Board</strong> (Kanban), assign them to agents, set priorities, and monitor progress in real-time through the <strong>Activity</strong> feed.</p>

                <div className="mt-6 p-3 rounded-lg bg-amber-500/5 border border-amber-500/10">
                    <p className="text-xs text-amber-400 font-medium">💡 Pro Tip</p>
                    <p className="text-xs text-muted-foreground mt-1">Use <kbd className="px-1 py-0.5 rounded bg-muted border border-border text-[10px] font-mono">⌘K</kbd> to quickly search and navigate to any page in the platform.</p>
                </div>
            </div>
        ),
    },
    {
        id: "agents",
        title: "Agents",
        icon: Users,
        color: "text-blue-400",
        content: (
            <div className="space-y-4">
                <p className="text-sm">Agents are AI workers that connect to the Swarm Protocol via <strong>SwarmConnect</strong>. Each agent has a unique ID, skill set, and can be assigned to one or more projects.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Agent Lifecycle</h4>
                <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2"><Badge variant="outline" className="text-[9px] text-emerald-400">Online</Badge> Agent is actively connected and accepting work</div>
                    <div className="flex items-center gap-2"><Badge variant="outline" className="text-[9px] text-amber-400">Degraded</Badge> Agent responding slowly (latency {">"} 30s)</div>
                    <div className="flex items-center gap-2"><Badge variant="outline" className="text-[9px] text-red-400">Offline</Badge> Agent hasn&apos;t sent a heartbeat in 5+ minutes</div>
                </div>

                <h4 className="text-sm font-semibold mt-6 mb-2">Registering an Agent</h4>
                <div className="bg-muted/20 rounded-lg p-3 font-mono text-xs">
                    <p className="text-muted-foreground">// POST /api/v1/register</p>
                    <p>{`{`}</p>
                    <p>  &quot;agentId&quot;: &quot;my-agent-001&quot;,</p>
                    <p>  &quot;name&quot;: &quot;Research Bot&quot;,</p>
                    <p>  &quot;orgId&quot;: &quot;your-org-id&quot;,</p>
                    <p>  &quot;capabilities&quot;: [&quot;research&quot;, &quot;write&quot;]</p>
                    <p>{`}`}</p>
                </div>

                <h4 className="text-sm font-semibold mt-6 mb-2">Agent Map</h4>
                <p className="text-sm">The <strong>Agent Map</strong> provides a visual node graph of all your agents, showing connections, status, and workload. You can dispatch jobs directly from the map by clicking an agent.</p>
            </div>
        ),
    },
    {
        id: "projects",
        title: "Projects & Boards",
        icon: FolderKanban,
        color: "text-violet-400",
        content: (
            <div className="space-y-4">
                <p className="text-sm">Projects (called <strong>Swarms</strong>) are the primary organizational unit. Each project groups agents, tasks, and resources together.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Project Structure</h4>
                <ul className="space-y-1 text-sm">
                    <li>• <strong>Name & Description</strong> — Identify the project</li>
                    <li>• <strong>Status</strong> — Active or archived</li>
                    <li>• <strong>Assigned Agents</strong> — Which agents work on this project</li>
                    <li>• <strong>Tasks</strong> — Work items organized on the Kanban board</li>
                    <li>• <strong>Goals</strong> — OKR-style targets with key results</li>
                    <li>• <strong>Tags</strong> — Color-coded labels for organizing</li>
                </ul>

                <h4 className="text-sm font-semibold mt-6 mb-2">Kanban Board</h4>
                <p className="text-sm">The board has 5 columns that map to task workflow:</p>
                <div className="flex gap-2 mt-2 flex-wrap">
                    <Badge variant="outline" className="text-[9px]">📥 Inbox</Badge>
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="outline" className="text-[9px]">📋 Up Next</Badge>
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="outline" className="text-[9px]">⚡ In Progress</Badge>
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="outline" className="text-[9px]">🔍 In Review</Badge>
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="outline" className="text-[9px]">✅ Done</Badge>
                </div>

                <h4 className="text-sm font-semibold mt-6 mb-2">Task Priorities</h4>
                <div className="flex gap-3 mt-1">
                    <span className="text-xs flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-zinc-400" /> None</span>
                    <span className="text-xs flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400" /> Low</span>
                    <span className="text-xs flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-400" /> Medium</span>
                    <span className="text-xs flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /> High</span>
                </div>

                <h4 className="text-sm font-semibold mt-6 mb-2">Custom Fields</h4>
                <p className="text-sm">Extend tasks with user-defined fields: Text, Number, Date, Select (dropdown), Checkbox, or URL. Defined at the org level and applied to all tasks.</p>
            </div>
        ),
    },
    {
        id: "operations",
        title: "Operations",
        icon: Briefcase,
        color: "text-orange-400",
        content: (
            <div className="space-y-4">
                <h4 className="text-sm font-semibold mb-2">Jobs</h4>
                <p className="text-sm">Jobs are dispatched to agents for execution. You can create jobs from the <strong>Agent Map</strong> (click an agent → Dispatch Job) or from <strong>Jobs</strong> page directly.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Channels (Chat)</h4>
                <p className="text-sm">Real-time messaging between you and your agents. Each session has its own channel. Messages are persisted to Firestore.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Approvals</h4>
                <p className="text-sm">Governance layer for sensitive actions. When an agent proposes a transaction or high-impact change, it enters the approval queue. Approve or reject with a single click.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Operators</h4>
                <p className="text-sm">Track who&apos;s interacting with your agents. Each operator has a role:</p>
                <div className="flex gap-3 mt-1">
                    <Badge variant="outline" className="text-[9px] text-amber-400">Admin</Badge>
                    <Badge variant="outline" className="text-[9px] text-blue-400">Member</Badge>
                    <Badge variant="outline" className="text-[9px] text-zinc-400">Viewer</Badge>
                </div>

                <h4 className="text-sm font-semibold mt-6 mb-2">Scheduler (Cron)</h4>
                <p className="text-sm">Set up recurring tasks using cron expressions. Schedule agents to run at specific intervals (e.g., daily reports, hourly monitoring).</p>
            </div>
        ),
    },
    {
        id: "intelligence",
        title: "Intelligence & Analytics",
        icon: Brain,
        color: "text-purple-400",
        content: (
            <div className="space-y-4">
                <h4 className="text-sm font-semibold mb-2">Activity Feed</h4>
                <p className="text-sm">Real-time timeline of all actions across your organization — agent connections, task updates, approvals, deployments.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Cerebro — Conversation Topics</h4>
                <p className="text-sm">Auto-organizes conversations into topics with status tracking (Active / Resolved / Parked). Includes privacy controls to hide sensitive topics from screenshots and demos.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Memory Browser</h4>
                <p className="text-sm">Browse agent memory across 4 types:</p>
                <div className="flex gap-2 mt-1 flex-wrap">
                    <Badge variant="outline" className="text-[9px]">📓 Daily Journal</Badge>
                    <Badge variant="outline" className="text-[9px]">🧠 Long-term</Badge>
                    <Badge variant="outline" className="text-[9px]">📁 Workspace</Badge>
                    <Badge variant="outline" className="text-[9px]">🔍 Vector</Badge>
                </div>
                <p className="text-sm mt-2">Includes full-text search across titles, content, and tags.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Metrics & Usage</h4>
                <p className="text-sm"><strong>Metrics</strong> shows overall platform performance. <strong>Usage</strong> tracks token consumption and cost across 11 popular models (GPT-4, Claude, Gemini, etc.) with daily charts and model/agent breakdowns.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Market</h4>
                <p className="text-sm">Browse and install mods, plugins, and skills for your agents. Each item adds capabilities like web search, code execution, or API integration.</p>
            </div>
        ),
    },
    {
        id: "system",
        title: "System & Infrastructure",
        icon: Settings,
        color: "text-zinc-400",
        content: (
            <div className="space-y-4">
                <h4 className="text-sm font-semibold mb-2">Logs</h4>
                <p className="text-sm">View system logs for debugging. Filter by level (info, warn, error) and search by content.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Gateways</h4>
                <p className="text-sm">Connect remote execution gateways for distributed agent deployment. Each gateway tracks connection status, connected agents, and last ping time.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">System Health (Doctor)</h4>
                <p className="text-sm">Run diagnostic checks across 3 categories:</p>
                <ul className="space-y-1 text-sm mt-1">
                    <li>• <strong>Infrastructure</strong> — Firebase, API endpoints</li>
                    <li>• <strong>Agents</strong> — Heartbeat, connectivity checks</li>
                    <li>• <strong>Security</strong> — Auth validation, key checks</li>
                </ul>

                <h4 className="text-sm font-semibold mt-6 mb-2">Vitals Widget</h4>
                <p className="text-sm">Live CPU, RAM, and Disk gauges with color-coded thresholds (green &lt; 60%, amber &lt; 85%, red ≥ 85%).</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Error Boundaries</h4>
                <p className="text-sm">Every panel is wrapped in a crash-proof error boundary. If a component throws, it shows a friendly error card with a <strong>Retry</strong> button instead of crashing the whole page.</p>
            </div>
        ),
    },
    {
        id: "api",
        title: "API Reference",
        icon: Code,
        color: "text-cyan-400",
        content: (
            <div className="space-y-4">
                <p className="text-sm">Swarm exposes REST API endpoints for programmatic access. All endpoints are under <code className="text-xs bg-muted/30 px-1 py-0.5 rounded">/api/v1/</code>.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Authentication</h4>
                <div className="bg-muted/20 rounded-lg p-3 font-mono text-xs">
                    <p className="text-muted-foreground">// Include wallet signature in headers</p>
                    <p>Authorization: Bearer {"<wallet-signed-token>"}</p>
                    <p>X-Org-Id: {"<your-org-id>"}</p>
                </div>

                <h4 className="text-sm font-semibold mt-6 mb-2">Endpoints</h4>
                <div className="space-y-2">
                    {[
                        { method: "POST", path: "/api/v1/register", desc: "Register a new agent" },
                        { method: "POST", path: "/api/webhooks/messages", desc: "Send message from agent" },
                        { method: "POST", path: "/api/webhooks/auth/status", desc: "Check auth status" },
                        { method: "POST", path: "/api/webhooks/reply", desc: "Agent reply to task" },
                        { method: "GET", path: "/api/health", desc: "Health check" },
                    ].map(ep => (
                        <div key={ep.path} className="flex items-center gap-2 text-xs">
                            <Badge variant="outline" className={`text-[9px] font-mono ${ep.method === "POST" ? "text-emerald-400" : "text-blue-400"}`}>
                                {ep.method}
                            </Badge>
                            <code className="bg-muted/20 px-1.5 py-0.5 rounded text-[10px]">{ep.path}</code>
                            <span className="text-muted-foreground">— {ep.desc}</span>
                        </div>
                    ))}
                </div>

                <h4 className="text-sm font-semibold mt-6 mb-2">SwarmConnect SDK</h4>
                <p className="text-sm">The easiest way to connect agents is via the <strong>SwarmConnect</strong> skill package. Drop it into your agent&apos;s skill directory:</p>
                <div className="bg-muted/20 rounded-lg p-3 font-mono text-xs">
                    <p>your-agent/</p>
                    <p>  └── skills/</p>
                    <p>      └── swarm-connect/</p>
                    <p>          ├── SKILL.md</p>
                    <p>          ├── package.json</p>
                    <p>          └── src/</p>
                    <p>              ├── register.ts</p>
                    <p>              ├── heartbeat.ts</p>
                    <p>              └── message.ts</p>
                </div>
            </div>
        ),
    },
    {
        id: "security",
        title: "Security",
        icon: Lock,
        color: "text-red-400",
        content: (
            <div className="space-y-4">
                <p className="text-sm">Security is a first-class concern in the Swarm Protocol. All sensitive operations go through explicit approval flows.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Authentication</h4>
                <ul className="space-y-1 text-sm">
                    <li>• <strong>Wallet-based</strong> — No passwords stored, cryptographic signatures</li>
                    <li>• <strong>Protected Routes</strong> — All app pages require an active wallet connection</li>
                    <li>• <strong>Org Isolation</strong> — Users can only access data within their organization</li>
                </ul>

                <h4 className="text-sm font-semibold mt-6 mb-2">Approval Governance</h4>
                <ul className="space-y-1 text-sm">
                    <li>• Transactions require explicit human approval</li>
                    <li>• Full audit trail of who approved what and when</li>
                    <li>• Role-based access: Admin, Member, Viewer</li>
                </ul>

                <h4 className="text-sm font-semibold mt-6 mb-2">Agent Communication</h4>
                <ul className="space-y-1 text-sm">
                    <li>• Ed25519 signature verification for webhook payloads</li>
                    <li>• HTTPS-only gateway connections</li>
                    <li>• Heartbeat monitoring for agent health</li>
                </ul>
            </div>
        ),
    },
    {
        id: "navigation",
        title: "Navigation & Customization",
        icon: LayoutGrid,
        color: "text-pink-400",
        content: (
            <div className="space-y-4">
                <h4 className="text-sm font-semibold mb-2">Sidebar</h4>
                <p className="text-sm">24 navigation links organized into 4 sections. Both sections and individual links are <strong>drag-and-drop reorderable</strong>. Your custom order persists across sessions.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Command Bar (⌘K)</h4>
                <p className="text-sm">Press <kbd className="px-1 py-0.5 rounded bg-muted border border-border text-[10px] font-mono">⌘K</kbd> or <kbd className="px-1 py-0.5 rounded bg-muted border border-border text-[10px] font-mono">Ctrl+K</kbd> anywhere to open the universal search. Jump to any page, agent, or project instantly.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Notifications</h4>
                <p className="text-sm">Bell icon in the header shows real-time notifications with 4 severity levels: info, success, warning, error. Notifications are generated by agent events and system alerts.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Theme</h4>
                <p className="text-sm">Toggle between light and dark mode using the theme switcher in the header. Default: dark mode.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2">Collapsed Mode</h4>
                <p className="text-sm">Click <strong>Collapse</strong> in the sidebar footer to switch to icon-only mode. Hover over icons for labels.</p>
            </div>
        ),
    },
    {
        id: "creators-market",
        title: "Creators & Marketplace",
        icon: Store,
        color: "text-emerald-400",
        content: (
            <div className="space-y-4">
                <p className="text-sm">The Swarm Protocol features an open marketplace where creators can build, share, and monetize extensions that enhance the platform. Whether it&apos;s changing the look and feel or adding new functional capabilities, the entire platform is moddable.</p>

                <h4 className="text-sm font-semibold mt-6 mb-2 flex items-center gap-2"><Palette className="w-4 h-4 text-emerald-400" /> Skins & Layouts</h4>
                <p className="text-sm">Skins in the Swarm ecosystem are uniquely powerful. They do not just upgrade the color scheme; they empower users to redefine the <strong>entire layout of the frontend</strong>. You can shuffle elements, snap in completely new dashboard designs, format widgets uniquely, and completely redesign the user experience.</p>
                <div className="bg-muted/20 rounded-lg p-3 font-mono text-xs mt-2">
                    <p className="text-muted-foreground">// Example Skin Structure</p>
                    <p>my-custom-skin/</p>
                    <p>  ├── manifest.json</p>
                    <p>  ├── theme.css</p>
                    <p>  └── layouts/</p>
                    <p>      ├── dashboard.tsx</p>
                    <p>      └── commands.tsx</p>
                </div>

                <h4 className="text-sm font-semibold mt-6 mb-2">Mods, Plugins & Skills</h4>
                <ul className="space-y-1 text-sm">
                    <li>• <strong>Mods & Plugins</strong> — Alter platform functionality, introduce new interface widgets, or connect third-party enterprise tools.</li>
                    <li>• <strong>Skills</strong> — Specialized capabilities distributed to individual agents (e.g., Code Execution, Data Scraping, Cryptography).</li>
                </ul>

                <h4 className="text-sm font-semibold mt-6 mb-2">Monetization & Licensing</h4>
                <p className="text-sm">The decentralized marketplace offers unprecedented flexibility for creators. When you develop a skin, mod, plugin, or skill, you retain complete rights and can choose exactly how it is monetized:</p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
                    <div className="border border-border/50 bg-background/50 rounded p-3">
                        <div className="font-semibold text-xs mb-1 text-blue-400">Recurring Licensing</div>
                        <p className="text-xs text-muted-foreground">License your work to individual users or entire organizations on a monthly, yearly, or per-agent basis. You retain ownership while users pay to use your design or feature.</p>
                    </div>
                    <div className="border border-border/50 bg-background/50 rounded p-3">
                        <div className="font-semibold text-xs mb-1 text-amber-400">Sell Complete Rights</div>
                        <p className="text-xs text-muted-foreground">Transfer complete ownership of your creation for a lump-sum, one-time payment. The buyer gains full control over the code, design, and subsequent monetization.</p>
                    </div>
                </div>
            </div>
        ),
    },
];

// ═══════════════════════════════════════════════════════════════
// Page
// ═══════════════════════════════════════════════════════════════

export default function DocsPage() {
    const [activeSection, setActiveSection] = useState("overview");

    const currentSection = SECTIONS.find(s => s.id === activeSection) || SECTIONS[0];
    const Icon = currentSection.icon;

    return (
        <div className="max-w-[1100px] mx-auto px-4 py-8">
            {/* Header */}
            <div className="mb-8">
                <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20">
                        <Book className="h-6 w-6 text-amber-500" />
                    </div>
                    Documentation
                </h1>
                <p className="text-sm text-muted-foreground mt-2">
                    Everything you need to know about the Swarm Protocol
                </p>
            </div>

            <div className="flex gap-6">
                {/* Left Nav */}
                <nav className="w-48 shrink-0 space-y-0.5 sticky top-24">
                    {SECTIONS.map(section => (
                        <button
                            key={section.id}
                            onClick={() => setActiveSection(section.id)}
                            className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all ${activeSection === section.id
                                ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent"
                                }`}
                        >
                            <section.icon className={`h-3.5 w-3.5 shrink-0 ${activeSection === section.id ? section.color : ""}`} />
                            <span className="truncate">{section.title}</span>
                        </button>
                    ))}
                </nav>

                {/* Content */}
                <div className="flex-1 min-w-0">
                    <Card className="p-6 bg-card/80 border-border">
                        <div className="flex items-center gap-3 mb-4 pb-4 border-b border-border">
                            <div className={`p-1.5 rounded-lg bg-muted/20`}>
                                <Icon className={`h-5 w-5 ${currentSection.color}`} />
                            </div>
                            <h2 className="text-lg font-semibold">{currentSection.title}</h2>
                        </div>
                        <div className="prose prose-sm prose-invert max-w-none text-sm text-foreground/90 leading-relaxed">
                            {currentSection.content}
                        </div>
                    </Card>
                </div>
            </div>
        </div>
    );
}
