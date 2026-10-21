import type { GitReviewRequest, ReviewScope, Thread, Workspace } from "./types";

/** A stable identity masks results from another workspace, thread, scope or cut. */
export function reviewTarget(state: { reviewScope: ReviewScope; reviewBase: string; selectedWorkspaceId: string | null; selectedSessionId: string | null; workspaces: Workspace[]; threads: Thread[] }): { key: string; request?: GitReviewRequest; notice?: string } {
  const workspace = state.workspaces.find((item) => item.id === state.selectedWorkspaceId);
  const thread = state.threads.find((item) => item.sessionId === state.selectedSessionId && item.workspacePath === workspace?.path);
  const canonical = (id?: string): id is string => Boolean(id && id !== "history" && !id.startsWith("local:"));
  let turnId = canonical(thread?.lastTurnId) ? thread.lastTurnId : undefined;
  if (state.reviewScope === "lastTurn" && thread && (!turnId || turnId === thread.activeTurnId)) {
    const queued = new Set(thread.queuedTurns?.map((item) => item.turnId));
    turnId = undefined;
    for (let index = thread.items.length - 1; index >= 0; index -= 1) {
      const item = thread.items[index];
      if (canonical(item.turnId) && item.turnId !== thread.activeTurnId && !item.optimistic && !queued.has(item.turnId)) { turnId = item.turnId; break; }
    }
  }
  const snapshot = state.reviewScope === "lastTurn" && turnId ? thread?.snapshots?.[turnId] : undefined;
  const key = JSON.stringify([workspace?.id, workspace?.path, workspace?.grantId, state.selectedSessionId, state.reviewScope, state.reviewBase, state.reviewScope === "lastTurn" ? [turnId, snapshot?.snapshotId, snapshot?.state] : null]);
  if (!workspace) return { key, notice: "Open a workspace to review changes." };
  if (state.reviewScope === "branch") return state.reviewBase.trim() ? { key, request: { scope: "branch", base: state.reviewBase.trim() } } : { key, notice: "Choose a base branch or commit to review committed changes." };
  if (state.reviewScope === "lastTurn") {
    if (!thread) return { key, notice: "Choose a thread to review its last turn." };
    if (!snapshot) return { key, notice: "The last turn has no saved file state. Older turns cannot be reconstructed." };
    if (snapshot.state !== "ready" && snapshot.state !== "undone") return { key, notice: snapshot.reason ?? "The last turn’s saved file state is not ready." };
    return { key, request: { scope: "lastTurn", sessionId: thread.sessionId, snapshotId: snapshot.snapshotId } };
  }
  return { key, request: { scope: state.reviewScope } };
}

export type DiffLine = {
  type: "meta" | "hunk" | "add" | "del" | "ctx";
  /** Raw line text, sign prefix included — never rewritten. */
  text: string;
  /** 1-based number in the pre-change file, when inside a hunk. */
  oldLine?: number;
  /** 1-based number in the post-change file, when inside a hunk. */
  newLine?: number;
};

export type FileDiff = {
  path: string;
  header: string[];
  lines: DiffLine[];
  /** The exact raw patch text for this file — Copy/Export use it verbatim. */
  patch: string;
};

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07", b: "\x08", t: "\t", n: "\n", v: "\x0B", f: "\x0C", r: "\r", '"': '"', "\\": "\\",
};

/**
 * Reverse the quoting `core.quotePath` applies to unusual diff paths. Only
 * fully-formed escapes decode — a malformed or truncated sequence survives
 * literally instead of producing a NUL.
 */
export function unquoteDiffPath(raw: string): string {
  if (!raw.includes("\\")) return raw;
  const bytes: number[] = [];
  let out = "";
  const flush = () => {
    if (!bytes.length) return;
    out += bytes.some((byte) => byte >= 0x80) ? new TextDecoder().decode(new Uint8Array(bytes)) : String.fromCharCode(...bytes);
    bytes.length = 0;
  };
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "\\") { flush(); out += raw[index]; continue; }
    const char = raw[index + 1];
    if (char === undefined) { out += "\\"; break; }
    index += 1;
    if (char === "u") {
      const hex = raw.slice(index + 1, index + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        flush();
        out += String.fromCharCode(parseInt(hex, 16));
        index += 4;
      } else {
        flush();
        out += "\\u";
      }
      continue;
    }
    if (char >= "0" && char <= "7") {
      const octal = raw.slice(index, index + 3);
      if (/^[0-7]{3}$/.test(octal)) {
        bytes.push(parseInt(octal, 8));
        index += 2;
      } else {
        flush();
        out += `\\${char}`;
      }
      continue;
    }
    flush();
    out += SIMPLE_ESCAPES[char] ?? `\\${char}`;
  }
  flush();
  return out;
}

/**
 * The `b/` path of a `diff --git a/X b/Y` line, used as a fallback when the
 * `+++`/`rename to` headers are missing or truncated. The last ` b/` wins:
 * a bare `a/` side containing spaces (e.g. `a/dir b/name.txt b/dir b/name.txt`)
 * can contain the separator itself.
 */
function diffTargetPath(raw: string): string {
  const body = raw.slice("diff --git ".length);
  const quoted = body.match(/ "b\/((?:\\.|[^"\\])*)"$/);
  if (quoted) return unquoteDiffPath(quoted[1]);
  const at = body.lastIndexOf(" b/");
  return at >= 0 ? body.slice(at + 3) : body;
}

/** A path named by a `--- a/`/`+++ b/`/`rename to`/`copy to` header line. */
function headerPath(raw: string): { side: "old" | "new"; path: string } | null {
  let match = raw.match(/^[-+]{3} "([ab])\/((?:\\.|[^"\\])*)"$/);
  if (match) return { side: match[1] === "b" ? "new" : "old", path: unquoteDiffPath(match[2]) };
  match = raw.match(/^[-+]{3} ([ab])\/(.*)$/);
  if (match) return { side: match[1] === "b" ? "new" : "old", path: match[2] };
  match = raw.match(/^(?:rename|copy) to "((?:\\.|[^"\\])*)"$/);
  if (match) return { side: "new", path: unquoteDiffPath(match[1]) };
  match = raw.match(/^(?:rename|copy) to (.+)$/);
  if (match) return { side: "new", path: match[1] };
  return null;
}

const HEADER_PREFIX = /^(\+\+\+|---|index |new file|deleted file|similarity |dissimilarity |old mode|new mode|rename |copy |GIT binary|Binary )/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff into per-file entries. Each file's identity comes from
 * its `+++` header (the post-change name), falling back to `---` for
 * deletions, `rename to` for rename-only blocks, and finally the `diff --git`
 * line. `patch` keeps the raw text verbatim for copy/export; hunk headers
 * drive `oldLine`/`newLine` numbering, and metadata markers never increment.
 */
export function parseUnifiedDiff(diff: string, limit = 4000): { files: FileDiff[]; truncated: boolean } {
  if (!diff) return { files: [], truncated: false };
  const files: FileDiff[] = [];
  const patches: string[][] = [];
  let current: FileDiff | null = null;
  let inHunk = false;
  let hasNewPath = false;
  let oldLine = 0;
  let newLine = 0;
  let count = 0;
  let truncated = false;
  for (const raw of diff.split("\n")) {
    if (count >= limit) { truncated = true; break; }
    count += 1;
    if (raw.startsWith("diff --git ")) {
      // The newline that separated the previous file's last raw line from
      // this header belongs to that file's slice — record it so the patch
      // stays an exact raw cut even after blank separator lines.
      if (current) patches[patches.length - 1].push("");
      current = { path: diffTargetPath(raw), header: [raw], lines: [], patch: "" };
      files.push(current);
      patches.push([raw]);
      inHunk = false;
      hasNewPath = false;
      continue;
    }
    if (!current) {
      current = { path: "changes", header: [], lines: [], patch: "" };
      files.push(current);
      patches.push([]);
      inHunk = false;
      hasNewPath = false;
    }
    patches[patches.length - 1].push(raw);
    if (raw === "") continue;
    // File headers are only valid before the first hunk: inside a hunk a
    // `+++`/`---` line is code, not metadata, and must not redirect identity.
    if (!inHunk) {
      const named = headerPath(raw);
      if (named) {
        // The post-change name wins; the old name only fills deletions.
        if (named.side === "new" || !hasNewPath) current.path = named.path;
        if (named.side === "new") hasNewPath = true;
        current.header.push(raw);
        continue;
      }
      if (HEADER_PREFIX.test(raw)) {
        current.header.push(raw);
        continue;
      }
    }
    const hunk = raw.startsWith("@@") ? raw.match(HUNK_HEAD) : null;
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ type: "hunk", text: raw });
      continue;
    }
    if (raw.startsWith("\\")) {
      current.lines.push({ type: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      current.lines.push({ type: "add", text: raw, ...(inHunk ? { newLine: newLine++ } : {}) });
      continue;
    }
    if (raw.startsWith("-")) {
      current.lines.push({ type: "del", text: raw, ...(inHunk ? { oldLine: oldLine++ } : {}) });
      continue;
    }
    if (inHunk && raw.startsWith(" ")) {
      current.lines.push({ type: "ctx", text: raw, oldLine: oldLine++, newLine: newLine++ });
    } else {
      // Stray text inside a hunk (truncation, unexpected content) is metadata
      // and never consumes line numbers.
      current.lines.push({ type: "meta", text: raw });
    }
  }
  // The cap cut the diff mid-file: the last consumed raw line still had its
  // delimiter in the original, so the slice keeps it.
  if (truncated && current && patches[patches.length - 1].length) patches[patches.length - 1].push("");
  // Each file's patch is its raw slice verbatim — never reconstructed.
  files.forEach((file, index) => { file.patch = (patches[index] ?? []).join("\n"); });
  return { files, truncated };
}

/**
 * Remove the `hunk`-th `@@` block (0-based) of one file from a unified
 * diff. Preview-local discard; the native side re-derives from git.
 */
export function dropHunk(diff: string, path: string, hunk: number): string {
  const kept: string[] = [];
  let current: string | null = null;
  let hasNewPath = false;
  let inHunk = false;
  let index = -1;
  let dropping = false;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      current = diffTargetPath(raw);
      hasNewPath = false;
      inHunk = false;
      index = -1;
      dropping = false;
      kept.push(raw);
      continue;
    }
    // Track the same identity the parser derives, so quoted or renamed paths
    // drop the hunk of the file the user actually clicked. Inside a hunk a
    // `+++`/`---` line is code — never a header.
    if (!inHunk) {
      const named = headerPath(raw);
      if (named && (named.side === "new" || !hasNewPath)) current = named.path;
      if (named?.side === "new") hasNewPath = true;
    }
    if (raw.startsWith("@@")) {
      inHunk = true;
      if (current === path) {
        index += 1;
        dropping = index === hunk;
        if (!dropping) kept.push(raw);
        continue;
      }
    }
    if (!dropping) kept.push(raw);
  }
  return kept.join("\n");
}

/** Parse `git diff --numstat -z` output into added/removed keyed by the new path. */
export function parseNumstatZ(raw: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  const parts = raw.split("\0").filter((part) => part.length > 0);
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index];
    const tab = line.match(/^(\d+|-)\t(\d+|-)(?:\t(.*))?$/);
    if (!tab) continue;
    const added = tab[1] === "-" ? 0 : Number(tab[1]);
    const removed = tab[2] === "-" ? 0 : Number(tab[2]);
    let path = tab[3] ?? "";
    if (!path) {
      const from = parts[index + 1];
      const to = parts[index + 2];
      if (from != null && to != null) {
        path = to.includes("\t") ? to.split("\t").pop() ?? to : to;
        index += 2;
      }
    }
    if (path.includes(" => ")) path = path.split(" => ").pop() ?? path;
    counts.set(path.replace(/^"|"$/g, ""), { added, removed });
  }
  return counts;
}

/** A character range into a diff line's code text (the sign is stripped first). */
export type TextRange = { start: number; end: number };

/**
 * One display row in split view: a paired delete/add, a shared context line,
 * an unpaired remainder with an empty opposite cell, or a full-width meta row
 * (hunk header, `\ No newline`, out-of-hunk text).
 */
export type DiffRow = {
  left?: DiffLine;
  right?: DiffLine;
  leftChanges?: TextRange[];
  rightChanges?: TextRange[];
  meta?: DiffLine;
};

const WORD_TOKEN = /[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]+/gu;
/** Past these sizes the LCS falls back to plain prefix/suffix bounds. */
const WORD_TOKEN_CAP = 256;
const WORD_TEXT_CAP = 4096;

function tokenize(text: string): { text: string; start: number; end: number }[] {
  const tokens: { text: string; start: number; end: number }[] = [];
  WORD_TOKEN.lastIndex = 0;
  for (let match = WORD_TOKEN.exec(text); match; match = WORD_TOKEN.exec(text)) {
    tokens.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** Changed ranges when token-level diffing is skipped for very long input. */
function edgeChanges(before: string, after: string): { before: TextRange[]; after: TextRange[] } {
  // Compare by code point so two emoji that share a UTF-16 high surrogate
  // still diff whole — the ranges are converted back to UTF-16 offsets and
  // therefore can never bisect a surrogate pair.
  const a = [...before];
  const b = [...after];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1; }
  const utf16 = (chars: string[], point: number) => {
    let offset = 0;
    for (let i = 0; i < point; i += 1) offset += chars[i].length;
    return offset;
  };
  const beforeStart = utf16(a, start);
  const beforeEnd = utf16(a, endA);
  const afterStart = utf16(b, start);
  const afterEnd = utf16(b, endB);
  return {
    before: beforeStart < beforeEnd ? [{ start: beforeStart, end: beforeEnd }] : [],
    after: afterStart < afterEnd ? [{ start: afterStart, end: afterEnd }] : [],
  };
}

/** Ranges covered by a run of consecutive changed tokens, merged where adjacent. */
function mergeRanges(spans: { start: number; end: number }[]): TextRange[] {
  const ranges: TextRange[] = [];
  for (const span of spans) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === span.start) last.end = span.end;
    else ranges.push({ start: span.start, end: span.end });
  }
  return ranges;
}

/**
 * Word-level changes between a deleted and an added line: token LCS over
 * whitespace / letter+number+underscore runs / punctuation, capped so patho-
 * logical lines degrade to prefix/suffix bounds instead of quadratic work.
 * Equal lines mark nothing. Pure and deterministic; ranges index into the
 * argument strings (callers pass them with the sign already stripped).
 */
export function wordChanges(before: string, after: string): { before: TextRange[]; after: TextRange[] } {
  if (before === after) return { before: [], after: [] };
  if (before.length > WORD_TEXT_CAP || after.length > WORD_TEXT_CAP) return edgeChanges(before, after);
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > WORD_TOKEN_CAP || b.length > WORD_TOKEN_CAP) return edgeChanges(before, after);
  const stride = b.length + 1;
  // LCS table; 256² u32 cells is bounded, flat work.
  const cell = new Uint32Array((a.length + 1) * stride);
  for (let i = a.length; i-- > 0;) {
    for (let j = b.length; j-- > 0;) {
      cell[i * stride + j] = a[i].text === b[j].text
        ? cell[(i + 1) * stride + j + 1] + 1
        : Math.max(cell[(i + 1) * stride + j], cell[i * stride + j + 1]);
    }
  }
  const changedA: { start: number; end: number }[] = [];
  const changedB: { start: number; end: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].text === b[j].text) { i += 1; j += 1; continue; }
    if (cell[(i + 1) * stride + j] >= cell[i * stride + j + 1]) { changedA.push(a[i]); i += 1; }
    else { changedB.push(b[j]); j += 1; }
  }
  while (i < a.length) { changedA.push(a[i]); i += 1; }
  while (j < b.length) { changedB.push(b[j]); j += 1; }
  return { before: mergeRanges(changedA), after: mergeRanges(changedB) };
}

/**
 * Pair del/add runs inside each hunk for split view: paired lines share a row
 * (with word marks), unpaired lines get an empty opposite cell, context spans
 * both, and meta/hunk rows are full width. Input order and text are untouched.
 */
export function splitDiffLines(lines: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.type === "hunk" || line.type === "meta") { rows.push({ meta: line }); index += 1; continue; }
    if (line.type === "ctx") { rows.push({ left: line, right: line }); index += 1; continue; }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (index < lines.length && (lines[index].type === "del" || lines[index].type === "add")) {
      (lines[index].type === "del" ? dels : adds).push(lines[index]);
      index += 1;
    }
    const count = Math.max(dels.length, adds.length);
    for (let at = 0; at < count; at += 1) {
      const left = dels[at];
      const right = adds[at];
      const row: DiffRow = { ...(left ? { left } : {}), ...(right ? { right } : {}) };
      if (left && right) {
        const changed = wordChanges(left.text.slice(1), right.text.slice(1));
        if (changed.before.length) row.leftChanges = changed.before;
        if (changed.after.length) row.rightChanges = changed.after;
      }
      rows.push(row);
    }
  }
  return rows;
}
