/**
 * Solidity compile + Sourcify verification for agents. A model can write
 * Solidity but can't turn it into bytecode or an ABI; this does, with the
 * solc build pinned in package.json, so eth_deploy_source can go from
 * source text to a verified contract on Sepolia in one call.
 *
 * Imports resolve from the request's own files first, then from a short
 * allowlist of npm packages at pinned versions on jsDelivr (OpenZeppelin).
 * Nothing else is fetched: no arbitrary URLs, no filesystem.
 */
import type { Abi } from "viem";
import { DevtoolsInputError } from "./devtools";

export const MAX_SOURCE_BYTES = 200_000;
export const MAX_FILES = 80;
const FETCH_TIMEOUT_MS = 10_000;
const SOURCIFY = process.env.SOURCIFY_URL || "https://sourcify.dev/server";

/** Import prefixes an agent may use, each pinned to one version. */
export const IMPORT_PACKAGES: Record<string, string> = {
  "@openzeppelin/contracts/": "https://cdn.jsdelivr.net/npm/@openzeppelin/contracts@5.4.0/",
  "@openzeppelin/contracts-upgradeable/": "https://cdn.jsdelivr.net/npm/@openzeppelin/contracts-upgradeable@5.4.0/",
};

// ── solc (lazy: the emscripten build is 9 MB and takes ~1s to load) ──────

interface Solc { compile(input: string): string; version(): string }
let solcPromise: Promise<Solc> | null = null;
function loadSolc(): Promise<Solc> {
  solcPromise ??= import("solc").then((m) => ((m as { default?: Solc }).default ?? (m as unknown as Solc)));
  return solcPromise;
}

export async function compilerVersion(): Promise<string> {
  return (await loadSolc()).version().replace(/\.Emscripten.*$/, "");
}

// ── Import resolution ────────────────────────────────────────────────────

// Not anchored to line starts: one-line sources put imports after `pragma …;`.
const IMPORT_RE = /\bimport\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g;

export function importsOf(source: string): string[] {
  // Strip comments so a commented-out import isn't fetched.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return [...code.matchAll(IMPORT_RE)].map((m) => m[1]);
}

/** Resolves "./x.sol" / "../x.sol" against the importing file; package paths pass through. */
export function resolveImportPath(from: string, path: string): string {
  if (!path.startsWith(".")) return normalizePath(path);
  const dir = from.split("/").slice(0, -1);
  return normalizePath([...dir, path].join("/"));
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) throw new DevtoolsInputError(`Import "${path}" climbs above the project root`);
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** The pinned CDN URL for an allowlisted package path, or null. */
export function packageUrl(path: string): string | null {
  for (const [prefix, base] of Object.entries(IMPORT_PACKAGES)) {
    if (path.startsWith(prefix) && path.endsWith(".sol")) return base + path.slice(prefix.length);
  }
  return null;
}

/**
 * Every file the sources need: the caller's, plus allowlisted package files
 * fetched breadth-first. solc's import callback is synchronous, so all of
 * it is gathered before compiling.
 */
export async function gatherSources(files: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<Record<string, string>> {
  const all: Record<string, string> = { ...files };
  const queue = Object.keys(files);
  while (queue.length) {
    const file = queue.shift()!;
    for (const raw of importsOf(all[file])) {
      const path = resolveImportPath(file, raw);
      if (all[path] != null) continue;
      const url = packageUrl(path);
      if (!url) {
        const allowed = Object.keys(IMPORT_PACKAGES).join(", ");
        throw new DevtoolsInputError(`${file} imports "${raw}", which isn't in the request. Pass it in \`sources\`, or import from ${allowed}`);
      }
      if (Object.keys(all).length >= MAX_FILES) throw new DevtoolsInputError(`More than ${MAX_FILES} files after resolving imports`);
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new DevtoolsInputError(`Import "${raw}" not found (${res.status}). Check the path against ${url.replace(/[^/]+$/, "")}`);
      all[path] = await res.text();
      queue.push(path);
    }
  }
  return all;
}

// ── Compile ──────────────────────────────────────────────────────────────

export interface CompileOptions {
  optimize?: boolean;
  runs?: number;
  evmVersion?: string;
}

export interface CompiledContract {
  name: string;
  /** "File.sol:Name", the fullyQualifiedName Sourcify wants. */
  identifier: string;
  abi: Abi;
  bytecode: `0x${string}`;
  deployedBytecodeSize: number;
  /** Human-readable signatures, ready for eth_read_contract / eth_send. */
  functions: string[];
  constructorSignature: string | null;
}

export interface CompileDiagnostic { severity: "error" | "warning" | "info"; message: string; location: string | null }

export interface CompileResult {
  ok: boolean;
  compilerVersion: string;
  contracts: CompiledContract[];
  errors: CompileDiagnostic[];
  warnings: CompileDiagnostic[];
  /** The exact standard-JSON input, kept so the deploy can be verified with it. */
  stdJsonInput: Record<string, unknown>;
}

const EVM_VERSIONS = ["london", "paris", "shanghai", "cancun", "prague"];

/** `source` (one file) or `sources` (path → text) → validated file map. */
export function parseSources(source: unknown, sources: unknown): Record<string, string> {
  let files: Record<string, string>;
  if (typeof source === "string" && source.trim()) files = { "Contract.sol": source };
  else if (sources && typeof sources === "object" && !Array.isArray(sources)) files = sources as Record<string, string>;
  else throw new DevtoolsInputError("Pass `source` (Solidity text) or `sources` ({ \"path.sol\": text })");
  const entries = Object.entries(files);
  if (!entries.length) throw new DevtoolsInputError("sources is empty");
  if (entries.length > MAX_FILES) throw new DevtoolsInputError(`At most ${MAX_FILES} files`);
  let bytes = 0;
  const out: Record<string, string> = {};
  for (const [path, text] of entries) {
    if (typeof text !== "string") throw new DevtoolsInputError(`sources["${path}"] must be a string`);
    if (!/\.sol$/.test(path)) throw new DevtoolsInputError(`Source paths must end in .sol ("${path}")`);
    bytes += text.length;
    out[normalizePath(path)] = text;
  }
  if (bytes > MAX_SOURCE_BYTES) throw new DevtoolsInputError(`Sources total ${bytes} bytes; the limit is ${MAX_SOURCE_BYTES}`);
  return out;
}

export function standardJson(files: Record<string, string>, opts: CompileOptions = {}): Record<string, unknown> {
  if (opts.evmVersion && !EVM_VERSIONS.includes(opts.evmVersion)) throw new DevtoolsInputError(`evmVersion must be one of ${EVM_VERSIONS.join(", ")}`);
  const runs = opts.runs ?? 200;
  if (!Number.isInteger(runs) || runs < 1 || runs > 1_000_000) throw new DevtoolsInputError("runs must be an integer from 1 to 1000000");
  return {
    language: "Solidity",
    sources: Object.fromEntries(Object.entries(files).map(([p, content]) => [p, { content }])),
    settings: {
      optimizer: { enabled: opts.optimize !== false, runs },
      ...(opts.evmVersion ? { evmVersion: opts.evmVersion } : {}),
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
}

function signatureOf(item: { name?: string; inputs?: readonly { type: string; name?: string; components?: unknown }[]; outputs?: readonly { type: string }[]; stateMutability?: string }): string {
  const params = (list: readonly { type: string; name?: string }[] = []) => list.map((p) => `${p.type}${p.name ? ` ${p.name}` : ""}`).join(", ");
  const mut = item.stateMutability && item.stateMutability !== "nonpayable" ? ` ${item.stateMutability}` : "";
  const ret = item.outputs?.length ? ` returns (${item.outputs.map((o) => o.type).join(", ")})` : "";
  return `${item.name}(${params(item.inputs)})${mut}${ret}`;
}

type SolcOutput = {
  errors?: { severity: string; formattedMessage?: string; message: string; sourceLocation?: { file: string; start: number } }[];
  contracts?: Record<string, Record<string, { abi: Abi; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
};

/** Compiles with the bundled solc. Import resolution happens before this. */
export async function compileSolidity(files: Record<string, string>, opts: CompileOptions = {}, fetchImpl?: typeof fetch): Promise<CompileResult> {
  const all = await gatherSources(files, fetchImpl);
  const input = standardJson(all, opts);
  const solc = await loadSolc();
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput;

  const diags = (output.errors ?? []).map((e): CompileDiagnostic => ({
    severity: e.severity === "error" ? "error" : e.severity === "warning" ? "warning" : "info",
    message: (e.formattedMessage ?? e.message).trim().slice(0, 2000),
    location: e.sourceLocation ? `${e.sourceLocation.file}:${e.sourceLocation.start}` : null,
  }));
  const errors = diags.filter((d) => d.severity === "error");

  // Only the caller's own files are reported; library contracts stay out of the list.
  const contracts: CompiledContract[] = [];
  for (const file of Object.keys(files)) {
    for (const [name, c] of Object.entries(output.contracts?.[file] ?? {})) {
      const bytecode = c.evm.bytecode.object;
      if (!bytecode) continue; // interfaces and abstract contracts
      const ctor = c.abi.find((i) => i.type === "constructor") as { inputs?: { type: string; name?: string }[] } | undefined;
      contracts.push({
        name, identifier: `${file}:${name}`, abi: c.abi, bytecode: `0x${bytecode}`,
        deployedBytecodeSize: c.evm.deployedBytecode.object.length / 2,
        functions: c.abi.filter((i) => i.type === "function").map((i) => signatureOf(i as never)),
        constructorSignature: ctor?.inputs?.length ? `constructor(${ctor.inputs.map((p) => `${p.type}${p.name ? ` ${p.name}` : ""}`).join(", ")})` : null,
      });
    }
  }
  return {
    ok: errors.length === 0, compilerVersion: solc.version().replace(/\.Emscripten.*$/, ""), contracts, errors,
    warnings: diags.filter((d) => d.severity === "warning").slice(0, 20), stdJsonInput: input,
  };
}

/** The contract to deploy: the named one, or the only/last deployable contract in the caller's files. */
export function pickContract(result: CompileResult, name?: string | null): CompiledContract {
  if (!result.contracts.length) throw new DevtoolsInputError("Nothing deployable compiled (only interfaces, libraries or abstract contracts)");
  if (name) {
    const hit = result.contracts.find((c) => c.name === name || c.identifier === name);
    if (!hit) throw new DevtoolsInputError(`No contract "${name}". Compiled: ${result.contracts.map((c) => c.name).join(", ")}`);
    return hit;
  }
  if (result.contracts.length === 1) return result.contracts[0];
  return result.contracts[result.contracts.length - 1];
}

// ── Sourcify ─────────────────────────────────────────────────────────────

/** "already-verified" = Sourcify had source for this address before; it says nothing about this source. */
export interface VerifyResult { status: "verified" | "already-verified" | "pending" | "failed"; match: string | null; verificationId: string | null; url: string | null; error: string | null }

/**
 * Submits a deployment to Sourcify and polls briefly. Best-effort: a slow
 * queue returns "pending" with the job id rather than failing the deploy.
 */
export async function verifyOnSourcify(
  params: { chainId: number; address: string; stdJsonInput: Record<string, unknown>; compilerVersion: string; identifier: string; creationTxHash?: string | null },
  fetchImpl: typeof fetch = fetch, pollMs = 2_000, polls = 8,
): Promise<VerifyResult> {
  const repoUrl = `https://repo.sourcify.dev/${params.chainId}/${params.address}`;
  try {
    const res = await fetchImpl(`${SOURCIFY}/v2/verify/${params.chainId}/${params.address}`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      body: JSON.stringify({
        stdJsonInput: params.stdJsonInput, compilerVersion: params.compilerVersion, contractIdentifier: params.identifier,
        ...(params.creationTxHash ? { creationTransactionHash: params.creationTxHash } : {}),
      }),
    });
    const sent = (await res.json().catch(() => ({}))) as { verificationId?: string; message?: string; customCode?: string };
    if (sent.customCode === "already_verified") return { status: "already-verified", match: null, verificationId: null, url: repoUrl, error: null };
    if (!res.ok || !sent.verificationId) return { status: "failed", match: null, verificationId: null, url: null, error: sent.message ?? `Sourcify returned ${res.status}` };
    for (let i = 0; i < polls; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const job = (await (await fetchImpl(`${SOURCIFY}/v2/verify/${sent.verificationId}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })).json().catch(() => ({}))) as {
        isJobCompleted?: boolean; contract?: { match?: string | null }; error?: { message?: string };
      };
      if (!job.isJobCompleted) continue;
      if (job.error) return { status: "failed", match: null, verificationId: sent.verificationId, url: null, error: job.error.message ?? "verification failed" };
      return { status: "verified", match: job.contract?.match ?? "match", verificationId: sent.verificationId, url: repoUrl, error: null };
    }
    return { status: "pending", match: null, verificationId: sent.verificationId, url: null, error: null };
  } catch (err) {
    return { status: "failed", match: null, verificationId: null, url: null, error: (err as Error).message.split("\n")[0] };
  }
}

export interface ContractAbi {
  address: string;
  chainId: number;
  verified: boolean;
  source: "sourcify" | "etherscan" | null;
  name: string | null;
  compilerVersion: string | null;
  abi: Abi | null;
  functions: string[];
  events: string[];
  errors: string[];
  /** When the address is a proxy: the implementation's ABI is merged in, and its address is here. */
  implementation: string | null;
}

const abiLists = (abi: Abi) => ({
  functions: abi.filter((i) => i.type === "function").map((i) => signatureOf(i as never)),
  events: abi.filter((i) => i.type === "event").map((i) => `${(i as { name: string }).name}(${((i as unknown as { inputs: { type: string; indexed?: boolean; name?: string }[] }).inputs).map((p) => `${p.type}${p.indexed ? " indexed" : ""}${p.name ? ` ${p.name}` : ""}`).join(", ")})`),
  errors: abi.filter((i) => i.type === "error").map((i) => signatureOf(i as never)),
});

async function sourcifyAbi(chainId: number, address: string, fetchImpl: typeof fetch) {
  const res = await fetchImpl(`${SOURCIFY}/v2/contract/${chainId}/${address}?fields=abi,compilation,proxyResolution`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sourcify returned ${res.status}`);
  const d = (await res.json()) as { abi?: Abi; compilation?: { name?: string; compilerVersion?: string }; proxyResolution?: { isProxy?: boolean; implementations?: { address: string }[] } };
  if (!d.abi) return null;
  return { abi: d.abi, name: d.compilation?.name ?? null, compilerVersion: d.compilation?.compilerVersion ?? null, implementation: d.proxyResolution?.isProxy ? d.proxyResolution.implementations?.[0]?.address ?? null : null };
}

async function etherscanAbi(chainId: number, address: string, fetchImpl: typeof fetch) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return null;
  const qs = new URLSearchParams({ chainid: String(chainId), module: "contract", action: "getsourcecode", address, apikey: key });
  const res = await fetchImpl(`https://api.etherscan.io/v2/api?${qs}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const d = (await res.json()) as { status: string; result: { ABI: string; ContractName: string; CompilerVersion: string; Implementation?: string }[] | string };
  if (d.status !== "1" || !Array.isArray(d.result) || !d.result[0] || d.result[0].ABI.startsWith("Contract source code not verified")) return null;
  const r = d.result[0];
  return { abi: JSON.parse(r.ABI) as Abi, name: r.ContractName || null, compilerVersion: r.CompilerVersion || null, implementation: r.Implementation || null };
}

/**
 * A verified contract's ABI from Sourcify (keyless), falling back to
 * Etherscan when a key is set. Proxies get their implementation's ABI too.
 * `fallbackImplementation` is the EIP-1967 slot read, for proxies the
 * verifier didn't resolve.
 */
export async function contractAbi(chainId: number, address: string, fallbackImplementation: string | null = null, fetchImpl: typeof fetch = fetch): Promise<ContractAbi> {
  const lookup = async (a: string) => {
    const s = await sourcifyAbi(chainId, a, fetchImpl).catch(() => null);
    if (s) return { ...s, source: "sourcify" as const };
    const e = await etherscanAbi(chainId, a, fetchImpl).catch(() => null);
    return e ? { ...e, source: "etherscan" as const } : null;
  };
  const own = await lookup(address);
  const implAddress = own?.implementation ?? fallbackImplementation;
  const impl = implAddress && implAddress.toLowerCase() !== address.toLowerCase() ? await lookup(implAddress) : null;
  if (!own && !impl) {
    return { address, chainId, verified: false, source: null, name: null, compilerVersion: null, abi: null, functions: [], events: [], errors: [], implementation: implAddress };
  }
  const abi = [...(own?.abi ?? []), ...(impl?.abi ?? [])] as Abi;
  return {
    address, chainId, verified: !!own, source: (own ?? impl)!.source,
    name: impl?.name ?? own?.name ?? null, compilerVersion: (impl ?? own)?.compilerVersion ?? null, abi, ...abiLists(abi), implementation: implAddress,
  };
}
