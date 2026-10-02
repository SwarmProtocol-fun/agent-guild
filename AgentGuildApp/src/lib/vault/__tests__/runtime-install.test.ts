// @vitest-environment node
/**
 * Runs the real install command produced by installCommand() under /bin/sh,
 * with /etc, /usr/local and sudo redirected into a temp dir, against a mock
 * hub — so shell quoting, enrollment, the token cache and the CLI wrapper are
 * exercised for real.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { installCommand } from "../runtimes";

const CREDENTIAL = "agrt_test_credential_value";
let hub: string;
let server: http.Server;
let tokenCalls = 0;
let dir: string;

function sh(script: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], { env: { NODE_ENV: "test" as const, PATH: `${dir}/usr/bin:${process.env.PATH ?? ""}`, HOME: dir, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-runtime-"));
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.url === "/agent-guild.mjs") {
      res.end('console.log("CLI token=" + process.env.AGENT_GUILD_TOKEN + " hub=" + process.env.AGENT_GUILD_HUB + " args=" + process.argv.slice(2).join(","));');
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/runtime/enroll") {
      const { code } = JSON.parse(body);
      if (code !== "agen_good'code") { res.statusCode = 401; res.end('{"error":"Invalid or already used enrollment code"}'); return; }
      res.end(JSON.stringify({ runtimeId: "comp1", credential: CREDENTIAL }));
      return;
    }
    if (req.url === "/api/v1/runtime/token") {
      tokenCalls++;
      if (req.headers.authorization !== `Runtime ${CREDENTIAL}` || req.headers["x-runtime-id"] !== "comp1") { res.statusCode = 401; res.end('{"error":"bad"}'); return; }
      res.end(JSON.stringify({ token: `agt_tok${tokenCalls}`, expiresAt: Date.now() + 3600_000 }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hub = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function sandboxed(cmd: string) {
  return cmd.replaceAll("sudo ", "").replaceAll("/etc/agent-guild", `${dir}/etc/agent-guild`).replaceAll("/usr/local", `${dir}/usr`);
}

describe("runtime install command", () => {
  it("enrolls, writes the credential, and installs working helpers", async () => {
    // A quote in the code checks the shell quoting.
    const res = await sh(sandboxed(installCommand(hub, "agen_good'code")));
    expect(res.stderr).toBe("");
    expect(res.stdout).toContain("Agent Guild runtime connected: comp1");

    const env = fs.readFileSync(`${dir}/etc/agent-guild/runtime.env`, "utf8");
    expect(env).toContain(`AGENT_GUILD_RUNTIME_CREDENTIAL=${CREDENTIAL}`);
    expect(env).toContain(`AGENT_GUILD_HUB=${hub}`);

    const t1 = await sh("agent-guild-token", { XDG_RUNTIME_DIR: dir });
    const t2 = await sh("agent-guild-token", { XDG_RUNTIME_DIR: dir });
    expect(t1.stdout).toBe("agt_tok1\n");
    expect(t2.stdout).toBe("agt_tok1\n"); // served from cache
    expect(tokenCalls).toBe(1);

    const cli = await sh("agent-guild bindings --json", { XDG_RUNTIME_DIR: dir });
    expect(cli.stdout.trim()).toBe(`CLI token=agt_tok1 hub=${hub} args=bindings,--json`);
  });

  it("fails loudly on a bad code and writes no credential", async () => {
    fs.rmSync(`${dir}/etc`, { recursive: true, force: true });
    const res = await sh(sandboxed(installCommand(hub, "agen_wrong")));
    expect(res.code).not.toBe(0);
    expect(fs.existsSync(`${dir}/etc/agent-guild/runtime.env`)).toBe(false);
  });
});
