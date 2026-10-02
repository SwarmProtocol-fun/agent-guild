// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

vi.mock("../store", async (orig) => {
  const actual = await orig<typeof import("../store")>();
  return {
    ...actual,
    getBindingByName: vi.fn(),
    reserveCall: vi.fn(async () => true),
    useSecretValue: vi.fn(async () => SECRET),
    auditQuietly: vi.fn(),
  };
});

import { seal, open, maskSecret } from "../crypto";
import { validateBindingInput, buildUpstreamRequest, redact, filterResponseHeaders, auditUrl, agentMayUse, type Binding } from "../policy";
import { isPrivateAddress, checkHostname, sendUpstream } from "../egress";
import { auditHash, verifyAuditWindow, VaultError, type AuditEntry } from "../store";
import * as store from "../store";
import { executeBinding } from "../execute";

const SECRET = "sk_live_51N8xSuperSecretValue123";

function binding(over: Partial<Binding> = {}): Binding {
  return {
    id: "b1",
    orgId: "org1",
    name: "stripe-api",
    description: "",
    secretId: "s1",
    baseUrl: "https://api.stripe.com",
    auth: { style: "bearer" },
    allowedMethods: ["GET"],
    allowedPaths: ["/v1/balance"],
    agentIds: ["agentA"],
    maxCallsPerHour: 0,
    revoked: false,
    createdBy: "0xowner",
    ...over,
  };
}

beforeAll(() => {
  process.env.VAULT_MASTER_KEY = crypto.randomBytes(32).toString("base64");
  delete process.env.VAULT_KMS_KEY;
});

describe("envelope crypto", () => {
  it("round-trips and binds ciphertext to its owner", async () => {
    const sealed = await seal(SECRET, "vault:org1:s1");
    expect(sealed.kekProvider).toBe("local");
    expect(sealed.ciphertext).not.toContain("sk_live");
    expect(await open(sealed, "vault:org1:s1")).toBe(SECRET);
    await expect(open(sealed, "vault:org2:s1")).rejects.toThrow();
  });

  it("detects tampering", async () => {
    const sealed = await seal(SECRET, "a");
    const ct = Buffer.from(sealed.ciphertext, "base64");
    ct[0] ^= 1;
    await expect(open({ ...sealed, ciphertext: ct.toString("base64") }, "a")).rejects.toThrow();
  });

  it("fails closed without a master key", async () => {
    const key = process.env.VAULT_MASTER_KEY;
    delete process.env.VAULT_MASTER_KEY;
    await expect(seal("x", "a")).rejects.toThrow(/Vault not configured/);
    process.env.VAULT_MASTER_KEY = key;
  });

  it("masks to the last 4 characters only", () => {
    expect(maskSecret(SECRET)).toBe("••••••••e123");
    expect(maskSecret("short")).toBe("••••••••");
  });
});

describe("binding validation", () => {
  const base = { name: "stripe-api", secretId: "s1", baseUrl: "https://api.stripe.com/", auth: { style: "bearer" }, agentIds: ["*"] };

  it("accepts a sane binding and normalizes it", () => {
    const r = validateBindingInput(base);
    expect(r.ok && r.value.baseUrl).toBe("https://api.stripe.com");
    expect(r.ok && r.value.allowedMethods).toEqual(["GET"]);
  });

  it.each([
    [{ baseUrl: "http://api.stripe.com" }, /https/],
    [{ baseUrl: "https://user:pw@api.stripe.com" }, /credentials/],
    [{ baseUrl: "https://api.stripe.com?x=1" }, /query/],
    [{ name: "Bad Name" }, /name/],
    [{ agentIds: [] }, /agentIds/],
    [{ allowedMethods: ["TRACE"] }, /allowedMethods/],
    [{ allowedPaths: ["v1"] }, /allowedPaths/],
    [{ auth: { style: "header", header: "X Bad" } }, /auth.header/],
  ])("rejects %j", (over, msg) => {
    const r = validateBindingInput({ ...base, ...over });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(msg);
  });

  it("allows http only in insecure mode", () => {
    expect(validateBindingInput({ ...base, baseUrl: "http://localhost:1" }, true).ok).toBe(true);
  });
});

describe("upstream request building", () => {
  it("injects each auth style", () => {
    const bearer = buildUpstreamRequest(binding(), { binding: "x", method: "GET", path: "/v1/balance" }, SECRET);
    expect(bearer.ok && bearer.value.headers.authorization).toBe(`Bearer ${SECRET}`);

    const header = buildUpstreamRequest(binding({ auth: { style: "header", header: "X-Api-Key", prefix: "Key " } }), { binding: "x", method: "GET", path: "/v1/balance" }, SECRET);
    expect(header.ok && header.value.headers["x-api-key"]).toBe(`Key ${SECRET}`);

    const query = buildUpstreamRequest(binding({ auth: { style: "query", param: "api_key" } }), { binding: "x", method: "GET", path: "/v1/balance" }, SECRET);
    expect(query.ok && query.value.url.searchParams.get("api_key")).toBe(SECRET);

    const basic = buildUpstreamRequest(binding({ auth: { style: "basic", username: "u" } }), { binding: "x", method: "GET", path: "/v1/balance" }, SECRET);
    expect(basic.ok && basic.value.headers.authorization).toBe(`Basic ${Buffer.from(`u:${SECRET}`).toString("base64")}`);
  });

  it.each([
    ["POST", "/v1/balance", /Method POST not allowed/],
    ["GET", "/v1/charges", /not allowed/],
    ["GET", "/v1/balancex", /not allowed/],
    ["GET", "/v1/../v1/charges", /\.\./],
    ["GET", "/v1/balance/%2e%2e/%2e%2e/admin", /not allowed/],
    ["GET", "//evil.com/v1/balance", /absolute path/],
    ["GET", "/v1/balance?x=1", /query/],
    ["GET", "v1/balance", /absolute path/],
  ])("refuses %s %s", (method, path, msg) => {
    const r = buildUpstreamRequest(binding(), { binding: "x", method, path }, SECRET);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(msg);
  });

  it("allows sub-paths of an allowed prefix and keeps the host fixed", () => {
    const r = buildUpstreamRequest(binding(), { binding: "x", method: "GET", path: "/v1/balance/history" }, SECRET);
    expect(r.ok && r.value.url.toString()).toBe("https://api.stripe.com/v1/balance/history");
  });

  it("can't escape a base path", () => {
    const b = binding({ baseUrl: "https://api.example.com/tenant-a", allowedPaths: ["/"] });
    const r = buildUpstreamRequest(b, { binding: "x", method: "GET", path: "/%2e%2e/tenant-b/data" }, SECRET);
    expect(r.ok).toBe(false);
  });

  it("refuses agent-supplied credentials and hop-by-hop headers", () => {
    for (const h of ["Authorization", "Cookie", "Host", "Proxy-Foo", "X-Forwarded-For"]) {
      const r = buildUpstreamRequest(binding(), { binding: "x", method: "GET", path: "/v1/balance", headers: { [h]: "v" } }, SECRET);
      expect(r.ok, h).toBe(false);
    }
    const custom = binding({ auth: { style: "header", header: "X-Api-Key" } });
    expect(buildUpstreamRequest(custom, { binding: "x", method: "GET", path: "/v1/balance", headers: { "x-api-key": "mine" } }, SECRET).ok).toBe(false);
    const q = binding({ auth: { style: "query", param: "api_key" } });
    expect(buildUpstreamRequest(q, { binding: "x", method: "GET", path: "/v1/balance", query: { API_KEY: "mine" } }, SECRET).ok).toBe(false);
  });

  it("refuses header injection", () => {
    const r = buildUpstreamRequest(binding(), { binding: "x", method: "GET", path: "/v1/balance", headers: { "X-Note": "a\r\nAuthorization: x" } }, SECRET);
    expect(r.ok).toBe(false);
  });

  it("serializes object bodies as JSON", () => {
    const r = buildUpstreamRequest(binding({ allowedMethods: ["POST"] }), { binding: "x", method: "POST", path: "/v1/balance", body: { a: 1 } }, SECRET);
    expect(r.ok && r.value.body).toBe('{"a":1}');
    expect(r.ok && r.value.headers["content-type"]).toBe("application/json");
  });

  it("checks agent access", () => {
    expect(agentMayUse(binding(), "agentA")).toBe(true);
    expect(agentMayUse(binding(), "agentB")).toBe(false);
    expect(agentMayUse(binding({ agentIds: ["*"] }), "agentB")).toBe(true);
    expect(agentMayUse(binding({ revoked: true }), "agentA")).toBe(false);
  });
});

describe("response hygiene", () => {
  it("redacts raw, url-encoded and base64 echoes of the secret", () => {
    const text = `a ${SECRET} b ${encodeURIComponent(SECRET)} c ${Buffer.from(SECRET).toString("base64")}`;
    expect(redact(text, SECRET)).not.toMatch(/sk_live|c2tf/);
  });

  it("drops cookies and redacts headers", () => {
    const out = filterResponseHeaders({ "set-cookie": "s=1", "x-echo": SECRET, "content-type": "json" }, SECRET);
    expect(out).toEqual({ "x-echo": "[REDACTED]", "content-type": "json" });
  });

  it("keeps query-string credentials out of the audit URL", () => {
    const url = new URL(`https://api.x.com/v1?api_key=${SECRET}&q=1`);
    expect(auditUrl(url, { style: "query", param: "api_key" })).not.toContain(SECRET);
  });
});

describe("egress guard", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"])(
    "treats %s as private",
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(["8.8.8.8", "151.101.1.69", "2606:4700::1111"])("treats %s as public", (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it("blocks internal hostnames", () => {
    delete process.env.VAULT_ALLOW_INSECURE_EGRESS;
    expect(checkHostname("localhost")).toMatch(/not allowed/);
    expect(checkHostname("metadata.google.internal")).toMatch(/not allowed/);
    expect(checkHostname("169.254.169.254")).toMatch(/private/);
    expect(checkHostname("api.stripe.com")).toBeNull();
  });

  it("refuses to reach localhost unless insecure egress is enabled", async () => {
    delete process.env.VAULT_ALLOW_INSECURE_EGRESS;
    await expect(sendUpstream({ url: new URL("https://localhost:1/"), method: "GET", headers: {} })).rejects.toThrow(/not allowed/);
  });
});

describe("audit hash chain", () => {
  const entry: AuditEntry = { orgId: "o", action: "binding.executed", actorType: "agent", actorId: "a", target: "stripe-api", detail: { status: 200 } };
  function chain(n: number) {
    const out = [];
    let prev = "0".repeat(64);
    for (let seq = 1; seq <= n; seq++) {
      const at = 1000 + seq;
      const hash = auditHash(prev, seq, at, entry);
      out.push({ ...entry, seq, at, prevHash: prev, hash });
      prev = hash;
    }
    return out;
  }

  it("verifies an untouched chain", () => expect(verifyAuditWindow(chain(5)).intact).toBe(true));

  it("detects an edited entry", () => {
    const c = chain(5);
    c[2] = { ...c[2], target: "other" };
    expect(verifyAuditWindow(c)).toEqual({ intact: false, brokenAt: 3 });
  });

  it("detects a deleted entry", () => {
    const c = chain(5);
    c.splice(2, 1);
    expect(verifyAuditWindow(c).intact).toBe(false);
  });
});

describe("executeBinding end to end", () => {
  let server: http.Server;
  let baseUrl: string;
  let lastAuth: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      lastAuth = req.headers.authorization;
      res.setHeader("set-cookie", "session=1");
      res.setHeader("content-type", "application/json");
      // A careless upstream that echoes the credential back.
      res.end(JSON.stringify({ path: req.url, echoed: req.headers.authorization }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    process.env.VAULT_ALLOW_INSECURE_EGRESS = "1";
    vi.mocked(store.auditQuietly).mockClear();
  });

  const agent = { agentId: "agentA", agentName: "A", orgId: "org1" };

  it("injects the secret upstream and never returns it", async () => {
    vi.mocked(store.getBindingByName).mockResolvedValue({ ...binding({ baseUrl }), createdAt: null });
    const res = await executeBinding(agent, { binding: "stripe-api", method: "GET", path: "/v1/balance" });
    expect(lastAuth).toBe(`Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).toContain("[REDACTED]");
    expect(res.headers["set-cookie"]).toBeUndefined();
    const audited = vi.mocked(store.auditQuietly).mock.calls[0][0];
    expect(audited.action).toBe("binding.executed");
    expect(JSON.stringify(audited)).not.toContain(SECRET);
  });

  it("denies and audits an agent that isn't on the binding", async () => {
    vi.mocked(store.getBindingByName).mockResolvedValue({ ...binding({ baseUrl }), createdAt: null });
    vi.mocked(store.useSecretValue).mockClear();
    await expect(executeBinding({ ...agent, agentId: "agentB" }, { binding: "stripe-api", method: "GET", path: "/v1/balance" })).rejects.toBeInstanceOf(VaultError);
    expect(vi.mocked(store.auditQuietly).mock.calls[0][0].action).toBe("binding.denied");
    expect(store.useSecretValue).not.toHaveBeenCalled();
  });

  it("does not decrypt the secret for a request policy refuses", async () => {
    vi.mocked(store.getBindingByName).mockResolvedValue({ ...binding({ baseUrl }), createdAt: null });
    vi.mocked(store.useSecretValue).mockClear();
    await expect(executeBinding(agent, { binding: "stripe-api", method: "DELETE", path: "/v1/balance" })).rejects.toThrow(/not allowed/);
    expect(store.useSecretValue).not.toHaveBeenCalled();
  });

  it("enforces the hourly cap", async () => {
    vi.mocked(store.getBindingByName).mockResolvedValue({ ...binding({ baseUrl, maxCallsPerHour: 1 }), createdAt: null });
    vi.mocked(store.reserveCall).mockResolvedValueOnce(false);
    await expect(executeBinding(agent, { binding: "stripe-api", method: "GET", path: "/v1/balance" })).rejects.toMatchObject({ status: 429 });
  });
});
