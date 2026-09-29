"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import {
  Users, Loader2, RefreshCw, ShieldAlert, ArrowLeft, Search,
  Clock, TrendingUp, Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface UserProfile {
  walletAddress: string;
  email?: string;
  firstSeen: string | null;
  lastSeen: string | null;
  totalSessions: number;
  totalTimeMs: number;
  role: string;
  orgsOwned: number;
  lastUserAgent?: string;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString();
}

function timeAgo(d: string | null): string {
  if (!d) return "never";
  const diff = Date.now() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortenWallet(w: string): string {
  if (w.length <= 14) return w;
  return `${w.slice(0, 6)}...${w.slice(-4)}`;
}

type SortField = "lastSeen" | "totalSessions" | "totalTimeMs";

export default function UserDirectoryPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<SortField>("lastSeen");
  const [search, setSearch] = useState("");

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100", sort: sortBy });
      if (search) params.set("search", search);
      const res = await fetch(`/api/admin/analytics/users?${params}`);
      if (res.ok) {
        const d = await res.json();
        setUsers(d.users || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [sortBy, search]);

  useEffect(() => {
    if (isAdmin) fetchUsers();
  }, [isAdmin, fetchUsers]);

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

  const sortOptions: { value: SortField; label: string }[] = [
    { value: "lastSeen", label: "Last Seen" },
    { value: "totalSessions", label: "Most Sessions" },
    { value: "totalTimeMs", label: "Most Time" },
  ];

  return (
    <div className="space-y-6 p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin/analytics" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <Users className="h-6 w-6 text-cyan-400" />
          <h1 className="text-2xl font-bold">User Directory</h1>
          {!loading && (
            <span className="text-sm text-muted-foreground">({users.length} users)</span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={fetchUsers} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-[320px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search wallet or email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex gap-1">
          {sortOptions.map((opt) => (
            <Button
              key={opt.value}
              variant={sortBy === opt.value ? "default" : "outline"}
              size="sm"
              onClick={() => setSortBy(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : users.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Users className="h-10 w-10 mx-auto mb-3 opacity-50" />
          <p>No users found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Header row */}
          <div className="grid grid-cols-[1fr_1fr_80px_100px_90px_80px_80px_80px] gap-2 px-3 py-2 text-xs text-muted-foreground font-medium">
            <span>Wallet</span>
            <span>Email</span>
            <span>Role</span>
            <span>Last Seen</span>
            <span>First Seen</span>
            <span>Sessions</span>
            <span>Total Time</span>
            <span>Avg/Session</span>
          </div>

          {users.map((u) => {
            const avgMs = u.totalSessions > 0 ? Math.round(u.totalTimeMs / u.totalSessions) : 0;
            return (
              <Link
                key={u.walletAddress}
                href={`/admin/analytics/sessions?wallet=${u.walletAddress}`}
                className="grid grid-cols-[1fr_1fr_80px_100px_90px_80px_80px_80px] gap-2 items-center p-3 rounded-lg border border-border bg-card/50 hover:bg-card/80 transition-colors"
              >
                <span className="font-mono text-sm truncate" title={u.walletAddress}>
                  {shortenWallet(u.walletAddress)}
                </span>
                <span className="text-xs text-muted-foreground truncate" title={u.email || ""}>
                  {u.email || "—"}
                </span>
                <span className={`text-xs px-1.5 py-0.5 rounded w-fit ${
                  u.role === "platform_admin"
                    ? "bg-amber-500/20 text-amber-400"
                    : u.role === "org_admin"
                      ? "bg-blue-500/20 text-blue-400"
                      : "bg-zinc-500/20 text-zinc-400"
                }`}>
                  {u.role === "platform_admin" ? "admin" : u.role === "org_admin" ? "org" : "op"}
                </span>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  <span>{timeAgo(u.lastSeen)}</span>
                </div>
                <span className="text-xs text-muted-foreground">{formatDate(u.firstSeen)}</span>
                <div className="flex items-center gap-1 text-xs">
                  <TrendingUp className="h-3 w-3 text-muted-foreground" />
                  <span className="font-medium">{u.totalSessions}</span>
                </div>
                <div className="flex items-center gap-1 text-xs">
                  <Timer className="h-3 w-3 text-muted-foreground" />
                  <span>{formatDuration(u.totalTimeMs)}</span>
                </div>
                <span className="text-xs text-muted-foreground">{formatDuration(avgMs)}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
