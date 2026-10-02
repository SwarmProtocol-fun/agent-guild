// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

// ─── tiny in-memory Firestore for vaultSecrets ────────────────
const docs = new Map<string, Record<string, unknown>>();
function setPath(obj: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
  cur[parts.at(-1)!] = value;
}
function docRef(id: string) {
  return {
    id,
    get: async () => ({ id, exists: docs.has(id), data: () => docs.get(id) }),
    update: async (patch: Record<string, unknown>) => {
      const d = docs.get(id)!;
      for (const [k, v] of Object.entries(patch)) {
        if (k.includes(".")) setPath(d, k, v);
        else d[k] = v;
      }
    },
  };
}
vi.mock("@/lib/firebase-admin", () => ({
  adminDb: () => ({
    collection: () => ({
      doc: (id: string) => docRef(id),
      where: (_f: string, _op: string, ts: { toMillis(): number }) => ({
        limit: () => ({
          get: async () => ({
            docs: [...docs.entries()]
              .filter(([, d]) => (d.rotation as { nextAt?: { toMillis(): number } } | null)?.nextAt && (d.rotation as { nextAt: { toMillis(): number } }).nextAt.toMillis() <= ts.toMillis())
              .map(([id, d]) => ({ id, data: () => d, ref: docRef(id) })),
          }),
        }),
      }),
    }),
  }),
}));

const rotated: { secretId: string; value: string }[] = [];
const audits: { action: string }[] = [];
vi.mock("../store", async (orig) => ({
  ...(await orig<typeof import("../store")>()),
  rotateSecret: vi.fn(async (_org: string, secretId: string, value: string) => { rotated.push({ secretId, value }); }),
  appendAudit: vi.fn(async (e: { action: string }) => { audits.push(e); }),
  auditQuietly: vi.fn((e: { action: string }) => { audits.push(e); }),
}));

import { validateRotationInput, signWebhook, setRotationPolicy, rotateViaWebhook, sweepRotations } from "../rotation";

let server: http.Server;
let hookUrl: string;
let reply: { status: number; body: string } = { status: 200, body: '{"value":"sk_new_value_123456"}' };
let lastSigOk = false;
let signingSecret = "";

beforeAll(async () => {
  process.env.VAULT_MASTER_KEY = crypto.randomBytes(32).toString("base64");
  process.env.VAULT_ALLOW_INSECURE_EGRESS = "1";
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const ts = String(req.headers["x-agent-guild-timestamp"]);
    lastSigOk = req.headers["x-agent-guild-signature"] === signWebhook(signingSecret, ts, body);
    res.statusCode = reply.status;
    res.end(reply.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rotate`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  docs.clear();
  rotated.length = 0;
  audits.length = 0;
  reply = { status: 200, body: '{"value":"sk_new_value_123456"}' };
});

describe("rotation policy input", () => {
  it("validates", () => {
    expect(validateRotationInput({ intervalDays: 30, mode: "remind" })).toEqual({ intervalDays: 30, mode: "remind" });
    expect(validateRotationInput({ intervalDays: 0, mode: "remind" })).toMatch(/intervalDays/);
    expect(validateRotationInput({ intervalDays: 30, mode: "sometimes" })).toMatch(/mode/);
    delete process.env.VAULT_ALLOW_INSECURE_EGRESS;
    expect(validateRotationInput({ intervalDays: 30, mode: "webhook", webhookUrl: "http://example.com" })).toMatch(/https/);
    expect(validateRotationInput({ intervalDays: 30, mode: "webhook", webhookUrl: "https://169.254.169.254/x" })).toMatch(/private/);
    process.env.VAULT_ALLOW_INSECURE_EGRESS = "1";
  });
});

describe("webhook rotation", () => {
  async function setup() {
    docs.set("s1", { orgId: "org1", name: "STRIPE_KEY" });
    const { signingSecret: s } = await setRotationPolicy("org1", "s1", { intervalDays: 30, mode: "webhook", webhookUrl: hookUrl });
    signingSecret = s!;
  }

  it("shows the signing secret once and keeps it sealed", async () => {
    await setup();
    expect(signingSecret).toMatch(/^whsec_/);
    expect(JSON.stringify(docs.get("s1"))).not.toContain(signingSecret);
    const again = await setRotationPolicy("org1", "s1", { intervalDays: 7, mode: "webhook", webhookUrl: hookUrl });
    expect(again.signingSecret).toBeNull(); // same URL → same secret, not re-shown
  });

  it("fetches a new value with a valid signature and seals it", async () => {
    await setup();
    await rotateViaWebhook("org1", "s1");
    expect(lastSigOk).toBe(true);
    expect(rotated).toEqual([{ secretId: "s1", value: "sk_new_value_123456" }]);
    expect(audits.at(-1)?.action).toBe("secret.rotated");
  });

  it.each([
    [{ status: 500, body: "{}" }, /HTTP 500/],
    [{ status: 200, body: "not json" }, /not JSON/],
    [{ status: 200, body: '{"key":"x"}' }, /no "value"/],
  ])("records failure %#", async (r, msg) => {
    await setup();
    reply = r;
    await expect(rotateViaWebhook("org1", "s1")).rejects.toThrow(msg);
    expect(rotated).toEqual([]);
    const rot = docs.get("s1")!.rotation as { overdue: boolean; lastError: string };
    expect(rot.overdue).toBe(true);
    expect(rot.lastError).toMatch(msg);
    expect(audits.at(-1)?.action).toBe("secret.rotation_failed");
  });
});

describe("sweep", () => {
  it("rotates due webhook secrets, flags due reminders once, skips the rest", async () => {
    docs.set("hook", { orgId: "org1", name: "A" });
    docs.set("remind", { orgId: "org1", name: "B" });
    docs.set("later", { orgId: "org1", name: "C" });
    signingSecret = (await setRotationPolicy("org1", "hook", { intervalDays: 1, mode: "webhook", webhookUrl: hookUrl })).signingSecret!;
    await setRotationPolicy("org1", "remind", { intervalDays: 1, mode: "remind" });
    await setRotationPolicy("org1", "later", { intervalDays: 90, mode: "remind" });

    const result = await sweepRotations(Date.now() + 2 * 86_400_000);
    expect(result.rotated).toEqual(["hook"]);
    expect(result.reminded).toEqual(["remind"]);
    expect((docs.get("remind")!.rotation as { overdue: boolean }).overdue).toBe(true);
    expect((docs.get("later")!.rotation as { overdue: boolean }).overdue).toBe(false);

    const second = await sweepRotations(Date.now() + 4 * 86_400_000);
    expect(second.reminded).toEqual([]); // already flagged — not re-announced
  });
});
