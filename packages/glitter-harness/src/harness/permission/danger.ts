import { innerScript, parseScript, programName, writesFile, type ParsedScript, type SimpleCommand } from "./shell.js";

/**
 * Commands that need more than the permission mode to run. `block` is final:
 * a deny-only guard refuses it in every mode. `ask` means the call is asked
 * about once, even when a thread grant would cover it, and it is never offered
 * a grant of its own. Rules read argv after wrappers such as `sudo` and
 * `env` are removed, and recurse into `bash -c` scripts. A script the shell
 * reader cannot parse is checked with the fallback patterns instead.
 */

export type Risk = { id: string; level: "block" | "ask"; reason: string };

type Rule = Risk & { test: (program: string, args: readonly string[]) => boolean };

/** Programs that run the rest of their argv as another command. */
export const WRAPPERS = new Set(["sudo", "doas", "env", "nice", "nohup", "time", "timeout", "command", "exec", "xargs", "stdbuf", "caffeinate", "ionice", "watch"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python2", "python3", "node", "deno", "bun", "perl", "ruby", "php", "lua", "osascript"]);
const ROOT_TARGETS = new Set(["/", "/*", "/.", "~", "~/", "~/*", "$HOME", "$HOME/", "$HOME/*", "${HOME}", "${HOME}/", "${HOME}/*"]);
const DEVICE = /^\/dev\/r?(?:disk|sd|hd|nvme|xvd)/;

const flagged = (args: readonly string[], short: string, ...long: string[]) =>
  args.some((arg) => long.includes(arg) || (/^-[A-Za-z]+$/.test(arg) && [...short].some((flag) => arg.includes(flag))));
const recursive = (args: readonly string[]) => flagged(args, "rR", "--recursive");
const sub = (args: readonly string[]) => args.find((arg) => !arg.startsWith("-"));

/** Git's global options precede the verb, and some consume the next word. */
export function gitCommandArgs(args: readonly string[]): readonly string[] {
  const withValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"]);
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--") return args.slice(index + 1);
    if (!arg.startsWith("-") || arg === "-") break;
    index += withValue.has(arg) ? 2 : 1;
  }
  return args.slice(index);
}

/** Inline code each interpreter accepts, by flag. */
const INLINE_CODE: Record<string, string[]> = {
  python: ["-c"], python2: ["-c"], python3: ["-c"], node: ["-e", "--eval", "-p", "--print"], bun: ["-e", "--eval"],
  perl: ["-e", "-E"], ruby: ["-e"], php: ["-r"], lua: ["-e"], osascript: ["-e"],
};

const RULES: Rule[] = [
  { id: "rm-root", level: "block", reason: "Deletes the whole disk or the home folder.", test: (program, args) => program === "rm" && recursive(args) && args.some((arg) => ROOT_TARGETS.has(arg)) },
  { id: "format-disk", level: "block", reason: "Formats or erases a disk.", test: (program, args) => program.startsWith("mkfs") || program.startsWith("newfs") || (program === "diskutil" && /^(?:erase|partitionDisk|zeroDisk|randomDisk|secureErase|reformat)/.test(sub(args) ?? "")) },
  { id: "write-device", level: "block", reason: "Writes raw data to a disk device.", test: (program, args) => program === "dd" && args.some((arg) => arg.startsWith("of=") && DEVICE.test(arg.slice(3))) },
  { id: "chmod-root", level: "block", reason: "Changes ownership or permissions across the whole disk or home folder.", test: (program, args) => ["chmod", "chown", "chgrp"].includes(program) && recursive(args) && args.some((arg) => ROOT_TARGETS.has(arg)) },
  { id: "rm-recursive", level: "ask", reason: "Deletes a folder and everything in it.", test: (program, args) => program === "rm" && recursive(args) },
  {
    id: "git-push-force", level: "ask", reason: "Overwrites or deletes history on the remote.",
    test: (program, args) => program === "git" && sub(args) === "push" && args.some((arg) => arg === "-f" || arg === "-d" || arg.startsWith("--force") || arg === "--mirror" || arg === "--delete" || arg === "--prune" || /^[+:]/.test(arg) || (/^-[A-Za-z]+$/.test(arg) && /[fd]/.test(arg))),
  },
  {
    id: "git-discard", level: "ask", reason: "Discards uncommitted changes.",
    test: (program, args) => {
      if (program !== "git") return false;
      const verb = sub(args);
      const rest = args.slice(args.indexOf(verb ?? "") + 1);
      if (verb === "reset") return rest.includes("--hard") || rest.includes("--merge");
      if (verb === "checkout") return rest.includes("--") || rest.includes(".") || flagged(rest, "f", "--force");
      if (verb === "restore") return !rest.includes("--staged") || rest.includes("--worktree") || flagged(rest, "W");
      if (verb === "clean") return flagged(rest, "f", "--force");
      if (verb === "stash") return rest[0] === "drop" || rest[0] === "clear";
      if (verb === "branch") return rest.includes("-D") || (flagged(rest, "d", "--delete") && flagged(rest, "f", "--force"));
      return false;
    },
  },
  {
    id: "git-rewrite", level: "ask", reason: "Rewrites local history.",
    test: (program, args) => program === "git" && (["rebase", "filter-branch", "filter-repo"].includes(sub(args) ?? "") || (sub(args) === "reflog" && /^(?:expire|delete)$/.test(args[args.indexOf("reflog") + 1] ?? "")) || (sub(args) === "update-ref" && args.includes("-d"))),
  },
  { id: "find-delete", level: "ask", reason: "Deletes, or runs a command on, every file it finds.", test: (program, args) => program === "find" && args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg)) },
  { id: "rsync-delete", level: "ask", reason: "Deletes files at the destination.", test: (program, args) => program === "rsync" && args.some((arg) => arg.startsWith("--delete") || arg === "--remove-source-files") },
  { id: "chmod-recursive", level: "ask", reason: "Changes ownership or permissions on a whole folder.", test: (program, args) => ["chmod", "chown", "chgrp"].includes(program) && recursive(args) },
  { id: "inline-code", level: "ask", reason: "Runs inline code that cannot be checked.", test: (program, args) => program === "eval" || (program === "deno" && sub(args) === "eval") || (INLINE_CODE[program]?.some((flag) => args.includes(flag)) ?? false) },
  { id: "kill-by-name", level: "ask", reason: "Stops other programs by name.", test: (program) => program === "killall" || program === "pkill" },
  { id: "destroy-contents", level: "ask", reason: "Destroys file contents.", test: (program) => program === "truncate" || program === "shred" || program === "srm" },
  {
    id: "publish", level: "ask", reason: "Publishes outside this Mac.",
    test: (program, args) => (["npm", "pnpm", "yarn", "cargo"].includes(program) && sub(args) === "publish") || (program === "gem" && sub(args) === "push") || (program === "twine" && sub(args) === "upload") || (program === "docker" && sub(args) === "push") || (program === "gh" && sub(args) === "release"),
  },
  { id: "keychain", level: "ask", reason: "Reads or changes the macOS keychain.", test: (program) => program === "security" },
  { id: "power", level: "ask", reason: "Restarts or shuts down the Mac.", test: (program) => ["shutdown", "reboot", "halt"].includes(program) },
];

/** For scripts the reader cannot parse. Coarser, so they only ever add caution. */
const FALLBACK: Array<Risk & { pattern: RegExp }> = [
  { id: "fork-bomb", level: "block", reason: "Starts a fork bomb.", pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { id: "rm-root", level: "block", reason: "Deletes the whole disk or the home folder.", pattern: /\brm\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:-\S+\s+)*(?:\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?)(?=$|[\s;&|)])/ },
  { id: "rm-recursive", level: "ask", reason: "Deletes a folder and everything in it.", pattern: /\brm\s+(?:-\S+\s+)*(?:-\S*[rR]|--recursive)/ },
  { id: "git-push-force", level: "ask", reason: "Overwrites or deletes history on the remote.", pattern: /\bgit\s+push\b[^;&|]*(?:\s-[A-Za-z]*[fd]\b|--force|--mirror|--delete|\s\+)/ },
  { id: "git-discard", level: "ask", reason: "Discards uncommitted changes.", pattern: /\bgit\s+(?:reset\s+[^;&|]*--hard|clean\s+[^;&|]*-[A-Za-z]*f|stash\s+(?:drop|clear)|checkout\s+[^;&|]*(?:--|\s\.)(?=$|\s))/ },
  { id: "pipe-to-shell", level: "ask", reason: "Runs code piped from another command.", pattern: /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\|\s*(?:python[23]?|node|perl|ruby|php)\b/ },
  { id: "admin", level: "ask", reason: "Runs as an administrator.", pattern: /(?:^|[\s;&|(])(?:sudo|doas)\s/ },
  { id: "inline-code", level: "ask", reason: "Runs inline code that cannot be checked.", pattern: /(?:^|[\s;&|(])eval\s|\b(?:python[23]?\s+-c|node\s+(?:-e|--eval|-p)|perl\s+-[eE]|ruby\s+-e)\b/ },
  { id: "find-delete", level: "ask", reason: "Deletes, or runs a command on, every file it finds.", pattern: /\bfind\b[^;&|]*\s-(?:delete|exec|execdir|ok)\b/ },
];

/** Strip wrappers from argv. `sudo` is itself a risk, reported through `admin`. */
function unwrap(argv: readonly string[]): { argv: readonly string[]; admin: boolean } {
  let rest = argv;
  let admin = false;
  while (rest.length && WRAPPERS.has(programName(rest[0]))) {
    const wrapper = programName(rest[0]);
    if (wrapper === "sudo" || wrapper === "doas") admin = true;
    rest = rest.slice(1);
    // Options, `NAME=value` for env, and a duration or priority for timeout and nice.
    while (rest.length && (rest[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]) || ((wrapper === "timeout" || wrapper === "nice") && /^-?\d+(?:\.\d+)?[smhd]?$/.test(rest[0])))) rest = rest.slice(1);
  }
  return { argv: rest, admin };
}

function commandRisks(command: SimpleCommand, stage: number, depth: number): Risk[] {
  const risks: Risk[] = [];
  if (command.redirects.some((redirect) => writesFile(redirect) && DEVICE.test(redirect.target))) risks.push({ id: "write-device", level: "block", reason: "Writes raw data to a disk device." });
  const { argv, admin } = unwrap(command.argv);
  if (admin) risks.push({ id: "admin", level: "ask", reason: "Runs as an administrator." });
  if (!argv.length) return risks;
  const program = programName(argv[0]);
  const args = argv.slice(1);
  const inner = innerScript({ ...command, argv: [...argv] });
  if (inner !== undefined) {
    risks.push(...(depth < 3 ? assessCommand(inner, depth + 1) : [{ id: "inline-code", level: "ask" as const, reason: "Runs inline code that cannot be checked." }]));
  } else if (stage > 0 && INTERPRETERS.has(program) && args.every((arg) => arg.startsWith("-"))) {
    // A shell or interpreter with no script file reads its program from the pipe.
    risks.push({ id: "pipe-to-shell", level: "ask", reason: "Runs code piped from another command." });
  }
  const riskArgs = program === "git" ? gitCommandArgs(args) : args;
  for (const rule of RULES) if (rule.test(program, riskArgs)) risks.push({ id: rule.id, level: rule.level, reason: rule.reason });
  return risks;
}

function scriptRisks(script: ParsedScript, depth: number): Risk[] {
  return script.pipelines.flatMap((pipeline) => pipeline.flatMap((command, stage) => commandRisks(command, stage, depth)));
}

/** Every risk in a script, blocks first, one entry per rule. */
export function assessCommand(source: string, depth = 0): Risk[] {
  const script = parseScript(source);
  const found = script ? scriptRisks(script, depth) : FALLBACK.filter((rule) => rule.pattern.test(source)).map(({ id, level, reason }) => ({ id, level, reason }));
  const unique = new Map<string, Risk>();
  for (const risk of found) if (!unique.has(risk.id)) unique.set(risk.id, risk);
  return [...unique.values()].sort((a, b) => (a.level === b.level ? 0 : a.level === "block" ? -1 : 1));
}
