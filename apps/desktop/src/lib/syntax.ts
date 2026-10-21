import type { HLJSApi, LanguageFn } from "highlight.js";
import type { TextRange } from "./diff";

export type SyntaxKind = "keyword" | "string" | "literal" | "comment";
export interface SyntaxSpan { start: number; end: number; kind: SyntaxKind }
export interface CodeSegment { text: string; kind?: SyntaxKind; changed: boolean }

// Bounds are fixed: anything beyond renders plain — source text is never
// truncated or altered for coloring.
export const SYNTAX_SOURCE_CAP = 64 * 1024;
export const SYNTAX_LINE_CAP = 4096;
const HTML_CAP = 1024 * 1024;
export const SPAN_CAP = 5000;
const CACHE_ENTRIES = 32;
const CACHE_CHARS = 256 * 1024;

/** Whole-source bounds checked before the highlighter core is ever requested. */
export function syntaxSourceAllowed(source: string): boolean {
  if (source.length > SYNTAX_SOURCE_CAP) return false;
  let at = 0;
  while (at < source.length) {
    const lf = source.indexOf("\n", at);
    const end = lf === -1 ? source.length : lf;
    if (end - at > SYNTAX_LINE_CAP) return false;
    if (lf === -1) break;
    at = lf + 1;
  }
  return true;
}

const ALIASES: Record<string, string> = {
  javascript: "javascript", typescript: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  html: "xml", htm: "xml", svg: "xml", xml: "xml", vue: "xml", svelte: "xml",
  sh: "bash", bash: "bash", zsh: "bash", shell: "bash",
  py: "python", python: "python",
  rs: "rust", rust: "rust", go: "go",
  yml: "yaml", yaml: "yaml",
  md: "markdown", markdown: "markdown",
  c: "c", h: "cpp", hpp: "cpp", cc: "cpp", cxx: "cpp", cpp: "cpp",
  cs: "csharp", csharp: "csharp", java: "java",
  rb: "ruby", ruby: "ruby",
  toml: "ini", ini: "ini", cfg: "ini",
  graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile",
  json: "json", sql: "sql", css: "css",
};

const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

const resolve = (name: string): string | undefined => own(ALIASES, name.toLowerCase());

/**
 * Resolve a root grammar from an explicit fence name or a file path. An
 * explicit language we do not map yields undefined — never inferred. With no
 * explicit language the path's basename (Dockerfile, .bashrc, .zshrc) or
 * extension is consulted; anything unrecognized stays plain.
 */
export function syntaxLanguage(language?: string, path?: string): string | undefined {
  const explicit = language?.trim();
  if (explicit) return resolve(explicit);
  if (!path) return undefined;
  const clean = path.split("?")[0];
  const base = clean.split("/").pop() ?? "";
  const lowered = base.toLowerCase();
  if (lowered === "dockerfile") return "dockerfile";
  if (lowered === ".bashrc" || lowered === ".zshrc") return "bash";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return undefined;
  return resolve(base.slice(dot + 1));
}

// Sublanguage requirements read from the installed grammars (`subLanguage`
// names). `xml` and `javascript` depend on each other, so the closure below is
// a visited set — the cycle cannot deadlock.
const DEPS: Record<string, readonly string[]> = {
  javascript: ["xml", "css", "graphql"],
  typescript: ["javascript", "xml", "css", "graphql"],
  xml: ["javascript", "css"],
  markdown: ["xml"],
  yaml: ["ruby"],
  dockerfile: ["bash"],
};

const GRAMMARS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  json: () => import("highlight.js/lib/languages/json"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  bash: () => import("highlight.js/lib/languages/bash"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  go: () => import("highlight.js/lib/languages/go"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  sql: () => import("highlight.js/lib/languages/sql"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  c: () => import("highlight.js/lib/languages/c"),
  java: () => import("highlight.js/lib/languages/java"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
};

const KIND: Record<string, SyntaxKind> = {
  comment: "comment", quote: "comment",
  string: "string", regexp: "string",
  number: "literal", literal: "literal", attr: "literal", attribute: "literal", symbol: "literal", bullet: "literal",
  keyword: "keyword", built_in: "keyword", type: "keyword", title: "keyword", name: "keyword",
  "selector-tag": "keyword", "selector-class": "keyword", "selector-id": "keyword", "selector-pseudo": "keyword",
  meta: "keyword", "meta-keyword": "keyword", section: "keyword", doctag: "keyword",
};

// Wrapper scopes that reset to plain — inner recognized scopes still color.
// hljs 11 emits prefixed scope names (`hljs-keyword`); normalize the prefix
// so both spellings land on the fixed four-kind palette.
const BARE = (token: string) => token.toLowerCase().startsWith("hljs-") ? token.slice(5) : token;
const TRANSPARENT = /^(hljs|subst|language-[a-z0-9_-]*)$/i;

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'" };
const ENTITIES = /&(?:amp|lt|gt|quot|#x27);/g;
const decodeEntities = (text: string) => text.replace(ENTITIES, (full) => ENTITY[full.slice(1, -1)] ?? full);

const OPEN_TAG = /^<span class="([A-Za-z0-9_ -]*)">/;
const CLASS_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * Translate `highlight().value` back into plain spans over the original
 * source. The accepted grammar is exactly the highlighter's own output:
 * `<span class="…">` open tags, `</span>` closes, and entity-escaped text.
 * Foreign tags, attributes, imbalance, or decoded text that does not exactly
 * reproduce `source` reject the whole result to []. The HTML is only ever
 * parsed here — it is never inserted into the DOM.
 */
export function parseSyntaxHtml(source: string, html: string): SyntaxSpan[] {
  interface Frame { kind?: SyntaxKind }
  const stack: Frame[] = [];
  const spans: SyntaxSpan[] = [];
  const parts: string[] = [];
  let at = 0;
  let pos = 0; // current UTF-16 offset into the decoded text
  while (at < html.length) {
    if (html[at] === "<") {
      const rest = html.slice(at);
      if (rest.startsWith("</span>")) {
        const frame = stack.pop();
        if (!frame) return [];
        at += "</span>".length;
        continue;
      }
      const open = OPEN_TAG.exec(rest);
      if (!open) return [];
      const tokens = open[1].split(" ").filter(Boolean);
      if (tokens.some((token) => !CLASS_TOKEN.test(token))) return [];
      const parent = stack.length ? stack[stack.length - 1].kind : undefined;
      const transparent = tokens.some((token) => TRANSPARENT.test(token) || TRANSPARENT.test(BARE(token)));
      const mapped = tokens.map((token) => own(KIND, BARE(token))).find((kind) => kind !== undefined);
      stack.push({ kind: transparent ? undefined : (mapped ?? parent) });
      at += open[0].length;
      continue;
    }
    const next = html.indexOf("<", at);
    const run = html.slice(at, next === -1 ? html.length : next);
    const text = decodeEntities(run);
    const kind = stack.length ? stack[stack.length - 1].kind : undefined;
    if (kind && text.length) {
      const last = spans[spans.length - 1];
      if (last && last.kind === kind && last.end === pos) last.end = pos + text.length;
      else {
        if (spans.length >= SPAN_CAP) return []; // beyond the cap the whole result degrades to plain
        spans.push({ start: pos, end: pos + text.length, kind });
      }
    }
    parts.push(text);
    pos += text.length;
    at = next === -1 ? html.length : next;
  }
  if (stack.length) return [];
  // The decoded text must be byte-identical to the source — entities decode
  // exactly once, so a literal `&lt;` in source stays `&lt;` here.
  if (parts.join("") !== source) return [];
  return spans;
}

/**
 * Split whole-source spans at LF boundaries into per-line local-offset spans.
 * The LF itself is never inside a span; CR remains ordinary content. A final
 * LF yields a trailing empty line (with no spans).
 */
export function syntaxLines(source: string, spans: readonly SyntaxSpan[]): SyntaxSpan[][] {
  const out: SyntaxSpan[][] = [];
  let lineStart = 0;
  let cursor = 0;
  while (true) {
    const lf = source.indexOf("\n", lineStart);
    const lineEnd = lf === -1 ? source.length : lf;
    const line: SyntaxSpan[] = [];
    while (cursor < spans.length && spans[cursor].end <= lineStart) cursor += 1;
    for (let i = cursor; i < spans.length && spans[i].start < lineEnd; i += 1) {
      const start = Math.max(spans[i].start, lineStart) - lineStart;
      const end = Math.min(spans[i].end, lineEnd) - lineStart;
      if (end > start) line.push({ start, end, kind: spans[i].kind });
    }
    out.push(line);
    if (lf === -1) break;
    lineStart = lf + 1;
  }
  return out;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const KINDS = new Set<SyntaxKind>(["keyword", "string", "literal", "comment"]);

// A range boundary inside a surrogate pair invalidates the whole range —
// dropping it degrades to plain text instead of coloring a broken cut.
const splitsPair = (text: string, at: number) => at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));

/**
 * Partition `text` at the union of syntax-span and word-mark boundaries into
 * ordered segments — after sorting, the sweep is linear in the text and
 * ranges. Every source character is preserved exactly once. Spans are
 * normalized to valid, ordered, nonoverlapping ranges (an overlap drops the
 * offender's coloring rather than inventing one); marks union to maximal
 * coverage. Segments carry only source text, a fixed kind, and a changed flag.
 */
export function segmentCode(text: string, spans: readonly SyntaxSpan[] = [], marks: readonly TextRange[] = []): CodeSegment[] {
  const inBounds = (r: TextRange) => Number.isInteger(r.start) && Number.isInteger(r.end)
    && r.start >= 0 && r.end <= text.length && r.end > r.start
    && !splitsPair(text, r.start) && !splitsPair(text, r.end);
  const validSpans = spans.filter((s) => inBounds(s) && KINDS.has(s.kind));
  const validMarks = marks.filter(inBounds);
  // Drop any span whose start is below the furthest accepted end — ordered
  // nonoverlapping ranges for the sweep.
  const accepted: SyntaxSpan[] = [];
  let covered = 0;
  for (const span of validSpans.sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (span.start >= covered) { accepted.push(span); covered = span.end; }
  }
  const okMarks = ((): TextRange[] => {
    const merged: TextRange[] = [];
    for (const mark of validMarks.sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = merged[merged.length - 1];
      if (last && mark.start <= last.end) last.end = Math.max(last.end, mark.end);
      else merged.push({ start: mark.start, end: mark.end });
    }
    return merged;
  })();
  const edges = new Set<number>([0, text.length]);
  for (const span of accepted) { edges.add(span.start); edges.add(span.end); }
  for (const mark of okMarks) { edges.add(mark.start); edges.add(mark.end); }
  const points = [...edges].sort((a, b) => a - b);
  const segments: CodeSegment[] = [];
  let si = 0;
  let mi = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;
    while (si < accepted.length && accepted[si].end <= start) si += 1;
    while (mi < okMarks.length && okMarks[mi].end <= start) mi += 1;
    const kind = si < accepted.length && accepted[si].start <= start && start < accepted[si].end ? accepted[si].kind : undefined;
    const changed = mi < okMarks.length && okMarks[mi].start <= start && start < okMarks[mi].end;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && last.changed === changed) { last.text += text.slice(start, end); continue; }
    segments.push({ text: text.slice(start, end), kind, changed });
  }
  return segments;
}

// Bounded completed-result cache keyed by language+source — an LRU, so a
// streaming editor does not re-tokenize settled text.
const resultCache = new Map<string, { spans: readonly SyntaxSpan[]; chars: number }>();
let resultCacheChars = 0;

const cacheRead = (key: string): readonly SyntaxSpan[] | undefined => {
  const hit = resultCache.get(key);
  if (!hit) return undefined;
  resultCache.delete(key);
  resultCache.set(key, hit);
  return hit.spans;
};

const cacheWrite = (key: string, spans: readonly SyntaxSpan[], chars: number) => {
  const prior = resultCache.get(key);
  if (prior) resultCacheChars -= prior.chars;
  resultCache.delete(key);
  resultCache.set(key, { spans, chars });
  resultCacheChars += chars;
  while (resultCache.size > CACHE_ENTRIES || resultCacheChars > CACHE_CHARS) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCacheChars -= resultCache.get(oldest)?.chars ?? 0;
    resultCache.delete(oldest);
  }
};

const closures = (root: string): string[] => {
  const wanted = new Set<string>([root]);
  const queue = [root];
  while (queue.length) {
    const name = queue.pop() ?? "";
    for (const dep of own(DEPS, name) ?? []) if (!wanted.has(dep)) { wanted.add(dep); queue.push(dep); }
  }
  return [...wanted];
};

const highlightWith = (engine: HLJSApi, language: string) => (source: string): readonly SyntaxSpan[] => {
  // Pair-serialized key: 'c'+'ss…' and 'css'+'…' can never collide.
  const key = JSON.stringify([language, source]);
  const cached = cacheRead(key);
  if (cached) return cached;
  if (!syntaxSourceAllowed(source)) return [];
  let spans: readonly SyntaxSpan[] = [];
  try {
    const result = engine.highlight(source, { language, ignoreIllegals: true });
    if (!result.errorRaised && result.value.length <= HTML_CAP) {
      const parsed = parseSyntaxHtml(source, result.value);
      if (parsed.length <= SPAN_CAP) spans = parsed;
    }
  } catch {
    // Any engine failure renders plain — never logs source text.
  }
  cacheWrite(key, spans, source.length);
  return spans;
};

const loaders = new Map<string, Promise<(source: string) => readonly SyntaxSpan[]>>();
const PLAIN: Promise<(source: string) => readonly SyntaxSpan[]> = Promise.resolve(() => []);

/**
 * Lazy per-root highlighter. Each root grammar loads on an isolated core
 * instance pre-registered with its finite dependency closure, so loading one
 * surface cannot change the tokens another already produced. Unknown names
 * resolve to a shared plain stub — no core import, no cache growth.
 */
export function loadSyntaxHighlighter(language: string): Promise<(source: string) => readonly SyntaxSpan[]> {
  if (own(GRAMMARS, language) === undefined) return PLAIN;
  const existing = loaders.get(language);
  if (existing) return existing;
  const wanted = closures(language);
  const loader = (async () => {
    const [{ default: core }, ...modules] = await Promise.all([
      import("highlight.js/lib/core"),
      ...wanted.map((name) => own(GRAMMARS, name)?.() ?? Promise.reject(new Error(`missing grammar ${name}`))),
    ]);
    const engine = core.newInstance();
    wanted.forEach((name, index) => engine.registerLanguage(name, modules[index].default));
    return highlightWith(engine, language);
  })();
  loaders.set(language, loader);
  return loader;
}
