/** Notification Center — Bell icon dropdown with real-time notifications by severity (info/success/warning/error). */
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell, X, AlertTriangle, CheckCircle, Info, AlertCircle } from "lucide-react";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type NotifSeverity = "info" | "success" | "warning" | "error";

export interface Notification {
    id: string;
    title: string;
    detail?: string;
    severity: NotifSeverity;
    timestamp: Date;
    read: boolean;
}

const SEVERITY_CONFIG: Record<NotifSeverity, { icon: typeof Info; color: string; bg: string }> = {
    info: { icon: Info, color: "text-blue-400", bg: "bg-blue-500/10" },
    success: { icon: CheckCircle, color: "text-emerald-400", bg: "bg-emerald-500/10" },
    warning: { icon: AlertTriangle, color: "text-amber-400", bg: "bg-amber-500/10" },
    error: { icon: AlertCircle, color: "text-red-400", bg: "bg-red-500/10" },
};

// ═══════════════════════════════════════════════════════════════
// In-memory store (could be wired to Firestore/WebSocket later)
// ═══════════════════════════════════════════════════════════════

let _notifications: Notification[] = [];
let _listeners: (() => void)[] = [];

export function pushNotification(n: Omit<Notification, "id" | "timestamp" | "read">) {
    _notifications = [
        { ...n, id: crypto.randomUUID(), timestamp: new Date(), read: false },
        ..._notifications,
    ].slice(0, 50);
    _listeners.forEach(fn => fn());
}

function markRead(id: string) {
    _notifications = _notifications.map(n => n.id === id ? { ...n, read: true } : n);
    _listeners.forEach(fn => fn());
}

function clearAll() {
    _notifications = [];
    _listeners.forEach(fn => fn());
}

function useNotifications() {
    const [notifs, setNotifs] = useState<Notification[]>(_notifications);
    useEffect(() => {
        const update = () => setNotifs([..._notifications]);
        _listeners.push(update);
        return () => { _listeners = _listeners.filter(l => l !== update); };
    }, []);
    return notifs;
}

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export function NotificationCenter() {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const notifications = useNotifications();
    const unread = notifications.filter(n => !n.read).length;

    // Close on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    function timeAgo(date: Date): string {
        const sec = Math.round((Date.now() - date.getTime()) / 1000);
        if (sec < 60) return "just now";
        if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
        if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
        return `${Math.floor(sec / 86400)}d ago`;
    }

    return (
        <div ref={ref} className="relative">
            {/* Bell button */}
            <button
                onClick={() => setOpen(!open)}
                className="relative p-2 rounded-md border border-border hover:border-amber-500/30 transition-colors text-muted-foreground hover:text-foreground"
            >
                <Bell className="h-4 w-4" />
                {unread > 0 && (
                    <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] flex items-center justify-center font-bold animate-pulse">
                        {unread > 9 ? "9+" : unread}
                    </span>
                )}
            </button>

            {/* Dropdown */}
            {open && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-card border border-border rounded-xl shadow-2xl z-50 overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
                        <span className="text-xs font-semibold">Notifications</span>
                        {notifications.length > 0 && (
                            <button onClick={clearAll} className="text-[10px] text-muted-foreground hover:text-foreground">
                                Clear all
                            </button>
                        )}
                    </div>

                    <div className="max-h-80 overflow-y-auto">
                        {notifications.length === 0 ? (
                            <div className="py-8 text-center">
                                <Bell className="h-6 w-6 mx-auto text-muted-foreground/30 mb-2" />
                                <p className="text-xs text-muted-foreground">No notifications</p>
                            </div>
                        ) : (
                            notifications.map((n) => {
                                const cfg = SEVERITY_CONFIG[n.severity];
                                const Icon = cfg.icon;
                                return (
                                    <button
                                        key={n.id}
                                        onClick={() => markRead(n.id)}
                                        className={`w-full text-left px-4 py-2.5 border-b border-border last:border-0 hover:bg-muted/30 transition-colors ${!n.read ? "bg-muted/10" : ""
                                            }`}
                                    >
                                        <div className="flex gap-2.5">
                                            <div className={`p-1 rounded-md ${cfg.bg} shrink-0 mt-0.5`}>
                                                <Icon className={`h-3 w-3 ${cfg.color}`} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <p className="text-xs font-medium truncate">{n.title}</p>
                                                    {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />}
                                                </div>
                                                {n.detail && <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">{n.detail}</p>}
                                                <p className="text-[9px] text-muted-foreground/60 mt-1">{timeAgo(n.timestamp)}</p>
                                            </div>
                                        </div>
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
