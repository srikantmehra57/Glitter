import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { Worker } from "node:worker_threads";
import { IgnoreScope } from "./ignore.js";
import { credentialRoots, spawnIsolated, terminateTree } from "../isolation.js";
import { killShell, readShell, startShell } from "./shells.js";
import type { Subject } from "./permission/grants.js";
import type { UserInputIntent } from "../protocol.js";
import type { Asked, Question } from "./questions.js";
import { dangerGuard, gitControlGuard } from "./permission/guards.js";
import type { Extension } from "./registry.js";
import type { ImagePart, ToolSchema } from "./wire.js";

/**
 * The harness's tools. Every path is resolved against the workspace root and
 * must stay inside it after symlinks are followed; the shell runs under the
 * same OS write sandbox and minimal environment as third-party agents, so it
 * never sees provider keys and cannot write outside the workspace and temp.
 */

export type ToolKind = "read" | "edit" | "shell" | "plan" | "mcp" | "delegate" | "browser" | "web";
export type OffsetUnit = "line" | "match" | "file";

/** The truth a tool produced. Frozen by `runTool` before anyone renders it. */
export type ToolValue =
  | { kind: "read"; path: string; lines: string; offset: number; nextOffset?: number }
  | { kind: "list"; path: string; files: string[]; nextOffset?: number; note?: string }
  | { kind: "grep"; path: string; pattern: string; matches: string[]; nextOffset?: number; note?: string }
  | { kind: "diff"; path: string; oldText: string; newText: string; created?: boolean; replacements?: number }
  | { kind: "terminal"; command: string; stdout: string; exitCode: number; note?: string }
  /** A background shell: what it printed since the last read, and whether it still runs. */
  | { kind: "process"; shellId: string; command: string; output: string; running: boolean; exitCode?: number; missed?: number; started?: boolean; stopped?: boolean }
  | { kind: "plan"; plan: Array<{ content: string; status: string }> }
  /** Questions for the user: the call waits for their answer, which ends the turn. */
  | { kind: "question"; questions: Question[]; intent?: UserInputIntent }
  /** A tool on an external MCP server; the text is the server's own result. */
  | { kind: "mcp"; server: string; tool: string; text: string; isError?: boolean }
  /** A delegated child agent's final reply. */
  | { kind: "task"; childSessionId: string; summary: string; text: string; failed?: boolean }
  /** The shared browser's current page and a receipt for the requested action. */
  | { kind: "browser"; path: string; text: string }
  /** A fetched page or a search, as text the model reads. */
  | { kind: "web"; url: string; status: number; text: string }
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
  /** Set when the call asks the user: the host ends the turn and completes the call from the answer. */
  question?: Asked;
  continuation?: Continuation;
  /** Deferred tools this call makes callable for the rest of the turn, by advertised name. */
  activate?: readonly string[];
  /** Image evidence produced by a tool, sent to the model with its text result. */
  images?: ImagePart[];
};

const READ_LIMIT_LINES = 2000;
const READ_BUDGET = 24 * 1024;
const OUTPUT_LIMIT = 30_000;
const LIST_LIMIT = 500;
const GREP_LIMIT = 200;
const GREP_BUDGET = 16 * 1024;
const GREP_FILE_BYTES = 1024 * 1024;
/** A search that runs longer than this is stopped: a pattern that backtracks can take hours on one long line. */
const GREP_TIMEOUT_MS = 20_000;
/** Files handed to the search thread at once; the walk stops reading ahead as soon as the answer is full. */
const GREP_BATCH = 256;
/** The most one read or edit loads into memory at once. Larger files are searched or sliced with the shell. */
const TEXT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const BASH_BUDGET = 24 * 1024;
const SHELL_CAPTURE_MAX = 8 * 1024 * 1024;
const SHELL_DEFAULT_MS = 120_000;
/** After a shell exits, how long output already in flight may still arrive before its pipes are let go. */
const SHELL_DRAIN_MS = 200;
/** After a timeout or Stop, the most the call waits for the shell to finish, whatever holds its pipes. */
const SHELL_KILL_CEILING_MS = 3_000;
const SHELL_MAX_MS = 600_000;
const ARTIFACT_DIR = join(".glitter", "tool-output");
/** Directories a listing or search never walks into. */
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "target", ".venv", "venv", "__pycache__", ".cache", ".turbo", "coverage", ".glitter"]);

/** What a handler produces before it is rendered, packed and possibly saved to an artifact. */
export type ToolProduced = { value: ToolValue; continuation?: Continuation; activate?: readonly string[]; images?: ImagePart[] };

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
  /**
   * A promise that re-running this call after an interruption has no side
   * effects, so a missing result is safe to retry. Only pure local reads
   * declare it; edits, shell, MCP, delegation and external calls stay
   * outcome-unknown when a crash leaves no result.
   */
  replay?: "safe";
  /** What the call acts on, for guards and thread grants. Called only after `validate` passed. */
  subject?: (root: string, input: Readonly<Record<string, unknown>>) => Subject;
  /** Kept out of the model's tool list until a tool call activates it. */
  deferred?: boolean;
  /** Why the frozen arguments are refused before any approval card, or undefined. May throw a ToolError. */
  validate?: (root: string, input: Readonly<Record<string, unknown>>) => Promise<string | undefined> | string | undefined;
  run: (root: string, input: Readonly<Record<string, unknown>>, signal?: AbortSignal, context?: ToolContext) => Promise<ToolProduced> | ToolProduced;
};

/** What a handler may know about the call beyond its arguments. */
export type ToolContext = {
  /** The thread is in Full access: the shell is not kept offline. */
  fullAccess?: boolean;
  /** The session the call belongs to, for state that outlives the call (background shells). */
  sessionId?: string;
  /** Settings → Permissions' protected paths, which the shell's sandbox cannot write. The defaults when absent. */
  protectedPaths?: readonly string[];
  /** A workspace-relative file the user's `Read(…)` rules deny: search skips it. */
  readDenied?: (path: string) => boolean;
  /** How long a search may run before it is stopped. For tests; the default is 20 seconds. */
  searchTimeoutMs?: number;
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
    replay: "safe",
    validate: (root, input) => {
      if (!str(input.path).trim()) return "A path is required.";
      confine(root, str(input.path));
      return undefined;
    },
    subject: (root, input) => editSubject(root, input),
    run: (root, input) => readTool(root, input),
  },
  {
    schema: {
      name: "list_files",
      description: "List files under a directory of the workspace, optionally filtered by a glob such as **/*.ts. Skips .git, node_modules, build output and what .gitignore excludes (say how many were left out; include_ignored lists them).",
      parameters: { type: "object", properties: { path: { type: "string", description: "Directory relative to the workspace root. Defaults to the root." }, pattern: { type: "string", description: "Glob relative to that directory." }, include_ignored: { type: "boolean", description: "Also list files .gitignore excludes." }, next_offset: { type: "integer", minimum: 0, description: "File index from a previous truncated listing. Pass it to read the next slice." } } },
    },
    kind: "read",
    concurrencySafe: true,
    replay: "safe",
    validate: (root, input) => {
      if (str(input.path).trim()) confine(root, str(input.path));
      return undefined;
    },
    run: (root, input) => listTool(root, input),
  },
  {
    schema: {
      name: "grep",
      description: "Search file contents with a regular expression. Returns path:line: text for each match. Skips binary files, files over 1 MB and what .gitignore excludes, and says how many; include_ignored searches the ignored ones. A truncated result names next_offset; pass that same next_offset to read the next matches.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", description: "Directory or file to search. Defaults to the root." }, include: { type: "string", description: "Glob of files to search, such as *.py." }, ignore_case: { type: "boolean" }, include_ignored: { type: "boolean", description: "Also search files .gitignore excludes." }, next_offset: { type: "integer", minimum: 0, description: "Match index from a previous truncated search. Pass it unchanged to read the next slice." } }, required: ["pattern"] },
    },
    kind: "read",
    concurrencySafe: true,
    replay: "safe",
    validate: (root, input) => {
      if (!str(input.pattern).trim()) return "A pattern is required.";
      if (str(input.path).trim()) confine(root, str(input.path));
      return undefined;
    },
    subject: (root, input) => editSubject(root, input),
    run: (root, input, signal, context) => grepTool(root, input, signal, context),
  },
  {
    schema: {
      name: "write_file",
      description: "Create or overwrite a file in the workspace with the given content. Prefer edit_file for changes to an existing file.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
    kind: "edit",
    subject: (root, input) => editSubject(root, input),
    validate: (root, input) => {
      if (!str(input.path).trim()) return "A path is required.";
      confine(root, str(input.path));
      if (typeof input.content !== "string") return "content is required and must be a string.";
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
    subject: (root, input) => editSubject(root, input),
    validate: (root, input) => editProblem(root, input),
    run: (root, input) => editTool(root, input),
  },
  {
    schema: {
      name: "multi_edit",
      description: "Make several exact-string replacements in one file, in order, as one change: either every edit applies or none does. Each old_string is matched against the file as the earlier edits left it, and must match exactly once unless replace_all is true. Prefer it to several edit_file calls on the same file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: {
            type: "array",
            minItems: 1,
            items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["old_string", "new_string"] },
          },
        },
        required: ["path", "edits"],
      },
    },
    kind: "edit",
    subject: (root, input) => editSubject(root, input),
    validate: async (root, input) => (await multiEditPlan(root, input)).problem,
    run: (root, input) => multiEditTool(root, input),
  },
  {
    schema: {
      name: "bash",
      description: "Run a shell command in the workspace root. Use for builds, tests, git and other CLI work. Writes outside the workspace and temp are blocked. The command runs without internet access unless you set network: true, which the user may be asked to approve; set it only for commands that must go online (installing packages, fetching, git push or pull). Set run_in_background: true for a command that keeps running, such as a dev server or a watcher: it returns a shell id at once, and bash_output reads what it has printed.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1000, maximum: SHELL_MAX_MS },
          network: { type: "boolean", description: "The command needs the internet." },
          run_in_background: { type: "boolean", description: "Start the command and return without waiting for it to exit." },
        },
        required: ["command"],
      },
    },
    kind: "shell",
    subject: (_root, input) => ({ kind: "command", command: str(input.command), ...(input.network === true ? { network: true } : {}) }),
    validate: (_root, input) => (str(input.command).trim() ? undefined : "A command is required."),
    run: (root, input, signal, context) => input.run_in_background === true ? startBackground(root, input, context) : shellTool(root, input, signal, context),
  },
  {
    schema: {
      name: "bash_output",
      description: "Read what a background shell (started with bash run_in_background: true) has printed since the last read, and whether it is still running.",
      parameters: { type: "object", properties: { shell_id: { type: "string" } }, required: ["shell_id"] },
    },
    // Reading an approved process's output acts on nothing new.
    kind: "read",
    concurrencySafe: true,
    validate: (_root, input) => (str(input.shell_id).trim() ? undefined : "A shell_id is required."),
    run: (_root, input, _signal, context) => {
      const read = readShell(str(input.shell_id), context?.sessionId ?? "");
      return { value: { kind: "process", shellId: read.id, command: read.command, output: read.output, running: read.running, ...(read.exitCode !== undefined ? { exitCode: read.exitCode } : {}), ...(read.missed ? { missed: read.missed } : {}) } };
    },
  },
  {
    schema: {
      name: "kill_shell",
      description: "Stop a background shell this thread started, and return its last output.",
      parameters: { type: "object", properties: { shell_id: { type: "string" } }, required: ["shell_id"] },
    },
    // Stopping the agent's own background process needs no approval.
    kind: "read",
    validate: (_root, input) => (str(input.shell_id).trim() ? undefined : "A shell_id is required."),
    run: async (_root, input, _signal, context) => {
      const read = await killShell(str(input.shell_id), context?.sessionId ?? "");
      return { value: { kind: "process", shellId: read.id, command: read.command, output: read.output, running: false, ...(read.exitCode !== undefined ? { exitCode: read.exitCode } : {}), stopped: true } };
    },
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

/** The built-in tools, the guard every call passes, and the system-prompt guidance that names the tools. */
export const BUILTIN_EXTENSION: Extension = {
  id: "builtin",
  tools: BUILTIN_TOOLS,
  // What a delegated child may use. It is the whole built-in set minus the
  // extensions a child must not touch: skills, MCP, questions and plan review.
  // `delegate` can still hand off once more; the leaf profile cannot.
  profiles: {
    delegate: ["read_file", "list_files", "grep", "write_file", "edit_file", "multi_edit", "bash", "bash_output", "kill_shell", "web_fetch?", "web_search?", "todo_write", "task"],
    "delegate-leaf": ["read_file", "list_files", "grep", "write_file", "edit_file", "multi_edit", "bash", "bash_output", "kill_shell", "web_fetch?", "web_search?", "todo_write"],
  },
  guards: [dangerGuard, gitControlGuard],
  prompt: [{
    placement: "stable",
    text: "Work methodically: look before you change anything (list_files, grep, read_file), keep edits minimal and in the project's existing style, and verify with the project's own build or tests (bash) when that is practical. Use edit_file for changes to existing files and write_file only for new files or full rewrites. For a task with several steps, keep a checklist with todo_write.",
  }],
};

export class ToolError extends Error {}

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

/** The file a call reads or edits, as a workspace-relative `/` path, so a grant or rule can name it. */
function editSubject(root: string, input: Readonly<Record<string, unknown>>): Subject {
  return { kind: "path", path: display(root, confine(root, str(input.path))).split(sep).join("/") };
}

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

/** What a walk left out because the project's `.gitignore` excludes it. */
type Ignored = { count: number; examples: string[] };

/**
 * Visit files in name order. A visitor that returns false stops the whole walk,
 * not just its directory. Resolves false when stopped. With an ignore scope the
 * walk skips what `.gitignore` excludes and records it.
 */
async function walk(dir: string, visit: (path: string) => boolean | Promise<boolean>, ignore?: { scope: IgnoreScope; seen: Ignored; root: string }): Promise<boolean> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return true; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const isDirectory = entry.isDirectory();
    if (!isDirectory && !entry.isFile()) continue;
    if (isDirectory && SKIP_DIRS.has(entry.name)) continue;
    if (ignore?.scope.ignores(path, isDirectory)) {
      ignore.seen.count += 1;
      if (ignore.seen.examples.length < 4) ignore.seen.examples.push(`${relative(ignore.root, path).split(sep).join("/")}${isDirectory ? "/" : ""}`);
      continue;
    }
    if (isDirectory) {
      const inner = ignore ? { ...ignore, scope: await ignore.scope.into(path) } : undefined;
      if (!(await walk(path, visit, inner))) return false;
    } else if ((await visit(path)) === false) return false;
  }
  return true;
}

/** A sentence for the model naming what a `.gitignore` kept out of a search or listing, or undefined when nothing. */
function ignoredNote(seen: Ignored): string | undefined {
  return seen.count ? `${seen.count} path${seen.count === 1 ? "" : "s"} excluded by .gitignore were left out (${seen.examples.join(", ")}${seen.count > seen.examples.length ? ", …" : ""}). Pass include_ignored: true to include them.` : undefined;
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
      if (value.note) text += `\n${value.note}`;
      break;
    case "grep":
      text = value.matches.length ? value.matches.join("\n") : "No matches.";
      if (value.note) text += `\n${value.note}`;
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
    case "question":
      text = "Waiting for the user's answer.";
      break;
    case "mcp":
      text = value.text.trim() || (value.isError ? "The MCP server reported an error." : "(no output)");
      break;
    case "task":
      text = value.text;
      break;
    case "browser":
    case "web":
      text = value.text;
      break;
    case "process": {
      const status = value.running ? `Shell ${value.shellId} is running.` : `Shell ${value.shellId} exited with code ${value.exitCode ?? 1}.`;
      if (value.started) {
        text = `Started shell ${value.shellId} in the background: ${value.command}\nRead its output with bash_output({ shell_id: "${value.shellId}" }) and stop it with kill_shell when it is no longer needed.`;
        break;
      }
      let body = value.output.trimEnd();
      if (body.length > BASH_BUDGET) {
        const fitted = headTail(body, BASH_BUDGET);
        body = `${fitted.text}\n… output truncated (${fitted.omitted} more characters)`;
      }
      const missed = value.missed ? `… ${value.missed} earlier characters were dropped before they were read.\n` : "";
      text = `${missed}${body || "(no new output)"}\n\n${value.stopped ? `Stopped shell ${value.shellId}.` : status}`;
      break;
    }
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
    case "process":
      return { kind: "terminal", command: value.command, ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}) };
    case "plan":
      return { kind: "plan" };
    case "question":
      return { kind: "question" };
    case "mcp":
      return { kind: "mcp", path: `${value.server} › ${value.tool}` };
    case "task":
      return { kind: "task" };
    case "browser":
      return { kind: "browser", path: value.path };
    case "web":
      return { kind: "web", path: value.url };
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

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The text of a file, or why it is not text the tools may rewrite. Reading,
 * editing and writing all go through a JavaScript string, so a file that is not
 * valid UTF-8 would come back with "\uFFFD" in place of every byte it cannot
 * represent, and the next save would write those in. Refuse it instead. A byte
 * order mark is kept, so a file that has one is saved with it.
 */
function decodeText(buffer: Buffer, label: string): { text: string } | { problem: string } {
  if (buffer.subarray(0, 8000).includes(0)) return { problem: `${label} is a binary file.` };
  try { return { text: UTF8.decode(buffer) }; } catch {
    return { problem: `${label} is not valid UTF-8 (it may be Latin-1 or another encoding). Saving it through this tool would replace the bytes it cannot represent with \uFFFD, so it is left alone. Convert or edit it with bash, such as iconv.` };
  }
}

function tooLarge(label: string, bytes: number): string {
  return `${label} is ${(bytes / (1024 * 1024)).toFixed(1)} MB, over the ${TEXT_FILE_MAX_BYTES / (1024 * 1024)} MB these tools load at once. Print a range with bash, such as sed -n '1,200p', or search it with grep.`;
}

/** A file the edit and write tools may replace: null when it does not exist, else its text or the reason it is off limits. */
async function loadEditable(path: string, label: string): Promise<{ text: string } | { problem: string } | null> {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  if (info.isDirectory()) return { problem: `${label} is a directory.` };
  if (info.size > TEXT_FILE_MAX_BYTES) return { problem: tooLarge(label, info.size) };
  const buffer = await readFile(path).catch(() => null);
  return buffer ? decodeText(buffer, label) : null;
}

/**
 * A file with Windows line endings throughout is edited with the strings the
 * model sees, which read as plain newlines. Match them to the file, so the edit
 * lands and the endings survive; a mixed file is left as typed and the error
 * says why a multi-line match may fail.
 */
function matchEndings(before: string, oldText: string, newText: string): { oldText: string; newText: string } {
  const crlf = (before.match(/\r\n/g) ?? []).length;
  if (!crlf || crlf !== (before.match(/\n/g) ?? []).length) return { oldText, newText };
  const toCrlf = (text: string) => (text.includes("\r") ? text : text.replace(/\n/g, "\r\n"));
  return oldText.includes("\n") && !oldText.includes("\r") ? { oldText: toCrlf(oldText), newText: toCrlf(newText) } : { oldText, newText };
}

/** Say why an old_string spanning lines is not found when line endings are the likely cause. */
function endingsHint(before: string, oldText: string): string {
  if (!oldText.includes("\n")) return "";
  const crlf = (before.match(/\r\n/g) ?? []).length;
  const lf = (before.match(/\n/g) ?? []).length - crlf;
  if (crlf && lf) return " The file mixes CRLF and LF line endings, so a match across lines must use each line's own ending.";
  if (!crlf && oldText.includes("\r\n")) return " The file uses LF line endings but old_string has CRLF.";
  return "";
}

async function readTool(root: string, input: Record<string, unknown>): Promise<{ value: ToolValue; continuation?: Continuation }> {
  const path = confine(root, str(input.path));
  const info = await stat(path).catch(() => null);
  if (!info) throw new ToolError(`${str(input.path)} does not exist.`);
  if (info.isDirectory()) throw new ToolError(`${str(input.path)} is a directory. Use list_files.`);
  if (info.size > TEXT_FILE_MAX_BYTES) throw new ToolError(tooLarge(str(input.path), info.size));
  const buffer = await readFile(path);
  const decoded = decodeText(buffer, str(input.path));
  if ("problem" in decoded) throw new ToolError(decoded.problem);
  const lines = decoded.text.split("\n");
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
  const ignored: Ignored = { count: 0, examples: [] };
  const workspace = realpathSync(root);
  const scope = input.include_ignored === true ? undefined : { scope: await IgnoreScope.at(workspace, dir), seen: ignored, root: workspace };
  await walk(dir, (path) => {
    const rel = relative(dir, path).split(sep).join("/");
    if (matcher && !matcher.test(rel)) return true;
    seen += 1;
    if (seen <= skip) return true;
    if (found.length >= LIST_LIMIT) { truncated = true; return false; }
    found.push(display(root, path).split(sep).join("/"));
    return true;
  }, scope);
  const label = display(root, dir);
  const nextOffset = skip + found.length;
  const note = ignoredNote(ignored);
  const value: ToolValue = { kind: "list", path: label, files: found, ...(truncated ? { nextOffset } : {}), ...(note ? { note } : {}) };
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
      preserveArgs: { ...definedArgs(input, ["path", "pattern", "include_ignored"]), next_offset: nextOffset },
      instruction: `… more files remain; re-run list_files with next_offset ${nextOffset}.`,
    },
  }) : undefined;
  return { value, continuation };
}

/**
 * The search runs in a worker thread. A pattern such as `(a+)+$` can take hours
 * on one long line, and on this thread that would freeze every conversation the
 * app has open; in a worker it costs one search, which is stopped at a deadline
 * or when the user presses Stop. The worker is plain script, with no imports
 * but Node's own, so it needs no bundling of its own.
 */
const GREP_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const { pattern, flags, skip, limit, budget } = workerData;
const regex = new RegExp(pattern, flags);
const hits = [];
let seen = 0, bytes = 0, binary = 0, stopped = false;
parentPort.on("message", (message) => {
  if (message.type === "end") { parentPort.postMessage({ type: "result", hits, truncated: stopped, binary }); return; }
  outer: for (const file of message.files) {
    if (stopped) break;
    let buffer;
    try { buffer = fs.readFileSync(file.path); } catch { continue; }
    if (buffer.subarray(0, 8000).includes(0)) { binary += 1; continue; }
    const lines = buffer.toString("utf8").split("\\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue;
      seen += 1;
      if (seen <= skip) continue;
      const row = file.label + ":" + (index + 1) + ": " + lines[index].slice(0, 300);
      if (hits.length >= limit || (hits.length > 0 && bytes + row.length + 1 > budget)) { stopped = true; break outer; }
      hits.push(row);
      bytes += row.length + 1;
    }
  }
  parentPort.postMessage({ type: "batch", stopped });
});
`;

type SearchReply = { type: "batch"; stopped: boolean } | { type: "result"; hits: string[]; truncated: boolean; binary: number };

class SearchWorker {
  private readonly worker: Worker;
  private readonly timer: ReturnType<typeof setTimeout>;
  private waiting?: { resolve: (reply: SearchReply) => void; reject: (error: Error) => void };
  private failure?: Error;
  private closed = false;

  constructor(data: { pattern: string; flags: string; skip: number; limit: number; budget: number }, deadlineMs: number, private readonly signal?: AbortSignal) {
    this.worker = new Worker(GREP_WORKER, { eval: true, workerData: data, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    this.worker.on("message", (reply: SearchReply) => { const next = this.waiting; this.waiting = undefined; next?.resolve(reply); });
    this.worker.on("error", (error: unknown) => this.fail(new ToolError(`The search failed: ${error instanceof Error ? error.message : String(error)}`)));
    this.worker.on("exit", () => { if (!this.closed) this.fail(new ToolError("The search stopped unexpectedly.")); });
    this.timer = setTimeout(() => this.fail(new ToolError(`The search ran longer than ${Math.round(deadlineMs / 1000)} s and was stopped. A pattern that repeats a repeat, such as (a+)+, can take that long on one line: simplify it, or narrow path and include.`)), deadlineMs);
    this.timer.unref();
    signal?.addEventListener("abort", this.stop, { once: true });
    if (signal?.aborted) this.stop();
  }

  private readonly stop = () => this.fail(new ToolError("The search was stopped."));

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    void this.worker.terminate();
    const next = this.waiting;
    this.waiting = undefined;
    next?.reject(error);
  }

  request(message: { type: "files"; files: Array<{ path: string; label: string }> } | { type: "end" }): Promise<SearchReply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.worker.postMessage(message);
    });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.stop);
    void this.worker.terminate();
  }
}

async function grepTool(root: string, input: Record<string, unknown>, signal?: AbortSignal, context?: ToolContext): Promise<{ value: ToolValue; continuation?: Continuation }> {
  const flags = input.ignore_case === true ? "i" : "";
  try { new RegExp(str(input.pattern), flags); }
  catch (error) { throw new ToolError(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`); }
  const base = confine(root, str(input.path));
  const include = str(input.include) ? globRegex(str(input.include)) : null;
  const skip = Math.max(0, int(input.next_offset) ?? 0);
  const info = await stat(base).catch(() => null);
  if (!info) throw new ToolError(`${str(input.path)} does not exist.`);
  const ignored: Ignored = { count: 0, examples: [] };
  let tooLarge = 0;
  const workspace = realpathSync(root);
  const scope = input.include_ignored === true ? undefined : { scope: await IgnoreScope.at(workspace, info.isFile() ? dirname(base) : base), seen: ignored, root: workspace };
  const search = new SearchWorker({ pattern: str(input.pattern), flags, skip, limit: GREP_LIMIT, budget: GREP_BUDGET }, context?.searchTimeoutMs ?? GREP_TIMEOUT_MS, signal);
  let result: Extract<SearchReply, { type: "result" }>;
  try {
    let batch: Array<{ path: string; label: string }> = [];
    let stopped = false;
    const flush = async () => {
      if (!batch.length) return;
      const files = batch;
      batch = [];
      const reply = await search.request({ type: "files", files });
      if (reply.type === "batch" && reply.stopped) stopped = true;
    };
    const visit = async (path: string) => {
      if (include && !include.test(path.split(sep).join("/"))) return true;
      const label = display(root, path).split(sep).join("/");
      // A file the user's Read(…) rules deny is not searched either.
      if (context?.readDenied?.(label)) return true;
      const size = await stat(path).then((entry) => entry.size, () => null);
      if (size === null) return true;
      if (size > GREP_FILE_BYTES) { tooLarge += 1; return true; }
      batch.push({ path, label });
      if (batch.length >= GREP_BATCH) { await flush(); if (stopped) return false; }
      return true;
    };
    if (info.isFile()) await visit(base);
    else await walk(base, visit, scope);
    await flush();
    const reply = await search.request({ type: "end" });
    if (reply.type !== "result") throw new ToolError("The search did not finish.");
    result = reply;
  } finally {
    search.close();
  }
  const label = display(root, base);
  const hits = result.hits;
  const truncated = result.truncated;
  const bytes = hits.reduce((sum, row) => sum + row.length + 1, 0);
  const nextOffset = skip + hits.length;
  const notes = [
    ignoredNote(ignored),
    tooLarge ? `${tooLarge} file${tooLarge === 1 ? "" : "s"} over ${GREP_FILE_BYTES / (1024 * 1024)} MB ${tooLarge === 1 ? "was" : "were"} not searched; print a range with bash instead.` : undefined,
    result.binary ? `${result.binary} binary file${result.binary === 1 ? "" : "s"} skipped.` : undefined,
  ].filter(Boolean).join(" ");
  const value: ToolValue = { kind: "grep", path: label, pattern: str(input.pattern), matches: hits, ...(truncated ? { nextOffset } : {}), ...(notes ? { note: notes } : {}) };
  const continuation = truncated ? continuationOf({
    strategy: "prefix_lines",
    nextOffset,
    offsetUnit: "match",
    originalBytes: bytes,
    returnedBytes: bytes,
    maxBytes: GREP_BUDGET,
    continuationHint: {
      tool: "grep",
      preserveArgs: { ...definedArgs(input, ["pattern", "path", "include", "ignore_case", "include_ignored"]), next_offset: nextOffset },
      instruction: `… stopped after ${hits.length} matches in this slice; re-run grep with next_offset ${nextOffset}.`,
    },
  }) : undefined;
  return { value, continuation };
}

async function writeTool(root: string, input: Record<string, unknown>): Promise<{ value: ToolValue }> {
  const path = confine(root, str(input.path));
  if (!str(input.path).trim()) throw new ToolError("A path is required.");
  const existing = await loadEditable(path, str(input.path));
  if (existing && "problem" in existing) throw new ToolError(existing.problem);
  const existed = existing !== null || existsSync(path);
  const oldText = existing?.text ?? "";
  if (typeof input.content !== "string") throw new ToolError("content is required and must be a string.");
  const newText = input.content;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, newText, "utf8");
  return { value: { kind: "diff", path: display(root, path), oldText, newText, created: !existed } };
}

/** Why these exact strings cannot be applied to the file's current text. */
function editProblemText(pathLabel: string, before: string | null, input: Record<string, unknown>): string | undefined {
  if (before == null) return `${pathLabel} does not exist. Use write_file to create it.`;
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") return "old_string and new_string are required and must be strings.";
  if (!input.old_string) return "old_string is empty. Use write_file to create or replace a whole file.";
  const oldText = matchEndings(before, input.old_string, input.new_string).oldText;
  const count = before.split(oldText).length - 1;
  if (count === 0) return `old_string was not found in ${pathLabel}. Read the file and copy the text exactly, including whitespace.${endingsHint(before, input.old_string)}`;
  if (count > 1 && input.replace_all !== true) return `old_string matches ${count} places in ${pathLabel}. Add surrounding lines to make it unique, or set replace_all.`;
  return undefined;
}

/** Why an edit cannot be applied, or undefined when the frozen strings are safe to run. Reads the file; does not write it. */
export async function editProblem(root: string, input: Record<string, unknown>): Promise<string | undefined> {
  const path = confine(root, str(input.path));
  const loaded = await loadEditable(path, str(input.path));
  if (loaded && "problem" in loaded) return loaded.problem;
  return editProblemText(str(input.path), loaded?.text ?? null, input);
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

const MULTI_EDIT_MAX = 100;

/** Apply every edit to the text in memory, or say which one fails and why. Nothing is written. */
async function multiEditPlan(root: string, input: Readonly<Record<string, unknown>>): Promise<{ problem?: string; before?: string; after?: string; count?: number; path?: string }> {
  if (!str(input.path).trim()) return { problem: "A path is required." };
  const path = confine(root, str(input.path));
  const edits = Array.isArray(input.edits) ? input.edits as Array<Record<string, unknown>> : null;
  if (!edits?.length) return { problem: "edits must be a non-empty list of { old_string, new_string }." };
  if (edits.length > MULTI_EDIT_MAX) return { problem: `At most ${MULTI_EDIT_MAX} edits in one call.` };
  const loaded = await loadEditable(path, str(input.path));
  if (loaded && "problem" in loaded) return { problem: loaded.problem };
  const before = loaded?.text ?? null;
  let text = before;
  let count = 0;
  for (const [index, edit] of edits.entries()) {
    const problem = editProblemText(str(input.path), text, edit ?? {});
    if (problem) return { problem: `Edit ${index + 1} of ${edits.length}: ${problem}` };
    const { oldText, newText } = matchEndings(text!, str(edit.old_string), str(edit.new_string));
    count += edit.replace_all === true ? text!.split(oldText).length - 1 : 1;
    text = edit.replace_all === true ? text!.split(oldText).join(newText) : text!.replace(oldText, () => newText);
  }
  return { before: before ?? "", after: text ?? "", count, path };
}

async function multiEditTool(root: string, input: Readonly<Record<string, unknown>>): Promise<{ value: ToolValue }> {
  const plan = await multiEditPlan(root, input);
  if (plan.problem || plan.path == null) throw new ToolError(plan.problem ?? "The edits could not be applied.");
  await writeFile(plan.path, plan.after!, "utf8");
  return { value: { kind: "diff", path: display(root, plan.path), oldText: plan.before!, newText: plan.after!, replacements: plan.count } };
}

async function editTool(root: string, input: Record<string, unknown>): Promise<{ value: ToolValue }> {
  const path = confine(root, str(input.path));
  const loaded = await loadEditable(path, str(input.path));
  if (loaded && "problem" in loaded) throw new ToolError(loaded.problem);
  const before = loaded?.text ?? null;
  const problem = editProblemText(str(input.path), before, input);
  if (problem) throw new ToolError(problem);
  const { oldText, newText } = matchEndings(before!, str(input.old_string), str(input.new_string));
  const count = (before ?? "").split(oldText).length - 1;
  const after = input.replace_all === true ? (before ?? "").split(oldText).join(newText) : (before ?? "").replace(oldText, () => newText);
  await writeFile(path, after, "utf8");
  return { value: { kind: "diff", path: display(root, path), oldText: before ?? "", newText: after, replacements: count } };
}

/**
 * The harness shell: the workspace write sandbox, and offline unless the call
 * asked for the network (and was allowed it) or the thread is in Full access.
 * An offline command cannot read cloud and registry tokens either.
 */
export function spawnShell(root: string, command: string, online: boolean, protectedPaths?: readonly string[]) {
  const workspace = realpathSync(root);
  return spawnIsolated("/bin/sh", ["-c", command], { workspace, cwd: workspace, network: online, protectedPaths, ...(online ? {} : { denyReadRoots: credentialRoots() }) });
}

async function shellTool(root: string, input: Readonly<Record<string, unknown>>, signal?: AbortSignal, context?: ToolContext): Promise<{ value: ToolValue }> {
  const command = str(input.command);
  if (!command.trim()) throw new ToolError("A command is required.");
  const timeout = Math.min(SHELL_MAX_MS, Math.max(1000, int(input.timeout_ms) ?? SHELL_DEFAULT_MS));
  const { child } = spawnShell(root, command, input.network === true || context?.fullAccess === true, context?.protectedPaths);
  child.stdin.end();
  let stdout = "";
  let capped = false;
  // A multi-byte character split across two chunks must not turn into replacement characters.
  const decoder = new StringDecoder("utf8");
  const take = (chunk: Buffer) => {
    if (stdout.length >= SHELL_CAPTURE_MAX) { capped = true; return; }
    stdout += decoder.write(chunk);
    if (stdout.length > SHELL_CAPTURE_MAX) { stdout = stdout.slice(0, SHELL_CAPTURE_MAX); capped = true; }
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  let timedOut = false;
  let endNow: (() => void) | undefined;
  // A call that was told to stop ends within a fixed time even when something
  // that outlived the shell still holds its pipes.
  const stop = () => { void terminateTree(child); const ceiling = setTimeout(() => endNow?.(), SHELL_KILL_CEILING_MS); ceiling.unref(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  const abort = () => stop();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  // The command is over when the shell exits, not when every pipe has closed:
  // `sleep 60 &` leaves a process holding stdout for a minute.
  const exitCode = await new Promise<number>((done) => {
    let finished = false;
    let status = 1;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (drain) clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
      done(code);
    };
    endNow = () => finish(status);
    child.on("exit", (code) => { status = code ?? 1; drain = setTimeout(() => finish(status), SHELL_DRAIN_MS); });
    child.on("close", (code) => finish(code ?? status));
    child.on("error", () => finish(127));
  });
  clearTimeout(timer);
  signal?.removeEventListener("abort", abort);
  const note = timedOut ? `\n… stopped after ${Math.round(timeout / 1000)}s.` : signal?.aborted ? "\n… stopped by the user." : capped ? "\n… capture stopped; the command kept writing." : "";
  return { value: { kind: "terminal", command, stdout, exitCode, ...(note ? { note } : {}) } };
}

function startBackground(root: string, input: Readonly<Record<string, unknown>>, context?: ToolContext): { value: ToolValue } {
  const command = str(input.command);
  if (!command.trim()) throw new ToolError("A command is required.");
  if (!context?.sessionId) throw new ToolError("Background shells need a thread.");
  const online = input.network === true || context.fullAccess === true;
  const shell = startShell(context.sessionId, command, () => spawnShell(root, command, online, context.protectedPaths).child);
  return { value: { kind: "process", shellId: shell.id, command, output: "", running: true, started: true } };
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

function pack(produced: ToolProduced): ToolOutcome {
  const { value, continuation, activate, images } = produced;
  const outcome: ToolOutcome = { output: render(value, continuation), value, presentation: presentationMeta(value), ...(continuation ? { continuation } : {}), ...(activate?.length ? { activate } : {}), ...(images?.length ? { images } : {}) };
  if (value.kind === "terminal") {
    outcome.exitCode = value.exitCode;
    outcome.command = value.command;
    if (value.exitCode !== 0) outcome.isError = true;
  } else if (value.kind === "plan") outcome.plan = value.plan;
  else if (value.kind === "question") outcome.question = { questions: value.questions, ...(value.intent ? { intent: value.intent } : {}) };
  else if (value.kind === "mcp") {
    outcome.path = `${value.server} › ${value.tool}`;
    if (value.isError) outcome.isError = true;
  } else if (value.kind === "task") {
    if (value.failed) outcome.isError = true;
  } else if (value.kind === "process") {
    outcome.command = value.command;
    if (value.exitCode !== undefined) {
      outcome.exitCode = value.exitCode;
      if (value.exitCode !== 0 && !value.stopped) outcome.isError = true;
    }
  } else if (value.kind === "web") outcome.path = value.url;
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

export type RunToolOptions = { canRead?: boolean } & ToolContext;

/** Run one tool. Failures come back as error results the model can read and correct, never as exceptions. */
export async function executeTool(definition: ToolDefinition, root: string, input: Record<string, unknown>, signal?: AbortSignal, options?: RunToolOptions): Promise<ToolOutcome> {
  try {
    const produced = await definition.run(root, input, signal, {
      ...(options?.fullAccess ? { fullAccess: true } : {}),
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options?.protectedPaths ? { protectedPaths: options.protectedPaths } : {}),
      ...(options?.readDenied ? { readDenied: options.readDenied } : {}),
      ...(options?.searchTimeoutMs ? { searchTimeoutMs: options.searchTimeoutMs } : {}),
    });
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
