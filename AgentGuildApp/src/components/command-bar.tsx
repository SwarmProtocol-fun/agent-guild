/** Command Bar (⌘K) — Universal search overlay for quick navigation to any page, agent, or project. */
"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Search, Command, ArrowRight,
  LayoutDashboard, LayoutGrid, MessageSquare, Users, Briefcase, Settings, Zap,
  Activity, BarChart3, Shield, Clock, Store, FolderKanban, UserCog, Coins,
  MapPinned, Building2, Brain, HardDrive, FileText, Network, Stethoscope, BookOpen,
} from "lucide-react";

// ═══════════════════════════════════════════════════════════════
// Routes & Actions
// ═══════════════════════════════════════════════════════════════

interface CommandItem {
    id: string;
    label: string;
    description?: string;
    icon: typeof Search;
    href?: string;
    action?: () => void;
    section: string;
}

const NAV_ITEMS: CommandItem[] = [
    // Navigate
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/dashboard", section: "Navigate" },
    { id: "projects", label: "Projects", icon: FolderKanban, href: "/swarms", section: "Navigate" },
    { id: "agents", label: "Agents", icon: Users, href: "/agents", section: "Navigate" },
    { id: "channels", label: "Channels", icon: MessageSquare, href: "/chat", section: "Navigate" },
    { id: "jobs", label: "Jobs", icon: Briefcase, href: "/jobs", section: "Navigate" },
    // Operate
    { id: "board", label: "Boards", icon: LayoutGrid, href: "/kanban", section: "Operate" },
    { id: "approvals", label: "Approvals", icon: Shield, href: "/approvals", section: "Operate" },
    { id: "operators", label: "Operators", icon: UserCog, href: "/operators", section: "Operate" },
    { id: "cron", label: "Scheduler", icon: Clock, href: "/cron", section: "Operate" },
    { id: "market", label: "Market", icon: Store, href: "/market", section: "Operate" },
    // Observe
    { id: "activity", label: "Activity", icon: Activity, href: "/activity", section: "Observe" },
    { id: "metrics", label: "Metrics", icon: BarChart3, href: "/metrics", section: "Observe" },
    { id: "usage", label: "Usage", icon: Coins, href: "/usage", section: "Observe" },
    { id: "agent-map", label: "Agent Map", icon: MapPinned, href: "/agent-map", section: "Observe" },
    // Platform
    { id: "organizations", label: "Organizations", icon: Building2, href: "/organizations", section: "Platform" },
    { id: "memory", label: "Memory", icon: HardDrive, href: "/memory", section: "Platform" },
    { id: "logs", label: "Logs", icon: FileText, href: "/logs", section: "Platform" },
    { id: "gateways", label: "Gateways", icon: Network, href: "/gateways", section: "Platform" },
    { id: "doctor", label: "Health", icon: Stethoscope, href: "/doctor", section: "Platform" },
    { id: "swarm", label: "Swarm Protocol", icon: Zap, href: "/swarm", section: "Platform" },
    // Quick
    { id: "docs", label: "Docs", icon: BookOpen, href: "/docs", section: "Quick" },
    { id: "settings", label: "Settings", icon: Settings, href: "/settings", section: "Quick" },
];

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function CommandBar() {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const router = useRouter();
    const pathname = usePathname();

    // Filter items
    const filtered = useMemo(() => {
        if (!query.trim()) return NAV_ITEMS;
        const q = query.toLowerCase();
        return NAV_ITEMS.filter(
            item => item.label.toLowerCase().includes(q) ||
                item.description?.toLowerCase().includes(q) ||
                item.section.toLowerCase().includes(q)
        );
    }, [query]);

    // Reset on open
    useEffect(() => {
        if (open) {
            setQuery("");
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [open]);

    // Keyboard shortcut
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "k") {
                e.preventDefault();
                setOpen(prev => !prev);
            }
            if (e.key === "Escape") setOpen(false);
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    // Execute action
    const execute = useCallback((item: CommandItem) => {
        setOpen(false);
        if (item.href) router.push(item.href);
        if (item.action) item.action();
    }, [router]);

    // Keyboard nav
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1));
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            setSelectedIndex(prev => Math.max(prev - 1, 0));
        }
        if (e.key === "Enter" && filtered[selectedIndex]) {
            execute(filtered[selectedIndex]);
        }
    };

    // Scroll into view
    useEffect(() => {
        const el = listRef.current?.children[selectedIndex] as HTMLElement;
        el?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    // Reset index on filter change
    useEffect(() => { setSelectedIndex(0); }, [query]);

    if (!open) return null;

    // Group by section
    const groupedSections = new Map<string, CommandItem[]>();
    for (const item of filtered) {
        const arr = groupedSections.get(item.section) || [];
        arr.push(item);
        groupedSections.set(item.section, arr);
    }

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
                onClick={() => setOpen(false)}
            />

            {/* Dialog */}
            <div className="fixed inset-0 flex items-start justify-center pt-[20vh] z-50 pointer-events-none">
                <div className="w-full max-w-lg bg-card border border-border rounded-xl shadow-2xl pointer-events-auto overflow-hidden">
                    {/* Search input */}
                    <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
                        <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                        <input
                            ref={inputRef}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Search commands..."
                            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                        />
                        <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border font-mono">
                            ESC
                        </kbd>
                    </div>

                    {/* Results */}
                    <div ref={listRef} className="max-h-[300px] overflow-y-auto py-1">
                        {filtered.length === 0 ? (
                            <div className="py-8 text-center text-sm text-muted-foreground">
                                No results for &ldquo;{query}&rdquo;
                            </div>
                        ) : (
                            Array.from(groupedSections.entries()).map(([section, items]) => (
                                <div key={section}>
                                    <div className="px-3 py-1.5">
                                        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{section}</span>
                                    </div>
                                    {items.map((item) => {
                                        const globalIdx = filtered.indexOf(item);
                                        const isActive = pathname === item.href;
                                        return (
                                            <button
                                                key={item.id}
                                                onClick={() => execute(item)}
                                                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${globalIdx === selectedIndex
                                                        ? "bg-amber-500/10 text-amber-400"
                                                        : "text-foreground hover:bg-muted/50"
                                                    }`}
                                            >
                                                <item.icon className="h-4 w-4 shrink-0 opacity-60" />
                                                <span className="flex-1 text-sm">{item.label}</span>
                                                {isActive && (
                                                    <Badge className="text-[9px] bg-amber-500/20 text-amber-400 border-0">Current</Badge>
                                                )}
                                                {globalIdx === selectedIndex && (
                                                    <ArrowRight className="h-3 w-3 opacity-40" />
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            ))
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-2 border-t border-border flex items-center justify-between text-[10px] text-muted-foreground">
                        <span className="flex items-center gap-1">
                            <Command className="h-2.5 w-2.5" />K to toggle
                        </span>
                        <span>↑↓ navigate · ↵ select</span>
                    </div>
                </div>
            </div>
        </>
    );
}

// Badge inline (reused from shadcn)
function Badge({ className, children, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
    return (
        <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-xs font-medium ${className}`} {...props}>
            {children}
        </span>
    );
}
