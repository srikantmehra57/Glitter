import { commandsOf, parseScript, programName, type SimpleCommand } from "./shell.js";

/**
 * What a call acts on, and the thread grants that can cover it. A grant names
 * the subject the user approved: one command, a command prefix, one file or a
 * folder, or one MCP tool or server. Never a whole tool kind: "allow
 * `git status`" cannot cover `git push --force`. The approval card offers the
 * narrowest scope first, so a client that shows only the first thread choice
 * grants the least.
 */

export type Subject =
  /** `network` marks a command that asked for internet access; the shell runs offline otherwise. */
  | { kind: "command"; command: string; network?: boolean }
  /** Workspace-relative, `/`-separated. */
  | { kind: "path"; path: string }
  /** One tool on one external MCP server. */
  | { kind: "mcp"; server: string; tool: string }
  /** Read-only browser work, or control on the current/target web origin. */
  | { kind: "browser"; control: boolean; origin: string }
  /** A web fetch from one origin, or (`search`) a query to the configured search provider. */
  | { kind: "web"; origin: string; search?: boolean }
  | { kind: "none" };

export type Grant =
  /** `network` extends an exact grant to the internet access that command asked for. */
  | { kind: "command"; match: "exact"; command: string; network?: boolean }
  | { kind: "command"; match: "prefix"; argv: readonly string[] }
  /** `folder` with an empty path is the whole workspace. */
  | { kind: "path"; match: "file" | "folder"; path: string }
  | { kind: "mcp"; match: "tool"; server: string; tool: string }
  | { kind: "mcp"; match: "server"; server: string }
  | { kind: "browser"; origin: string }
  /** Internet access for any command the thread already runs; the command itself still needs its own permission. */
  | { kind: "network" }
  /** Web fetches from one origin, or `search` for the search provider. */
  | { kind: "web"; origin: string; search?: boolean };

export type GrantScope = {
  choiceId: string;
  /** The button text for a client that lists every choice. */
  label: string;
  /** The picker text for a client that groups thread choices. */
  scopeLabel: string;
  grant: Grant;
};

/** Programs that run whatever comes after them: a prefix grant on one would cover any command. */
const WRAPPERS = new Set(["env", "sudo", "doas", "xargs", "time", "timeout", "nice", "nohup", "command", "exec", "builtin", "watch", "caffeinate", "stdbuf", "ionice", "chroot", "script", "eval", "source", "."]);
/** Programs that run arbitrary code: a grant on the program alone would cover any script. */
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "deno", "bun", "bunx", "npx", "pnpx", "perl", "ruby", "php", "lua", "osascript"]);
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9:_-]*$/;

const normalize = (command: string) => command.trim();
const code = (text: string) => `\`${text}\``;

/** A command a prefix grant may cover: plain words only, with no redirections. */
function plain(command: SimpleCommand): boolean {
  return !command.dynamic && !command.assignments.length && !command.globbed.length && !command.redirects.length;
}

/**
 * Path comparison as the workspace's file system makes it: case-insensitive on
 * macOS and Windows, where `.ENV` is the same file as `.env`. Deny rules use
 * the same comparison, so allow and deny agree on which file a path names.
 */
export const foldPath = (path: string) => (process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path);

function prefixCovers(prefix: readonly string[], argv: readonly string[]): boolean {
  return prefix.length <= argv.length && prefix.every((word, index) => argv[index] === word);
}

/**
 * Whether the grants cover this subject. A prefix grant covers a script only
 * when every command in it starts with a granted prefix, so an apparently
 * read-only helper cannot ride along with an unrelated grant.
 */
export function covers(grants: readonly Grant[], subject: Subject): boolean {
  if (subject.kind === "none") return false;
  if (subject.kind === "mcp") {
    return grants.some((grant) => grant.kind === "mcp" && grant.server === subject.server && (grant.match === "server" || grant.tool === subject.tool));
  }
  if (subject.kind === "path") {
    const path = foldPath(subject.path);
    return grants.some((grant) => grant.kind === "path" && (grant.match === "file" ? foldPath(grant.path) === path : grant.path === "" || path.startsWith(`${foldPath(grant.path)}/`)));
  }
  if (subject.kind === "browser") {
    return Boolean(subject.origin) && grants.some((grant) => grant.kind === "browser" && grant.origin === subject.origin);
  }
  if (subject.kind === "web") {
    return grants.some((grant) => grant.kind === "web" && (subject.search ? grant.search === true : !grant.search && grant.origin === subject.origin));
  }
  const command = normalize(subject.command);
  if (grants.some((grant) => grant.kind === "command" && grant.match === "exact" && grant.command === command)) return true;
  const prefixes = grants.flatMap((grant) => (grant.kind === "command" && grant.match === "prefix" ? [grant.argv] : []));
  if (!prefixes.length) return false;
  const script = parseScript(command);
  if (!script) return false;
  let granted = false;
  for (const part of commandsOf(script)) {
    if (!plain(part) || !prefixes.some((prefix) => prefixCovers(prefix, part.argv))) return false;
    granted = true;
  }
  return granted;
}

/** Whether the thread lets this command go online: an exact grant that included the network, or the thread-wide network grant. */
export function coversNetwork(grants: readonly Grant[], subject: Subject): boolean {
  if (subject.kind !== "command" || !subject.network) return true;
  const command = normalize(subject.command);
  return grants.some((grant) => grant.kind === "network" || (grant.kind === "command" && grant.match === "exact" && grant.network === true && grant.command === command));
}

/** The grants to offer for a command that asked for the network. `commandAllowed` says the command alone would already run. */
export function networkScopes(subject: Extract<Subject, { kind: "command" }>, commandAllowed: boolean): GrantScope[] {
  const command = normalize(subject.command);
  const scopes: GrantScope[] = [{ choiceId: "allow-session", label: "Allow this command, online, in this thread", scopeLabel: "This exact command, online", grant: { kind: "command", match: "exact", command, network: true } }];
  if (commandAllowed) scopes.push({ choiceId: "allow-session-network", label: "Allow internet access for commands in this thread", scopeLabel: "Internet for any command", grant: { kind: "network" } });
  return scopes;
}

/** The thread grants to offer for a subject, narrowest first. */
export function scopesFor(subject: Subject): GrantScope[] {
  if (subject.kind === "none") return [];
  if (subject.kind === "mcp") {
    return [
      { choiceId: "allow-session", label: `Allow ${code(subject.tool)} on ${code(subject.server)} in this thread`, scopeLabel: "This tool", grant: { kind: "mcp", match: "tool", server: subject.server, tool: subject.tool } },
      { choiceId: "allow-session-server", label: `Allow every tool on ${code(subject.server)} in this thread`, scopeLabel: `Any tool on ${subject.server}`, grant: { kind: "mcp", match: "server", server: subject.server } },
    ];
  }
  if (subject.kind === "web") {
    if (subject.search) return [{ choiceId: "allow-session", label: "Allow web searches in this thread", scopeLabel: "Web search", grant: { kind: "web", origin: "", search: true } }];
    return [{ choiceId: "allow-session", label: `Allow fetching from ${code(subject.origin)} in this thread`, scopeLabel: `Fetches from ${subject.origin}`, grant: { kind: "web", origin: subject.origin } }];
  }
  if (subject.kind === "browser") {
    if (!subject.origin) return [];
    return [{ choiceId: "allow-session", label: `Allow browser control on ${code(subject.origin)} in this thread`, scopeLabel: `Browser on ${subject.origin}`, grant: { kind: "browser", origin: subject.origin } }];
  }
  if (subject.kind === "path") {
    const scopes: GrantScope[] = [{ choiceId: "allow-session", label: "Allow edits to this file in this thread", scopeLabel: "This file", grant: { kind: "path", match: "file", path: subject.path } }];
    const folder = subject.path.includes("/") ? subject.path.slice(0, subject.path.lastIndexOf("/")) : "";
    if (folder) scopes.push({ choiceId: "allow-session-folder", label: `Allow edits in ${code(`${folder}/`)} in this thread`, scopeLabel: `Files in ${folder}/`, grant: { kind: "path", match: "folder", path: folder } });
    scopes.push({ choiceId: "allow-session-workspace", label: "Allow all edits in this thread", scopeLabel: "Any file in the workspace", grant: { kind: "path", match: "folder", path: "" } });
    return scopes;
  }
  const command = normalize(subject.command);
  const scopes: GrantScope[] = [{ choiceId: "allow-session", label: "Allow this command in this thread", scopeLabel: "This exact command", grant: { kind: "command", match: "exact", command } }];
  const script = parseScript(command);
  if (!script) return scopes;
  // Compound scripts get an exact grant: any part may execute a helper or read
  // outside the workspace even when its command name looks read-only.
  const parts = commandsOf(script);
  if (parts.length !== 1 || !plain(parts[0])) return scopes;
  const argv = parts[0].argv;
  const program = programName(argv[0]);
  if (WRAPPERS.has(program)) return scopes;
  if (argv.length > 2 && SUBCOMMAND.test(argv[1])) {
    const prefix = argv.slice(0, 2);
    scopes.push({ choiceId: "allow-session-prefix", label: `Allow ${code(`${prefix.join(" ")} …`)} in this thread`, scopeLabel: `${prefix.join(" ")} …`, grant: { kind: "command", match: "prefix", argv: prefix } });
  }
  if (argv.length > 1 && !INTERPRETERS.has(program)) {
    scopes.push({ choiceId: "allow-session-program", label: `Allow every ${code(argv[0])} command in this thread`, scopeLabel: `Any ${argv[0]} command`, grant: { kind: "command", match: "prefix", argv: [argv[0]] } });
  }
  return scopes;
}
