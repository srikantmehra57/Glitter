import { innerScript, parseScript, commandsOf, programName } from "./shell.js";
import { WRAPPERS, gitCommandArgs } from "./danger.js";
import { foldPath, type Grant, type Subject } from "./grants.js";
import type { ToolKind } from "../tools.js";
import type { ToolGuard } from "./guards.js";

/**
 * Persistent permission rules: the user's own allow and deny lists, kept in
 * Settings and applied to every Harness thread. The syntax follows the
 * familiar `Tool(pattern)` shape:
 *
 * - `Bash(npm test)` — exactly this command; `Bash(npm run *)` — commands
 *   that start with `npm run`.
 * - `Edit(README.md)` — one file; `Edit(src/**)` — files under a folder;
 *   `Edit(**)` — any file in the workspace. Deny only: edits already run in
 *   Ask and Auto, so an allow rule for a path would change nothing.
 * - `Read(.env)`, `Read(secrets/**)` — keeps the read tools (and search) away
 *   from a file or folder. Deny only: reading never asks. Commands can still
 *   read it; that is the sandbox's job, not a rule's.
 * - `WebFetch(docs.example.com)` — fetches from that host; `WebSearch`.
 * - `Mcp(server)` or `Mcp(server/tool)`.
 * - `Network` (allow only) — internet access for commands that may already run.
 *
 * An allow rule becomes a grant, exactly like a thread grant: it never
 * overrides the danger checks or a risky command's ask. A deny rule is a
 * guard: it refuses in every permission mode, Full access included.
 */

export type RuleEffect = "allow" | "deny";
export type PermissionRule = { effect: RuleEffect; rule: string };

type Parsed =
  | { tool: "bash"; exact?: string; prefix?: string[] }
  | { tool: "edit"; file?: string; folder?: string }
  | { tool: "read"; file?: string; folder?: string }
  | { tool: "webfetch"; host: string }
  | { tool: "websearch" }
  | { tool: "mcp"; server: string; tool_?: string }
  | { tool: "network" };

const RULE = /^\s*([A-Za-z]+)\s*(?:\(\s*([\s\S]*?)\s*\))?\s*$/;

/** One rule, or why it cannot be read. */
export function parseRule(text: string): Parsed | string {
  const match = RULE.exec(text);
  if (!match) return `"${text}" is not a rule. Write it as Tool(pattern), for example Bash(npm test).`;
  const tool = match[1].toLowerCase();
  const pattern = (match[2] ?? "").trim();
  if (tool === "bash") {
    if (!pattern) return "Bash needs a command, such as Bash(npm test) or Bash(npm run *).";
    if (/\s\*$|:\*$/.test(pattern)) {
      const words = pattern.replace(/\s*:?\*$/, "").trim().split(/\s+/).filter(Boolean);
      if (!words.length) return "Bash(*) would allow every command; use Full access on a thread instead.";
      if (words.some((word) => word.includes("*"))) return "A Bash rule may only end with *.";
      return { tool: "bash", prefix: words };
    }
    if (pattern.includes("*")) return "A Bash rule may only end with *.";
    return { tool: "bash", exact: pattern };
  }
  if (tool === "edit" || tool === "write" || tool === "read") {
    const kind = tool === "read" ? "read" : "edit";
    const name = kind === "read" ? "Read" : "Edit";
    const path = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!path) return `${name} needs a path, such as ${name}(src/**).`;
    if (path.startsWith("/") || path.split("/").includes("..")) return `A ${name} rule names a path inside the workspace.`;
    if (path === "**" || path === "*") return { tool: kind, folder: "" };
    if (path.endsWith("/**")) return { tool: kind, folder: path.slice(0, -3) };
    if (path.includes("*")) return `A ${name} rule is a file, or a folder ending in /**.`;
    return { tool: kind, file: path };
  }
  if (tool === "webfetch" || tool === "fetch") {
    const host = pattern.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();
    if (!host || !/^[a-z0-9.-]+(?::\d+)?$/.test(host)) return "WebFetch needs a host, such as WebFetch(docs.example.com).";
    return { tool: "webfetch", host };
  }
  if (tool === "websearch") return pattern ? "WebSearch does not take a pattern." : { tool: "websearch" };
  if (tool === "mcp") {
    const parts = pattern.split("/");
    const [server, mcpTool] = parts;
    if (!server || parts.length > 2 || (parts.length === 2 && !mcpTool)) return "Mcp needs a server or one server/tool, such as Mcp(github) or Mcp(github/create_issue).";
    return { tool: "mcp", server, ...(mcpTool ? { tool_: mcpTool } : {}) };
  }
  if (tool === "network") return pattern ? "Network does not take a pattern." : { tool: "network" };
  return `Unknown rule tool "${match[1]}". Use Bash, Edit, Read, WebFetch, WebSearch, Mcp or Network.`;
}

function grantsFor(parsed: Parsed): Grant[] {
  switch (parsed.tool) {
    case "bash":
      return parsed.exact ? [{ kind: "command", match: "exact", command: parsed.exact }] : [{ kind: "command", match: "prefix", argv: parsed.prefix! }];
    case "edit":
    case "read":
      return parsed.file !== undefined ? [{ kind: "path", match: "file", path: parsed.file }] : [{ kind: "path", match: "folder", path: parsed.folder ?? "" }];
    case "webfetch":
      return [{ kind: "web", origin: `https://${parsed.host}` }, { kind: "web", origin: `http://${parsed.host}` }];
    case "websearch":
      return [{ kind: "web", origin: "", search: true }];
    case "mcp":
      return parsed.tool_ ? [{ kind: "mcp", match: "tool", server: parsed.server, tool: parsed.tool_ }] : [{ kind: "mcp", match: "server", server: parsed.server }];
    case "network":
      return [{ kind: "network" }];
  }
}

/**
 * A program word as the system runs it: `/usr/bin/git` and `git` are one
 * program, and on a Mac `GIT` finds the same file. Deny rules compare this
 * form, so neither a path nor a case variant slips past them. Allow grants
 * keep comparing the literal argv: `/tmp/x/git` is not the user's git, and
 * widening a grant to it would run a different program.
 */
function programWord(word: string): string {
  return programName(word).toLowerCase();
}

/** A command's argv in the form deny rules compare: program word normalized, git's global options removed. */
function normalForm(argv: readonly string[]): string[] {
  if (!argv.length) return [];
  const program = programWord(argv[0]);
  const rest = program === "git" ? gitCommandArgs(argv.slice(1)) : argv.slice(1);
  return [program, ...rest];
}

/** A word a wrapper takes before the command it runs: an option, `NAME=value`, a duration or priority. */
const wrapperWord = (word: string) => word.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || /^-?\d+(?:\.\d+)?[smhd]?$/.test(word);

/**
 * Every way a simple command could be running a program: the command itself,
 * and each later word that wrappers (`sudo -u root`, `env NAME=1`, `nice -n
 * 5`, `xargs -n1`, `command`, …) hand control to. A word right after an option
 * may be that option's value, so it is skipped too; this reads more starts
 * than the shell would, which only ever makes a deny rule stricter. `env -S`
 * splits its string into a command of its own. `fromXargs` marks a start
 * whose remaining arguments may come from standard input.
 */
function runForms(argv: readonly string[]): Array<{ form: string[]; fromXargs: boolean }> {
  const forms: Array<{ form: string[]; fromXargs: boolean }> = [];
  let index = 0;
  let wrapped = false;
  let xargs = false;
  while (index < argv.length) {
    const program = programWord(argv[index]);
    forms.push({ form: normalForm(argv.slice(index)), fromXargs: xargs });
    if (!WRAPPERS.has(program)) break;
    wrapped = true;
    if (program === "xargs") xargs = true;
    index += 1;
    while (index < argv.length && wrapperWord(argv[index])) {
      const option = argv[index];
      if (program === "env" && (option === "-S" || option === "--split-string") && index + 1 < argv.length) {
        forms.push(...runForms(argv[index + 1].trim().split(/\s+/)).map((entry) => ({ ...entry, fromXargs: entry.fromXargs || xargs })));
      }
      index += 1;
      // An option's value: `sudo -u root`, `nice -n 5`, `xargs -I {}`.
      if (option.startsWith("-") && !option.includes("=") && index < argv.length && !WRAPPERS.has(programWord(argv[index])) && index + 1 < argv.length) {
        forms.push({ form: normalForm(argv.slice(index)), fromXargs: xargs });
        index += 1;
      }
    }
  }
  return wrapped ? forms : forms.slice(0, 1);
}

/**
 * Every simple command in a script, including the scripts of `bash -c`
 * (behind any wrapper, as in `sudo bash -c …`), to a fixed depth, each in
 * every form it could run as.
 */
function allForms(source: string, depth = 0): Array<{ form: string[]; fromXargs: boolean }> | null {
  const script = parseScript(source);
  if (!script) return null;
  const out: Array<{ form: string[]; fromXargs: boolean }> = [];
  for (const command of commandsOf(script)) {
    if (command.dynamic) return null;
    for (const entry of runForms(command.argv)) {
      out.push(entry);
      const inner = innerScript({ ...command, argv: entry.form });
      if (inner === undefined) continue;
      if (depth >= 2) return null;
      const nested = allForms(inner, depth + 1);
      if (!nested) return null;
      out.push(...nested);
    }
  }
  return out;
}

function denies(parsed: Parsed, subject: Subject, kind: ToolKind): boolean {
  if (parsed.tool === "bash" && subject.kind === "command") {
    const forms = allForms(subject.command);
    // An unreadable script could hide the denied command behind syntax or expansion.
    if (!forms) return true;
    const rule = normalForm((parsed.exact ?? parsed.prefix!.join(" ")).split(/\s+/).filter(Boolean));
    if (parsed.exact) return forms.some(({ form }) => form.join(" ") === rule.join(" "));
    return forms.some(({ form, fromXargs }) => {
      const shared = Math.min(form.length, rule.length);
      if (!rule.slice(0, shared).every((word, index) => form[index] === word)) return false;
      // `xargs git` may read `push` from its input, so a partial match still counts.
      return form.length >= rule.length || fromXargs;
    });
  }
  // Edit rules cover the tools that change files; Read rules the ones that read them.
  if ((parsed.tool === "edit" && kind !== "read") || (parsed.tool === "read" && kind === "read")) {
    if (subject.kind !== "path") return false;
    const path = foldPath(subject.path);
    if (parsed.file !== undefined) return path === foldPath(parsed.file);
    const folder = foldPath(parsed.folder ?? "");
    return folder === "" || path === folder || path.startsWith(`${folder}/`);
  }
  if (parsed.tool === "webfetch" && subject.kind === "web" && !subject.search) {
    try { return new URL(subject.origin).host === parsed.host; } catch { return false; }
  }
  if (parsed.tool === "websearch") return subject.kind === "web" && subject.search === true;
  if (parsed.tool === "mcp" && subject.kind === "mcp") return subject.server === parsed.server && (!parsed.tool_ || subject.tool === parsed.tool_);
  return false;
}

export type CompiledRules = {
  grants: Grant[];
  guard: ToolGuard;
  problems: string[];
  /** Whether a workspace-relative file is one a Read rule denies, for tools that read many files (grep). */
  readDenied: (path: string) => boolean;
};

/** Read the user's rules once. A rule that cannot be read is reported and ignored, never widened. */
export function compileRules(rules: readonly PermissionRule[]): CompiledRules {
  const grants: Grant[] = [];
  const deny: Array<{ parsed: Parsed; text: string }> = [];
  const problems: string[] = [];
  for (const { effect, rule } of rules) {
    const parsed = parseRule(rule);
    if (typeof parsed === "string") { problems.push(parsed); continue; }
    if (effect === "allow" && parsed.tool === "edit") problems.push(`Edits already run in Ask and Auto, so allow ${rule.trim()} changes nothing. Write it as a deny rule to protect the path.`);
    else if (effect === "allow" && parsed.tool === "read") problems.push(`Reading files never asks, so allow ${rule.trim()} changes nothing. Write it as a deny rule to keep the agent from reading the path.`);
    else if (effect === "allow") grants.push(...grantsFor(parsed));
    else if (parsed.tool === "network") problems.push("Network is an allow rule; to keep commands offline, leave it out.");
    else deny.push({ parsed, text: rule.trim() });
  }
  const guard: ToolGuard = ({ subject, kind }) => {
    const hit = deny.find((entry) => denies(entry.parsed, subject, kind));
    return hit ? `The user's permission rules deny this (${hit.text}). Do not retry it; tell the user what you were trying to do.` : undefined;
  };
  const reads = deny.filter((entry) => entry.parsed.tool === "read");
  const readDenied = (path: string) => reads.some((entry) => denies(entry.parsed, { kind: "path", path }, "read"));
  return { grants, guard, problems, readDenied };
}
