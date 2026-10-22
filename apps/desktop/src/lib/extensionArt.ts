/**
 * The thumbnail an extension gets: one icon and one tint, so a list of skills,
 * plugins and servers can be told apart at a glance instead of repeating the
 * same glyph on every row. Store entries are mapped by id; anything else (a
 * skill the user wrote, a CLI plugin) is matched on its name, then falls back
 * to its kind with a tint picked from its name so it stays stable.
 */
export type ExtensionKind = "skill" | "plugin" | "mcp";
export type ExtensionIcon =
  | "review" | "commit" | "pull-request" | "test" | "debug" | "refactor" | "security" | "performance" | "design" | "docs" | "explain" | "release"
  | "folder" | "steps" | "memory" | "web" | "time" | "browser" | "library" | "compass" | "database" | "api" | "terminal" | "daily" | "quality"
  | "skill" | "plugin" | "server";
export const EXTENSION_TONES = ["ember", "blue", "violet", "pink", "green", "teal", "yellow", "slate"] as const;
export type ExtensionTone = (typeof EXTENSION_TONES)[number];
export type ExtensionArt = { icon: ExtensionIcon; tone: ExtensionTone };

const BY_ID: Record<string, ExtensionArt> = {
  "code-review": { icon: "review", tone: "blue" },
  "commit-message": { icon: "commit", tone: "ember" },
  "pr-description": { icon: "pull-request", tone: "violet" },
  "test-first": { icon: "test", tone: "green" },
  debug: { icon: "debug", tone: "pink" },
  refactor: { icon: "refactor", tone: "teal" },
  "security-review": { icon: "security", tone: "slate" },
  performance: { icon: "performance", tone: "yellow" },
  "frontend-design": { icon: "design", tone: "pink" },
  "docs-writer": { icon: "docs", tone: "blue" },
  "explain-code": { icon: "explain", tone: "yellow" },
  "release-notes": { icon: "release", tone: "violet" },
  filesystem: { icon: "folder", tone: "teal" },
  "sequential-thinking": { icon: "steps", tone: "violet" },
  memory: { icon: "memory", tone: "pink" },
  fetch: { icon: "web", tone: "blue" },
  time: { icon: "time", tone: "yellow" },
  playwright: { icon: "browser", tone: "green" },
  context7: { icon: "library", tone: "ember" },
  deepwiki: { icon: "compass", tone: "slate" },
  "daily-driver": { icon: "daily", tone: "ember" },
  "quality-gate": { icon: "quality", tone: "green" },
  frontend: { icon: "design", tone: "violet" },
  "docs-and-release": { icon: "docs", tone: "teal" },
};

/** Words in a name that say what the extension is for, most specific first. */
const BY_WORD: Array<[RegExp, ExtensionIcon]> = [
  [/security|secret|vuln|audit/, "security"],
  [/pull[- ]?request|\bpr\b/, "pull-request"],
  [/commit|\bgit\b/, "commit"],
  [/review|lint|check/, "review"],
  [/test|tdd|spec/, "test"],
  [/debug|bug|fix|trace/, "debug"],
  [/refactor|clean|tidy/, "refactor"],
  [/perf|speed|bench|profil/, "performance"],
  [/design|ui\b|ux|frontend|css|style/, "design"],
  [/doc|readme|wiki|write/, "docs"],
  [/explain|learn|teach/, "explain"],
  [/release|deploy|ship|changelog/, "release"],
  [/file|folder|fs\b/, "folder"],
  [/think|plan|step/, "steps"],
  [/memory|remember|note/, "memory"],
  [/browser|playwright|puppeteer|selenium/, "browser"],
  [/fetch|http|web|url|search/, "web"],
  [/time|clock|date|calendar/, "time"],
  [/sql|postgres|database|\bdb\b|sqlite|mongo|redis/, "database"],
  [/api|graphql|webhook|stripe|slack|github|linear|jira/, "api"],
  [/shell|terminal|bash|command/, "terminal"],
];

const FALLBACK: Record<ExtensionKind, ExtensionIcon> = { skill: "skill", plugin: "plugin", mcp: "server" };

function toneFor(name: string): ExtensionTone {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return EXTENSION_TONES[hash % EXTENSION_TONES.length];
}

export function extensionArt(kind: ExtensionKind, id: string, name = id): ExtensionArt {
  const known = BY_ID[id];
  if (known) return known;
  const text = `${id} ${name}`.toLowerCase();
  const icon = BY_WORD.find(([pattern]) => pattern.test(text))?.[1] ?? FALLBACK[kind];
  return { icon, tone: toneFor(id || name) };
}
