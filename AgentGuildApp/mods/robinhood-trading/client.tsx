"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Activity as ActivityIcon, Bot, Check, ClipboardList, Link2, Play, RefreshCw, ShieldCheck, Unlink, X } from "lucide-react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";
import { Badge, Button, Card, Json, Notice, Stat, TextInput, cx, inputClass, json, muted, timeAgo, usd, type Tone } from "./ui";
import type { Policy } from "./policy";

// The owner's side of the Robinhood mod: connect the Agentic account, set
// the policy every agent order is checked against, approve held orders, and
// see what agents did. Agents themselves use the HTTP tools (GET /agent/tools).

interface AgentRow { agentId: string; name: string; capabilities: Record<string, boolean> }
interface OrgRow { orgId: string; orgName: string; isOwner: boolean; agents: AgentRow[] }
interface ConnectionInfo {
  connection: { connected: false } | { connected: true; status: "connected" | "needs_reconnect"; connectedBy: string | null; connectedAt: string | null; lastError: string | null };
  policy: Policy;
  today: { orders: number; usd: number };
}
interface OrderRow {
  id: string; status: string; summary: string; agentId: string; reason: string; reasons: string[]; warnings: string[];
  notionalUsd: number | null; createdAt: string; decidedAt: string | null; error: string | null;
}
interface ActivityRow { at: string; agentId: string | null; action: string; ok: boolean; summary: string }
interface ToolRow { name: string; kind: string; description: string }

const CAPS = [
  { key: "rh-read", label: "Read account", hint: "portfolio, positions, quotes, history" },
  { key: "rh-watchlist", label: "Watchlists", hint: "add to and reorder watchlists" },
  { key: "rh-trade", label: "Trade", hint: "submit orders (policy + approval) and cancel" },
];

const STATUS_TONE: Record<string, Tone> = {
  pending_approval: "warning", placing: "info", placed: "success", denied: "danger", rejected: "danger", failed: "danger", expired: "neutral",
};

const STORAGE_KEY = "robinhood-mod:org";

function RobinhoodPanel({ api }: PanelProps) {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  // Robinhood's redirect lands back here with ?robinhood=connected|error.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const result = p.get("robinhood");
    if (!result) return;
    setFlash(result === "connected" ? { tone: "success", text: "Robinhood connected." } : { tone: "danger", text: p.get("reason") ?? "Connecting Robinhood failed." });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const loadOrgs = useCallback(() => {
    json<{ orgs: OrgRow[] }>(api("my-agents"))
      .then(({ orgs: list }) => {
        setOrgs(list);
        let saved: string | null = null;
        try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }
        setOrgId((cur) => [cur, saved].find((id) => id && list.some((o) => o.orgId === id)) ?? list.find((o) => o.isOwner)?.orgId ?? list[0]?.orgId ?? null);
      })
      .catch((err: Error) => setError(err.message));
  }, [api]);
  useEffect(loadOrgs, [loadOrgs]);

  const org = orgs?.find((o) => o.orgId === orgId) ?? null;
  const agentName = useMemo(() => new Map((org?.agents ?? []).map((a) => [a.agentId, a.name])), [org]);

  const refresh = useCallback(() => {
    if (!orgId) return;
    try { localStorage.setItem(STORAGE_KEY, orgId); } catch { /* ignore */ }
    const q = `orgId=${encodeURIComponent(orgId)}`;
    Promise.all([
      json<ConnectionInfo>(api(`connection?${q}`)),
      json<{ orders: OrderRow[] }>(api(`orders?${q}`)),
      json<{ activity: ActivityRow[] }>(api(`activity?${q}`)),
    ])
      .then(([c, o, a]) => { setInfo(c); setOrders(o.orders); setActivity(a.activity); setError(null); })
      .catch((err: Error) => setError(err.message));
  }, [api, orgId]);
  useEffect(() => {
    setInfo(null);
    refresh();
    const t = setInterval(refresh, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function act(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setFlash(null);
    try {
      await fn();
      if (done) setFlash({ tone: "success", text: done });
      refresh();
    } catch (err) {
      setFlash({ tone: "danger", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const post = (path: string, payload: object) => json(api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }));

  const connect = () => act("connect", async () => {
    const { authorizeUrl } = await post("connect", { orgId }) as { authorizeUrl: string };
    window.location.assign(authorizeUrl);
  });

  const conn = info?.connection;
  const live = conn?.connected && conn.status === "connected";
  const isOwner = !!org?.isOwner;
  const pending = orders.filter((o) => o.status === "pending_approval");

  return (
    <div className="min-h-full bg-[hsl(var(--background))] text-[hsl(var(--foreground))]">
      <header className="border-b border-[hsl(var(--border))]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-4 px-4 py-4 lg:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#00C805] text-lg font-bold text-black" aria-hidden>R</div>
            <div>
              <h1 className="text-base font-semibold leading-tight">Robinhood Trading</h1>
              <p className={cx("text-xs", muted)}>Your agents trade your Agentic account, inside your limits</p>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {orgs && orgs.length > 1 && (
              <select aria-label="Organization" className={cx(inputClass, "w-auto [&_option]:bg-[hsl(var(--popover))]")} value={orgId ?? ""} onChange={(e) => setOrgId(e.target.value)}>
                {orgs.map((o) => <option key={o.orgId} value={o.orgId}>{o.orgName}{o.isOwner ? "" : " (member)"}</option>)}
              </select>
            )}
            <Button icon={RefreshCw} onClick={refresh} aria-label="Refresh">Refresh</Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 px-4 py-6 lg:px-6">
        {flash && <Notice tone={flash.tone}>{flash.text}</Notice>}
        {error && <Notice title="Couldn't load" action={<Button className="h-8" onClick={() => { loadOrgs(); refresh(); }}>Retry</Button>}>{error}</Notice>}
        {orgs && !orgs.length && <Notice tone="info">Create an organization first — Robinhood connects per org.</Notice>}

        {org && info && (
          <>
            <Card
              title="Connection"
              description="Robinhood's official Trading MCP server. You sign in on robinhood.com and open (or reuse) your dedicated Agentic account — this app never sees your password, and agents can only trade in that account."
              actions={isOwner && (conn?.connected
                ? <>
                    {!live && <Button variant="primary" icon={Link2} loading={busy === "connect"} onClick={connect}>Reconnect</Button>}
                    <Button variant="danger" icon={Unlink} loading={busy === "disconnect"}
                      onClick={() => confirm("Disconnect Robinhood? Agents lose access immediately.") && act("disconnect", () => post("disconnect", { orgId }), "Disconnected.")}>Disconnect</Button>
                  </>
                : <Button variant="primary" icon={Link2} loading={busy === "connect"} onClick={connect}>Connect Robinhood</Button>)}>
              {conn?.connected ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={live ? "success" : "warning"}>{live ? "Connected" : "Needs reconnect"}</Badge>
                  {conn.connectedAt && <span className={muted}>since {new Date(conn.connectedAt).toLocaleDateString()} by <span className="font-mono text-xs">{conn.connectedBy}</span></span>}
                  {conn.lastError && <span className="text-xs text-amber-700 dark:text-amber-300">{conn.lastError}</span>}
                </div>
              ) : (
                <p className={cx("text-sm", muted)}>{isOwner ? "Not connected yet." : "Not connected — the org owner connects Robinhood."}</p>
              )}
            </Card>

            {conn?.connected && (
              <Card title={`Waiting for you${pending.length ? ` (${pending.length})` : ""}`} description="Orders your policy holds for approval. Approving places the order with Robinhood right away; held orders expire after 24 hours.">
                {pending.length ? (
                  <ul className="space-y-3">
                    {pending.map((o) => (
                      <li key={o.id} className="rounded-lg border border-[hsl(var(--border))] p-3">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-mono text-sm">{o.summary}</div>
                            <div className={cx("mt-0.5 text-xs", muted)}>{agentName.get(o.agentId) ?? o.agentId} · {timeAgo(o.createdAt)}</div>
                          </div>
                          {isOwner && (
                            <div className="flex gap-2">
                              <Button variant="primary" icon={Check} loading={busy === `a:${o.id}`} onClick={() => act(`a:${o.id}`, () => post(`orders/${o.id}/decision`, { decision: "approve" }), "Order sent to Robinhood.")}>Approve</Button>
                              <Button icon={X} loading={busy === `r:${o.id}`} onClick={() => act(`r:${o.id}`, () => post(`orders/${o.id}/decision`, { decision: "reject" }), "Order rejected.")}>Reject</Button>
                            </div>
                          )}
                        </div>
                        <p className="mt-2 text-sm">&ldquo;{o.reason}&rdquo;</p>
                        {o.warnings.length > 0 && <div className="mt-2"><Notice tone="warning" title="Robinhood's review">{o.warnings.join(" · ")}</Notice></div>}
                        <p className={cx("mt-1.5 text-xs", muted)}>Held because: {o.reasons.join("; ")}</p>
                      </li>
                    ))}
                  </ul>
                ) : <p className={cx("text-sm", muted)}>Nothing waiting.</p>}
              </Card>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Orders today" value={`${info.today.orders} / ${info.policy.maxDailyOrders}`} />
              <Stat label="Spent today" value={usd(info.today.usd)} sub={`of ${usd(info.policy.maxDailyUsd)}`} />
              <Stat label="Per order" value={usd(info.policy.maxOrderUsd)} />
              <Stat label="Approval" value={info.policy.approval === "always" ? "Every order" : info.policy.approval === "never" ? "Never" : `Over ${usd(info.policy.approvalThresholdUsd)}`} sub={info.policy.tradingEnabled ? "trading on" : "trading off"} />
            </div>

            <PolicyCard policy={info.policy} editable={isOwner} busy={busy === "policy"}
              onSave={(policy) => act("policy", () => post("policy", { orgId, policy }), "Policy saved.")} />

            <Card title="Agents" description="Upgrades apply org-wide. Trade lets agents submit orders; your policy and approvals still decide what's placed.">
              {org.agents.length ? (
                <ul className="divide-y divide-[hsl(var(--border))]">
                  {org.agents.map((a) => (
                    <li key={a.agentId} className="flex flex-wrap items-center gap-2 py-2">
                      <Bot className={cx("h-4 w-4", muted)} aria-hidden />
                      <span className="text-sm font-medium">{a.name}</span>
                      <span className="ml-auto flex flex-wrap gap-1">{CAPS.map((c) => <Badge key={c.key} tone={a.capabilities[c.key] ? "success" : "neutral"}>{c.label}</Badge>)}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className={cx("text-sm", muted)}>No agents in this org yet.</p>}
              {isOwner && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button icon={ShieldCheck} loading={busy === "up-read"} onClick={() => act("up-read", () => post("upgrade", { orgId, capabilities: ["rh-read", "rh-watchlist"] }), "Read and watchlist upgrades enabled.")}>Enable read + watchlists</Button>
                  <Button variant="primary" icon={ShieldCheck} loading={busy === "up-all"}
                    onClick={() => confirm("Let this org's agents submit real-money orders (still subject to your policy)?") && act("up-all", () => post("upgrade", { orgId }), "All upgrades enabled, including Trade.")}>Enable trading too</Button>
                </div>
              )}
            </Card>

            {live && isOwner && <AccountCard api={api} orgId={org.orgId} />}

            <Card title="Orders" description="Every order an agent asked for through this mod.">
              {orders.length ? (
                <ul className="divide-y divide-[hsl(var(--border))]">
                  {orders.map((o) => (
                    <li key={o.id} className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{o.status.replace("_", " ")}</Badge>
                        <span className="min-w-0 truncate font-mono text-xs">{o.summary}</span>
                        <span className={cx("ml-auto text-xs", muted)}>{agentName.get(o.agentId) ?? o.agentId} · {timeAgo(o.createdAt)}</span>
                      </div>
                      {(o.error || (o.status === "denied" && o.reasons.length > 0)) && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{o.error ?? o.reasons.join("; ")}</p>}
                    </li>
                  ))}
                </ul>
              ) : <p className={cx("text-sm", muted)}>No orders yet.</p>}
            </Card>

            <Card title="Activity" actions={<ActivityIcon className={cx("h-4 w-4", muted)} aria-hidden />}>
              {activity.length ? (
                <ul className="space-y-1.5">
                  {activity.map((a, i) => (
                    <li key={`${a.at}-${i}`} className="flex gap-2 text-xs">
                      <span className={cx("w-16 shrink-0 tabular-nums", muted)}>{timeAgo(a.at)}</span>
                      <span className={cx("h-1.5 w-1.5 shrink-0 translate-y-1.5 rounded-full", a.ok ? "bg-green-500" : "bg-red-500")} aria-hidden />
                      <span className="min-w-0 break-words">{a.agentId ? <span className="font-medium">{agentName.get(a.agentId) ?? a.agentId}: </span> : null}{a.summary}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className={cx("text-sm", muted)}>Nothing yet.</p>}
            </Card>
          </>
        )}
      </main>
    </div>
  );
}

/** onSave gets the raw form: symbol lists stay comma-separated strings, which the server's normalizePolicy splits. */
function PolicyCard({ policy, editable, busy, onSave }: { policy: Policy; editable: boolean; busy: boolean; onSave: (p: Record<string, unknown>) => void }) {
  const [draft, setDraft] = useState(policy);
  const [allowed, setAllowed] = useState(policy.allowedSymbols.join(", "));
  const [blocked, setBlocked] = useState(policy.blockedSymbols.join(", "));
  // Re-seed when the saved policy changes (after a save or an org switch).
  const key = JSON.stringify(policy);
  useEffect(() => {
    setDraft(policy);
    setAllowed(policy.allowedSymbols.join(", "));
    setBlocked(policy.blockedSymbols.join(", "));
  }, [key]);

  const set = <K extends keyof Policy>(k: K, v: Policy[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ ...draft, allowedSymbols: allowed, blockedSymbols: blocked });
  };
  const money = (k: "maxOrderUsd" | "maxDailyUsd" | "approvalThresholdUsd", label: string) => (
    <label className="space-y-1 text-xs font-medium">
      <span>{label}</span>
      <TextInput type="number" min={0} step="0.01" disabled={!editable} value={draft[k]} onChange={(e) => set(k, Number(e.target.value))} />
    </label>
  );
  const toggle = (k: "tradingEnabled" | "allowOptions" | "allowCrypto", label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 accent-[hsl(var(--primary))]" disabled={!editable} checked={draft[k]} onChange={(e) => set(k, e.target.checked)} />
      {label}
    </label>
  );

  return (
    <Card title="Policy" description="Checked on every order, after Robinhood's own review. Orders whose dollar size can't be worked out always wait for you.">
      <form onSubmit={submit} className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {toggle("tradingEnabled", "Trading on")}
          {toggle("allowOptions", "Allow options")}
          {toggle("allowCrypto", "Allow crypto")}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1 text-xs font-medium">
            <span>Approval</span>
            <select className={inputClass} disabled={!editable} value={draft.approval} onChange={(e) => set("approval", e.target.value as Policy["approval"])}>
              <option value="always">Approve every order</option>
              <option value="over_threshold">Approve above a threshold</option>
              <option value="never">Auto-place within limits</option>
            </select>
          </label>
          {draft.approval === "over_threshold" && money("approvalThresholdUsd", "Approve above ($)")}
          {money("maxOrderUsd", "Max per order ($)")}
          {money("maxDailyUsd", "Max per day ($)")}
          <label className="space-y-1 text-xs font-medium">
            <span>Max orders per day</span>
            <TextInput type="number" min={0} step={1} disabled={!editable} value={draft.maxDailyOrders} onChange={(e) => set("maxDailyOrders", Number(e.target.value))} />
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs font-medium">
            <span>Only these symbols (blank = any)</span>
            <TextInput disabled={!editable} placeholder="SPY, QQQ, AAPL" value={allowed} onChange={(e) => setAllowed(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs font-medium">
            <span>Never these symbols</span>
            <TextInput disabled={!editable} placeholder="GME, AMC" value={blocked} onChange={(e) => setBlocked(e.target.value)} />
          </label>
        </div>
        {draft.approval === "never" && editable && <Notice tone="warning">Agents will place real orders without asking you, up to these limits.</Notice>}
        {editable ? <Button type="submit" variant="primary" loading={busy}>Save policy</Button> : <p className={cx("text-xs", muted)}>Only the org owner can change the policy.</p>}
      </form>
    </Card>
  );
}

/** The owner reading their own account through the same MCP tools agents use (read tools only). */
function AccountCard({ api, orgId }: { api: PanelProps["api"]; orgId: string }) {
  const [tools, setTools] = useState<ToolRow[] | null>(null);
  const [tool, setTool] = useState("get_portfolio");
  const [args, setArgs] = useState("{}");
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    json<{ tools: ToolRow[] }>(api(`panel/tools?orgId=${encodeURIComponent(orgId)}`))
      .then(({ tools: list }) => {
        setTools(list);
        if (!list.some((t) => t.name === "get_portfolio") && list[0]) setTool(list.find((t) => t.kind === "read")?.name ?? list[0].name);
      })
      .catch((err: Error) => setError(err.message));
  }, [api, orgId]);

  async function run(e?: FormEvent) {
    e?.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const parsed = JSON.parse(args || "{}");
      const out = await json<{ result: unknown }>(api("panel/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orgId, tool, arguments: parsed }) }));
      setResult(out.result);
    } catch (err) {
      setError(err instanceof SyntaxError ? "Arguments must be JSON" : (err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const reads = (tools ?? []).filter((t) => t.kind === "read");
  const others = (tools ?? []).filter((t) => t.kind !== "read");

  return (
    <Card title="Your account" description="Run any Robinhood read tool — what your agents see." actions={<ClipboardList className={cx("h-4 w-4", muted)} aria-hidden />}>
      <form onSubmit={run} className="flex flex-wrap gap-2">
        <select aria-label="Tool" className={cx(inputClass, "w-auto")} value={tool} onChange={(e) => setTool(e.target.value)} disabled={!tools}>
          {reads.map((t) => <option key={t.name} value={t.name} title={t.description}>{t.name}</option>)}
        </select>
        <TextInput aria-label="Arguments (JSON)" className="min-w-[12rem] flex-1 font-mono text-xs" value={args} onChange={(e) => setArgs(e.target.value)} />
        <Button type="submit" variant="primary" icon={Play} loading={loading} disabled={!tools}>Run</Button>
      </form>
      {tools && reads.find((t) => t.name === tool)?.description && <p className={cx("mt-2 text-xs", muted)}>{reads.find((t) => t.name === tool)!.description}</p>}
      {error && <div className="mt-3"><Notice>{error}</Notice></div>}
      {result !== null && <div className="mt-3"><Json value={result} /></div>}
      {others.length > 0 && (
        <p className={cx("mt-3 text-xs", muted)}>
          Agent-only tools: {others.map((t) => `${t.name} (${t.kind})`).join(", ")}
        </p>
      )}
    </Card>
  );
}

export default defineClientMod({ panels: { trading: RobinhoodPanel } });
