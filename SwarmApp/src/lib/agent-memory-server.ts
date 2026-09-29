/**
 * Agent Memory (server) — the real, agent-writable half of the context
 * library. Server-only (Admin SDK via adminDb()) — never import from
 * client-facing code.
 *
 * Each agent gets exactly three fixed-ID documents in `agentMemories`
 * (working notes, long-term memory, one per daily journal date) instead of
 * the query-and-find-or-create pattern used elsewhere in this codebase
 * (src/lib/memory.ts, src/lib/firestore-admin.ts) — that pattern silently
 * created a new duplicate doc on every call because the mapped MemoryEntry
 * never carried `subtype`/`structuredData` back out of Firestore, so the
 * "does it already exist" lookup could never match. Fixed IDs make
 * get-or-create a single doc read/create with no query, no index, and no
 * race between concurrent callers.
 */
import { adminDb } from "./firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import {
  getTemplateForSubtype,
  updateWorkingMdSection,
  appendToMemoryMd,
  updateTimestamp,
  type MemorySubtype,
} from "./memory-templates";

const COLLECTION = "agentMemories";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AgentIdentity {
  agentId: string;
  orgId: string;
  agentName?: string;
}

export interface MemoryDoc {
  id: string;
  content: string;
  subtype: MemorySubtype;
  createdAt: number | null;
  updatedAt: number | null;
}

/** Section headings each doc type's templates actually contain — checked
 *  before any caller-supplied section name reaches memory-templates.ts's
 *  RegExp-building functions, since those build regexes directly from the
 *  string with no escaping. */
export const ALLOWED_SECTIONS: Record<"working_md" | "memory_md" | "daily_note", string[]> = {
  working_md: ["Current Focus", "Active Tasks", "Context", "Blockers", "Notes"],
  memory_md: ["About Me", "Key Facts", "Patterns & Preferences", "Learnings", "Context"],
  daily_note: ["Summary", "Tasks Completed", "Tasks Started", "Learnings", "Tomorrow's Focus", "Notes"],
};

export function isAllowedSection(docType: keyof typeof ALLOWED_SECTIONS, section: string): boolean {
  return ALLOWED_SECTIONS[docType].includes(section);
}

/** Defense in depth: the route handlers pre-validate `section` for a clean
 *  400, but these library functions guard too, since they're the ones that
 *  actually reach into memory-templates.ts's RegExp-building functions —
 *  an unvalidated caller here could still throw/hang the process otherwise. */
function assertAllowedSection(docType: keyof typeof ALLOWED_SECTIONS, section: string): asserts section is (typeof ALLOWED_SECTIONS)[typeof docType][number] {
  if (!isAllowedSection(docType, section)) {
    throw new Error(`Invalid section "${section}" for ${docType}`);
  }
}

function docId(agentId: string, subtype: "working_md" | "memory_md"): string;
function docId(agentId: string, subtype: "daily_note", date: string): string;
function docId(agentId: string, subtype: MemorySubtype, date?: string): string {
  if (subtype === "daily_note") return `${agentId}__daily_${date}`;
  return `${agentId}__${subtype}`;
}

function toMillis(v: unknown): number | null {
  const ts = v as { toMillis?: () => number } | undefined;
  return ts?.toMillis ? ts.toMillis() : null;
}

/**
 * One-time fallback for pre-existing, randomly-ID'd duplicate docs created
 * by the old buggy lookup. Folds any found content into a freshly-created
 * fixed-ID doc (oldest first) instead of discarding it. Old docs are left
 * in place so the /memory dashboard keeps showing them. Single equality
 * filter — no composite index needed.
 */
async function mergeLegacyContent(
  orgId: string,
  agentId: string,
  subtype: MemorySubtype,
  matches: (data: FirebaseFirestore.DocumentData) => boolean,
): Promise<string | null> {
  const snap = await adminDb()
    .collection(COLLECTION)
    .where("agentId", "==", agentId)
    .get();
  const legacy = snap.docs
    .map((d) => d.data())
    .filter((d) => d.orgId === orgId && d.subtype === subtype && matches(d))
    .sort((a, b) => (toMillis(a.createdAt) ?? 0) - (toMillis(b.createdAt) ?? 0));
  if (legacy.length === 0) return null;
  return legacy.map((d) => String(d.content ?? "")).join("\n\n");
}

async function getOrCreate(
  id: string,
  agent: AgentIdentity,
  subtype: MemorySubtype,
  type: "workspace" | "long_term" | "journal",
  title: string,
  template: string,
  structuredData: Record<string, unknown> | undefined,
  legacyMatches: (data: FirebaseFirestore.DocumentData) => boolean,
): Promise<MemoryDoc> {
  const ref = adminDb().collection(COLLECTION).doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    const data = existing.data()!;
    return {
      id,
      content: data.content,
      subtype,
      createdAt: toMillis(data.createdAt),
      updatedAt: toMillis(data.updatedAt),
    };
  }

  const legacyContent = await mergeLegacyContent(agent.orgId, agent.agentId, subtype, legacyMatches);
  const content = legacyContent ? `${template}\n${legacyContent}` : template;

  try {
    await ref.create({
      orgId: agent.orgId,
      agentId: agent.agentId,
      agentName: agent.agentName || agent.agentId,
      type,
      title,
      content,
      subtype,
      structuredData: structuredData || null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    // ALREADY_EXISTS (gRPC code 6) — another concurrent call created it first.
    const code = (err as { code?: number })?.code;
    if (code !== 6) throw err;
  }

  const created = await ref.get();
  const data = created.data()!;
  return {
    id,
    content: data.content,
    subtype,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  };
}

// ─── Working memory ───────────────────────────────────────

export async function getOrCreateWorkingMd(agent: AgentIdentity): Promise<MemoryDoc> {
  const id = docId(agent.agentId, "working_md");
  const template = getTemplateForSubtype("working_md", agent.agentName || agent.agentId);
  return getOrCreate(id, agent, "working_md", "workspace", "WORKING.md", template, undefined,
    (d) => d.title === "WORKING.md" || d.subtype === "working_md");
}

export async function updateWorkingMd(agent: AgentIdentity, content: string, section?: string): Promise<MemoryDoc> {
  const id = docId(agent.agentId, "working_md");
  const ref = adminDb().collection(COLLECTION).doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (section) assertAllowedSection("working_md", section);
    let newContent: string;
    if (!snap.exists) {
      const template = getTemplateForSubtype("working_md", agent.agentName || agent.agentId);
      newContent = section
        ? updateWorkingMdSection(template, section as Parameters<typeof updateWorkingMdSection>[1], content)
        : content;
    } else {
      const existing = snap.data()!.content as string;
      newContent = section
        ? updateWorkingMdSection(existing, section as Parameters<typeof updateWorkingMdSection>[1], content)
        : content;
    }
    newContent = updateTimestamp(newContent);
    tx.set(ref, {
      orgId: agent.orgId,
      agentId: agent.agentId,
      agentName: agent.agentName || agent.agentId,
      type: "workspace",
      title: "WORKING.md",
      content: newContent,
      subtype: "working_md",
      updatedAt: FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    return { id, content: newContent, subtype: "working_md" as const, createdAt: null, updatedAt: Date.now() };
  });
}

// ─── Long-term memory ─────────────────────────────────────

export async function getOrCreateMemoryMd(agent: AgentIdentity): Promise<MemoryDoc> {
  const id = docId(agent.agentId, "memory_md");
  const template = getTemplateForSubtype("memory_md", agent.agentName || agent.agentId);
  return getOrCreate(id, agent, "memory_md", "long_term", "MEMORY.md", template, undefined,
    (d) => d.title === "MEMORY.md" || d.subtype === "memory_md");
}

export async function appendMemoryMd(agent: AgentIdentity, entry: string, section?: string): Promise<MemoryDoc> {
  if (section) assertAllowedSection("memory_md", section);
  const id = docId(agent.agentId, "memory_md");
  const ref = adminDb().collection(COLLECTION).doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const base = snap.exists
      ? (snap.data()!.content as string)
      : getTemplateForSubtype("memory_md", agent.agentName || agent.agentId);
    let newContent = appendToMemoryMd(base, entry, section);
    newContent = updateTimestamp(newContent);
    tx.set(ref, {
      orgId: agent.orgId,
      agentId: agent.agentId,
      agentName: agent.agentName || agent.agentId,
      type: "long_term",
      title: "MEMORY.md",
      content: newContent,
      subtype: "memory_md",
      updatedAt: FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    return { id, content: newContent, subtype: "memory_md" as const, createdAt: null, updatedAt: Date.now() };
  });
}

// ─── Daily journal ────────────────────────────────────────

function assertValidDate(date: string) {
  if (!DATE_RE.test(date)) throw new Error("date must be YYYY-MM-DD");
}

export async function getOrCreateDailyNote(agent: AgentIdentity, date: string): Promise<MemoryDoc> {
  assertValidDate(date);
  const id = docId(agent.agentId, "daily_note", date);
  const template = getTemplateForSubtype("daily_note", agent.agentName || agent.agentId, { date });
  return getOrCreate(id, agent, "daily_note", "journal", `Daily Note — ${date}`, template, { date },
    (d) => d.structuredData?.date === date);
}

/** Read-only lookup — does NOT create a doc. Used by the context endpoint
 *  so a context read never has a write side effect. */
export async function getDailyNoteIfExists(agent: AgentIdentity, date: string): Promise<MemoryDoc | null> {
  assertValidDate(date);
  const id = docId(agent.agentId, "daily_note", date);
  const snap = await adminDb().collection(COLLECTION).doc(id).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return { id, content: data.content, subtype: "daily_note", createdAt: toMillis(data.createdAt), updatedAt: toMillis(data.updatedAt) };
}

export async function appendDailyNote(agent: AgentIdentity, date: string, entry: string, section?: string): Promise<MemoryDoc> {
  assertValidDate(date);
  if (section) assertAllowedSection("daily_note", section);
  const id = docId(agent.agentId, "daily_note", date);
  const ref = adminDb().collection(COLLECTION).doc(id);
  return adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const base = snap.exists
      ? (snap.data()!.content as string)
      : getTemplateForSubtype("daily_note", agent.agentName || agent.agentId, { date });
    // appendToMemoryMd's footer regex only matches "Last updated" (working/long-term
    // templates); daily notes use "Created" and have no matching footer, so it falls
    // through to plain end-of-string append — correct for this doc type too.
    const newContent = appendToMemoryMd(base, entry, section);
    tx.set(ref, {
      orgId: agent.orgId,
      agentId: agent.agentId,
      agentName: agent.agentName || agent.agentId,
      type: "journal",
      title: `Daily Note — ${date}`,
      content: newContent,
      subtype: "daily_note",
      structuredData: { date },
      updatedAt: FieldValue.serverTimestamp(),
      ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
    return { id, content: newContent, subtype: "daily_note" as const, createdAt: null, updatedAt: Date.now() };
  });
}

/** Read-only fetch of working + long-term memory for the context endpoint —
 *  never creates a doc (unlike the getOrCreate* functions above, which are
 *  for explicit read/write calls). */
export async function getExistingMemory(agent: AgentIdentity): Promise<{ working: MemoryDoc | null; longTerm: MemoryDoc | null }> {
  const [workingSnap, longTermSnap] = await Promise.all([
    adminDb().collection(COLLECTION).doc(docId(agent.agentId, "working_md")).get(),
    adminDb().collection(COLLECTION).doc(docId(agent.agentId, "memory_md")).get(),
  ]);
  const toDoc = (snap: FirebaseFirestore.DocumentSnapshot, subtype: "working_md" | "memory_md"): MemoryDoc | null => {
    if (!snap.exists) return null;
    const data = snap.data()!;
    return { id: snap.id, content: data.content, subtype, createdAt: toMillis(data.createdAt), updatedAt: toMillis(data.updatedAt) };
  };
  return {
    working: toDoc(workingSnap, "working_md"),
    longTerm: toDoc(longTermSnap, "memory_md"),
  };
}
