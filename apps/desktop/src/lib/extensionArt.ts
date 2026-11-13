/**
 * The thumbnail an extension gets: one icon and one tint, so a list of skills,
 * plugins and servers can be told apart at a glance instead of repeating the
 * same glyph on every row. Store entries are mapped by id; anything else (a
 * skill the user wrote, a plugin from GitHub) is matched on its name, then on
 * its marketplace category, then falls back to its kind, with a tint picked
 * from its name so it stays stable.
 */
export type ExtensionKind = "skill" | "plugin" | "mcp";
export type ExtensionIcon =
  | "review" | "commit" | "pull-request" | "test" | "debug" | "refactor" | "security" | "performance" | "design" | "docs" | "explain" | "release"
  | "folder" | "steps" | "memory" | "web" | "time" | "browser" | "library" | "compass" | "database" | "api" | "terminal" | "daily" | "quality"
  | "document" | "spreadsheet" | "slides" | "image" | "video" | "audio" | "cloud" | "container" | "mobile" | "agent" | "plug" | "mail"
  | "chart" | "monitor" | "lock" | "art" | "game" | "learn" | "location" | "math" | "migrate" | "automation" | "language" | "code"
  | "productivity" | "payments" | "chat" | "deploy"
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
  // Featured GitHub repositories, by `owner/repo`.
  "anthropics/claude-plugins-official": { icon: "library", tone: "ember" },
  "anthropics/skills": { icon: "document", tone: "blue" },
  "obra/superpowers": { icon: "steps", tone: "yellow" },
  "openai/skills": { icon: "code", tone: "teal" },
  "anthropics/claude-code": { icon: "terminal", tone: "violet" },
};

/** Words in a name that say what the extension is for, most specific first. */
const BY_WORD: Array<[RegExp, ExtensionIcon]> = [
  [/security|secret|vuln|audit|owasp/, "security"],
  [/auth|login|oauth|password|vault|1password/, "lock"],
  [/pull[- ]?request|\bpr\b/, "pull-request"],
  [/commit|\bgit\b|branch/, "commit"],
  [/review|lint|check/, "review"],
  [/\btest|tdd|\bspec\b|\bqa\b/, "test"],
  [/debug|bug|fix|trace|sentry/, "debug"],
  [/refactor|clean|tidy|simplif|moderni/, "refactor"],
  [/perf|speed|bench|profil/, "performance"],
  [/deploy|vercel|netlify|render|heroku|fly\b/, "deploy"],
  [/cloud|aws|azure|gcp|google cloud|cloudflare/, "cloud"],
  [/docker|kubernetes|k8s|container|terraform|helm/, "container"],
  [/ios|android|mobile|swift|kotlin|expo/, "mobile"],
  [/xlsx|excel|sheet|csv/, "spreadsheet"],
  [/pptx|slide|deck|keynote|powerpoint/, "slides"],
  [/pdf|docx|\bword\b|document/, "document"],
  [/image|photo|picture|imagegen|screenshot|png|svg/, "image"],
  [/video|film|movie|youtube|remotion/, "video"],
  [/audio|speech|voice|music|sound|transcri|podcast/, "audio"],
  [/\bart\b|artwork|canvas|paint|draw|illustrat|\bgif\b/, "art"],
  [/design|ui\b|ux|frontend|css|style|theme|brand|figma/, "design"],
  [/doc|readme|wiki|write|notion|confluence/, "docs"],
  [/explain|learn|teach|tutor|course|academy|onboard/, "learn"],
  [/release|changelog|version/, "release"],
  [/agent|subagent|orchestr|assistant|\bbot\b/, "agent"],
  [/mcp|connector|integration|plugin-creator/, "plug"],
  [/mail|gmail|inbox|outlook/, "mail"],
  [/slack|discord|teams|chat|message|comms/, "chat"],
  [/stripe|payment|billing|invoice|checkout/, "payments"],
  [/analytic|metric|chart|dashboard|insight|amplitude|posthog/, "chart"],
  [/monitor|observab|datadog|grafana|log\b|logs|alert|incident/, "monitor"],
  [/game|unity|godot/, "game"],
  [/map|geo|location|place/, "location"],
  [/math|calc|numer|stat\b|statistic/, "math"],
  [/migrat|upgrade|convert/, "migrate"],
  [/automat|workflow|pipeline|\bci\b|cron|zapier/, "automation"],
  [/lsp|language server|clangd|pyright|rust-analyzer|gopls|typescript-lsp/, "language"],
  [/file|folder|fs\b/, "folder"],
  [/think|plan|step|brainstorm/, "steps"],
  [/memory|remember|note/, "memory"],
  [/browser|playwright|puppeteer|selenium|chrome/, "browser"],
  [/fetch|http|web|url|search|scrape|crawl/, "web"],
  [/time|clock|date|calendar|schedul/, "time"],
  [/sql|postgres|database|\bdb\b|sqlite|mongo|redis|supabase|firebase|prisma|convex/, "database"],
  [/api|graphql|webhook|github|gitlab|linear|jira|asana/, "api"],
  [/shell|terminal|bash|command|cli\b/, "terminal"],
  [/library|docs?-lookup|context7|reference/, "library"],
];

/** A marketplace's category, when the name says nothing more specific. */
const BY_CATEGORY: Array<[RegExp, ExtensionIcon]> = [
  [/develop|engineering|code|tools/, "code"],
  [/product|office|business/, "productivity"],
  [/database|data/, "database"],
  [/monitor|observab/, "monitor"],
  [/security/, "security"],
  [/deploy|devops|infra/, "deploy"],
  [/design|creative/, "design"],
  [/automat/, "automation"],
  [/learn|education/, "learn"],
  [/location|map/, "location"],
  [/test/, "test"],
  [/math|science/, "math"],
  [/migrat/, "migrate"],
];

const FALLBACK: Record<ExtensionKind, ExtensionIcon> = { skill: "skill", plugin: "plugin", mcp: "server" };

function toneFor(name: string): ExtensionTone {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return EXTENSION_TONES[hash % EXTENSION_TONES.length];
}

export function extensionArt(kind: ExtensionKind, id: string, name = id, category?: string | null): ExtensionArt {
  const known = BY_ID[id];
  if (known) return known;
  const text = `${id} ${name}`.toLowerCase();
  const icon = BY_WORD.find(([pattern]) => pattern.test(text))?.[1]
    ?? (category ? BY_CATEGORY.find(([pattern]) => pattern.test(category.toLowerCase()))?.[1] : undefined)
    ?? FALLBACK[kind];
  return { icon, tone: toneFor(id || name) };
}
