"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Clock, Loader2, RefreshCw, ShieldAlert, ArrowLeft, Search,
  Monitor, Globe, LogIn, LogOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface SessionRecord {
  id: string;
  walletAddress: string;
  role: string;
  loginAt: string | null;
  logoutAt: string | null;
  durationMs?: number;
  userAgent?: string;
  ipHash?: string;
  referrer?: string;
  sessionId: string;
}

function formatDuration(ms?: number): string {
  if (!ms || ms <= 0) return "—";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return `${hours}h ${rem}m`;
}

function formatDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleString();
}

function shortenWallet(w: string): string {
  if (w.length <= 12) return w;
  return `${w.slice(0, 6)}...${w.slice(-4)}`;
}

function parseDevice(ua?: string): string {
  if (!ua || ua === "unknown") return "Unknown";
  if (ua.includes("Mobile")) return "Mobile";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Safari")) return "Safari";
  if (ua.includes("Edge")) return "Edge";
  return "Desktop";
}

export default function SessionExplorerPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [walletFilter, setWalletFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (walletFilter) params.set("wallet", walletFilter);
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);

      const res = await fetch(`/api/admin/analytics/sessions?${params}`);
      if (res.ok) {
        const d = await res.json();
        setSessions(d.sessions || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [walletFilter, dateFrom, dateTo]);

  useEffect(() => {
    if (isAdmin) fetchSessions();
  }, [isAdmin, fetchSessions]);

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-muted-foreground">Connect your wallet to continue.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground">Platform admin wallet required.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin/analytics" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Clock className="h-6 w-6 text-cyan-400" />
          <h1 className="text-2xl font-bold">Session Explorer</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSessions} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter by wallet address..."
            value={walletFilter}
            onChange={(e) => setWalletFilter(e.target.value)}
            className="pl-9"
          />
        </div>
        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="w-[160px]"
          placeholder="From"
        />
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="w-[160px]"
          placeholder="To"
        />
        <Button variant="outline" size="sm" onClick={fetchSessions}>
          Apply
        </Button>
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Clock className="h-10 w-10 mx-auto mb-3 opacity-50" />
          <p>No sessions found</p>
          <p className="text-xs mt-1">Sessions are recorded when users log in via wallet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_80px_140px_140px_80px_80px] gap-2 px-3 py-2 text-xs text-muted-foreground font-medium">
            <span>Wallet</span>
            <span>Role</span>
            <span>Login</span>
            <span>Logout</span>
            <span>Duration</span>
            <span>Device</span>
          </div>

          {sessions.map((s) => (
            <div
              key={s.id}
              className="grid grid-cols-[1fr_80px_140px_140px_80px_80px] gap-2 items-center p-3 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-sm truncate" title={s.walletAddress}>
                  {shortenWallet(s.walletAddress)}
                </span>
              </div>
              <span className={`text-xs px-1.5 py-0.5 rounded w-fit ${
                s.role === "platform_admin"
                  ? "bg-amber-500/20 text-amber-400"
                  : s.role === "org_admin"
                    ? "bg-blue-500/20 text-blue-400"
                    : "bg-zinc-500/20 text-zinc-400"
              }`}>
                {s.role === "platform_admin" ? "admin" : s.role === "org_admin" ? "org" : "op"}
              </span>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <LogIn className="h-3 w-3 text-green-400" />
                <span>{formatDate(s.loginAt)}</span>
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {s.logoutAt ? (
                  <>
                    <LogOut className="h-3 w-3 text-red-400" />
                    <span>{formatDate(s.logoutAt)}</span>
                  </>
                ) : (
                  <span className="text-emerald-400">active</span>
                )}
              </div>
              <span className="text-xs font-medium">
                {formatDuration(s.durationMs)}
              </span>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Monitor className="h-3 w-3" />
                <span>{parseDevice(s.userAgent)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
