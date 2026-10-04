"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { defineClientMod, type PanelProps } from "@agent-guild/sdk";

interface Org { id: string; name: string }

interface Record1RM { exercise: string; e1rmKg: number; weightKg: number; reps: number; date: string }

interface Stats {
  windowDays: number;
  totals: { workouts: number; sets: number; volumeKg: number; minutes: number };
  weekly: { weekStart: string; workouts: number; volumeKg: number }[];
  weekStreak: number;
  lastWorkout: { id: string; date: string; name: string } | null;
  bodyParts: { bodyPart: string; sets: number }[];
  records: Record1RM[];
  bodyweight: { latestKg: number; date: string; change30dKg: number | null } | null;
  summary: string;
}

interface WorkoutBrief {
  id: string; date: string; name: string; durationMin: number | null;
  exercises: string[]; sets: number; volumeKg: number; source: string;
}

interface WorkoutFull {
  id: string; date: string; name: string; notes?: string;
  exercises: { name: string; sets: { reps?: number; weightKg?: number; seconds?: number; rir?: number; warmup?: boolean }[] }[];
}

interface Link { baseUrl: string; profileName: string | null; linkedAt: string; lastSyncAt: string | null; lastSyncCount: number | null }

type Tab = "overview" | "log" | "history" | "connect";

const KG_TO_LB = 2.20462262;
const inputCls = "border rounded px-2 py-1 bg-background text-sm";
const btnCls = "border rounded px-3 py-1 text-sm hover:bg-muted disabled:opacity-50";

async function readJson<T>(r: Response): Promise<T> {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error || `Request failed (${r.status})`);
  return d as T;
}

function GymPanel({ api }: PanelProps) {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [orgId, setOrgId] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [unit, setUnit] = useState<"kg" | "lb">("kg");
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    try {
      if (localStorage.getItem("opengym.unit") === "lb") setUnit("lb");
    } catch { /* storage unavailable */ }
    api("orgs")
      .then((r) => readJson<{ orgs: Org[] }>(r))
      .then((d) => {
        setOrgs(d.orgs);
        if (d.orgs[0]) setOrgId(d.orgs[0].id);
      })
      .catch((e) => { setOrgs([]); setError(e.message); });
  }, [api]);

  function changeUnit(u: "kg" | "lb") {
    setUnit(u);
    try { localStorage.setItem("opengym.unit", u); } catch { /* storage unavailable */ }
  }

  const fmt = useCallback(
    (kg: number) => `${Math.round((unit === "lb" ? kg * KG_TO_LB : kg) * 10) / 10} ${unit}`,
    [unit],
  );

  const q = `orgId=${encodeURIComponent(orgId)}`;

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold mr-auto">openGym</h1>
        {orgs && orgs.length > 1 && (
          <select className={inputCls} value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Organization">
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        <select className={inputCls} value={unit} onChange={(e) => changeUnit(e.target.value as "kg" | "lb")} aria-label="Unit">
          <option value="kg">kg</option>
          <option value="lb">lb</option>
        </select>
      </div>
      <p className="text-sm text-muted-foreground">
        A workout log your agents keep for you. Tell an agent what you trained and it logs the session; ask it how
        training is going and it reads the same numbers you see here. Bring in your history from a self-hosted{" "}
        <a className="underline" href="https://github.com/DuarteSantos8/openGym" target="_blank" rel="noreferrer">openGym</a>.
      </p>

      {error && <div className="text-sm text-red-400">{error}</div>}
      {orgs && orgs.length === 0 && !error && <div className="text-sm text-muted-foreground">You are not in any organization yet.</div>}

      {orgId && (
        <>
          <div className="flex gap-1 border-b">
            {(["overview", "log", "history", "connect"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-sm capitalize border-b-2 -mb-px ${tab === t ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}
              >
                {t === "connect" ? "Connect & agents" : t}
              </button>
            ))}
          </div>
          {tab === "overview" && <Overview api={api} q={q} fmt={fmt} version={version} />}
          {tab === "log" && <LogForm api={api} orgId={orgId} unit={unit} fmt={fmt} onSaved={refresh} />}
          {tab === "history" && <History api={api} q={q} fmt={fmt} version={version} onChange={refresh} />}
          {tab === "connect" && <Connect api={api} orgId={orgId} q={q} onImported={refresh} />}
        </>
      )}
    </div>
  );
}

function Overview({ api, q, fmt, version }: { api: PanelProps["api"]; q: string; fmt: (kg: number) => string; version: number }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api(`stats?${q}&days=${days}`).then((r) => readJson<Stats>(r)).then(setStats).catch((e) => setError(e.message));
  }, [api, q, days, version]);

  if (error) return <div className="text-sm text-red-400">{error}</div>;
  if (!stats) return <div className="text-sm text-muted-foreground">Loading…</div>;

  const maxVol = Math.max(1, ...stats.weekly.map((w) => w.volumeKg));
  return (
    <div className="space-y-4">
      <div className="border rounded-lg p-3 text-sm">{stats.summary}</div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted-foreground">Window</span>
        {[7, 30, 90, 365].map((d) => (
          <button key={d} onClick={() => setDays(d)} className={`${btnCls} ${days === d ? "bg-muted" : ""}`}>{d}d</button>
        ))}
      </div>

      <div className="border rounded-lg p-3 text-sm grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="Workouts" value={stats.totals.workouts} />
        <Stat label="Working sets" value={stats.totals.sets} />
        <Stat label="Volume" value={fmt(stats.totals.volumeKg)} />
        <Stat label="Minutes" value={stats.totals.minutes} />
        <Stat label="Week streak" value={stats.weekStreak} />
      </div>

      <div className="border rounded-lg p-3">
        <div className="text-sm font-medium mb-2">Last 8 weeks</div>
        <div className="flex items-end gap-2 h-32">
          {stats.weekly.map((w) => (
            <div key={w.weekStart} className="flex-1 flex flex-col items-center gap-1 h-full justify-end" title={`${w.weekStart}: ${w.workouts} workouts, ${fmt(w.volumeKg)}`}>
              <span className="text-[10px] text-muted-foreground">{w.workouts || ""}</span>
              <div className="w-full rounded-t bg-primary/70" style={{ height: `${Math.max(2, (w.volumeKg / maxVol) * 100)}%` }} />
              <span className="text-[10px] text-muted-foreground">{w.weekStart.slice(5)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div className="border rounded-lg p-3">
          <div className="text-sm font-medium mb-2">Estimated 1RM records</div>
          {stats.records.length === 0 ? (
            <div className="text-sm text-muted-foreground">Log a weighted set of 12 reps or fewer to see records.</div>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {stats.records.slice(0, 12).map((r) => (
                  <tr key={r.exercise} className="border-t first:border-t-0">
                    <td className="py-1 capitalize">{r.exercise}</td>
                    <td className="py-1 text-right font-medium tabular-nums">{fmt(r.e1rmKg)}</td>
                    <td className="py-1 text-right text-muted-foreground tabular-nums">{r.reps} × {fmt(r.weightKg)}</td>
                    <td className="py-1 text-right text-muted-foreground">{r.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="border rounded-lg p-3 space-y-3">
          <div>
            <div className="text-sm font-medium mb-1">Body weight</div>
            {stats.bodyweight ? (
              <div className="text-sm">
                {fmt(stats.bodyweight.latestKg)} <span className="text-muted-foreground">on {stats.bodyweight.date}</span>
                {stats.bodyweight.change30dKg != null && (
                  <span className="text-muted-foreground"> · {stats.bodyweight.change30dKg >= 0 ? "+" : "−"}{fmt(Math.abs(stats.bodyweight.change30dKg))} in 30 days</span>
                )}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No weigh-ins yet.</div>
            )}
          </div>
          <div>
            <div className="text-sm font-medium mb-1">Sets by body part ({stats.windowDays}d)</div>
            {stats.bodyParts.length === 0 ? (
              <div className="text-sm text-muted-foreground">Add a body part to exercises to see the split.</div>
            ) : (
              stats.bodyParts.map((b) => (
                <div key={b.bodyPart} className="flex justify-between text-sm capitalize"><span>{b.bodyPart}</span><span className="tabular-nums">{b.sets}</span></div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div><div className="text-muted-foreground">{label}</div><div className="font-medium tabular-nums">{value}</div></div>;
}

interface DraftSet { reps: string; weight: string; warmup: boolean }
interface DraftExercise { name: string; bodyPart: string; sets: DraftSet[] }

const emptySet = (): DraftSet => ({ reps: "", weight: "", warmup: false });
const emptyExercise = (): DraftExercise => ({ name: "", bodyPart: "", sets: [emptySet()] });

function LogForm({ api, orgId, unit, fmt, onSaved }: { api: PanelProps["api"]; orgId: string; unit: "kg" | "lb"; fmt: (kg: number) => string; onSaved: () => void }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [name, setName] = useState("");
  const [durationMin, setDurationMin] = useState("");
  const [bodyweight, setBodyweight] = useState("");
  const [notes, setNotes] = useState("");
  const [exercises, setExercises] = useState<DraftExercise[]>([emptyExercise()]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const updateEx = (i: number, patch: Partial<DraftExercise>) =>
    setExercises((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const updateSet = (i: number, k: number, patch: Partial<DraftSet>) =>
    setExercises((xs) => xs.map((x, j) => (j === i ? { ...x, sets: x.sets.map((s, m) => (m === k ? { ...s, ...patch } : s)) } : x)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setMessage(null);
    try {
      const body = {
        orgId, date, unit,
        name: name || undefined,
        durationMin: durationMin ? Number(durationMin) : undefined,
        bodyweight: bodyweight ? Number(bodyweight) : undefined,
        notes: notes || undefined,
        exercises: exercises
          .filter((x) => x.name.trim())
          .map((x) => ({
            name: x.name,
            bodyPart: x.bodyPart || undefined,
            sets: x.sets
              .filter((s) => s.reps !== "")
              .map((s) => ({ reps: Number(s.reps), weight: s.weight === "" ? undefined : Number(s.weight), warmup: s.warmup || undefined })),
          })),
      };
      const d = await readJson<{ volumeKg: number; newRecords: Record1RM[] }>(
        await api("workouts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      );
      setMessage(
        `Saved — ${fmt(d.volumeKg)} volume.` +
          (d.newRecords.length ? ` New records: ${d.newRecords.map((r) => `${r.exercise} ${fmt(r.e1rmKg)}`).join(", ")}.` : ""),
      );
      setExercises([emptyExercise()]); setName(""); setNotes(""); setDurationMin(""); setBodyweight("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input type="date" className={inputCls} value={date} onChange={(e) => setDate(e.target.value)} required />
        <input className={inputCls} placeholder="Name (e.g. Push day)" value={name} onChange={(e) => setName(e.target.value)} />
        <input className={`${inputCls} w-28`} type="number" min={0} placeholder="Minutes" value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
        <input className={`${inputCls} w-36`} type="number" step="0.1" min={0} placeholder={`Body weight (${unit})`} value={bodyweight} onChange={(e) => setBodyweight(e.target.value)} />
      </div>

      {exercises.map((x, i) => (
        <div key={i} className="border rounded-lg p-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input className={`${inputCls} flex-1 min-w-40`} placeholder="Exercise (e.g. Barbell bench press)" value={x.name} onChange={(e) => updateEx(i, { name: e.target.value })} />
            <input className={`${inputCls} w-36`} placeholder="Body part" value={x.bodyPart} onChange={(e) => updateEx(i, { bodyPart: e.target.value })} />
            {exercises.length > 1 && (
              <button type="button" className={btnCls} onClick={() => setExercises((xs) => xs.filter((_, j) => j !== i))}>Remove</button>
            )}
          </div>
          {x.sets.map((s, k) => (
            <div key={k} className="flex items-center gap-2 text-sm">
              <span className="w-12 text-muted-foreground">Set {k + 1}</span>
              <input className={`${inputCls} w-20`} type="number" min={0} placeholder="Reps" value={s.reps} onChange={(e) => updateSet(i, k, { reps: e.target.value })} />
              <span className="text-muted-foreground">×</span>
              <input className={`${inputCls} w-24`} type="number" step="0.5" placeholder={unit} value={s.weight} onChange={(e) => updateSet(i, k, { weight: e.target.value })} />
              <label className="flex items-center gap-1 text-muted-foreground">
                <input type="checkbox" checked={s.warmup} onChange={(e) => updateSet(i, k, { warmup: e.target.checked })} /> warm-up
              </label>
            </div>
          ))}
          <button
            type="button"
            className={btnCls}
            onClick={() => updateEx(i, { sets: [...x.sets, { ...(x.sets[x.sets.length - 1] ?? emptySet()) }] })}
          >
            + Set
          </button>
        </div>
      ))}

      <div className="flex flex-wrap gap-2">
        <button type="button" className={btnCls} onClick={() => setExercises((xs) => [...xs, emptyExercise()])}>+ Exercise</button>
      </div>
      <textarea className={`${inputCls} w-full`} rows={2} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button type="submit" className={btnCls} disabled={busy}>{busy ? "Saving…" : "Save workout"}</button>
      {message && <div className="text-sm text-green-500">{message}</div>}
      {error && <div className="text-sm text-red-400">{error}</div>}
    </form>
  );
}

function History({ api, q, fmt, version, onChange }: { api: PanelProps["api"]; q: string; fmt: (kg: number) => string; version: number; onChange: () => void }) {
  const [workouts, setWorkouts] = useState<WorkoutBrief[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<WorkoutFull | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ limit: "100" });
    if (filter.trim()) params.set("exercise", filter.trim());
    api(`workouts?${q}&${params}`)
      .then((r) => readJson<{ total: number; workouts: WorkoutBrief[] }>(r))
      .then((d) => { setWorkouts(d.workouts); setTotal(d.total); })
      .catch((e) => setError(e.message));
  }, [api, q, filter, version]);

  async function show(id: string) {
    if (open?.id === id) return setOpen(null);
    const d = await readJson<{ workout: WorkoutFull }>(await api(`workouts/${id}?${q}`));
    setOpen(d.workout);
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this workout?")) return;
    try {
      await readJson(await api(`workouts/${id}?${q}`, { method: "DELETE" }));
      setOpen(null);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="space-y-3">
      <input className={`${inputCls} w-64`} placeholder="Filter by exercise" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {error && <div className="text-sm text-red-400">{error}</div>}
      {!workouts ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : workouts.length === 0 ? (
        <div className="text-sm text-muted-foreground">No workouts yet.</div>
      ) : (
        <>
          <div className="text-xs text-muted-foreground">{total} workout{total === 1 ? "" : "s"}{total > workouts.length ? `, showing ${workouts.length}` : ""}</div>
          <div className="border rounded-lg divide-y">
            {workouts.map((w) => (
              <div key={w.id} className="p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <button className="font-medium hover:underline text-left" onClick={() => show(w.id)}>{w.date} · {w.name}</button>
                  <span className="text-muted-foreground">{w.sets} sets · {fmt(w.volumeKg)}{w.durationMin ? ` · ${w.durationMin} min` : ""}</span>
                  <span className="text-xs border rounded px-1.5 text-muted-foreground">{w.source}</span>
                  <button className="ml-auto text-xs text-muted-foreground hover:text-red-400" onClick={() => remove(w.id)}>Delete</button>
                </div>
                <div className="text-muted-foreground capitalize">{w.exercises.join(", ")}</div>
                {open?.id === w.id && (
                  <div className="mt-2 space-y-1">
                    {open.exercises.map((e, i) => (
                      <div key={i}>
                        <span className="capitalize">{e.name}</span>:{" "}
                        <span className="text-muted-foreground">
                          {e.sets.map((s) => [
                            s.reps != null ? `${s.reps}` : null,
                            s.weightKg ? `× ${fmt(s.weightKg)}` : null,
                            s.seconds ? `${s.seconds}s` : null,
                            s.warmup ? "(wu)" : null,
                          ].filter(Boolean).join(" ")).join(", ")}
                        </span>
                      </div>
                    ))}
                    {open.notes && <div className="text-muted-foreground italic">{open.notes}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Connect({ api, orgId, q, onImported }: { api: PanelProps["api"]; orgId: string; q: string; onImported: () => void }) {
  const [link, setLink] = useState<Link | null | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadLink = useCallback(() => {
    api(`link?${q}`).then((r) => readJson<{ link: Link | null }>(r)).then((d) => setLink(d.link)).catch(() => setLink(null));
  }, [api, q]);
  useEffect(loadLink, [loadLink]);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(label); setError(null); setMessage(null);
    try {
      setMessage(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const describe = (i: { workouts: number; bodyweight: number; skipped: number }) =>
    `Imported ${i.workouts} workouts and ${i.bodyweight} weigh-ins${i.skipped ? ` (${i.skipped} empty sessions skipped)` : ""}.`;

  const linkInstance = (e: FormEvent) => {
    e.preventDefault();
    run("link", async () => {
      await readJson(await api("link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId, baseUrl, code }) }));
      setCode("");
      loadLink();
      return "Linked. Sync to pull your history.";
    });
  };

  const sync = () =>
    run("sync", async () => {
      const d = await readJson<{ imported: { workouts: number; bodyweight: number; skipped: number } }>(
        await api("sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId }) }),
      );
      loadLink();
      onImported();
      return describe(d.imported);
    });

  const unlink = () =>
    run("unlink", async () => {
      await readJson(await api(`link?${q}`, { method: "DELETE" }));
      loadLink();
      return "Unlinked. Logged workouts were kept.";
    });

  const importFile = (file: File) =>
    run("import", async () => {
      let state: unknown;
      try {
        state = JSON.parse(await file.text());
      } catch {
        throw new Error("That file is not JSON. Use openGym Settings → Export backup (JSON).");
      }
      const d = await readJson<{ imported: { workouts: number; bodyweight: number; skipped: number } }>(
        await api("import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId, state }) }),
      );
      onImported();
      return describe(d.imported);
    });

  return (
    <div className="space-y-4">
      <section className="border rounded-lg p-3 space-y-2">
        <div className="text-sm font-medium">Self-hosted openGym</div>
        {link === undefined ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : link ? (
          <div className="space-y-2 text-sm">
            <div>
              Linked to <span className="font-medium">{link.baseUrl}</span>
              {link.profileName && <> as <span className="font-medium">{link.profileName}</span></>}.
              <span className="text-muted-foreground"> {link.lastSyncAt ? `Last sync ${new Date(link.lastSyncAt).toLocaleString()} (${link.lastSyncCount} workouts).` : "Not synced yet."}</span>
            </div>
            <div className="flex gap-2">
              <button className={btnCls} onClick={sync} disabled={!!busy}>{busy === "sync" ? "Syncing…" : "Sync now"}</button>
              <button className={btnCls} onClick={unlink} disabled={!!busy}>Unlink</button>
            </div>
          </div>
        ) : (
          <form onSubmit={linkInstance} className="space-y-2 text-sm">
            <p className="text-muted-foreground">
              In openGym open Settings → <em>Pair the mobile app</em> and paste the 8-character code here within 5 minutes.
              Agent Guild keeps the resulting token sealed and only uses it to read your history. The instance must be reachable over https.
            </p>
            <div className="flex flex-wrap gap-2">
              <input className={`${inputCls} flex-1 min-w-56`} placeholder="https://gym.example.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
              <input className={`${inputCls} w-32 uppercase`} placeholder="K7WQ2MZP" value={code} onChange={(e) => setCode(e.target.value)} required />
              <button className={btnCls} disabled={!!busy}>{busy === "link" ? "Linking…" : "Link"}</button>
            </div>
          </form>
        )}
      </section>

      <section className="border rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">Import a backup file</div>
        <p className="text-muted-foreground">openGym Settings → Export backup (JSON), or the Android app's backup. Importing again updates rather than duplicates.</p>
        <input
          type="file"
          accept="application/json,.json"
          disabled={!!busy}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = ""; }}
        />
      </section>

      {message && <div className="text-sm text-green-500">{message}</div>}
      {error && <div className="text-sm text-red-400">{error}</div>}

      <section className="border rounded-lg p-3 space-y-2 text-sm">
        <div className="font-medium">How agents use it</div>
        <p className="text-muted-foreground">
          Give an agent the <code>opengym-log</code> and <code>opengym-read</code> capabilities. It calls these routes signed as itself
          (or with a token carrying <code>mods:call</code>), and the logbook is always its own org&apos;s:
        </p>
        <pre className="bg-muted rounded p-2 text-xs overflow-x-auto">{`POST /api/mods/opengym/workouts
{ "name": "Leg day", "unit": "kg", "durationMin": 55,
  "exercises": [
    { "name": "Back squat", "bodyPart": "upper legs", "sets": 5, "reps": 5, "weight": 120 },
    { "name": "Romanian deadlift", "sets": [{ "reps": 8, "weight": 100 }, { "reps": 8, "weight": 100 }] }
  ] }
→ { workout, volumeKg, newRecords: [...] }

GET  /api/mods/opengym/stats?days=30        → totals, streak, records, summary
GET  /api/mods/opengym/workouts?from=&exercise=
GET  /api/mods/opengym/exercises/back%20squat
POST /api/mods/opengym/bodyweight  { "weight": 82.4 }
POST /api/mods/opengym/sync        (pull the linked openGym)`}</pre>
      </section>
    </div>
  );
}

export default defineClientMod({ panels: { gym: GymPanel } });
