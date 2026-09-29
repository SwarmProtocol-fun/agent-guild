/** Agent Map Palette — Dockable node palette with compact items and drag-to-dock support. */
"use client";

import { useState, useRef, useCallback } from "react";
import { NODE_CATALOG, type CatalogNodeItem } from "./agent-map-node-catalog";
import { ChevronDown, Search, GripVertical, PanelLeft, PanelRight, PanelTop, PanelBottom } from "lucide-react";

export type DockPosition = "left" | "right" | "top" | "bottom";

interface AgentMapPaletteProps {
  agents: Array<{ id: string; name: string; type: string; status: string }>;
  dockPosition: DockPosition;
  onDockChange: (position: DockPosition) => void;
}

const TYPE_ICONS: Record<string, string> = {
  Research: "🔬", Trading: "📈", Operations: "⚙️", Support: "🛟",
  Analytics: "📊", Scout: "🔍", Security: "🛡️", Creative: "🎨",
  Engineering: "🔧", DevOps: "🚀", Marketing: "📢", Finance: "💰",
  Data: "📦", Coordinator: "🎯", Legal: "⚖️", Communication: "📡",
};

const CATEGORY_BORDER_COLORS: Record<string, string> = {
  amber: "border-amber-400/60 hover:border-amber-400",
  purple: "border-purple-400/60 hover:border-purple-400",
  blue: "border-blue-400/60 hover:border-blue-400",
  orange: "border-orange-400/60 hover:border-orange-400",
  red: "border-red-400/60 hover:border-red-400",
  yellow: "border-yellow-400/60 hover:border-yellow-400",
};

const CATEGORY_BG_COLORS: Record<string, string> = {
  amber: "bg-amber-500/5",
  purple: "bg-purple-500/5",
  blue: "bg-blue-500/5",
  orange: "bg-orange-500/5",
  red: "bg-red-500/5",
  yellow: "bg-yellow-500/5",
};

const DOCK_ICONS = {
  left: PanelLeft,
  right: PanelRight,
  top: PanelTop,
  bottom: PanelBottom,
};

export function AgentMapPalette({ agents, dockPosition, onDockChange }: AgentMapPaletteProps) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const dragRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const isHorizontal = dockPosition === "top" || dockPosition === "bottom";

  const onDragStart = (event: React.DragEvent, nodeType: string, data: string) => {
    event.dataTransfer.setData("application/reactflow-type", nodeType);
    event.dataTransfer.setData("application/reactflow-data", data);
    event.dataTransfer.effectAllowed = "move";
  };

  const toggleCategory = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Palette dock drag handling
  const handleDockDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData("application/palette-dock", "true");
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }, []);

  const handleDockDragEnd = useCallback(() => {
    setDragging(false);
  }, []);

  const lowerSearch = search.toLowerCase();

  const filterItem = (item: CatalogNodeItem) =>
    !search || item.label.toLowerCase().includes(lowerSearch) || item.description.toLowerCase().includes(lowerSearch);

  const filteredAgents = agents.filter(
    (a) => !search || a.name.toLowerCase().includes(lowerSearch) || a.type.toLowerCase().includes(lowerSearch)
  );

  // Border based on dock position
  const borderClass = dockPosition === "left" ? "border-r" : dockPosition === "right" ? "border-l" : dockPosition === "top" ? "border-b" : "border-t";

  // Container classes
  const containerClass = isHorizontal
    ? `${borderClass} border-border bg-muted/50 flex-shrink-0 flex flex-col`
    : `${borderClass} border-border bg-muted/50 flex-shrink-0 flex flex-col`;

  // Dimensions — horizontal: fixed height, full width; vertical: fixed width, fills height
  const containerStyle: React.CSSProperties = isHorizontal
    ? { height: "180px", width: "100%", maxHeight: "35%" }
    : { width: "220px", height: "100%" };

  return (
    <div
      ref={dragRef}
      className={`${containerClass} ${dragging ? "opacity-60" : ""}`}
      style={containerStyle}
    >
      {/* Header — title, dock controls, drag handle */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50 flex-shrink-0">
        <div
          draggable
          onDragStart={handleDockDragStart}
          onDragEnd={handleDockDragEnd}
          className="cursor-grab active:cursor-grabbing p-0.5 rounded hover:bg-accent transition-colors"
          title="Drag to dock palette"
        >
          <GripVertical className="w-3 h-3 text-muted-foreground" />
        </div>
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex-1">
          Nodes
        </span>
        {/* Dock position buttons */}
        <div className="flex items-center gap-0">
          {(["left", "top", "right", "bottom"] as DockPosition[]).map((pos) => {
            const Icon = DOCK_ICONS[pos];
            return (
              <button
                key={pos}
                onClick={() => onDockChange(pos)}
                className={`p-1 rounded transition-colors ${
                  dockPosition === pos
                    ? "bg-amber-500/15 text-amber-500"
                    : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-accent"
                }`}
                title={`Dock ${pos}`}
              >
                <Icon className="w-3 h-3" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search..."
            className="w-full rounded border border-border bg-background pl-6 pr-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-amber-500/40 focus:border-amber-500/50 placeholder:text-muted-foreground/50"
          />
        </div>
      </div>

      {/* Scrollable content */}
      <div className={`flex-1 min-h-0 overflow-auto px-2 pb-2 ${
        isHorizontal ? "flex gap-3" : "space-y-2"
      }`}>
        {/* Horizontal layout: categories as columns */}
        {isHorizontal ? (
          <>
            {/* Agents first */}
            {filteredAgents.length > 0 && (
              <div className="flex-shrink-0" style={{ minWidth: "140px" }}>
                <button
                  onClick={() => toggleCategory("agents")}
                  className="w-full flex items-center gap-1 text-[10px] font-medium text-muted-foreground mb-1 hover:text-foreground transition-colors"
                >
                  <span>🤖</span>
                  <span>Agents</span>
                  <span className="text-[9px] text-muted-foreground/60">({filteredAgents.length})</span>
                  <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${collapsed.has("agents") ? "-rotate-90" : ""}`} />
                </button>
                {!collapsed.has("agents") && (
                  <div className="space-y-1">
                    {filteredAgents.map((agent) => (
                      <CompactAgentItem key={agent.id} agent={agent} onDragStart={onDragStart} />
                    ))}
                  </div>
                )}
              </div>
            )}
            {NODE_CATALOG.map((category) => {
              const items = category.items.filter(filterItem);
              if (items.length === 0) return null;
              const isCollapsed = collapsed.has(category.id);

              return (
                <div key={category.id} className="flex-shrink-0" style={{ minWidth: "140px" }}>
                  <button
                    onClick={() => toggleCategory(category.id)}
                    className="w-full flex items-center gap-1 text-[10px] font-medium text-muted-foreground mb-1 hover:text-foreground transition-colors"
                  >
                    <span>{category.icon}</span>
                    <span className="truncate">{category.label}</span>
                    <span className="text-[9px] text-muted-foreground/60">({items.length})</span>
                    <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                  </button>
                  {!isCollapsed && (
                    <div className="space-y-1">
                      {items.map((item) => (
                        <CompactNodeItem key={item.nodeType} item={item} onDragStart={onDragStart} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ) : (
          /* Vertical layout: Agents first, then catalog categories */
          <>
            {/* Agents at top */}
            {filteredAgents.length > 0 && (
              <div>
                <button
                  onClick={() => toggleCategory("agents")}
                  className="w-full flex items-center justify-between text-[10px] font-medium text-muted-foreground mb-1 px-0.5 hover:text-foreground transition-colors"
                >
                  <span className="flex items-center gap-1">
                    <span className="text-xs">🤖</span>
                    <span>Agents</span>
                    <span className="text-[9px] text-muted-foreground/60">({filteredAgents.length})</span>
                  </span>
                  <ChevronDown className={`w-3 h-3 transition-transform ${collapsed.has("agents") ? "-rotate-90" : ""}`} />
                </button>

                {!collapsed.has("agents") && (
                  <div className="space-y-1">
                    {filteredAgents.map((agent) => (
                      <CompactAgentItem key={agent.id} agent={agent} onDragStart={onDragStart} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {NODE_CATALOG.map((category) => {
              const items = category.items.filter(filterItem);
              if (items.length === 0) return null;
              const isCollapsed = collapsed.has(category.id);

              return (
                <div key={category.id}>
                  <button
                    onClick={() => toggleCategory(category.id)}
                    className="w-full flex items-center justify-between text-[10px] font-medium text-muted-foreground mb-1 px-0.5 hover:text-foreground transition-colors"
                  >
                    <span className="flex items-center gap-1">
                      <span className="text-xs">{category.icon}</span>
                      <span>{category.label}</span>
                      <span className="text-[9px] text-muted-foreground/60">({items.length})</span>
                    </span>
                    <ChevronDown className={`w-3 h-3 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                  </button>

                  {!isCollapsed && (
                    <div className="space-y-1">
                      {items.map((item) => (
                        <CompactNodeItem key={item.nodeType} item={item} onDragStart={onDragStart} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* Empty state */}
        {search && filteredAgents.length === 0 && NODE_CATALOG.every((c) => c.items.filter(filterItem).length === 0) && (
          <div className="text-center py-3 text-muted-foreground">
            <p className="text-[10px]">No matches</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Compact node item (smaller than before) ── */
function CompactNodeItem({
  item,
  onDragStart,
}: {
  item: CatalogNodeItem;
  onDragStart: (e: React.DragEvent, nodeType: string, data: string) => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, item.nodeType, JSON.stringify(item.defaultData))}
      className={`px-2 py-1.5 rounded border border-dashed cursor-grab active:cursor-grabbing transition-all hover:shadow-sm ${
        CATEGORY_BORDER_COLORS[item.color] || "border-border"
      } ${CATEGORY_BG_COLORS[item.color] || "bg-muted/30"}`}
    >
      <div className="flex items-center gap-1.5">
        <span className="text-xs leading-none">{item.icon}</span>
        <span className="text-[10px] font-medium truncate">{item.label}</span>
      </div>
    </div>
  );
}

/* ── Compact agent item ── */
function CompactAgentItem({
  agent,
  onDragStart,
}: {
  agent: { id: string; name: string; type: string; status: string };
  onDragStart: (e: React.DragEvent, nodeType: string, data: string) => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) =>
        onDragStart(
          e,
          "agentNode",
          JSON.stringify({
            label: agent.name,
            agentName: agent.name,
            type: agent.type,
            status: agent.status,
            taskCount: 0,
            activeCount: 0,
            costEstimate: "$0.00",
            assignedCost: 0,
          })
        )
      }
      className="px-2 py-1.5 rounded border border-border bg-card cursor-grab active:cursor-grabbing hover:border-amber-300 hover:shadow-sm transition-all"
    >
      <div className="flex items-center gap-1.5">
        <div className="w-4 h-4 rounded-full bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center text-[8px] font-bold text-amber-700 dark:text-amber-400 flex-shrink-0">
          {agent.name.charAt(0)}
        </div>
        <span className="text-[10px] font-medium truncate flex-1">{agent.name}</span>
        <span
          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
            agent.status === "online"
              ? "bg-emerald-500"
              : agent.status === "busy"
              ? "bg-orange-500"
              : "bg-muted-foreground/40"
          }`}
        />
      </div>
    </div>
  );
}
