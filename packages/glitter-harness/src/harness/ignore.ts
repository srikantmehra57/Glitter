import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/**
 * `.gitignore` for the search tools. Pure parsing plus a scope that carries the
 * rules down a walk, so a search skips what the project already treats as
 * generated. This is not Git: only `.gitignore` files in the workspace are read
 * (not `.git/info/exclude` or a global excludes file), and nothing here runs git,
 * which would run whatever the repository configured.
 */

type Rule = { negate: boolean; dirOnly: boolean; regex: RegExp };

/**
 * A `.gitignore` is text a repository supplies, and a pattern with many
 * wildcards backtracks badly on a long name. Patterns past this many wildcards
 * are left out, which only means a search looks at more, never less.
 */
const MAX_WILDCARDS = 3;
const MAX_RULES = 2000;
/** V8 compiles a regex on first use, so an enormous pattern fails there rather than where it is built. */
const MAX_PATTERN = 512;
type Layer = { base: string; rules: Rule[] };

const escapeRegex = (text: string) => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

function patternSource(pattern: string): string {
  let source = "";
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at];
    if (char === "*") {
      if (pattern[at + 1] === "*") {
        if (pattern[at + 2] === "/") { source += "(?:.*/)?"; at += 2; } else { source += ".*"; at += 1; }
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = pattern.indexOf("]", at + 2);
      if (end > at) { source += `[${pattern.slice(at + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`; at = end; } else source += "\\[";
    } else if (char === "\\" && at + 1 < pattern.length) { source += escapeRegex(pattern[at + 1]); at += 1; }
    else source += escapeRegex(char);
  }
  return source;
}

/** The rules of one `.gitignore`, in order. Blank lines, comments and patterns that cannot be read are dropped. */
export function parseIgnore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // trimEnd, not a regex: a long run of spaces would rescan itself from every position.
    let line = raw.trimEnd();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (!line || line.length > MAX_PATTERN || rules.length >= MAX_RULES) continue;
    if ((line.match(/\*+|\?|\[/g) ?? []).length > MAX_WILDCARDS) continue;
    // A slash anywhere but the end ties the pattern to this folder; otherwise it matches at any depth.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    try { rules.push({ negate, dirOnly, regex: new RegExp(anchored ? `^${patternSource(line)}$` : `^(?:.*/)?${patternSource(line)}$`) }); } catch { /* an unreadable pattern ignores nothing */ }
  }
  return rules;
}

/** The ignore rules in force at one folder: every `.gitignore` from the workspace root down to it. */
export class IgnoreScope {
  private constructor(private readonly layers: readonly Layer[]) {}

  /** Scope for `dir`, reading the `.gitignore` of every folder from `root` to `dir`. */
  static async at(root: string, dir: string): Promise<IgnoreScope> {
    const down = relative(root, dir);
    if (down.startsWith("..")) return new IgnoreScope([]);
    let scope = new IgnoreScope([]);
    let current = root;
    scope = await scope.into(current);
    for (const part of down ? down.split(sep) : []) {
      current = join(current, part);
      scope = await scope.into(current);
    }
    return scope;
  }

  /** The scope inside `dir`, which adds that folder's own `.gitignore`. */
  async into(dir: string): Promise<IgnoreScope> {
    const text = await readFile(join(dir, ".gitignore"), "utf8").catch(() => "");
    const rules = text ? parseIgnore(text.slice(0, 256 * 1024)) : [];
    return rules.length ? new IgnoreScope([...this.layers, { base: dir, rules }]) : this;
  }

  /** Whether the project's `.gitignore` files exclude this path. The last matching rule wins, deeper files after shallower ones. */
  ignores(path: string, isDirectory: boolean): boolean {
    let ignored = false;
    for (const layer of this.layers) {
      const rel = relative(layer.base, path).split(sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      for (const rule of layer.rules) {
        if (rule.dirOnly && !isDirectory) continue;
        if (rule.regex.test(rel)) ignored = !rule.negate;
      }
    }
    return ignored;
  }
}
