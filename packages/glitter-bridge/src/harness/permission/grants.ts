import { isReadOnlyCommand } from "./classify.js";
import { commandsOf, parseScript, programName, writesFile, type SimpleCommand } from "./shell.js";

/**
 * What a call acts on, and the thread grants that can cover it. A grant names
 * the subject the user approved: one command, a command prefix, one file or a
 * folder. Never a whole tool kind: "allow `git status`" cannot cover
 * `git push --force`. The approval card offers the narrowest scope first, so a
 * client that shows only the first thread choice grants the least.
 */

export type Subject =
  | { kind: "command"; command: string }
  /** Workspace-relative, `/`-separated. */
  | { kind: "path"; path: string }
  | { kind: "none" };

export type Grant =
  | { kind: "command"; match: "exact"; command: string }
  | { kind: "command"; match: "prefix"; argv: readonly string[] }
  /** `folder` with an empty path is the whole workspace. */
  | { kind: "path"; match: "file" | "folder"; path: string };

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

/** A command a prefix grant may cover: plain words only, no assignments and no file writes. */
function plain(command: SimpleCommand): boolean {
  return !command.dynamic && !command.assignments.length && !command.globbed.length && !command.redirects.some(writesFile);
}

function prefixCovers(prefix: readonly string[], argv: readonly string[]): boolean {
  return prefix.length <= argv.length && prefix.every((word, index) => argv[index] === word);
}

/**
 * Whether the grants cover this subject. A prefix grant covers a script only
 * when every command in it is read-only or starts with a granted prefix, so
 * `npm test && curl …` is not covered by a grant for `npm test`.
 */
export function covers(grants: readonly Grant[], subject: Subject): boolean {
  if (subject.kind === "none") return false;
  if (subject.kind === "path") {
    return grants.some((grant) => grant.kind === "path" && (grant.match === "file" ? grant.path === subject.path : grant.path === "" || subject.path.startsWith(`${grant.path}/`)));
  }
  const command = normalize(subject.command);
  if (grants.some((grant) => grant.kind === "command" && grant.match === "exact" && grant.command === command)) return true;
  const prefixes = grants.flatMap((grant) => (grant.kind === "command" && grant.match === "prefix" ? [grant.argv] : []));
  if (!prefixes.length) return false;
  const script = parseScript(command);
  if (!script) return false;
  let granted = false;
  for (const part of commandsOf(script)) {
    if (isReadOnlyCommand(part)) continue;
    if (!plain(part) || !prefixes.some((prefix) => prefixCovers(prefix, part.argv))) return false;
    granted = true;
  }
  return granted;
}

/** The thread grants to offer for a subject, narrowest first. */
export function scopesFor(subject: Subject): GrantScope[] {
  if (subject.kind === "none") return [];
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
  // A prefix is offered only when one command in the script needs approval: the rest must be read-only.
  const needs = commandsOf(script).filter((part) => !isReadOnlyCommand(part));
  if (needs.length !== 1 || !plain(needs[0])) return scopes;
  const argv = needs[0].argv;
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
