import { commandsOf, innerScript, parseScript, writesFile, type SimpleCommand } from "./shell.js";

/**
 * Known read-only commands, after OpenAI Codex's `is_safe_command.rs` (the
 * list MiniMax Code ported). A command this accepts reads and prints, and can
 * run without asking in any permission mode. It is an allow-list: anything not
 * recognised, or recognised with a flag that can write or execute, is not
 * read-only, and the normal permission mode decides.
 *
 * Stricter than Codex in one way: the shell can read outside the workspace,
 * while the harness's read tools cannot. So an argument that is an absolute
 * path, starts with `~`, or has a `..` segment makes the command ask instead.
 * A symlink inside the workspace that points out of it is not detected here.
 */

const ALWAYS_SAFE = new Set(["cat", "cd", "cut", "echo", "expr", "false", "grep", "head", "id", "ls", "nl", "paste", "pwd", "rev", "seq", "stat", "tail", "tr", "true", "uname", "uniq", "wc", "which", "whoami"]);

const UNSAFE_FIND = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fls", "-fprint", "-fprint0", "-fprintf"]);
/** `--pre` runs a program on every file; `--hostname-bin` runs one; `-z` decompresses through external tools. */
const UNSAFE_RG_WITH_VALUE = ["--pre", "--hostname-bin"];
const UNSAFE_RG_FLAGS = new Set(["--search-zip", "-z"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show"]);
/** `--output` writes a file; external diff and text conversion run configured programs. */
const UNSAFE_GIT_FLAGS = /^(?:--output(?:=|$)|--ext-diff$|--textconv$)/;
const LISTING_BRANCH_FLAGS = new Set(["--list", "-l", "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--no-color", "--color"]);

/** Whether a word could reach outside the workspace: absolute, home-relative, or through `..`. */
function leavesWorkspace(word: string): boolean {
  if (word.startsWith("/") || word.startsWith("~")) return true;
  return word.split(/[/=]/).includes("..");
}

/** A glob such as `.*` or `src/.?` can expand to `..`. */
function globReachesParent(word: string): boolean {
  return /(?:^|[/=])\.[*?[]/.test(word);
}

function shortFlagsInclude(word: string, flag: string): boolean {
  return /^-[A-Za-z]+$/.test(word) && word.includes(flag);
}

/** The per-program rules, for a command whose words are already known to be plain. */
function programIsReadOnly(argv: readonly string[], globbed: readonly number[]): boolean {
  const [program, ...args] = argv;
  // A bare `cd` or `cd -` moves to a folder outside the workspace, where later relative reads would land.
  if (program === "cd") return args.length === 1 && args[0] !== "-";
  if (ALWAYS_SAFE.has(program)) return true;
  // Option checks below read words literally, so a glob that could expand to a flag disqualifies them.
  if (globbed.length) return false;
  switch (program) {
    case "base64":
      return !args.some((arg) => arg === "-o" || arg === "--output" || arg.startsWith("--output=") || /^-o./.test(arg));
    case "find":
      return !args.some((arg) => UNSAFE_FIND.has(arg));
    case "rg":
      return !args.some((arg) => UNSAFE_RG_FLAGS.has(arg) || shortFlagsInclude(arg, "z") || UNSAFE_RG_WITH_VALUE.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
    case "git": {
      // An option before the subcommand (`-c`, `-C`, `--exec-path`) can point git at other programs.
      const [subcommand, ...rest] = args;
      if (!subcommand || subcommand.startsWith("-")) return false;
      if (READ_ONLY_GIT.has(subcommand)) return !rest.some((arg) => UNSAFE_GIT_FLAGS.test(arg));
      if (subcommand === "branch") return rest.every((arg) => LISTING_BRANCH_FLAGS.has(arg));
      return false;
    }
    case "sed":
      // Only `sed -n 10p` or `sed -n 10,20p`, with at most one file.
      return args.length >= 2 && args.length <= 3 && args[0] === "-n" && /^\d+(?:,\d+)?p$/.test(args[1]);
    default:
      return false;
  }
}

/** Whether one simple command only reads. `depth` bounds `bash -c` unwrapping. */
export function isReadOnlyCommand(command: SimpleCommand, depth = 0): boolean {
  if (command.assignments.length || command.dynamic || !command.argv.length) return false;
  // No file is written, and an input file is read from inside the workspace.
  if (command.redirects.some((redirect) => writesFile(redirect) || (redirect.target !== "/dev/null" && !/^(?:\d+|-)$/.test(redirect.target) && leavesWorkspace(redirect.target)))) return false;
  const inner = innerScript(command);
  if (inner !== undefined) return depth < 2 && isReadOnly(inner, depth + 1);
  // A program named by path could be anything; only bare names are recognised.
  if (command.argv[0].includes("/")) return false;
  if (command.argv.slice(1).some(leavesWorkspace)) return false;
  if (command.globbed.some((index) => globReachesParent(command.argv[index]))) return false;
  return programIsReadOnly(command.argv, command.globbed);
}

/** Whether a whole script only reads: it parses, and every command in it is read-only. */
export function isReadOnly(source: string, depth = 0): boolean {
  const script = parseScript(source);
  return script != null && commandsOf(script).every((command) => isReadOnlyCommand(command, depth));
}
