/** Sidebar — Draggable navigation with collapsible sections (Navigate/Operate/Observe/Platform/Modifications). */
"use client";

import { useState, useEffect, useCallback, useRef, type DragEvent } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useOrg } from "@/contexts/OrgContext";
import { useSession } from "@/contexts/SessionContext";
import { useSkin } from "@/contexts/SkinContext";
import { getOwnedItems, SKILL_REGISTRY } from "@/lib/skills";
import {
  LayoutDashboard, FolderKanban, Users, Briefcase, MessageSquare,
  LayoutGrid, Shield, Clock, Activity, BarChart3, Settings,
  Map, FileText, ChevronLeft, ChevronRight, ChevronDown, GripVertical,
  Command, Coins, Stethoscope, Brain, UserCog, Network, HardDrive, BookOpen, Store, Building2,
  Link as LinkIcon, Zap, Palette, Megaphone, Wrench, Plug, Puzzle, Sparkles,
  Monitor, Globe, Code as CodeIcon, Bot, ShieldAlert, Flag, Package, History,
  TrendingUp, DollarSign, Settings2, Database,
  Star, Search, X, Hexagon, Upload, Layers, Diamond, Landmark,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MaturityBadge } from "@/components/ui/maturity-badge";
import { MOD_MANIFESTS } from "@/lib/mods/generated/manifests";

/** Map iconName strings from sidebarConfig to lucide components */
const ICON_MAP: Record<string, typeof LayoutDashboard> = {
  Link: LinkIcon,
  Coins: Coins,
  Zap: Zap,
  Palette: Palette,
  Brain: Brain,
  Megaphone: Megaphone,
  Wrench: Wrench,
  Plug: Plug,
  Puzzle: Puzzle,
  Sparkles: Sparkles,
  Bot: Bot,
  ShieldAlert: ShieldAlert,
  Monitor: Monitor,
  DollarSign: DollarSign,
  Diamond: Diamond,
  Shield: Shield,
  Database: Database,
};

/** Default icon per item type for mods without explicit sidebarConfig */
const TYPE_ICON: Record<string, typeof LayoutDashboard> = {
  mod: Wrench,
  plugin: Plug,
  skill: Puzzle,
  skin: Palette,
};

/** Runtime mod ids (mods/<id>/) that are also marketplace items — their
 *  sidebar entry comes from ownership (refreshModSidebar), not the
 *  always-on runtime-mod list below. */
const MARKETPLACE_MOD_IDS = new Set(
  SKILL_REGISTRY.filter((s) => s.type === "mod").map((s) => s.id),
);

// ═══════════════════════════════════════════════════════════════
// Navigation Model
// ═══════════════════════════════════════════════════════════════

export interface NavItem {
  id: string;
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  badge?: string;
  /** Production readiness status */
  maturity?: "production" | "beta" | "experimental" | "planned";
  /** Child mods rendered indented under this item */
  children?: NavItem[];
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
  accentColor?: "amber" | "cyan";
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}

const SECTION_COLORS: Record<string, { activeBg: string; activeText: string; activeBorder: string; activeBar: string; badgeBg: string; badgeText: string; dropIndicator: string; headerText: string }> = {
  amber: {
    activeBg: "bg-amber-500/10",
    activeText: "text-amber-400",
    activeBorder: "border-amber-500/20",
    activeBar: "bg-amber-500",
    badgeBg: "bg-amber-500/20",
    badgeText: "text-amber-400",
    dropIndicator: "border-amber-500/50",
    headerText: "text-muted-foreground/40",
  },
  cyan: {
    activeBg: "bg-cyan-500/10",
    activeText: "text-cyan-400",
    activeBorder: "border-cyan-500/20",
    activeBar: "bg-cyan-500",
    badgeBg: "bg-cyan-500/20",
    badgeText: "text-cyan-400",
    dropIndicator: "border-cyan-500/50",
    headerText: "text-cyan-400/50",
  },
};

export const DEFAULT_SECTIONS: NavSection[] = [
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // STREAMLINED NAVIGATION — Consolidated for clarity (40% fewer items)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  {
    id: "command",
    label: "Command",
    collapsible: true,
    items: [
      { id: "dashboard", href: "/dashboard", label: "Dashboard", icon: BarChart3, maturity: "production" },
      { id: "credit", href: "/analytics/credit", label: "Credit", icon: TrendingUp, maturity: "production" },
      { id: "lending", href: "/lending", label: "Lending", icon: Landmark, maturity: "beta" },
      { id: "activity", href: "/activity", label: "Activity", icon: Activity, maturity: "production" },
      { id: "doctor", href: "/doctor", label: "Health", icon: Stethoscope, maturity: "production" },
      { id: "agent-map", href: "/agent-map", label: "Agent Map", icon: Map, maturity: "production" },
      { id: "logs", href: "/logs", label: "Logs", icon: FileText, maturity: "production" },
    ],
  },
  {
    id: "deploy",
    label: "Deploy",
    collapsible: true,
    items: [
      { id: "agents", href: "/agents", label: "Fleet", icon: Users, maturity: "production" },
      { id: "projects", href: "/agent-guilds", label: "Projects", icon: FolderKanban, maturity: "production" },
      { id: "market", href: "/market", label: "Marketplace", icon: Store, maturity: "production" },
      { id: "operators", href: "/operators", label: "Team", icon: UserCog, maturity: "production" },
      { id: "compute-overview", href: "/compute", label: "Compute", icon: Monitor, maturity: "production" },
      { id: "compute-computers", href: "/compute/computers", label: "Computers", icon: HardDrive, maturity: "production" },
      { id: "compute-workspaces", href: "/compute/workspaces", label: "Workspaces", icon: Layers, maturity: "beta" },
    ],
  },
  {
    id: "coordinate",
    label: "Coordinate",
    collapsible: true,
    items: [
      { id: "board", href: "/kanban", label: "Task Board", icon: LayoutGrid, maturity: "production" },
      { id: "jobs", href: "/jobs", label: "Job Board", icon: Briefcase, maturity: "production" },
      { id: "channels", href: "/chat", label: "Channels", icon: MessageSquare, maturity: "production" },
      { id: "agent-comms", href: "/agent-comms", label: "Agent Chat Logs", icon: Bot, maturity: "production" },
      { id: "approvals", href: "/approvals", label: "Approvals", icon: Shield, maturity: "production" },
      { id: "workflows", href: "/workflows", label: "Workflows", icon: Zap, maturity: "beta" },
      { id: "cron", href: "/cron", label: "Scheduler", icon: Clock, maturity: "production" },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    collapsible: true,
    defaultCollapsed: true,
    items: [
      { id: "organizations", href: "/organizations", label: "Organizations", icon: Building2, maturity: "production" },
      { id: "usage", href: "/usage", label: "Usage & Billing", icon: Coins, maturity: "beta" },
      { id: "storage", href: "/usage/storage", label: "Storage", icon: Database, maturity: "production" },
      { id: "publisher", href: "/market/publisher", label: "Publisher", icon: Upload, maturity: "production" },
    ],
  },
  // Panels contributed by runtime mods (mods/<id>/agent-guild.mod.json) that
  // aren't in the marketplace — always visible. Mods listed in SKILL_REGISTRY
  // are marketplace-gated instead and only appear once an org owns them (see
  // refreshModSidebar below), so orgs start with none and add them from the
  // market.
  {
    id: "modifications",
    label: "Mods",
    collapsible: true,
    items: MOD_MANIFESTS.filter((m) => !MARKETPLACE_MOD_IDS.has(m.id)).flatMap((m) =>
      (m.panels ?? []).map((p): NavItem => ({
        id: `runtime-mod-${m.id}-${p.id}`,
        href: `/mods/${m.id}/${p.id}`,
        label: p.title,
        icon: (p.icon && ICON_MAP[p.icon]) || Puzzle,
      })),
    ),
  },
];

/** Bottom-pinned items — always visible, not part of draggable sections */
export const PINNED_ITEMS: NavItem[] = [
  { id: "docs", href: "/docs", label: "Docs", icon: BookOpen },
  { id: "settings", href: "/settings", label: "Settings", icon: Settings },
];

// ═══════════════════════════════════════════════════════════════
// Persistence Keys
// ═══════════════════════════════════════════════════════════════

const PLATFORM_ADMIN_ADDRESS = (process.env.NEXT_PUBLIC_ADMIN_ADDRESS || "").toLowerCase();

function isAdminAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  return lower === PLATFORM_ADMIN_ADDRESS
    || lower === "0x723708273e811a07d90d2e81e799b9ab27f0b549"
    || lower === "0x116c28e6dcabca363f83217c712d79dce168d90e"
    || lower === "0xeab03556443e0b852a8efe836a004bc02cff2974";
}

const ADMIN_SECTION: NavSection = {
  id: "admin",
  label: "Admin",
  accentColor: "amber",
  collapsible: true,
  items: [
    { id: "admin-dashboard", href: "/admin", label: "Dashboard", icon: ShieldAlert },
    { id: "admin-marketplace", href: "/admin/marketplace", label: "Marketplace", icon: Store },
    { id: "admin-credit-ops", href: "/admin/credit-ops", label: "Credit Ops", icon: DollarSign },
    { id: "admin-risk", href: "/admin/risk", label: "Risk", icon: Flag },
    { id: "admin-analytics", href: "/admin/analytics", label: "Analytics", icon: BarChart3 },
    { id: "admin-compute", href: "/compute/admin", label: "Compute", icon: HardDrive },
  ],
};

/** Inject or remove the admin section from a sections array based on admin status */
function applyAdminSection(sections: NavSection[], isAdmin: boolean): NavSection[] {
  const hasAdmin = sections.some(s => s.id === "admin");
  if (isAdmin && !hasAdmin) {
    const modsIndex = sections.findIndex(s => s.id === "modifications");
    if (modsIndex >= 0) {
      return [...sections.slice(0, modsIndex + 1), ADMIN_SECTION, ...sections.slice(modsIndex + 1)];
    }
    return [...sections, ADMIN_SECTION];
  }
  if (!isAdmin && hasAdmin) {
    return sections.filter(s => s.id !== "admin");
  }
  return sections;
}

const SECTION_ORDER_KEY = "agent-guild-sidebar-order-v2";
const ITEM_ORDER_KEY = "agent-guild-sidebar-items-v2";
const COLLAPSED_KEY = "agent-guild-sidebar-collapsed";
const SECTION_COLLAPSED_KEY = "agent-guild-sidebar-sections-collapsed";

// ═══════════════════════════════════════════════════════════════
// Persistence Helpers
// ═══════════════════════════════════════════════════════════════

function loadJSON<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const val = localStorage.getItem(key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}

function saveJSON(key: string, val: unknown) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
}

function loadCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
}

// Build a complete lookup of all items from the given sections by id
function buildItemLookup(base: NavSection[]): Record<string, NavItem> {
  const m: Record<string, NavItem> = {};
  for (const s of base) for (const i of s.items) m[i.id] = i;
  return m;
}

/**
 * Apply saved section order + item order to produce the final NavSection[].
 * Any new items not in saved order get appended to their default section.
 */
function applySavedState(base: NavSection[] = DEFAULT_SECTIONS): NavSection[] {
  const sectionOrder = loadJSON<string[]>(SECTION_ORDER_KEY);
  const itemOrder = loadJSON<Record<string, string[]>>(ITEM_ORDER_KEY);

  // Start with base, then re-order sections
  let sections = [...base.map(s => ({ ...s, items: [...s.items] }))];

  if (sectionOrder) {
    const lookup: Record<string, NavSection> = {};
    for (const s of sections) lookup[s.id] = s;
    const ordered: NavSection[] = [];
    const used = new Set<string>();
    for (const id of sectionOrder) {
      if (lookup[id]) { ordered.push(lookup[id]); used.add(id); }
    }
    for (const s of sections) {
      if (!used.has(s.id)) ordered.push(s);
    }
    sections = ordered;
  }

  // Apply saved item order within each section
  if (itemOrder) {
    const allItems = buildItemLookup(base);
    const globalClaimed = new Set<string>(); // prevent duplicates across sections
    for (const section of sections) {
      const savedItemIds = itemOrder[section.id];
      if (!savedItemIds) continue;

      const sectionItemLookup: Record<string, NavItem> = {};
      for (const item of section.items) sectionItemLookup[item.id] = item;
      // Also check global lookup for items moved from other sections
      const ordered: NavItem[] = [];
      const used = new Set<string>();
      for (const id of savedItemIds) {
        if (globalClaimed.has(id)) continue; // already placed in another section
        const item = sectionItemLookup[id] || allItems[id];
        if (item) { ordered.push(item); used.add(id); globalClaimed.add(id); }
      }
      // Append any items in section.items not in saved order (new items)
      for (const item of section.items) {
        if (!used.has(item.id) && !globalClaimed.has(item.id)) {
          ordered.push(item);
          globalClaimed.add(item.id);
        }
      }
      section.items = ordered;
    }
  }

  return sections;
}

function saveSectionOrder(sections: NavSection[]) {
  saveJSON(SECTION_ORDER_KEY, sections.map(s => s.id));
}

function saveItemOrder(sections: NavSection[]) {
  const order: Record<string, string[]> = {};
  for (const s of sections) order[s.id] = s.items.map(i => i.id);
  saveJSON(ITEM_ORDER_KEY, order);
}

// ═══════════════════════════════════════════════════════════════
// Drag-and-drop Types
// ═══════════════════════════════════════════════════════════════

type DragKind = "section" | "item";

interface DragState {
  kind: DragKind;
  sectionId: string;
  itemId?: string; // only for "item" kind
}

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function Sidebar() {
  const pathname = usePathname();
  const { currentOrg } = useOrg();
  const { address: sessionAddress } = useSession();
  const { skin } = useSkin();
  const [collapsed, setCollapsed] = useState(() => loadCollapsed());
  const [sections, setSections] = useState<NavSection[]>(() => applySavedState());
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<{ sectionId: string; itemId?: string } | null>(null);
  const orgIdRef = useRef<string | null>(null);
  const router = useRouter();

  // Favorites
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    const saved = loadJSON<string[]>("agent-guild-sidebar-favorites");
    return saved ? new Set(saved) : new Set();
  });
  const toggleFavorite = useCallback((itemId: string) => {
    setFavorites(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      saveJSON("agent-guild-sidebar-favorites", [...next]);
      return next;
    });
  }, []);

  // Sidebar search/filter
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Keyboard navigation
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const navItemRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  // DnD onboarding hint
  const [dndHintSeen, setDndHintSeen] = useState(() => {
    if (typeof window === "undefined") return true;
    return localStorage.getItem("agent-guild-sidebar-dnd-hint-seen") === "true";
  });

  // Section collapse state
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(() => {
    const saved = loadJSON<string[]>(SECTION_COLLAPSED_KEY);
    if (saved) return new Set(saved);
    return new Set(DEFAULT_SECTIONS.filter(s => s.defaultCollapsed).map(s => s.id));
  });

  const toggleSection = useCallback((sectionId: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      saveJSON(SECTION_COLLAPSED_KEY, [...next]);
      return next;
    });
  }, []);

  // Inject or remove admin section whenever session address or sections change
  const isAdmin = isAdminAddress(sessionAddress);
  useEffect(() => {
    setSections(prev => {
      const next = applyAdminSection(prev, isAdmin);
      return next === prev ? prev : next;
    });
  }, [isAdmin]);

  // Auto-expand section when navigating to a route inside it
  useEffect(() => {
    for (const section of sections) {
      if (!section.collapsible) continue;
      const hasActive = section.items.some(
        item => pathname === item.href || pathname.startsWith(item.href + "/")
      );
      if (hasActive && collapsedSections.has(section.id)) {
        setCollapsedSections(prev => {
          const next = new Set(prev);
          next.delete(section.id);
          saveJSON(SECTION_COLLAPSED_KEY, [...next]);
          return next;
        });
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Fetch installed mods and rebuild sidebar sections
  const refreshModSidebar = useCallback(async (orgId: string) => {
    try {
      const owned = await getOwnedItems(orgId);
      const ownedIds = new Set(owned.filter(o => o.enabled).map(o => o.skillId));

      // Separate parent items from child items
      const parentItems: { sectionId: string; item: NavItem }[] = [];
      const childItems: { parentModId: string; sectionId: string; item: NavItem }[] = [];
      const handled = new Set<string>(); // track items with explicit sidebarConfig

      for (const skill of SKILL_REGISTRY) {
        if (!ownedIds.has(skill.id)) continue;

        if (skill.sidebarConfig) {
          handled.add(skill.id);
          const icon = ICON_MAP[skill.sidebarConfig.iconName] as typeof LayoutDashboard | undefined;
          if (icon != null) {
            const navItem: NavItem = {
              id: `mod-${skill.id}`,
              href: skill.sidebarConfig.href,
              label: skill.sidebarConfig.label,
              icon,
            };
            if (skill.sidebarConfig.parentModId) {
              childItems.push({
                parentModId: skill.sidebarConfig.parentModId,
                sectionId: skill.sidebarConfig.sectionId,
                item: navItem,
              });
            } else {
              parentItems.push({
                sectionId: skill.sidebarConfig.sectionId,
                item: navItem,
              });
            }
          }
        }
      }

      // Auto-generate sidebar entries for owned items WITHOUT explicit sidebarConfig
      for (const skill of SKILL_REGISTRY) {
        if (!ownedIds.has(skill.id) || handled.has(skill.id)) continue;
        // Only add mods, plugins, and skills — skins don't need sidebar entries
        if (skill.type === "skin") continue;

        const icon = TYPE_ICON[skill.type] || Wrench;
        parentItems.push({
          sectionId: "modifications",
          item: {
            id: `mod-${skill.id}`,
            href: `/market/${skill.id}`,
            label: skill.name,
            icon,
          },
        });
      }

      const base = DEFAULT_SECTIONS.map(s => ({ ...s, items: [...s.items] }));

      // Add parent items first
      for (const { sectionId, item } of parentItems) {
        const section = base.find(s => s.id === sectionId);
        if (section && !section.items.some(i => i.id === item.id)) {
          section.items.push(item);
        }
      }

      // Attach children to their parent items
      for (const { parentModId, sectionId, item } of childItems) {
        const parentId = `mod-${parentModId}`;
        const section = base.find(s => s.id === sectionId);
        if (section) {
          const parent = section.items.find(i => i.id === parentId);
          if (parent) {
            if (!parent.children) parent.children = [];
            if (!parent.children.some(c => c.id === item.id)) {
              parent.children.push(item);
            }
          }
        }
      }

      setSections(applyAdminSection(applySavedState(base), isAdmin));
    } catch {
      setSections(applyAdminSection(applySavedState(), isAdmin));
    }
  }, [isAdmin]);

  // Load on org change
  useEffect(() => {
    const orgId = currentOrg?.id ?? null;
    orgIdRef.current = orgId;

    if (!orgId) {
      setSections(applyAdminSection(applySavedState(), isAdmin));
      return;
    }

    refreshModSidebar(orgId);
  }, [currentOrg, refreshModSidebar]);

  // Re-fetch when marketplace installs/removes items
  useEffect(() => {
    const handler = () => {
      if (orgIdRef.current) refreshModSidebar(orgIdRef.current);
    };
    window.addEventListener("agent-guild-inventory-changed", handler);
    return () => window.removeEventListener("agent-guild-inventory-changed", handler);
  }, [refreshModSidebar]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSED_KEY, String(next)); } catch { }
      return next;
    });
  }, []);

  // ── Section-level drag ──

  const onSectionDragStart = (sectionId: string) => (e: DragEvent) => {
    setDragging({ kind: "section", sectionId });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `section:${sectionId}`);
  };

  const onSectionDragOver = (sectionId: string) => (e: DragEvent) => {
    if (!dragging || dragging.kind !== "section") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (sectionId !== dragging.sectionId) setDropTarget({ sectionId });
  };

  const onSectionDrop = (targetSectionId: string) => (e: DragEvent) => {
    e.preventDefault();
    setDropTarget(null);
    if (!dragging || dragging.kind !== "section" || dragging.sectionId === targetSectionId) return;

    setSections(prev => {
      const arr = [...prev];
      const from = arr.findIndex(s => s.id === dragging.sectionId);
      const to = arr.findIndex(s => s.id === targetSectionId);
      if (from === -1 || to === -1) return prev;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      saveSectionOrder(arr);
      return arr;
    });
    setDragging(null);
  };

  // ── Item-level drag ──

  const onItemDragStart = (sectionId: string, itemId: string) => (e: DragEvent) => {
    e.stopPropagation(); // Don't trigger section drag
    setDragging({ kind: "item", sectionId, itemId });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", `item:${sectionId}:${itemId}`);
  };

  const onItemDragOver = (sectionId: string, itemId: string) => (e: DragEvent) => {
    if (!dragging || dragging.kind !== "item") return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTarget({ sectionId, itemId });
  };

  const onItemDrop = (targetSectionId: string, targetItemId: string) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    if (!dragging || dragging.kind !== "item") return;
    if (dragging.sectionId === targetSectionId && dragging.itemId === targetItemId) {
      setDragging(null);
      return;
    }

    setSections(prev => {
      const next = prev.map(s => ({ ...s, items: [...s.items] }));
      const srcSection = next.find(s => s.id === dragging.sectionId);
      const dstSection = next.find(s => s.id === targetSectionId);
      if (!srcSection || !dstSection) return prev;

      const srcIdx = srcSection.items.findIndex(i => i.id === dragging.itemId);
      if (srcIdx === -1) return prev;

      const [movedItem] = srcSection.items.splice(srcIdx, 1);
      const dstIdx = dstSection.items.findIndex(i => i.id === targetItemId);
      if (dstIdx === -1) {
        dstSection.items.push(movedItem);
      } else {
        dstSection.items.splice(dstIdx, 0, movedItem);
      }

      saveSectionOrder(next);
      saveItemOrder(next);
      return next;
    });
    setDragging(null);
  };

  // Allow dropping items onto a section when it's empty or as a catch-all
  const onSectionDropForItem = (sectionId: string) => (e: DragEvent) => {
    if (!dragging || dragging.kind !== "item") return;
    e.preventDefault();
    setDropTarget(null);

    setSections(prev => {
      const next = prev.map(s => ({ ...s, items: [...s.items] }));
      const srcSection = next.find(s => s.id === dragging.sectionId);
      const dstSection = next.find(s => s.id === sectionId);
      if (!srcSection || !dstSection) return prev;

      const srcIdx = srcSection.items.findIndex(i => i.id === dragging.itemId);
      if (srcIdx === -1) return prev;

      const [movedItem] = srcSection.items.splice(srcIdx, 1);
      dstSection.items.push(movedItem);

      saveSectionOrder(next);
      saveItemOrder(next);
      return next;
    });
    setDragging(null);
  };

  const onDragEnd = () => {
    setDragging(null);
    setDropTarget(null);
  };

  // ── Search filter ──
  const normalizedQuery = searchQuery.toLowerCase().trim();
  const filteredSections = normalizedQuery
    ? sections.map(s => ({
        ...s,
        items: s.items.filter(item =>
          item.label.toLowerCase().includes(normalizedQuery) ||
          item.children?.some(c => c.label.toLowerCase().includes(normalizedQuery))
        ),
      })).filter(s => s.items.length > 0)
    : sections;

  // ── Favorites ──
  const allItems: NavItem[] = [
    ...sections.flatMap(s => s.items.flatMap(i => [i, ...(i.children || [])])),
    ...PINNED_ITEMS,
  ];
  const favoritedItems = allItems.filter(item =>
    favorites.has(item.id) &&
    (!normalizedQuery || item.label.toLowerCase().includes(normalizedQuery))
  );

  // ── Keyboard navigation ──
  // Build flat list of navigable items for arrow key support
  const flatNavItems: { id: string; href: string }[] = [];
  for (const item of favoritedItems) flatNavItems.push({ id: `fav-${item.id}`, href: item.href });
  for (const section of filteredSections) {
    if (section.items.length === 0) continue;
    const isSectionHidden = !normalizedQuery && section.collapsible && collapsedSections.has(section.id);
    if (!isSectionHidden || collapsed) {
      for (const item of section.items) {
        flatNavItems.push({ id: item.id, href: item.href });
        if (item.children && !collapsed) {
          for (const child of item.children) flatNavItems.push({ id: child.id, href: child.href });
        }
      }
    }
  }
  for (const item of PINNED_ITEMS) flatNavItems.push({ id: item.id, href: item.href });

  // Reset ref array each render
  navItemRefs.current = [];

  const handleNavKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex(prev => {
        const max = flatNavItems.length - 1;
        if (max < 0) return -1;
        const next = e.key === "ArrowDown"
          ? (prev < max ? prev + 1 : 0)
          : (prev > 0 ? prev - 1 : max);
        navItemRefs.current[next]?.focus();
        return next;
      });
    }
    if (e.key === "Enter" && focusedIndex >= 0 && focusedIndex < flatNavItems.length) {
      e.preventDefault();
      router.push(flatNavItems[focusedIndex].href);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flatNavItems, focusedIndex, router]);

  let navCounter = 0; // incremented per rendered nav link for keyboard focus tracking

  return (
    <TooltipProvider delayDuration={0}>
    <aside
      aria-label="Sidebar"
      className={cn(
        "h-full border-r border-border shrink-0 transition-all duration-300 flex flex-col",
        "bg-card/50 backdrop-blur-xl",
        collapsed ? "w-[52px]" : "w-56"
      )}
    >
      {/* Sections */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-1 scrollbar-thin" role="navigation" aria-label="Main navigation" onKeyDown={handleNavKeyDown}>
        {/* Sidebar filter */}
        {!collapsed ? (
          <div className="px-2 pt-1 pb-0.5">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter..."
                className="w-full pl-7 pr-7 py-1 text-xs bg-muted/30 border border-border/50 rounded-md text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-amber-500/40 focus:ring-1 focus:ring-amber-500/20"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  setCollapsed(false);
                  try { localStorage.setItem(COLLAPSED_KEY, "false"); } catch {}
                  setTimeout(() => searchInputRef.current?.focus(), 350);
                }}
                className="w-full flex justify-center p-2 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors rounded-lg"
              >
                <Search className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>Filter navigation</TooltipContent>
          </Tooltip>
        )}

        {/* DnD onboarding hint */}
        {!collapsed && !dndHintSeen && !normalizedQuery && (
          <div className="mx-2 mb-1 px-2 py-1.5 rounded-lg bg-muted/50 border border-border/50 flex items-center gap-2 text-[10px] text-muted-foreground">
            <GripVertical className="h-3 w-3 shrink-0" />
            <span>Drag items and sections to reorder</span>
            <button
              onClick={() => {
                setDndHintSeen(true);
                try { localStorage.setItem("agent-guild-sidebar-dnd-hint-seen", "true"); } catch {}
              }}
              className="ml-auto text-muted-foreground/60 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* Favorites section */}
        {favoritedItems.length > 0 && (
          <div className="transition-all">
            {!collapsed ? (
              <div className="flex items-center gap-1 px-3 pt-2 pb-0.5 select-none">
                <Star className="h-3 w-3 text-amber-400/60 shrink-0" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/40">
                  Favorites
                </span>
              </div>
            ) : (
              <div className="flex justify-center py-1">
                <Star className="h-3.5 w-3.5 text-amber-400/40" />
              </div>
            )}
            <div className={cn("space-y-0.5", collapsed ? "px-1" : "px-2")}>
              {favoritedItems.map(item => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                const colors = SECTION_COLORS.amber;
                const idx = navCounter++;
                return (
                  <div key={`fav-${item.id}`} className="relative group/item">
                    {collapsed ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            ref={(el) => { navItemRefs.current[idx] = el; }}
                            tabIndex={focusedIndex === idx ? 0 : -1}
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "relative flex items-center gap-2.5 rounded-lg text-sm font-medium transition-all duration-200 justify-center p-2",
                              "focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-none",
                              isActive
                                ? `${colors.activeBg} ${colors.activeText} border ${colors.activeBorder}`
                                : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent"
                            )}
                          >
                            {isActive && <span className={cn("absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 rounded-full", colors.activeBar)} />}
                            <item.icon className="shrink-0 h-4.5 w-4.5" />
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent side="right" sideOffset={8}>{item.label}</TooltipContent>
                      </Tooltip>
                    ) : (
                      <Link
                        ref={(el) => { navItemRefs.current[idx] = el; }}
                        tabIndex={focusedIndex === idx ? 0 : -1}
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "relative flex items-center gap-2.5 rounded-lg text-sm font-medium transition-all duration-200 px-2.5 py-1.5",
                          "focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-none",
                          isActive
                            ? `${colors.activeBg} ${colors.activeText} border ${colors.activeBorder}`
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent"
                        )}
                      >
                        {isActive && <span className={cn("absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 rounded-full", colors.activeBar)} />}
                        <item.icon className="shrink-0 h-4 w-4" />
                        <span className="truncate">{item.label}</span>
                        <button
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.id); }}
                          className="ml-auto text-amber-400 hover:text-amber-300"
                        >
                          <Star className="h-3 w-3 fill-current" />
                        </button>
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Divider after favorites */}
            {collapsed ? (
              <div className="mx-2 my-1 border-t border-border/40" />
            ) : (
              <div className="mx-3 my-1 border-t border-border/20" />
            )}
          </div>
        )}

        {filteredSections.map((section, sectionIndex) => {
          // Hide empty sections (e.g., Modifications with no installed mods)
          if (section.items.length === 0) return null;
          // With Tailwind v4 color remap, amber classes auto-transform per skin.
          // Only the modifications section keeps its own accent when using classic skin.
          const colorKey = skin === "classic" ? (section.accentColor || "amber") : "amber";
          const colors = SECTION_COLORS[colorKey];
          // Auto-expand sections when searching
          const isSectionCollapsed = !normalizedQuery && section.collapsible && collapsedSections.has(section.id);
          return (
          <div
            key={section.id}
            role="group"
            aria-label={section.label}
            draggable={!collapsed && !normalizedQuery && dragging?.kind !== "item"}
            onDragStart={onSectionDragStart(section.id)}
            onDragOver={(e) => {
              onSectionDragOver(section.id)(e);
              // Also allow item drops onto section area
              if (dragging?.kind === "item") {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(e) => {
              if (dragging?.kind === "section") {
                onSectionDrop(section.id)(e);
              } else if (dragging?.kind === "item") {
                onSectionDropForItem(section.id)(e);
              }
            }}
            onDragEnd={onDragEnd}
            className={cn(
              "transition-all",
              collapsed && sectionIndex > 0 && !(dropTarget?.sectionId === section.id && !dropTarget?.itemId) && "mt-1 pt-1 border-t border-border/30",
              dropTarget?.sectionId === section.id && !dropTarget?.itemId && `border-t-2 ${colors.dropIndicator}`,
              dragging?.kind === "section" && dragging.sectionId === section.id && "opacity-40"
            )}
          >
            {/* Section header */}
            {!collapsed && (
              <div
                className={cn(
                  "flex items-center gap-1 px-3 pt-2 pb-0.5 group select-none",
                  section.collapsible ? "cursor-pointer" : "cursor-grab active:cursor-grabbing"
                )}
                onClick={section.collapsible ? () => toggleSection(section.id) : undefined}
              >
                <GripVertical
                  className="h-3 w-3 text-muted-foreground/20 group-hover:text-muted-foreground/60 transition-colors shrink-0 cursor-grab active:cursor-grabbing"
                  onClick={(e) => e.stopPropagation()}
                />
                <span className={cn("text-[10px] font-semibold uppercase tracking-wider flex-1", colors.headerText)}>
                  {section.label}
                </span>
                {section.collapsible && (
                  <ChevronDown className={cn(
                    "h-3 w-3 text-muted-foreground/40 transition-transform duration-200",
                    isSectionCollapsed && "-rotate-90"
                  )} />
                )}
              </div>
            )}

            {/* Items — hidden when section is collapsed (but always visible in icon mode) */}
            {(!isSectionCollapsed || collapsed) && (
              <div className={cn("space-y-0.5", collapsed ? "px-1" : "px-2")}>
                {section.items.flatMap((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                  const isBeingDragged = dragging?.kind === "item" && dragging.itemId === item.id;
                  const isDropTarget = dropTarget?.sectionId === section.id && dropTarget?.itemId === item.id;
                  const idx = navCounter++;

                  const elements = [
                    <div
                      key={item.id}
                      draggable={!collapsed && !normalizedQuery}
                      onDragStart={onItemDragStart(section.id, item.id)}
                      onDragOver={onItemDragOver(section.id, item.id)}
                      onDrop={onItemDrop(section.id, item.id)}
                      onDragEnd={onDragEnd}
                      className={cn(
                        "relative group/item",
                        isBeingDragged && "opacity-30",
                        isDropTarget && `before:absolute before:left-2 before:right-2 before:top-0 before:h-[2px] before:rounded-full ${colors.activeBar}`
                      )}
                    >
                      {collapsed ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Link
                              ref={(el) => { navItemRefs.current[idx] = el; }}
                              tabIndex={focusedIndex === idx ? 0 : -1}
                              href={item.href}
                              aria-current={isActive ? "page" : undefined}
                              className={cn(
                                "relative flex items-center gap-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                                "justify-center p-2",
                                "focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-none",
                                isActive
                                  ? `${colors.activeBg} ${colors.activeText} border ${colors.activeBorder}`
                                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent"
                              )}
                            >
                              {isActive && (
                                <span className={cn("absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 rounded-full", colors.activeBar)} />
                              )}
                              <item.icon className="shrink-0 h-4.5 w-4.5" />
                            </Link>
                          </TooltipTrigger>
                          <TooltipContent side="right" sideOffset={8}>{item.label}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <Link
                          ref={(el) => { navItemRefs.current[idx] = el; }}
                          tabIndex={focusedIndex === idx ? 0 : -1}
                          href={item.href}
                          aria-current={isActive ? "page" : undefined}
                          className={cn(
                            "relative flex items-center gap-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                            "px-2.5 py-1.5",
                            "focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-none",
                            isActive
                              ? `${colors.activeBg} ${colors.activeText} border ${colors.activeBorder}`
                              : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent"
                          )}
                        >
                          {isActive && (
                            <span className={cn("absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 rounded-full", colors.activeBar)} />
                          )}
                          {!normalizedQuery && <GripVertical className="h-2.5 w-2.5 text-muted-foreground/20 group-hover/item:text-muted-foreground/60 transition-colors shrink-0 cursor-grab active:cursor-grabbing" />}
                          <item.icon className="shrink-0 h-4 w-4" />
                          <span className="truncate">{item.label}</span>
                          <div className="ml-auto flex items-center gap-1">
                            {item.maturity && item.maturity !== "production" && <MaturityBadge level={item.maturity} />}
                            {item.badge && (
                              <span className={cn("text-[9px] px-1.5 py-0.5 rounded-full font-medium", colors.badgeBg, colors.badgeText)}>
                                {item.badge}
                              </span>
                            )}
                            <button
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFavorite(item.id); }}
                              className={cn(
                                "transition-opacity",
                                favorites.has(item.id)
                                  ? "text-amber-400 opacity-100"
                                  : "text-muted-foreground/40 opacity-0 group-hover/item:opacity-100"
                              )}
                            >
                              <Star className={cn("h-3 w-3", favorites.has(item.id) && "fill-current")} />
                            </button>
                          </div>
                        </Link>
                      )}
                    </div>,
                  ];

                  // Render child mod items indented under parent
                  if (item.children && item.children.length > 0 && !collapsed) {
                    for (const child of item.children) {
                      const childHrefBase = child.href.split("?")[0];
                      const isChildActive = pathname === childHrefBase || pathname.startsWith(childHrefBase + "/");
                      const childIdx = navCounter++;
                      elements.push(
                        <div key={child.id} className="relative group/item">
                          <Link
                            ref={(el) => { navItemRefs.current[childIdx] = el; }}
                            tabIndex={focusedIndex === childIdx ? 0 : -1}
                            href={child.href}
                            aria-current={isChildActive ? "page" : undefined}
                            className={cn(
                              "relative flex items-center gap-2 rounded-lg text-xs font-medium transition-all duration-200",
                              "pl-9 pr-2.5 py-1",
                              "focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-none",
                              isChildActive
                                ? `${colors.activeBg} ${colors.activeText} border ${colors.activeBorder}`
                                : "text-muted-foreground/70 hover:text-foreground hover:bg-muted/50 border border-transparent"
                            )}
                          >
                            <child.icon className="shrink-0 h-3.5 w-3.5" />
                            <span className="truncate">{child.label}</span>
                          </Link>
                        </div>
                      );
                    }
                  }

                  return elements;
                })}
              </div>
            )}
          </div>
          );
        })}
      </nav>

      {/* Pinned items — always visible, not part of draggable sections */}
      <div className={cn("border-t border-border pt-1", collapsed ? "px-1" : "px-2")}>
        {PINNED_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
          const pidx = navCounter++;
          const linkContent = (
            <Link
              key={item.id}
              ref={(el) => { navItemRefs.current[pidx] = el; }}
              tabIndex={focusedIndex === pidx ? 0 : -1}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-2.5 rounded-lg text-sm font-medium transition-all duration-200",
                "focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-none",
                collapsed ? "justify-center p-2" : "px-2.5 py-1.5",
                isActive
                  ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent"
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 rounded-full bg-amber-500" />
              )}
              <item.icon className={cn("shrink-0", collapsed ? "h-4.5 w-4.5" : "h-4 w-4")} />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
          return collapsed ? (
            <Tooltip key={item.id}>
              <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>{item.label}</TooltipContent>
            </Tooltip>
          ) : (
            <div key={item.id}>{linkContent}</div>
          );
        })}
      </div>

      {/* Footer: Collapse + ⌘K hint */}
      <div className={cn(
        "border-t border-border p-2 space-y-1",
        collapsed ? "items-center" : ""
      )}>
        {!collapsed && (
          <button
            onClick={() => {
              window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }));
            }}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Command className="h-3.5 w-3.5" />
            <span>Search</span>
            <kbd className="ml-auto text-[9px] px-1 py-0.5 rounded bg-muted border border-border font-mono">⌘K</kbd>
          </button>
        )}
        <button
          onClick={toggleCollapsed}
          className={cn(
            "flex items-center gap-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors",
            collapsed ? "w-full justify-center p-2" : "w-full px-2.5 py-1.5"
          )}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed
            ? <ChevronRight className="h-3.5 w-3.5" />
            : <><ChevronLeft className="h-3.5 w-3.5" /><span>Collapse</span></>
          }
        </button>
      </div>
    </aside>
    </TooltipProvider>
  );
}
