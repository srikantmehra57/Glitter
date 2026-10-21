import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnIsolated, terminateTree } from "../isolation.js";
import type { Extension } from "./registry.js";
import type { ToolSchema } from "./wire.js";

/**
 * The harness's tools. Every path is resolved against the workspace root and
 * must stay inside it after symlinks are followed; the shell runs under the
 * same OS write sandbox and minimal environment as third-party agents, so it
 * never sees provider keys and cannot write outside the workspace and temp.
 */

export type ToolKind = "read" | "edit" | "shell" | "plan";
export type OffsetUnit = "line" | "match" | "file";

/** The truth a tool produced. Frozen by `runTool` before anyone renders it. */
export type ToolValue =
  | { kind: "read"; path: string; lines: string; offset: number; nextOffset?: number }
  | { kind: "list"; path: string; files: string[]; nextOffset?: number }
  | { kind: "grep"; path: string; pattern: string; matches: string[]; nextOffset?: number }
  | { kind: "diff"; path: string; oldText: string; newText: string; created?: boolean; replacements?: number }
  | { kind: "terminal"; command: string; stdout: string; exitCode: number; note?: string }
  | { kind: "plan"; plan: Array<{ content: string; status: string }> }
  | { kind: "error"; message: string };

/** Replayable card state. Pure: no I/O, no clock, no session. */
export type PresentationMeta = {
  kind: ToolValue["kind"];
  path?: string;
  oldText?: string;
  newText?: string;
  command?: string;
  exitCode?: number;
  truncated?: boolean;
  artifactPath?: string;
};

export type ContinuationHint = { tool: string; preserveArgs: Record<string, unknown>; instruction: string };

/** How to ask for the next slice. Present only when the result was cut short. */
export type Continuation = {
  truncated: true;
  hasMore: true;
  strategy: "prefix_lines" | "head_tail_lines";
  nextOffset: number;
  offsetUnit: OffsetUnit;
  originalBytes: number;
  returnedBytes: number;
  maxBytes: number;
  continuationHint: ContinuationHint;
};

/**
 * Three channels. `output` is the only text the model reads. `value` is the
 * typed result. `presentation` is what a card can redraw without touching the disk.
 * `display` is the user's view when it must differ from the model's receipt.
 */
export type ToolOutcome = {
  output: string;
  value: ToolValue;
  presentation: PresentationMeta;
  display?: string;
  isError?: boolean;
  exitCode?: number;
  path?: string;
  command?: string;
  plan?: Array<{ content: string; status: string }>;
  continuation?: Continuation;
};

const READ_LIMIT_LINES = 2000;
const READ_BUDGET = 24 * 1024;
const OUTPUT_LIMIT = 30_000;
const LIST_LIMIT = 500;
const GREP_LIMIT = 200;
const GREP_BUDGET = 16 * 1024;
const GREP_FILE_BYTES = 1024 * 1024;
const BASH_BUDGET = 24 * 1024;
const SHELL_CAPTURE_MAX = 8 * 1024 * 1024;
const SHELL_DEFAULT_MS = 120_000;
const SHELL_MAX_MS = 600_000;
const ARTIFACT_DIR = join(".muse", "tool-output");
/** Directories a listing or search never walks into. */
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "target", ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage", ".muse"]);

/** What a handler produces before it is rendered, packed and possibly saved to an artifact. */
export type ToolProduced = { value: ToolValue; continuation?: Continuation };

/**
 * One tool, as an extension contributes it. The host reads only these fields:
 * it never branches on a tool's name.
 */
export type ToolDefinition = {
  schema: ToolSchema;
  /** The permission class the host's gate reads. */
  kind: ToolKind;
  /** Only an exact `true` may overlap another call. */
  concurrencySafe?: boolean;
  /** Why the frozen arguments are refused before any approval card, or undefined. May throw a ToolError. */
  validate?: (root: string, input: Readonly<Record<string, unknown>>) => Promise<string | undefined> | string | undefined;
  run: (root: string, input: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<ToolProduced> | ToolProduced;
};

export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  {
    schema: {
      name: "read_file",
      description: "Read a text file in the workspace. Returns numbered lines. Use offset and limit (in lines) for large files. A truncated result names the offset to pass next.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Path relative to the workspace root." }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["path"] },
    },
    kind: "read",
    concurrencySafe: true,
    validate: (root, input) => {
      if (!str(input.path).trim()) return "A path is required.";
      confine(root, str(input.path));
      return undefined;
    },
    run: (root, input) => readTool(root, input),
  },
  {
    schema: {
      name: "list_files",
      description: "List files under a directory of the workspace, optionally filtered by a glob such as **/*.ts. Skips .git, node_modules and build output.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Directory relative to the workspace root. Defaults to the root." }, pattern: { type: "string", description: "Glob relative to that directory." }, next_offset: { type: "integer", minimum: 0, description: "File index from a previous truncated listing. Pass it to read the next slice." } } },
    },
    kind: "read",
    concurrencySafe: true,
    validate: (root, input) => {
      if (str(input.path).trim()) confine(root, str(input.path));
      return undefined;
    },
    run: (root, input) => listTool(root, input),
  },
  {
    schema: {
      name: "grep",
      description: "Search file contents with a regular expression. Returns path:line: text for each match. A truncated result names next_offset; pass that same next_offset to read the next matches.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Directory or file to search. Defaults to the root." }, include: { type: "string", description: "Glob of files to search, such as *.py." }, ignore_case: { type: "boolean" }, next_offset: { type: "integer", minimum: 0, description: "Match index from a previous truncated search. Pass it unchanged to read the next slice." } }, required: ["pattern"] },
    },
    kind: "read",
    concurrencySafe: true,
    validate: (root, input) => {
      if (!str(input.pattern).trim()) return "A pattern is required.";
      if (str(input.path).trim()) confine(root, str(input.path));
      return undefined;
    },
    run: (root, input) => grepTool(root, input),
  },
  {
    schema: {
      name: "write_file",
      description: "Create or overwrite a file in the workspace with the given content. Prefer edit_file for changes to an existing file.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
    kind: "edit",
    validate: (root, input) => {
      if (!str(input.path).trim()) return "A path is required.";
      confine(root, str(input.path));
      return undefined;
    },
    run: (root, input) => writeTool(root, input),
  },
  {
    schema: {
      name: "edit_file",
      description: "Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Read the file first.",
      parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] },
    },
    kind: "edit",
    validate: (root, input) => editProblem(root, input),
    run: (root, input) => editTool(root, input),
  },
  {
    schema: {
      name: "bash",
      description: "Run a shell command in the workspace root. Writes outside the workspace and temp are blocked. Use for builds, tests, git and other CLI work.",
      parameters: { type: "object", properties: { command: { type: "string" }, timeout_ms: { type: "integer", minimum: 1000, maximum: SHELL_MAX_MS } }, required: ["command"] },
    },
    kind: "shell",
    validate: (_root, input) => (str(input.command).trim() ? undefined : "A command is required."),
    run: (root, input, signal) => shellTool(root, input, signal),
  },
  {
    schema: {
      name: "todo_write",
      description: "Record the plan for this task as a checklist the user can see. Send the whole list each time; status is pending, in_progress or completed.",
      parameters: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["content", "status"] } } }, required: ["todos"] },
    },
    kind: "plan",
    run: (_root, input) => planTool(input),
  },
];

/** The built-in tools and the system-prompt guidance that names them. */
export const BUILTIN_EXTENSION: Extension = {
  id: "builtin",
  tools: BUILTIN_TOOLS,
  prompt: [{
    placement: "stable",
    text: "Work methodically: look before you change anything (list_files, grep, read_file), keep edits minimal and in the project's existing style, and verify with the project's own build or tests (bash) when that is practical. Use edit_file for changes to existing files and write_file only for new files or full rewrites. For a task with several steps, keep a checklist with todo_write.",
  }],
};

class ToolError extends Error {}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const int = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined);

/**
 * Resolve a model-supplied path inside the workspace. The nearest existing
 * ancestor is canonicalized, so a symlink inside the workspace that points out
 * of it cannot be used to read or write beyond the root.
 */
export function confine(root: string, raw: string): string {
  const canonicalRoot = realpathSync(root);
  const requested = raw.trim() || ".";
  const target = isAbsolute(requested) ? resolve(requested) : resolve(canonicalRoot, requested);
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const real = join(realpathSync(existing), relative(existing, target));
  const rel = relative(canonicalRoot, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ToolError(`${raw} is outside the workspace.`);
  return real;
}

const display = (root: string, path: string) => relative(realpathSync(root), path) || ".";

/** A glob (`**`, `*`, `?`) as an anchored regular expression over `/`-separated paths. */
export function globRegex(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      source += glob[index + 2] === "/" ? "(?:.*/)?" : ".*";
      index += glob[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A bare name (no slash) matches at any depth, like most tools' include globs.
  return new RegExp(glob.includes("/") ? `^${source}$` : `(?:^|/)${source}$`);
}

/** Visit files in name order. A visitor that returns false stops the whole walk, not just its directory. Resolves false when stopped. */
async function walk(dir: string, visit: (path: string) => boolean | Promise<boolean>): Promise<boolean> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return true; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (!(await walk(path, visit))) return false;
    } else if (entry.isFile()) {
      if ((await visit(path)) === false) return false;
    }
  }
  return true;
}

/** Drop a dangling UTF-16 surrogate so a cut never splits a character. */
function safeCut(text: string): string {
  if (!text.length) return text;
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, -1) : text;
}

/** Whole lines from the start, within a character budget. */
function prefixLines(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const cut = text.lastIndexOf("\n", budget);
  return safeCut(cut > 0 ? text.slice(0, cut) : text.slice(0, budget));
}

/** Whole lines from the end, within a character budget. */
function suffixLines(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const start = text.length - budget;
  const cut = text.indexOf("\n", start);
  const slice = cut >= 0 && cut < text.length - 1 ? text.slice(cut + 1) : text.slice(start);
  const lead = slice.charCodeAt(0);
  return lead >= 0xdc00 && lead <= 0xdfff ? slice.slice(1) : slice;
}

/** 45% head and 55% tail, on line boundaries. The omitted middle is not evidence. */
function headTail(text: string, budget: number): { text: string; omitted: number } {
  if (text.length <= budget) return { text, omitted: 0 };
  const head = prefixLines(text, Math.floor(budget * 0.45));
  const tail = suffixLines(text, Math.max(1, budget - head.length - 2));
  const omitted = Math.max(0, text.length - head.length - tail.length);
  return { text: `${head}\n…\n${tail}`, omitted };
}

function definedArgs(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (input[key] !== undefined && input[key] !== "") out[key] = input[key];
  return out;
}

/** The model's prose. Continuation instructions are part of the prose, not a side channel. */
export function render(value: ToolValue, continuation?: Continuation): string {
  let text: string;
  switch (value.kind) {
    case "read":
      text = value.lines;
      break;
    case "list":
      text = value.files.length ? value.files.join("\n") : "No files match.";
      break;
    case "grep":
      text = value.matches.length ? value.matches.join("\n") : "No matches.";
      break;
    case "diff":
      if (value.replacements != null) text = `Edited ${value.path}${value.replacements > 1 ? ` (${value.replacements} replacements)` : ""}.`;
      else text = `${value.created ? "Created" : "Overwrote"} ${value.path} (${value.newText.split("\n").length} lines).`;
      break;
    case "terminal":
      text = value.stdout.trimEnd() || "(no output)";
      if (text.length > BASH_BUDGET) {
        const fitted = headTail(text, BASH_BUDGET);
        text = `${fitted.text}\n… output truncated (${fitted.omitted} more characters)`;
      }
      if (value.note) text += value.note;
      break;
    case "plan":
      text = `Plan updated (${value.plan.filter((todo) => todo.status === "completed").length} of ${value.plan.length} done).`;
      break;
    case "error":
      text = value.message;
      break;
  }
  return continuation ? `${text}\n${continuation.continuationHint.instruction}` : text;
}

/** Card state derived only from the value. Safe to run again on replay. */
export function presentationMeta(value: ToolValue): PresentationMeta {
  switch (value.kind) {
    case "read":
    case "list":
      return { kind: value.kind, path: value.path, ...(value.nextOffset != null ? { truncated: true } : {}) };
    case "grep":
      return { kind: "grep", path: value.path, ...(value.nextOffset != null ? { truncated: true } : {}) };
    case "diff":
      return { kind: "diff", path: value.path, oldText: value.oldText, newText: value.newText };
    case "terminal":
      return { kind: "terminal", command: value.command, exitCode: value.exitCode };
    case "plan":
      return { kind: "plan" };
    case "error":
      return { kind: "error" };
  }
}

function continuationOf(partial: Omit<Continuation, "truncated" | "hasMore">): Continuation {
  return { truncated: true, hasMore: true, ...partial };
}

/** Deep key-sort, so `{a:1,b:2}` and `{b:2,a:1}` are the same call. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/**
 * Observe-and-enrich. The second identical call gets a short note; later
 * thresholds name the tool, the run length and the canonical arguments.
 * The label keeps the note from being read as something the user typed.
 */
export function repeatReminder(name: string, count: number, canonicalArgs: string): string | undefined {
  if (count !== 2 && count !== 5 && count !== 8) return undefined;
  const args = canonicalArgs.length > 500 ? `${canonicalArgs.slice(0, 500)}…` : canonicalArgs;
  if (count === 2) return `[harness-repeat] Note from the harness, not the user: ${name} was just called again with the same arguments. Use the result you have, or change the arguments.`;
  return `[harness-repeat] Note from the harness, not the user: ${name} has run ${count} times in a row with the same arguments. Canonical arguments: ${args}. Stop repeating it. Change the arguments or answer from the results you already have.`;
}

export type ExecutionMode = "concurrent" | "exclusive";

/** Only an exact `true` may overlap another call. Anything else, an unknown tool included, runs alone. */
export function executionMode(definition: ToolDefinition | undefined): ExecutionMode {
  return definition?.concurrencySafe === true ? "concurrent" : "exclusive";
}

/**
 * Bounded rolling pool. Concurrent-safe calls overlap up to `limit`. A call
 * that is not exactly safe waits until the pool is idle, then runs alone.
 * Slots are filled in model order and the returned array is in that same order.
 * After `signal` aborts, calls that have not started receive `onAborted`.
 */
export async function scheduleToolCalls<T>(options: {
  safe: readonly boolean[];
  run: (index: number) => Promise<T>;
  onAborted: (index: number) => T;
  signal?: AbortSignal;
  limit?: number;
}): Promise<T[]> {
  const limit = Math.max(1, options.limit ?? 10);
  const results = new Array<T>(options.safe.length);
  const pending = new Map<number, Promise<void>>();
  let cursor = 0;
  const launch = (index: number) => {
    const tracked = options.run(index).then((value) => { results[index] = value; }).finally(() => pending.delete(index));
    pending.set(index, tracked);
  };
  while (cursor < options.safe.length) {
    if (options.signal?.aborted) break;
    const index = cursor;
    if (options.safe[index] !== true) {
      while (pending.size) await Promise.all([...pending.values()]);
      if (options.signal?.aborted) break;
      cursor += 1;
      launch(index);
      await pending.get(index);
      continue;
    }
    while (pending.size >= limit) await Promise.race(pending.values());
    if (options.signal?.aborted) break;
    cursor += 1;
    launch(index);
  }
  if (options.signal?.aborted) {
    for (let index = cursor; index < options.safe.length; index += 1) results[index] = options.onAborted(index);
  }
  while (pending.size) await Promise.all([...pending.values()]);
  return results;
}

/** One path segment. `[A-Za-z0-9._-]` stay; everything else is `~XXXX`, so a slash cannot survive. */
export function encodeSegment(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const char = text[index];
    if (code < 128 && /[A-Za-z0-9._-]/.test(char)) out += char;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

function artifactName(label: string, body: string): string {
  const hash = createHash("sha256").update(label).update("\0").update(body).digest("hex").slice(0, 20);
  let stem = encodeSegment(label).slice(0, 48);
  if (!stem || stem === "." || stem === "..") stem = "out";
  return `${stem}-${hash}.txt`;
}

async function spill(root: string, source: string, body: string): Promise<string | undefined> {
  try {
    const dir = confine(root, ARTIFACT_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dirname(dir), 0o700);
    await chmod(dir, 0o700);
    // Saved output is scratch for the model, not a change to the project: keep it out of git status and the review.
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) await writeFile(ignore, "*\n", { encoding: "utf8", mode: 0o600 });
    const name = artifactName(source, body);
    if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") return undefined;
    const path = join(dir, name);
    const rel = relative(dir, path);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
    return display(root, path).split(sep).join("/");
  } catch {
    return undefined;
  }
}

function sourceLabel(input: Record<string, unknown>): string {
  if (typeof input.command === "string" && input.command.trim()) return `command=${input.command.slice(0, 180)}`;
  if (typeof input.path === "string" && input.path.trim()) return `path=${input.path}`;
  if (typeof input.pattern === "string") return `pattern=${input.pattern}`;
  return "input";
}

function receipt(tool: string, source: string, artifact: string): string {
  return [
    "[Tool output externalized",
    `Tool: ${tool}`,
    `Source: ${source}`,
    `Artifact: ${artifact}`,
    "Recover the needed facts from this artifact now, before answering. Search this artifact first with bounded rg/grep when available, then read the relevant ranges with read_file(path, offset, limit).",
    "Do not treat this receipt as evidence.]",
  ].join("\n");
}

/** read_file is how saved output is read back, so it pages instead of saving. */
function spillBody(value: ToolValue): string | undefined {
  if (value.kind === "terminal") return value.stdout;
  if (value.kind === "grep") return value.matches.join("\n");
  if (value.kind === "list") return value.files.join("\n");
  return undefined;
}

async function readTool(root: string, input: Record<string, unknown>): Promise<{ value: ToolValue; continuation?: Continuation }> {
  const path = confine(root, str(input.path));
  const info = await stat(path).catch(() => null);
  if (!info) throw new ToolError(`${str(input.path)} does not exist.`);
  if (info.isDirectory()) throw new ToolError(`${str(input.path)} is a directory. Use list_files.`);
  const buffer = await readFile(path);
  if (buffer.subarray(0, 8000).includes(0)) throw new ToolError(`${str(input.path)} is a binary file.`);
  const lines = buffer.toString("utf8").split("\n");
  const offset = Math.max(1, int(input.offset) ?? 1);
  const limit = Math.min(READ_LIMIT_LINES, int(input.limit) ?? READ_LIMIT_LINES);
  const shown: string[] = [];
  let bytes = 0;
  for (let index = offset - 1; index < lines.length && shown.length < limit; index += 1) {
    let row = `${String(index + 1).padStart(5)}\t${lines[index]}`;
    // One line past the budget (minified code, a saved log) is cut here. Saving it elsewhere would only hand back a file read_file cannot show either.
    if (row.length > READ_BUDGET) row = `${safeCut(row.slice(0, READ_BUDGET))}… [line ${index + 1} cut: ${lines[index].length} characters in all. Search it with grep, or print a range with bash, such as cut -c.]`;
    if (shown.length > 0 && bytes + row.length + 1 > READ_BUDGET) break;
    shown.push(row);
    bytes += row.length + 1;
    if (bytes >= READ_BUDGET) break;
  }
  const next = offset + shown.length;
  const more = next <= lines.length;
  const label = display(root, path);
  const value: ToolValue = { kind: "read", path: label, lines: shown.join("\n"), offset, ...(more ? { nextOffset: next } : {}) };
  const continuation = more ? continuationOf({
    strategy: "prefix_lines",
    nextOffset: next,
    offsetUnit: "line",
    originalBytes: buffer.length,
    returnedBytes: bytes,
    maxBytes: READ_BUDGET,
    continuationHint: {
      tool: "read_file",
      preserveArgs: { ...definedArgs(input, ["path", "limit"]), offset: next },
      instruction: `… ${lines.length - next + 1} more lines; re-run read_file with offset ${next}.`,
    },
  }) : undefined;
  return { value, continuation };
}

async function listTool(root: string, input: Record<string, unknown>): Promise<{ value: ToolValue; continuation?: Continuation }> {
  const dir = confine(root, str(input.path));
  const pattern = str(input.pattern);
  const matcher = pattern ? globRegex(pattern) : null;
  const skip = Math.max(0, int(input.next_offset) ?? 0);
  const found: string[] = [];
  let seen = 0;
  let truncated = false;
  await walk(dir, (path) => {
    const rel = relative(dir, path).split(sep).join("/");
    if (matcher && !matcher.test(rel)) return true;
    seen += 1;
    if (seen <= skip) return true;
    if (found.length >= LIST_LIMIT) { truncated = true; return false; }
    found.push(display(root, path).split(sep).join("/"));
    return true;
  });
  const label = display(root, dir);
  const nextOffset = skip + found.length;
  const value: ToolValue = { kind: "list", path: label, files: found, ...(truncated ? { nextOffset } : {}) };
  const body = found.join("\n");
  const continuation = truncated ? continuationOf({
    strategy: "prefix_lines",
    nextOffset,
    offsetUnit: "file",
    originalBytes: body.length,
    returnedBytes: body.length,
    maxBytes: LIST_LIMIT,
    continuationHint: {
      tool: "list_files",
      preserveArgs: { ...definedArgs(input, ["path", "pattern"]), next_offset: nextOffset },
      instruction: `… more files remain; re-run list_files with next_offset ${nextOffset}.`,
    },
  }) : undefined;
  return { value, continuation };
}

async function grepTool(root: string, input: Record<string, unknown>): Promise<{ value: ToolValue; continuation?: Continuation }> {
  let regex: RegExp;
  try { regex = new RegExp(str(input.pattern), input.ignore_case === true ? "i" : ""); }
  catch (error) { throw new ToolError(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`); }
  const base = confine(root, str(input.path));
  const include = str(input.include) ? globRegex(str(input.include)) : null;
  const skip = Math.max(0, int(input.next_offset) ?? 0);
  const hits: string[] = [];
  let seen = 0;
  let bytes = 0;
  let truncated = false;
  const take = (row: string) => {
    seen += 1;
    if (seen <= skip) return true;
    if (hits.length >= GREP_LIMIT || (hits.length > 0 && bytes + row.length + 1 > GREP_BUDGET)) { truncated = true; return false; }
    hits.push(row);
    bytes += row.length + 1;
    return true;
  };
  const searchFile = async (path: string) => {
    if (include && !include.test(path.split(sep).join("/"))) return true;
    const info = await stat(path).catch(() => null);
    if (!info || info.size > GREP_FILE_BYTES) return true;
    const buffer = await readFile(path).catch(() => null);
    if (!buffer || buffer.subarray(0, 8000).includes(0)) return true;
    const lines = buffer.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue;
      if (!take(`${display(root, path).split(sep).join("/")}:${index + 1}: ${lines[index].slice(0, 300)}`)) return false;
    }
    return true;
  };
  const info = await stat(base).catch(() => null);
  if (!info) throw new ToolError(`${str(input.path)} does not exist.`);
  if (info.isFile()) await searchFile(base);
  else await walk(base, searchFile);
  const label = display(root, base);
  const nextOffset = skip + hits.length;
  const value: ToolValue = { kind: "grep", path: label, pattern: str(input.pattern), matches: hits, ...(truncated ? { nextOffset } : {}) };
  const continuation = truncated ? continuationOf({
    strategy: "prefix_lines",
    nextOffset,
    offsetUnit: "match",
    originalBytes: bytes,
    returnedBytes: bytes,
    maxBytes: GREP_BUDGET,
    continuationHint: {
      tool: "grep",
      preserveArgs: { ...definedArgs(input, ["pattern", "path", "include", "ignore_case"]), next_offset: nextOffset },
      instruction: `… stopped after ${hits.length} matches in this slice; re-run grep with next_offset ${nextOffset}.`,
    },
  }) : undefined;
  return { value, continuation };
}

async function writeTool(root: string, input: Record<string, unknown>): Promise<{ value: ToolValue }> {
  const path = confine(root, str(input.path));
  if (!str(input.path).trim()) throw new ToolError("A path is required.");
  const existed = existsSync(path);
  const oldText = existed ? await readFile(path, "utf8").catch(() => "") : "";
  const newText = str(input.content);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, newText, "utf8");
  return { value: { kind: "diff", path: display(root, path), oldText, newText, created: !existed } };
}

/** Why these exact strings cannot be applied to the file's current text. */
function editProblemText(pathLabel: string, before: string | null, input: Record<string, unknown>): string | undefined {
  if (before == null) return `${pathLabel} does not exist. Use write_file to create it.`;
  const oldText = str(input.old_string);
  if (!oldText) return "old_string is empty. Use write_file to create or replace a whole file.";
  const count = before.split(oldText).length - 1;
  if (count === 0) return `old_string was not found in ${pathLabel}. Read the file and copy the text exactly, including whitespace.`;
  if (count > 1 && input.replace_all !== true) return `old_string matches ${count} places in ${pathLabel}. Add surrounding lines to make it unique, or set replace_all.`;
  return undefined;
}

/** Why an edit cannot be applied, or undefined when the frozen strings are safe to run. Reads the file; does not write it. */
export async function editProblem(root: string, input: Record<string, unknown>): Promise<string | undefined> {
  const path = confine(root, str(input.path));
  const before = await readFile(path, "utf8").catch(() => null);
  return editProblemText(str(input.path), before, input);
}

/**
 * Parse a tool's arguments once, before anyone is asked to approve them.
 * The returned object is what the approval card shows and what the handler runs.
 * An error means the call is refused without a card.
 */
export async function prepareTool(definition: ToolDefinition, root: string, input: Record<string, unknown>): Promise<{ input: Record<string, unknown>; error?: string }> {
  if (typeof input._unparsed === "string") {
    return { input: Object.freeze({ ...input }), error: "The tool arguments were cut off and are not valid JSON. Re-issue the call with complete arguments." };
  }
  const frozen = Object.freeze({ ...input });
  try {
    const error = await definition.validate?.(root, frozen);
    if (error) return { input: frozen, error };
  } catch (error) {
    return { input: frozen, error: error instanceof Error ? error.message : String(error) };
  }
  return { input: frozen };
}

async function editTool(root: string, input: Record<string, unknown>): Promise<{ value: ToolValue }> {
  const path = confine(root, str(input.path));
  const before = await readFile(path, "utf8").catch(() => null);
  const problem = editProblemText(str(input.path), before, input);
  if (problem) throw new ToolError(problem);
  const oldText = str(input.old_string);
  const newText = str(input.new_string);
  const count = (before ?? "").split(oldText).length - 1;
  const after = input.replace_all === true ? (before ?? "").split(oldText).join(newText) : (before ?? "").replace(oldText, () => newText);
  await writeFile(path, after, "utf8");
  return { value: { kind: "diff", path: display(root, path), oldText: before ?? "", newText: after, replacements: count } };
}

async function shellTool(root: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ value: ToolValue }> {
  const command = str(input.command);
  if (!command.trim()) throw new ToolError("A command is required.");
  const timeout = Math.min(SHELL_MAX_MS, Math.max(1000, int(input.timeout_ms) ?? SHELL_DEFAULT_MS));
  const { child } = spawnIsolated("/bin/sh", ["-c", command], { agentId: "harness", workspace: realpathSync(root), cwd: realpathSync(root) });
  child.stdin.end();
  let stdout = "";
  let capped = false;
  const take = (chunk: Buffer) => {
    if (stdout.length >= SHELL_CAPTURE_MAX) { capped = true; return; }
    stdout += chunk.toString("utf8");
    if (stdout.length > SHELL_CAPTURE_MAX) { stdout = stdout.slice(0, SHELL_CAPTURE_MAX); capped = true; }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void terminateTree(child); }, timeout);
  const abort = () => void terminateTree(child);
  signal?.addEventListener("abort", abort, { once: true });
  const exitCode = await new Promise<number>((done) => {
    child.on("close", (code) => done(code ?? 1));
    child.on("error", () => done(127));
  });
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  const note = timedOut ? `\n… stopped after ${Math.round(timeout / 1000)}s.` : signal?.aborted ? "\n… stopped by the user." : capped ? "\n… capture stopped; the command kept writing." : "";
  return { value: { kind: "terminal", command, stdout, exitCode, ...(note ? { note } : {}) } };
}

function planTool(input: Record<string, unknown>): { value: ToolValue } {
  const todos = Array.isArray(input.todos) ? input.todos as Array<Record<string, unknown>> : [];
  const plan = todos.map((todo) => ({ content: str(todo.content), status: ["pending", "in_progress", "completed"].includes(str(todo.status)) ? str(todo.status) : "pending" })).filter((todo) => todo.content);
  return { value: { kind: "plan", plan } };
}

function failure(message: string): ToolOutcome {
  const value: ToolValue = { kind: "error", message };
  return { output: message, value, presentation: presentationMeta(value), isError: true };
}

function pack(produced: { value: ToolValue; continuation?: Continuation }): ToolOutcome {
  const { value, continuation } = produced;
  const outcome: ToolOutcome = { output: render(value, continuation), value, presentation: presentationMeta(value), ...(continuation ? { continuation } : {}) };
  if (value.kind === "terminal") {
    outcome.exitCode = value.exitCode;
    outcome.command = value.command;
    if (value.exitCode !== 0) outcome.isError = true;
  } else if (value.kind === "plan") outcome.plan = value.plan;
  else if (value.kind !== "error") outcome.path = value.path;
  return outcome;
}

/**
 * When the turn can read files back, a result past the inline budget is stored
 * in the workspace and the model receives a receipt instead of the bytes.
 * A failed write keeps the inline result.
 */
async function externalize(root: string, name: string, input: Record<string, unknown>, outcome: ToolOutcome, canRead: boolean): Promise<ToolOutcome> {
  const body = spillBody(outcome.value);
  if (!canRead || body == null || body.length <= OUTPUT_LIMIT) return outcome;
  const artifact = await spill(root, sourceLabel(input), body);
  if (!artifact) return outcome;
  const preview = outcome.value.kind === "terminal" ? headTail(body, BASH_BUDGET).text : prefixLines(body, 2_000);
  const note = outcome.value.kind === "terminal" && outcome.value.note ? outcome.value.note : "";
  // The artifact holds this slice only. The next slice still comes from the tool, so the receipt keeps the paging instruction.
  const more = outcome.continuation ? `\n${outcome.continuation.continuationHint.instruction}` : "";
  return {
    ...outcome,
    output: `${receipt(name, sourceLabel(input), artifact)}${note}${more}`,
    display: `${preview}\n\nFull output saved at ${artifact}`,
    presentation: { ...outcome.presentation, truncated: true, artifactPath: artifact },
  };
}

export type RunToolOptions = { canRead?: boolean };

/** Run one tool. Failures come back as error results the model can read and correct, never as exceptions. */
export async function executeTool(definition: ToolDefinition, root: string, input: Record<string, unknown>, signal?: AbortSignal, options?: RunToolOptions): Promise<ToolOutcome> {
  try {
    const produced = await definition.run(root, input, signal);
    if (produced.value.kind === "error") return failure(produced.value.message);
    return await externalize(root, definition.schema.name, input, pack(produced), options?.canRead === true);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** Run a built-in tool by name, outside any turn. */
export async function runTool(root: string, name: string, input: Record<string, unknown>, signal?: AbortSignal, options?: RunToolOptions): Promise<ToolOutcome> {
  const definition = BUILTIN_TOOLS.find((tool) => tool.schema.name === name);
  return definition ? executeTool(definition, root, input, signal, options) : failure(`Unknown tool: ${name}`);
}
