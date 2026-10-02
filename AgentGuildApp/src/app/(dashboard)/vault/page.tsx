/**
 * Vault — org secrets that agents can *use* but never *see*.
 *
 * Secrets are write-only from here (no reveal). A binding says which agents
 * may call which API with which secret; agents call it with
 * `agent-guild call <binding> …` or the guild_call MCP tool, and the hub
 * injects the credential server-side. Every call lands in the hash-chained
 * audit log below. Writes are org-owner only (enforced by /api/vault/*).
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KeyRound, Link2, ScrollText, ShieldCheck, ShieldAlert, Plus, RotateCw, Trash2, Ban, Undo2, Loader2 } from "lucide-react";
import { useOrg } from "@/contexts/OrgContext";
import { useWalletAccount } from "@/lib/wallet";
import { canonicalizeWalletAddress } from "@/lib/wallet-address";
import { getAgentsByOrg, type Agent } from "@/lib/firestore";

interface SecretRow {
  id: string;
  name: string;
  description: string;
  maskedPreview: string;
  kekProvider: "gcp-kms" | "local";
  createdAt: number | null;
  rotatedAt: number | null;
  lastUsedAt: number | null;
  useCount: number;
}

interface BindingRow {
  id: string;
  name: string;
  description: string;
  secretId: string;
  baseUrl: string;
  auth: { style: "bearer" | "header" | "query" | "basic"; header?: string; prefix?: string; param?: string; username?: string };
  allowedMethods: string[];
  allowedPaths: string[];
  agentIds: string[];
  maxCallsPerHour: number;
  revoked: boolean;
}

interface AuditRow {
  seq: number;
  at: number;
  action: string;
  actorType: "user" | "agent";
  actorId: string;
  target: string;
  detail: Record<string, string | number | boolean | null> | null;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const fmtTime = (ms: number | null) => (ms ? new Date(ms).toLocaleString() : "—");
const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data as T;
}

export default function VaultPage() {
  const { currentOrg } = useOrg();
  const account = useWalletAccount();
  const orgId = currentOrg?.id;
  const isOwner = Boolean(
    currentOrg?.ownerAddress && account?.address &&
    canonicalizeWalletAddress(currentOrg.ownerAddress) === canonicalizeWalletAddress(account.address),
  );

  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [provider, setProvider] = useState<{ provider: string; configured: boolean } | null>(null);
  const [bindings, setBindings] = useState<BindingRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [chain, setChain] = useState<{ intact: boolean; brokenAt: number | null } | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  const [rotating, setRotating] = useState<SecretRow | null>(null);
  const [showBinding, setShowBinding] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, b, a] = await Promise.all([
        api<{ secrets: SecretRow[]; provider: { provider: string; configured: boolean } }>(`/api/vault/secrets?orgId=${orgId}`),
        api<{ bindings: BindingRow[] }>(`/api/vault/bindings?orgId=${orgId}`),
        api<{ entries: AuditRow[]; chain: { intact: boolean; brokenAt: number | null } }>(`/api/vault/audit?orgId=${orgId}&limit=100`),
      ]);
      setSecrets(s.secrets);
      setProvider(s.provider);
      setBindings(b.bindings);
      setAudit(a.entries);
      setChain(a.chain);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (orgId) getAgentsByOrg(orgId).then(setAgents).catch(() => setAgents([]));
  }, [orgId]);

  const agentName = (id: string) => (id === "*" ? "All agents" : agents.find((a) => a.id === id)?.name || id);
  const secretName = (id: string) => secrets.find((s) => s.id === id)?.name || "missing secret";

  /** Runs a mutation and reloads. Returns the error message (or null) so dialogs can stay open on failure. */
  const run = async (fn: () => Promise<unknown>, { inline = false } = {}): Promise<string | null> => {
    setError(null);
    try {
      await fn();
      await load();
      return null;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!inline) setError(message);
      return message;
    }
  };

  if (!orgId) {
    return <div className="container mx-auto p-6 text-sm text-muted-foreground">Select an organization to manage its vault.</div>;
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <KeyRound className="h-7 w-7" />Vault
        </h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Store API keys once. Agents call those APIs through <span className="font-medium text-foreground">bindings</span>: Agent Guild
          adds the key on the server, so it never shows up in an agent&apos;s prompt, logs or memory. Revoke a binding to cut access instantly
          without rotating the key.
        </p>
      </div>

      {provider && !provider.configured && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm">
          <ShieldAlert className="h-4 w-4 mt-0.5 text-red-500 shrink-0" />
          <span>The vault isn&apos;t configured on this server. Set <code>VAULT_KMS_KEY</code> (Cloud KMS key) or <code>VAULT_MASTER_KEY</code> before adding secrets.</span>
        </div>
      )}
      {provider?.configured && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          {provider.provider === "gcp-kms"
            ? "Each secret has its own data key, wrapped by Google Cloud KMS."
            : "Each secret has its own data key, wrapped by the server's master key."}
        </p>
      )}
      {!isOwner && (
        <p className="text-xs text-muted-foreground">You can view the vault. Only the organization owner can add, change or revoke secrets and bindings.</p>
      )}
      {error && <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-500">{error}</div>}

      <Tabs defaultValue="bindings">
        <TabsList>
          <TabsTrigger value="bindings"><Link2 className="h-4 w-4 mr-1.5" />Bindings ({bindings.length})</TabsTrigger>
          <TabsTrigger value="secrets"><KeyRound className="h-4 w-4 mr-1.5" />Secrets ({secrets.length})</TabsTrigger>
          <TabsTrigger value="audit"><ScrollText className="h-4 w-4 mr-1.5" />Audit log</TabsTrigger>
        </TabsList>

        {/* ── Bindings ─────────────────────────────────────────── */}
        <TabsContent value="bindings" className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Agents use these with <code className="text-xs">agent-guild call &lt;binding&gt; GET /path</code> or the <code className="text-xs">guild_call</code> MCP tool.
            </p>
            {isOwner && (
              <Button size="sm" onClick={() => setShowBinding(true)} disabled={!secrets.length} title={secrets.length ? undefined : "Add a secret first"}>
                <Plus className="h-4 w-4 mr-1" />New binding
              </Button>
            )}
          </div>
          {loading ? <Loading /> : bindings.length === 0 ? (
            <Empty text={secrets.length ? "No bindings yet. Create one to let agents use a secret." : "Add a secret first, then bind it to an API."} />
          ) : (
            <div className="grid gap-3">
              {bindings.map((b) => (
                <Card key={b.id} className={b.revoked ? "opacity-60" : undefined}>
                  <CardContent className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold">{b.name}</span>
                          {b.revoked ? <Badge variant="destructive">Revoked</Badge> : <Badge variant="secondary">Active</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground font-mono break-all">{b.baseUrl}</p>
                        {b.description && <p className="text-sm mt-1">{b.description}</p>}
                      </div>
                      {isOwner && (
                        <div className="flex gap-1 shrink-0">
                          <Button size="sm" variant="outline" onClick={() => run(() => api(`/api/vault/bindings/${b.id}`, { method: "PATCH", body: JSON.stringify({ orgId, revoked: !b.revoked }) }))}>
                            {b.revoked ? <><Undo2 className="h-3.5 w-3.5 mr-1" />Restore</> : <><Ban className="h-3.5 w-3.5 mr-1" />Revoke</>}
                          </Button>
                          <Button size="sm" variant="ghost" aria-label={`Delete ${b.name}`} onClick={() => {
                            if (confirm(`Delete binding "${b.name}"? Agents using it will start getting errors.`)) {
                              run(() => api(`/api/vault/bindings/${b.id}?orgId=${orgId}`, { method: "DELETE" }));
                            }
                          }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                      <span>Secret: <span className="font-mono text-foreground">{secretName(b.secretId)}</span></span>
                      <span>Auth: {authLabel(b.auth)}</span>
                      <span>Methods: {b.allowedMethods.join(", ")}</span>
                      <span>Paths: <span className="font-mono">{b.allowedPaths.join(", ")}</span></span>
                      <span>Agents: {b.agentIds.map(agentName).join(", ")}</span>
                      <span>Limit: {b.maxCallsPerHour ? `${b.maxCallsPerHour}/hour` : "none"}</span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Secrets ──────────────────────────────────────────── */}
        <TabsContent value="secrets" className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">Values are write-only. Nobody can read a secret back from here, the API, or an agent.</p>
            {isOwner && <Button size="sm" onClick={() => setShowSecret(true)} disabled={provider?.configured === false}><Plus className="h-4 w-4 mr-1" />Add secret</Button>}
          </div>
          {loading ? <Loading /> : secrets.length === 0 ? <Empty text="No secrets yet." /> : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr>
                      <th className="text-left font-medium p-3">Name</th>
                      <th className="text-left font-medium p-3">Value</th>
                      <th className="text-left font-medium p-3 hidden md:table-cell">Uses</th>
                      <th className="text-left font-medium p-3 hidden md:table-cell">Last used</th>
                      <th className="text-left font-medium p-3 hidden lg:table-cell">Rotated</th>
                      <th className="p-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {secrets.map((s) => (
                      <tr key={s.id} className="border-b last:border-0">
                        <td className="p-3">
                          <div className="font-mono font-medium">{s.name}</div>
                          {s.description && <div className="text-xs text-muted-foreground">{s.description}</div>}
                        </td>
                        <td className="p-3 font-mono text-xs text-muted-foreground">{s.maskedPreview}</td>
                        <td className="p-3 hidden md:table-cell tabular-nums">{s.useCount}</td>
                        <td className="p-3 hidden md:table-cell text-xs">{fmtTime(s.lastUsedAt)}</td>
                        <td className="p-3 hidden lg:table-cell text-xs">{fmtTime(s.rotatedAt)}</td>
                        <td className="p-3">
                          {isOwner && (
                            <div className="flex justify-end gap-1">
                              <Button size="sm" variant="outline" onClick={() => setRotating(s)}><RotateCw className="h-3.5 w-3.5 mr-1" />Rotate</Button>
                              <Button size="sm" variant="ghost" aria-label={`Delete ${s.name}`} onClick={() => {
                                if (confirm(`Delete secret ${s.name}? This can't be undone.`)) {
                                  run(() => api(`/api/vault/secrets/${s.id}?orgId=${orgId}`, { method: "DELETE" }));
                                }
                              }}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Audit ────────────────────────────────────────────── */}
        <TabsContent value="audit" className="space-y-4">
          {chain && (
            <p className={`text-sm flex items-center gap-1.5 ${chain.intact ? "text-muted-foreground" : "text-red-500"}`}>
              {chain.intact ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}
              {chain.intact
                ? "Hash chain intact for the entries shown. Each entry includes the hash of the one before it, so an edited or deleted entry would show up here."
                : `Hash chain broken at entry #${chain.brokenAt}. An audit entry was changed or removed.`}
            </p>
          )}
          {loading ? <Loading /> : audit.length === 0 ? <Empty text="Nothing recorded yet." /> : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground border-b">
                    <tr>
                      <th className="text-left font-medium p-3 w-12">#</th>
                      <th className="text-left font-medium p-3">When</th>
                      <th className="text-left font-medium p-3">Who</th>
                      <th className="text-left font-medium p-3">What</th>
                      <th className="text-left font-medium p-3 hidden md:table-cell">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map((e) => (
                      <tr key={e.seq} className="border-b last:border-0 align-top">
                        <td className="p-3 tabular-nums text-muted-foreground">{e.seq}</td>
                        <td className="p-3 text-xs whitespace-nowrap">{fmtTime(e.at)}</td>
                        <td className="p-3 text-xs">{e.actorType === "agent" ? `🤖 ${agentName(e.actorId)}` : shortAddr(e.actorId)}</td>
                        <td className="p-3">
                          <Badge variant={e.action === "binding.denied" ? "destructive" : "outline"} className="font-mono text-[10px]">{e.action}</Badge>
                          <span className="ml-2 font-mono text-xs">{e.target}</span>
                        </td>
                        <td className="p-3 hidden md:table-cell text-xs text-muted-foreground font-mono break-all">
                          {e.detail ? Object.entries(e.detail).map(([k, v]) => `${k}=${v}`).join("  ") : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <SecretDialog
        open={showSecret || Boolean(rotating)}
        rotating={rotating}
        onClose={() => { setShowSecret(false); setRotating(null); }}
        onSubmit={(name, value, description) => run(() => rotating
          ? api(`/api/vault/secrets/${rotating.id}`, { method: "PUT", body: JSON.stringify({ orgId, value }) })
          : api(`/api/vault/secrets`, { method: "POST", body: JSON.stringify({ orgId, name, value, description }) }), { inline: true })}
      />
      <BindingDialog
        open={showBinding}
        onClose={() => setShowBinding(false)}
        secrets={secrets}
        agents={agents}
        onSubmit={(payload) => run(() => api(`/api/vault/bindings`, { method: "POST", body: JSON.stringify({ orgId, ...payload }) }), { inline: true })}
      />
    </div>
  );
}

function authLabel(auth: BindingRow["auth"]) {
  switch (auth.style) {
    case "bearer": return "Bearer token";
    case "header": return `${auth.header} header`;
    case "query": return `?${auth.param}=`;
    case "basic": return `Basic (${auth.username})`;
  }
}

function Loading() {
  return <div className="flex items-center gap-2 text-sm text-muted-foreground py-6"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>;
}

function Empty({ text }: { text: string }) {
  return <Card><CardContent className="p-6 text-sm text-muted-foreground text-center">{text}</CardContent></Card>;
}

function SecretDialog({ open, rotating, onClose, onSubmit }: {
  open: boolean;
  rotating: SecretRow | null;
  onClose: () => void;
  onSubmit: (name: string, value: string, description: string) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setName(""); setValue(""); setDescription(""); setError(null); }
  }, [open]);

  const submit = async () => {
    setBusy(true);
    const err = await onSubmit(name.trim(), value, description.trim());
    setBusy(false);
    setError(err);
    if (!err) { setValue(""); onClose(); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{rotating ? `Rotate ${rotating.name}` : "Add secret"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!rotating && (
            <>
              <div className="space-y-1">
                <Label htmlFor="secret-name">Name</Label>
                <Input id="secret-name" placeholder="STRIPE_API_KEY" value={name} onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="secret-desc">Description (optional)</Label>
                <Input id="secret-desc" placeholder="Read-only restricted key" value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </>
          )}
          <div className="space-y-1">
            <Label htmlFor="secret-value">{rotating ? "New value" : "Value"}</Label>
            <Input id="secret-value" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Encrypted before it&apos;s stored. You won&apos;t be able to view it again{rotating ? "; bindings switch to the new value straight away" : ""}.
            </p>
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy || !value || (!rotating && name.length < 2)}>
              {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}{rotating ? "Rotate" : "Save secret"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BindingDialog({ open, onClose, secrets, agents, onSubmit }: {
  open: boolean;
  onClose: () => void;
  secrets: SecretRow[];
  agents: Agent[];
  onSubmit: (payload: Record<string, unknown>) => Promise<string | null>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [secretId, setSecretId] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://");
  const [style, setStyle] = useState<BindingRow["auth"]["style"]>("bearer");
  const [header, setHeader] = useState("X-API-Key");
  const [prefix, setPrefix] = useState("");
  const [param, setParam] = useState("api_key");
  const [username, setUsername] = useState("");
  const [methods, setMethods] = useState<string[]>(["GET"]);
  const [paths, setPaths] = useState("/");
  const [allAgents, setAllAgents] = useState(false);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(""); setDescription(""); setSecretId(secrets[0]?.id || ""); setBaseUrl("https://"); setStyle("bearer");
    setMethods(["GET"]); setPaths("/"); setAllAgents(false); setAgentIds([]); setLimit(""); setError(null);
  }, [open, secrets]);

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const submit = async () => {
    setBusy(true);
    const auth = style === "header" ? { style, header, ...(prefix ? { prefix } : {}) }
      : style === "query" ? { style, param }
      : style === "basic" ? { style, username }
      : { style };
    const err = await onSubmit({
      name, description, secretId, baseUrl, auth,
      allowedMethods: methods,
      allowedPaths: paths.split(",").map((p) => p.trim()).filter(Boolean),
      agentIds: allAgents ? ["*"] : agentIds,
      maxCallsPerHour: Number(limit) || 0,
    });
    setBusy(false);
    setError(err);
    if (!err) onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New binding</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="b-name">Name</Label>
              <Input id="b-name" placeholder="stripe-api" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
            </div>
            <div className="space-y-1">
              <Label>Secret</Label>
              <Select value={secretId} onValueChange={setSecretId}>
                <SelectTrigger><SelectValue placeholder="Choose a secret" /></SelectTrigger>
                <SelectContent>{secrets.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="b-desc">Description (optional)</Label>
            <Input id="b-desc" placeholder="Read account balance" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="b-url">Base URL</Label>
            <Input id="b-url" placeholder="https://api.stripe.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <p className="text-xs text-muted-foreground">HTTPS only. Agents can only reach paths under this URL; redirects aren&apos;t followed.</p>
          </div>

          <div className="space-y-2">
            <Label>How the key is sent</Label>
            <Select value={style} onValueChange={(v) => setStyle(v as typeof style)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bearer">Authorization: Bearer &lt;key&gt;</SelectItem>
                <SelectItem value="header">Custom header</SelectItem>
                <SelectItem value="query">Query parameter</SelectItem>
                <SelectItem value="basic">HTTP Basic (key as password)</SelectItem>
              </SelectContent>
            </Select>
            {style === "header" && (
              <div className="grid grid-cols-2 gap-3">
                <Input aria-label="Header name" placeholder="X-API-Key" value={header} onChange={(e) => setHeader(e.target.value)} />
                <Input aria-label="Value prefix" placeholder="Prefix (optional)" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              </div>
            )}
            {style === "query" && <Input aria-label="Query parameter" placeholder="api_key" value={param} onChange={(e) => setParam(e.target.value)} />}
            {style === "basic" && <Input aria-label="Username" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />}
          </div>

          <div className="space-y-2">
            <Label>Allowed methods</Label>
            <div className="flex flex-wrap gap-2">
              {METHODS.map((m) => (
                <button key={m} type="button" onClick={() => setMethods(toggle(methods, m))}
                  className={`px-2.5 py-1 rounded border text-xs font-mono ${methods.includes(m) ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground"}`}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="b-paths">Allowed path prefixes</Label>
            <Input id="b-paths" placeholder="/v1/balance, /v1/charges" value={paths} onChange={(e) => setPaths(e.target.value)} />
            <p className="text-xs text-muted-foreground">Comma-separated. <code>/</code> allows everything under the base URL.</p>
          </div>

          <div className="space-y-2">
            <Label>Agents that may use it</Label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={allAgents} onChange={(e) => setAllAgents(e.target.checked)} />
              Every agent in this organization
            </label>
            {!allAgents && (
              <div className="max-h-40 overflow-y-auto rounded border p-2 space-y-1">
                {agents.length === 0 && <p className="text-xs text-muted-foreground">No agents in this organization yet.</p>}
                {agents.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={agentIds.includes(a.id)} onChange={() => setAgentIds(toggle(agentIds, a.id))} />
                    {a.name}
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="b-limit">Max calls per hour (optional)</Label>
            <Input id="b-limit" type="number" min={0} placeholder="No limit" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={submit} disabled={busy || name.length < 2 || !secretId || !methods.length || (!allAgents && !agentIds.length)}>
              {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Create binding
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
