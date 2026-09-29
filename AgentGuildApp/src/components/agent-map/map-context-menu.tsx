/** Map Context Menu — Right-click context menu for canvas and node actions (n8n-style). */
"use client";

import { useEffect, useRef, useCallback } from "react";
import { StickyNote, Copy, Trash2, Ban, Maximize, MousePointerClick, Clipboard } from "lucide-react";

export interface ContextMenuAction {
  label: string;
  icon: React.ReactNode;
  action: () => void;
  destructive?: boolean;
  separator?: boolean;
}

interface MapContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
}

export function MapContextMenu({ x, y, actions, onClose }: MapContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Clamp position to viewport
  const clampedX = Math.min(x, window.innerWidth - 200);
  const clampedY = Math.min(y, window.innerHeight - actions.length * 36 - 20);

  // Close on outside click or escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="map-context-menu"
      style={{ left: clampedX, top: clampedY }}
    >
      {actions.map((action, i) => (
        <div key={i}>
          {action.separator && i > 0 && <div className="map-context-menu-separator" />}
          <button
            className={`map-context-menu-item ${action.destructive ? "destructive" : ""}`}
            onClick={() => {
              action.action();
              onClose();
            }}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

/** Builds the canvas (pane) context menu actions */
export function buildCanvasMenuActions(callbacks: {
  onAddSticky: (x: number, y: number) => void;
  onSelectAll: () => void;
  onFitView: () => void;
  onPaste?: () => void;
  menuX: number;
  menuY: number;
}): ContextMenuAction[] {
  const actions: ContextMenuAction[] = [
    {
      label: "Add Sticky Note",
      icon: <StickyNote className="w-3.5 h-3.5" />,
      action: () => callbacks.onAddSticky(callbacks.menuX, callbacks.menuY),
    },
  ];

  if (callbacks.onPaste) {
    actions.push({
      label: "Paste",
      icon: <Clipboard className="w-3.5 h-3.5" />,
      action: callbacks.onPaste,
    });
  }

  actions.push(
    {
      label: "Select All",
      icon: <MousePointerClick className="w-3.5 h-3.5" />,
      action: callbacks.onSelectAll,
      separator: true,
    },
    {
      label: "Fit View",
      icon: <Maximize className="w-3.5 h-3.5" />,
      action: callbacks.onFitView,
    }
  );

  return actions;
}

/** Builds the node context menu actions */
export function buildNodeMenuActions(callbacks: {
  onDuplicate: () => void;
  onDelete: () => void;
  onToggleDisable: () => void;
  onCopy: () => void;
  isDisabled: boolean;
  isProtected: boolean;
}): ContextMenuAction[] {
  const actions: ContextMenuAction[] = [
    {
      label: "Copy",
      icon: <Copy className="w-3.5 h-3.5" />,
      action: callbacks.onCopy,
    },
  ];

  if (!callbacks.isProtected) {
    actions.push(
      {
        label: "Duplicate",
        icon: <Copy className="w-3.5 h-3.5" />,
        action: callbacks.onDuplicate,
      },
      {
        label: callbacks.isDisabled ? "Enable" : "Disable",
        icon: <Ban className="w-3.5 h-3.5" />,
        action: callbacks.onToggleDisable,
        separator: true,
      },
      {
        label: "Delete",
        icon: <Trash2 className="w-3.5 h-3.5" />,
        action: callbacks.onDelete,
        destructive: true,
        separator: true,
      }
    );
  }

  return actions;
}
