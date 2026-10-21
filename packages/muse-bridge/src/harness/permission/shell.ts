/**
 * A deliberately small POSIX shell reader, for permission decisions only.
 * It splits a script into simple commands and records what the shell would do
 * to each word. It never guesses: anything it does not model (substitution,
 * subshells, here-documents, control flow) makes it return null, and a null
 * script is treated as unclassifiable by every caller.
 */

export type Redirect = { op: string; target: string };

export type SimpleCommand = {
  /** Words after quote removal, with `$NAME` and globs left as written. */
  argv: string[];
  /** Leading `NAME=value` words. */
  assignments: string[];
  redirects: Redirect[];
  /** A word holds a parameter expansion or a leading `~`, so the shell changes it before running. */
  dynamic: boolean;
  /** Indices into `argv` of words with an unquoted glob or brace expansion. */
  globbed: number[];
};

/** Commands joined by `|` run together; pipelines are joined by `&&`, `||`, `;`, `&` or a newline. */
export type ParsedScript = { pipelines: SimpleCommand[][] };

const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select", "time", "coproc", "!", "[[", "]]", "{", "}"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Word = { text: string; quoted: boolean; dynamic: boolean; glob: boolean; /** Text before the first quote, to recognise `NAME=`. */ bare: string };
type Token = { type: "word"; word: Word } | { type: "op"; op: string } | { type: "redirect"; op: string };

/** Split into words and operators, or null for a construct this reader does not model. */
function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  let word: Word | null = null;
  // Read through a call: the closures below reassign `word`, which flow narrowing cannot see.
  const pending = (): Word | null => word;
  const start = () => (word ??= { text: "", quoted: false, dynamic: false, glob: false, bare: "" });
  const push = (char: string, quoted: boolean) => {
    const current = start();
    current.text += char;
    if (!quoted && !current.quoted) current.bare += char;
    if (quoted) current.quoted = true;
  };
  const end = () => {
    if (word) tokens.push({ type: "word", word });
    word = null;
  };
  /** `$` at `index`: a parameter expansion marks the word dynamic; substitution is refused. */
  const dollar = (): boolean => {
    const next = source[index + 1];
    if (next === "(") return false;
    const current = start();
    if (next === "{") {
      const close = source.indexOf("}", index);
      if (close < 0) return false;
      current.text += source.slice(index, close + 1);
      current.dynamic = true;
      index = close + 1;
      return true;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9#?$!@*-])/.exec(source.slice(index + 1));
    if (!name) {
      current.text += "$";
      index += 1;
      return true;
    }
    current.text += `$${name[0]}`;
    current.dynamic = true;
    index += 1 + name[0].length;
    return true;
  };
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      const next = source[index + 1];
      if (next === undefined) return null;
      if (next !== "\n") push(next, true);
      index += 2;
      continue;
    }
    if (char === "'") {
      const close = source.indexOf("'", index + 1);
      if (close < 0) return null;
      start().quoted = true;
      for (const quoted of source.slice(index + 1, close)) push(quoted, true);
      index = close + 1;
      continue;
    }
    if (char === "\"") {
      start().quoted = true;
      index += 1;
      for (;;) {
        const inner = source[index];
        if (inner === undefined) return null;
        if (inner === "\"") { index += 1; break; }
        if (inner === "`") return null;
        if (inner === "$") { if (!dollar()) return null; continue; }
        if (inner === "\\" && "$`\"\\\n".includes(source[index + 1] ?? "")) {
          if (source[index + 1] !== "\n") push(source[index + 1], true);
          index += 2;
          continue;
        }
        push(inner, true);
        index += 1;
      }
      continue;
    }
    if (char === "`") return null;
    if (char === "$") { if (!dollar()) return null; continue; }
    if (char === " " || char === "\t") { end(); index += 1; continue; }
    if (char === "\n") { end(); tokens.push({ type: "op", op: ";" }); index += 1; continue; }
    if (char === "#" && !pending()) {
      const line = source.indexOf("\n", index);
      index = line < 0 ? source.length : line;
      continue;
    }
    if (char === "(" || char === ")") return null;
    if (char === "<" || char === ">") {
      if (source[index + 1] === "(") return null;
      // Digits written straight before the operator name a file descriptor.
      const open = pending();
      const fd = open && !open.quoted && /^\d+$/.test(open.text) ? open.text : "";
      if (fd) word = null;
      end();
      const op = /^(?:<<<|<<-?|<>|<&|>>|>&|>\||[<>])/.exec(source.slice(index))![0];
      if (op === "<<" || op === "<<-") return null;
      tokens.push({ type: "redirect", op: `${fd}${op}` });
      index += op.length;
      continue;
    }
    if (char === "|" || char === "&" || char === ";") {
      end();
      const op = /^(?:&&|\|\||\|&|;;|&>>|&>|[|&;])/.exec(source.slice(index))![0];
      if (op === ";;") return null;
      tokens.push(op.startsWith("&>") ? { type: "redirect", op } : { type: "op", op: op === "|&" ? "|" : op });
      index += op.length;
      continue;
    }
    if (char === "~" && !pending()) start().dynamic = true;
    if (char === "*" || char === "?" || char === "[") start().glob = true;
    if (char === "{" && /^\{[^}\s]*(?:,|\.\.)[^}\s]*\}/.test(source.slice(index))) start().glob = true;
    push(char, false);
    index += 1;
  }
  end();
  return tokens;
}

/** Parse a script, or return null when it uses anything this reader does not model. */
export function parseScript(source: string): ParsedScript | null {
  const tokens = tokenize(source);
  if (!tokens) return null;
  const pipelines: SimpleCommand[][] = [];
  let pipeline: SimpleCommand[] = [];
  let command: SimpleCommand | null = null;
  const fresh = (): SimpleCommand => ({ argv: [], assignments: [], redirects: [], dynamic: false, globbed: [] });
  /** Close the current command. A command of redirects alone (`> file`) is not modelled. */
  const finishCommand = (): "none" | "added" | "invalid" => {
    if (!command) return "none";
    if (!command.argv.length && !command.assignments.length) return "invalid";
    pipeline.push(command);
    command = null;
    return "added";
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "redirect") {
      // The target is a word; for `>&2` and `2>&1` it is a descriptor number, which `writesFile` allows.
      const target = tokens[index + 1];
      if (target?.type !== "word") return null;
      command ??= fresh();
      command.redirects.push({ op: token.op, target: target.word.text });
      if (target.word.dynamic) command.dynamic = true;
      index += 1;
      continue;
    }
    if (token.type === "op") {
      const closed = finishCommand();
      if (closed === "invalid") return null;
      if (token.op === "|") {
        if (closed !== "added") return null;
        continue;
      }
      if (closed === "none") {
        // A blank line, or a newline after `&&`, is fine. A leading `&&` or `a | ;` is not.
        if (pipeline.length || (token.op !== ";" && !pipelines.length)) return null;
        continue;
      }
      pipelines.push(pipeline);
      pipeline = [];
      continue;
    }
    command ??= fresh();
    const { word } = token;
    if (!command.argv.length && !word.quoted && KEYWORDS.has(word.text)) return null;
    const equals = word.bare.indexOf("=");
    if (!command.argv.length && equals > 0 && NAME.test(word.bare.slice(0, equals))) {
      command.assignments.push(word.text);
      if (word.dynamic) command.dynamic = true;
      continue;
    }
    if (word.dynamic) command.dynamic = true;
    if (word.glob) command.globbed.push(command.argv.length);
    command.argv.push(word.text);
  }
  const trailing = finishCommand();
  if (trailing === "invalid" || (trailing === "none" && pipeline.length)) return null;
  if (pipeline.length) pipelines.push(pipeline);
  return pipelines.length ? { pipelines } : null;
}

export function commandsOf(script: ParsedScript): SimpleCommand[] {
  return script.pipelines.flat();
}

/** Whether a redirect writes to a file. Reading, `/dev/null` and descriptor duplication do not. */
export function writesFile(redirect: Redirect): boolean {
  const op = redirect.op.replace(/^\d+/, "");
  if (op === "<" || op === "<<<" || op === "<&") return false;
  if ((op === ">&" || op === "<&") && /^(?:\d+|-)$/.test(redirect.target)) return false;
  return redirect.target !== "/dev/null";
}

/** The last path segment, so `/bin/rm` and `rm` are the same program. */
export function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** Shells that run their `-c` argument as a script. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/** The script inside `bash -c '…'` (or `-lc`), or undefined when the command is not that shape. */
export function innerScript(command: SimpleCommand): string | undefined {
  const [program, ...rest] = command.argv;
  if (!program || !SHELLS.has(programName(program))) return undefined;
  const flags = rest.slice(0, -1);
  const script = rest.at(-1);
  if (script === undefined || !flags.length) return undefined;
  if (!flags.every((flag) => /^-[lc]+$/.test(flag)) || !flags.some((flag) => flag.includes("c"))) return undefined;
  return script;
}
