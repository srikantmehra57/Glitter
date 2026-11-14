/**
 * Protected paths: files whose change outlives the turn or reaches past the
 * workspace. Agent instructions (`AGENTS.md`, `CLAUDE.md`) and skills are read
 * by every later thread; `.env` and `.envrc` hold secrets and `direnv` runs
 * `.envrc`; key files are credentials. An edit tool asks before each change to
 * one, in every permission mode, Full access included, and is offered no grant;
 * the shell's sandbox cannot write them at all. `.git` is stricter still and is
 * refused outright (`gitControlGuard`).
 *
 * A pattern is a glob over workspace-relative `/` paths: a bare name such as
 * `.env` or `*.pem` matches at any depth, a pattern with a `/` is anchored at
 * the workspace root, and `folder/**` covers the folder and everything in it.
 * Files under `node_modules` are not protected: installs write fixtures there.
 */

export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  "AGENTS.md", "CLAUDE.md", ".glitter/**", ".agents/**",
  ".env", ".env.*", ".envrc",
  "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
];

/** Mirrors the native DTO's limits. */
export const PROTECTED_PATH_LIMIT = 100;
export const PROTECTED_PATH_LENGTH = 200;

/** Why a pattern cannot be used, or null. */
export function protectedPathProblem(pattern: string): string | null {
  const text = pattern.trim();
  if (!text) return "Write a path or pattern, such as .env or secrets/**.";
  if (new TextEncoder().encode(text).length > PROTECTED_PATH_LENGTH) return `A pattern is at most ${PROTECTED_PATH_LENGTH} bytes.`;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) return "A pattern cannot contain control characters.";
  if (text.startsWith("/") || text.startsWith("~")) return "A pattern names a path inside the workspace.";
  if (text.split("/").some((part) => part === ".." || part === "." || part === "")) return "A pattern cannot contain empty, . or .. parts.";
  if (/[[\]{}\\"]/.test(text)) return "A pattern may use * and ? only.";
  if (text === "**" || text === "*") return "That would protect every file; use a narrower pattern.";
  return null;
}

/** Valid, unique patterns in order; invalid ones are dropped. */
export function normalizeProtectedPaths(patterns: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const entry of patterns) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (protectedPathProblem(text) || out.includes(text)) continue;
    out.push(text);
    if (out.length >= PROTECTED_PATH_LIMIT) break;
  }
  return out;
}

const caseFolds = () => process.platform === "darwin" || process.platform === "win32";

/**
 * One pattern as regex source over the path after the workspace root. The
 * edit check and the shell's sandbox use this same source, so they agree on
 * which files a pattern names.
 */
function patternSource(pattern: string): string {
  const folder = pattern.endsWith("/**") ? pattern.slice(0, -3) : undefined;
  const body = folder ?? pattern;
  const anchored = folder !== undefined || body.includes("/");
  return `${anchored ? "" : "(.*/)?"}${seatbeltGlob(body)}${folder !== undefined ? "(/.*)?" : ""}$`;
}

function patternRegex(pattern: string): RegExp {
  return new RegExp(`^${patternSource(pattern)}`, caseFolds() ? "i" : "");
}

export type ProtectedPaths = { patterns: readonly string[]; matches: (path: string) => string | undefined };

/** A matcher that answers with the pattern a workspace-relative path falls under. */
export function compileProtectedPaths(patterns: readonly string[]): ProtectedPaths {
  const compiled = normalizeProtectedPaths(patterns).map((pattern) => ({ pattern, regex: patternRegex(pattern) }));
  return {
    patterns: compiled.map((entry) => entry.pattern),
    matches: (path) => {
      if (path.split("/").some((part) => part.toLowerCase() === "node_modules")) return undefined;
      return compiled.find((entry) => entry.regex.test(path))?.pattern;
    },
  };
}

/** A glob as seatbelt regex source (POSIX extended, no `(?:`), over the part after the root. */
function seatbeltGlob(glob: string): string {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      source += glob[index + 2] === "/" ? "(.*/)?" : ".*";
      index += glob[index + 2] === "/" ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^$()|[\]{}\\/"]/g, "\\$&");
  }
  return source;
}

const escapeRoot = (root: string) => root.replace(/[.*+?^$()|[\]{}\\/"]/g, "\\$&");

/**
 * Seatbelt rules that deny writes to the protected paths under each root, then
 * give `node_modules` back. Seatbelt matches the way APFS does, so a case
 * variant is denied too. For an anchored pattern, each folder above it is
 * denied as well, so the shell cannot rename a parent away, fill it, and
 * rename it back.
 */
export function protectedSeatbeltRules(roots: readonly string[], patterns: readonly string[]): string {
  const valid = normalizeProtectedPaths(patterns);
  if (!roots.length || !valid.length) return "";
  const deny: string[] = [];
  const allow: string[] = [];
  for (const root of roots) {
    const base = `^${escapeRoot(root)}/`;
    for (const pattern of valid) {
      deny.push(`(regex #"${base}${patternSource(pattern)}")`);
      const body = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
      if (body.includes("/") || body !== pattern) {
        const parts = body.split("/");
        for (let depth = 1; depth < parts.length; depth += 1) deny.push(`(regex #"${base}${seatbeltGlob(parts.slice(0, depth).join("/"))}$")`);
      }
    }
    allow.push(`(regex #"${base}(.*/)?node_modules/")`);
  }
  return `(deny file-write* ${deny.join(" ")})\n(allow file-write* ${allow.join(" ")})\n`;
}
