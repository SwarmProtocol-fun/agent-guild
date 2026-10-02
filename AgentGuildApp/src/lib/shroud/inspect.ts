/**
 * Shroud inspection — pure functions, no I/O.
 *
 * Looks at LLM traffic going through the proxy:
 *   - requests:  prompt-injection signals in untrusted content (user turns and
 *                tool results — what an agent reads from the web, files, other
 *                agents), secrets about to be sent to a model provider
 *                (redacted in flight), links to blocked domains, large
 *                base64 / data: URI blobs;
 *   - responses: exfiltration links (markdown images or links that carry data
 *                in their query string, links to blocked domains) and secrets.
 *
 * Heuristic, not a guarantee: the score is a signal for the org's block/flag
 * policy, and every hit is recorded so owners can see what tripped it.
 */

import { sanitizeText, scanForSecrets } from "@/lib/secret-scanner";

export type Provider = "anthropic" | "openai";

export interface Signal {
  kind: "injection" | "secret" | "blocked_domain" | "exfil_link" | "encoded_blob" | "hidden_text";
  detail: string;
  weight: number;
}

/** Patterns the shared secret-scanner doesn't cover (it has other callers, so it stays as is). */
const EXTRA_SECRET_PATTERNS: [string, RegExp][] = [
  ["OpenAI Project Key", /sk-proj-[A-Za-z0-9_-]{20,}/g],
  ["Anthropic Key", /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["Agent Guild Token", /agt_[A-Za-z0-9._-]{20,}/g],
  ["Agent Guild Runtime Credential", /agrt_[A-Za-z0-9_-]{20,}/g],
  ["GitHub Fine-grained Token", /github_pat_[A-Za-z0-9_]{40,}/g],
  ["Stripe Restricted Key", /rk_live_[A-Za-z0-9]{20,}/g],
];

const INJECTION_PATTERNS: [RegExp, string, number][] = [
  [/\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directives|guidelines)\b/i, "asks to ignore earlier instructions", 45],
  [/\b(reveal|print|output|repeat|show|leak|dump)\b[^.\n]{0,30}\b(system prompt|hidden (?:prompt|instructions)|your instructions|initial prompt|developer message)\b/i, "asks to reveal the system prompt", 40],
  [/\byou are now\b|\bfrom now on,? you (?:are|will)\b|\bnew instructions?:/i, "tries to reassign the model's role", 25],
  [/\b(developer|god|admin|jailbreak|DAN) mode\b|\bdo anything now\b/i, "jailbreak phrasing", 35],
  [/<\|im_start\|>|<\|system\|>|\[INST\]|<<SYS>>|^\s*#{2,}\s*(system|instructions?)\s*:?\s*$/im, "fake chat-template / system markers", 35],
  [/\b(send|post|upload|forward|exfiltrate|transmit)\b[^.\n]{0,60}\b(api[_ -]?keys?|credentials?|secrets?|tokens?|passwords?|private keys?|env(?:ironment)? variables?)\b/i, "asks to send credentials somewhere", 45],
  [/\bcurl\b[^\n|]{0,200}\|\s*(ba)?sh\b|\bwget\b[^\n|]{0,200}\|\s*(ba)?sh\b/i, "pipe-to-shell command", 30],
  [/\b(do not|don't) (tell|inform|mention|alert) (the )?(user|human|operator)\b/i, "asks to hide actions from the user", 30],
];

// Zero-width and Unicode "tag" characters are used to hide instructions from human reviewers.
const HIDDEN_TEXT = /[\u200B-\u200F\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const DATA_URI_BLOB = /data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{2000,}/gi;
const BASE64_BLOB = /(?:^|[^A-Za-z0-9+/])([A-Za-z0-9+/]{1500,}={0,2})(?![A-Za-z0-9+/])/g;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const MD_IMAGE_RE = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;
const MD_LINK_RE = /(?<!!)\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi;

export function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

export function domainMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => {
    const dom = d.trim().toLowerCase().replace(/^\*\./, "");
    return dom && (host === dom || host.endsWith(`.${dom}`));
  });
}

/** A link that smuggles data out: long or secret-looking query/fragment, or a long path segment of encoded data. */
function looksLikeExfil(url: string): boolean {
  try {
    const u = new URL(url);
    const qs = `${u.search}${u.hash}`;
    if (qs.length > 120) return true;
    if (qs && scanForSecrets(decodeURIComponent(qs)).secrets.length) return true;
    return u.pathname.split("/").some((seg) => seg.length > 80 && /^[A-Za-z0-9+/=_-]+$/.test(seg));
  } catch {
    return false;
  }
}

// ─── secrets ───────────────────────────────────────────────────

export function redactSecrets(text: string): { text: string; types: string[] } {
  const types: string[] = [];
  let out = text;
  const scanned = scanForSecrets(out);
  if (!scanned.clean) {
    types.push(...scanned.secrets.map((s) => s.type));
    out = sanitizeText(out);
  }
  for (const [type, re] of EXTRA_SECRET_PATTERNS) {
    out = out.replace(re, () => {
      types.push(type);
      return `[REDACTED ${type}]`;
    });
  }
  return { text: out, types };
}

// ─── request inspection ────────────────────────────────────────

export interface Segment {
  role: string; // system | user | assistant | tool
  text: string;
  /** Where to write the redacted text back. */
  set: (value: string) => void;
}

/** Every text field in a request body, with a setter — Anthropic Messages or OpenAI Chat Completions shape. */
export function collectSegments(provider: Provider, body: Record<string, unknown>): Segment[] {
  const segs: Segment[] = [];
  const pushContent = (role: string, holder: Record<string, unknown>, key: string) => {
    const content = holder[key];
    if (typeof content === "string") {
      segs.push({ role, text: content, set: (v) => { holder[key] = v; } });
    } else if (Array.isArray(content)) {
      for (const part of content as Record<string, unknown>[]) {
        if (!part || typeof part !== "object") continue;
        if (typeof part.text === "string") segs.push({ role, text: part.text, set: (v) => { part.text = v; } });
        // Anthropic tool_result blocks carry their own content (string or blocks) — untrusted input.
        if (part.type === "tool_result" && part.content !== undefined) pushContent("tool", part, "content");
      }
    }
  };

  if (provider === "anthropic" && body.system !== undefined) pushContent("system", body, "system");
  for (const msg of (Array.isArray(body.messages) ? body.messages : []) as Record<string, unknown>[]) {
    if (!msg || typeof msg !== "object") continue;
    pushContent(String(msg.role || "user"), msg, "content");
  }
  return segs;
}

export interface RequestInspection {
  score: number;
  signals: Signal[];
  redactions: string[];
}

/**
 * Score the request and redact secrets in place. System and assistant turns
 * are trusted for injection scoring (they come from the agent's own code and
 * the model); user and tool turns are not.
 */
export function inspectRequest(provider: Provider, body: Record<string, unknown>, blockedDomains: string[]): RequestInspection {
  const signals: Signal[] = [];
  const redactions: string[] = [];

  for (const seg of collectSegments(provider, body)) {
    const untrusted = seg.role === "user" || seg.role === "tool";

    if (untrusted) {
      for (const [re, detail, weight] of INJECTION_PATTERNS) {
        if (re.test(seg.text)) signals.push({ kind: "injection", detail, weight });
      }
      if (HIDDEN_TEXT.test(seg.text)) signals.push({ kind: "hidden_text", detail: "zero-width or Unicode tag characters", weight: 25 });
      if (DATA_URI_BLOB.test(seg.text) || BASE64_BLOB.test(seg.text)) {
        signals.push({ kind: "encoded_blob", detail: "large base64 / data: URI blob", weight: 10 });
      }
      DATA_URI_BLOB.lastIndex = 0;
      BASE64_BLOB.lastIndex = 0;
    }

    for (const url of seg.text.match(URL_RE) || []) {
      const host = hostOf(url);
      if (host && domainMatches(host, blockedDomains)) signals.push({ kind: "blocked_domain", detail: host, weight: 50 });
    }

    const { text, types } = redactSecrets(seg.text);
    if (types.length) {
      redactions.push(...types);
      seg.set(text);
    }
  }

  // Same signal twice in one request shouldn't double its weight.
  const unique = new Map(signals.map((s) => [`${s.kind}:${s.detail}`, s]));
  const deduped = [...unique.values()];
  const score = Math.min(100, deduped.reduce((sum, s) => sum + s.weight, 0));
  return { score, signals: deduped, redactions: [...new Set(redactions)] };
}

// ─── response inspection ───────────────────────────────────────

export interface ResponseInspection {
  text: string;
  signals: Signal[];
}

/**
 * Clean model output before the agent sees it: drop exfil-shaped images and
 * links, neutralize links to blocked domains, redact secrets.
 */
export function inspectResponseText(text: string, blockedDomains: string[]): ResponseInspection {
  const signals: Signal[] = [];
  let out = text.replace(MD_IMAGE_RE, (whole, url: string) => {
    const host = hostOf(url) || "?";
    if (domainMatches(host, blockedDomains) || looksLikeExfil(url)) {
      signals.push({ kind: "exfil_link", detail: `image -> ${host}`, weight: 50 });
      return `[image removed by Agent Guild Shroud: ${host}]`;
    }
    return whole;
  });
  out = out.replace(MD_LINK_RE, (whole, url: string) => {
    const host = hostOf(url) || "?";
    if (domainMatches(host, blockedDomains) || looksLikeExfil(url)) {
      signals.push({ kind: "exfil_link", detail: `link -> ${host}`, weight: 40 });
      return `[link removed by Agent Guild Shroud: ${host}]`;
    }
    return whole;
  });
  out = out.replace(URL_RE, (url) => {
    const host = hostOf(url);
    if (host && domainMatches(host, blockedDomains)) {
      signals.push({ kind: "blocked_domain", detail: host, weight: 50 });
      return `[blocked URL: ${host}]`;
    }
    return url;
  });
  const red = redactSecrets(out);
  if (red.types.length) signals.push(...red.types.map((t) => ({ kind: "secret" as const, detail: t, weight: 30 })));
  return { text: red.text, signals };
}
