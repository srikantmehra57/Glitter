import { innerScript, parseScript, commandsOf, type SimpleCommand } from "./shell.js";
import type { Grant, Subject } from "./grants.js";
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
  if (tool === "edit" || tool === "write") {
    const path = pattern.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!path) return "Edit needs a path, such as Edit(src/**).";
    if (path.startsWith("/") || path.split("/").includes("..")) return "An Edit rule names a path inside the workspace.";
    if (path === "**" || path === "*") return { tool: "edit", folder: "" };
    if (path.endsWith("/**")) return { tool: "edit", folder: path.slice(0, -3) };
    if (path.includes("*")) return "An Edit rule is a file, or a folder ending in /**.";
    return { tool: "edit", file: path };
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
  return `Unknown rule tool "${match[1]}". Use Bash, Edit, WebFetch, WebSearch, Mcp or Network.`;
}

function grantsFor(parsed: Parsed): Grant[] {
  switch (parsed.tool) {
    case "bash":
      return parsed.exact ? [{ kind: "command", match: "exact", command: parsed.exact }] : [{ kind: "command", match: "prefix", argv: parsed.prefix! }];
    case "edit":
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

/** Every simple command in a script, including the scripts of `bash -c`, to a fixed depth. */
function allCommands(source: string, depth = 0): SimpleCommand[] | null {
  const script = parseScript(source);
  if (!script) return null;
  const out: SimpleCommand[] = [];
  for (const command of commandsOf(script)) {
    if (command.dynamic) return null;
    out.push(command);
    const inner = innerScript(command);
    if (inner !== undefined) {
      if (depth >= 2) return null;
      const nested = allCommands(inner, depth + 1);
      if (!nested) return null;
      out.push(...nested);
    }
  }
  return out;
}

function denies(parsed: Parsed, subject: Subject): boolean {
  if (parsed.tool === "bash" && subject.kind === "command") {
    const commands = allCommands(subject.command);
    // An unreadable script could hide the denied command behind syntax or expansion.
    if (!commands) return true;
    if (parsed.exact) return subject.command.trim() === parsed.exact || commands.some((command) => command.argv.join(" ") === parsed.exact);
    return commands.some((command) => parsed.prefix!.every((word, index) => command.argv[index] === word));
  }
  if (parsed.tool === "edit" && subject.kind === "path") {
    if (parsed.file !== undefined) return subject.path === parsed.file;
    return parsed.folder === "" || subject.path === parsed.folder || subject.path.startsWith(`${parsed.folder}/`);
  }
  if (parsed.tool === "webfetch" && subject.kind === "web" && !subject.search) {
    try { return new URL(subject.origin).host === parsed.host; } catch { return false; }
  }
  if (parsed.tool === "websearch") return subject.kind === "web" && subject.search === true;
  if (parsed.tool === "mcp" && subject.kind === "mcp") return subject.server === parsed.server && (!parsed.tool_ || subject.tool === parsed.tool_);
  return false;
}

export type CompiledRules = { grants: Grant[]; guard: ToolGuard; problems: string[] };

/** Read the user's rules once. A rule that cannot be read is reported and ignored, never widened. */
export function compileRules(rules: readonly PermissionRule[]): CompiledRules {
  const grants: Grant[] = [];
  const deny: Array<{ parsed: Parsed; text: string }> = [];
  const problems: string[] = [];
  for (const { effect, rule } of rules) {
    const parsed = parseRule(rule);
    if (typeof parsed === "string") { problems.push(parsed); continue; }
    if (effect === "allow" && parsed.tool === "edit") problems.push(`Edits already run in Ask and Auto, so allow ${rule.trim()} changes nothing. Write it as a deny rule to protect the path.`);
    else if (effect === "allow") grants.push(...grantsFor(parsed));
    else if (parsed.tool === "network") problems.push("Network is an allow rule; to keep commands offline, leave it out.");
    else deny.push({ parsed, text: rule.trim() });
  }
  const guard: ToolGuard = ({ subject }) => {
    const hit = deny.find((entry) => denies(entry.parsed, subject));
    return hit ? `The user's permission rules deny this (${hit.text}). Do not retry it; tell the user what you were trying to do.` : undefined;
  };
  return { grants, guard, problems };
}
