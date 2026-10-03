/**
 * Tests for the solana-anchor executor. A fake `docker` on PATH stands in
 * for the real container: it records its argv, writes the build outputs a
 * real `anchor build` would into the mounted workspace, and echoes deploy
 * output — so the whole execute() path (file layout, mounts, output
 * collection, cleanup) runs without a Docker daemon.
 *
 * Run with: npm test (node --test)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute, buildScript, validProjectPath, base58, parseDeploy } from "../solana-anchor.mjs";

let binDir;
let argvLog;
let originalPath;

// Program keypair whose public half is 32 bytes of 1 → base58 "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi".
const SECRET = [...Array(32).fill(7), ...Array(32).fill(1)];

before(async () => {
  binDir = await mkdtemp(join(tmpdir(), "fake-docker-"));
  argvLog = join(binDir, "argv.json");
  const fake = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));
if (args[0] === "kill") process.exit(0);
const mount = args[args.indexOf("-v") + 1].split(":")[0];
const deploy = path.join(mount, "target", "deploy"), idl = path.join(mount, "target", "idl");
fs.mkdirSync(deploy, { recursive: true }); fs.mkdirSync(idl, { recursive: true });
fs.writeFileSync(path.join(deploy, "counter-keypair.json"), JSON.stringify(${JSON.stringify(SECRET)}));
fs.writeFileSync(path.join(deploy, "counter.so"), Buffer.alloc(1234));
fs.writeFileSync(path.join(idl, "counter.json"), JSON.stringify({ metadata: { name: "counter" }, instructions: [] }));
const script = args[args.length - 1];
console.log("== anchor build");
if (script.includes("anchor deploy")) console.log("Program Id: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi\\n\\nSignature: " + "5".repeat(88));
if (process.env.FAKE_FAIL) { console.error("error[E0425]: cannot find value"); process.exit(101); }
`;
  await writeFile(join(binDir, "docker"), fake);
  await chmod(join(binDir, "docker"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath}`;
});

after(async () => {
  process.env.PATH = originalPath;
  await rm(binDir, { recursive: true, force: true });
});

const files = { "Anchor.toml": "[programs.localnet]\n", "programs/counter/src/lib.rs": "// program" };

test("path validation blocks escapes and build output", () => {
  assert.equal(validProjectPath("programs/x/src/lib.rs"), true);
  for (const bad of ["../etc/passwd", "/abs", "a//b", "target/deploy/x.so", "a b"]) assert.equal(validProjectPath(bad), false, bad);
});

test("base58 matches a known pubkey", () => {
  assert.equal(base58(Array(32).fill(1)), "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi");
  assert.equal(base58([0, 0, 1]), "112");
});

test("script syncs program ids and only deploys when asked", () => {
  const build = buildScript("build");
  assert.match(build, /anchor build\necho '== anchor keys sync'\nanchor keys sync\nanchor build/);
  assert.doesNotMatch(build, /anchor deploy|anchor test/);
  assert.match(buildScript("test"), /anchor test --skip-build --provider.cluster localnet/);
  assert.match(buildScript("deploy"), /anchor deploy --provider.cluster "\$DEPLOY_RPC_URL" --provider.wallet \/secrets\/deployer.json/);
});

test("parseDeploy extracts program ids and signatures", () => {
  const out = parseDeploy(`Program Id: 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi\n\nSignature: ${"5".repeat(88)}`);
  assert.deepEqual(out.programIds, ["4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"]);
  assert.equal(out.signatures.length, 1);
});

test("build: writes the project, runs the image sandboxed, returns program ids + IDLs, cleans up", async () => {
  const before = (await readdir(tmpdir())).filter((f) => f.startsWith("solana-anchor-")).length;
  const res = await execute({ payload: { action: "build", files }, timeoutMs: 10_000 }, null);
  assert.equal(res.exitCode, 0);
  assert.equal(res.data.success, true);
  assert.deepEqual(res.data.programs, [{ name: "counter", programId: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi", soBytes: 1234 }]);
  assert.equal(res.data.idls.counter.metadata.name, "counter");
  // The program keypair's secret half never comes back.
  assert.doesNotMatch(JSON.stringify(res.data), /\[7,7,7/);

  const argv = JSON.parse(await readFile(argvLog, "utf8"));
  assert.ok(argv.includes("solanafoundation/anchor:v0.31.1"));
  assert.ok(argv.some((a) => a.startsWith("--memory=")) && argv.includes("--pids-limit=1024"));
  assert.ok(!argv.some((a) => a.includes("/secrets")), "no key mount for build");

  const afterCount = (await readdir(tmpdir())).filter((f) => f.startsWith("solana-anchor-")).length;
  assert.equal(afterCount, before, "workspace removed");
});

test("deploy: key is mounted read-only from a file, never passed as an argument", async () => {
  const privateKey = JSON.stringify(SECRET);
  const res = await execute({
    payload: { action: "deploy", files, deploy: { cluster: "devnet", rpcUrl: "https://api.devnet.solana.com" }, privateKey },
    timeoutMs: 10_000,
  }, null);
  assert.equal(res.data.deploy.cluster, "devnet");
  assert.deepEqual(res.data.deploy.programIds, ["4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"]);
  const argv = JSON.parse(await readFile(argvLog, "utf8"));
  assert.ok(argv.some((a) => a.endsWith(":/secrets:ro")));
  assert.ok(argv.includes("DEPLOY_RPC_URL=https://api.devnet.solana.com"));
  assert.ok(!argv.join(" ").includes(privateKey), "key not in argv");
});

test("a failing build reports its exit code and log tail", async () => {
  process.env.FAKE_FAIL = "1";
  try {
    const res = await execute({ payload: { action: "build", files }, timeoutMs: 10_000 }, null);
    assert.equal(res.exitCode, 101);
    assert.equal(res.data.success, false);
    assert.match(res.data.logTail, /E0425/);
  } finally {
    delete process.env.FAKE_FAIL;
  }
});

test("rejects bad payloads before touching docker", async () => {
  await assert.rejects(execute({ payload: { action: "rm", files } }, null), /action must be/);
  await assert.rejects(execute({ payload: { action: "build", files: { "lib.rs": "" } } }, null), /Anchor.toml/);
  await assert.rejects(execute({ payload: { action: "build", files: { ...files, "../x": "" } } }, null), /invalid file/);
  await assert.rejects(execute({ payload: { action: "deploy", files } }, null), /privateKey/);
});
