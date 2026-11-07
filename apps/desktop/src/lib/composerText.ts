import type { CustomCommand } from "./types";

/** Pure text-editing helpers for the composer. Kept dependency-free so the
 *  node regression suite can bundle and exercise them directly. */

export const INDENT_UNIT = "  ";

export type TextEdit = { text: string; start: number; end: number };

function lineStartAt(text: string, index: number): number {
  return text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

/** Line index (0-based) containing `index`. */
function lineIndexAt(text: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** Indent the touched lines, or insert one indent unit at a collapsed caret. */
export function indentText(text: string, start: number, end: number, unit = INDENT_UNIT): TextEdit {
  if (start === end) {
    return { text: text.slice(0, start) + unit + text.slice(end), start: start + unit.length, end: start + unit.length };
  }
  // A selection ending at column 0 does not touch that last line.
  const lastTouched = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const firstLine = lineIndexAt(text, start);
  const lastLine = lineIndexAt(text, lastTouched);
  const lines = text.split("\n");
  for (let i = firstLine; i <= lastLine; i++) lines[i] = unit + lines[i];
  const count = lastLine - firstLine + 1;
  return { text: lines.join("\n"), start: start + unit.length, end: end + unit.length * count };
}

/** Remove one indent level from each touched line. */
export function outdentText(text: string, start: number, end: number, unit = INDENT_UNIT): TextEdit {
  const lastTouched = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const firstLine = lineIndexAt(text, start);
  const lastLine = lineIndexAt(text, lastTouched);
  const lines = text.split("\n");
  const removed: number[] = [];
  for (let i = firstLine; i <= lastLine; i++) {
    const line = lines[i];
    let cut = 0;
    if (line.startsWith(unit)) cut = unit.length;
    else if (line.startsWith("\t")) cut = 1;
    else {
      const spaces = line.match(/^ +/)?.[0].length ?? 0;
      cut = Math.min(spaces, unit.length);
    }
    lines[i] = line.slice(cut);
    removed.push(cut);
  }
  const total = removed.reduce((sum, value) => sum + value, 0);
  const firstLineStart = lineStartAt(text, start);
  return {
    text: lines.join("\n"),
    start: Math.max(firstLineStart, start - removed[0]),
    end: Math.max(firstLineStart, end - total),
  };
}

type ListPrefix = { indent: string; marker: string; ordered: number | null; delimiter: string; task: boolean };

function parseListPrefix(line: string): ListPrefix | null {
  const indent = line.match(/^\s*/)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const ordered = rest.match(/^(\d+)([.)])\s+/);
  if (ordered) {
    return { indent, marker: ordered[0], ordered: Number.parseInt(ordered[1], 10), delimiter: ordered[2], task: false };
  }
  const bullet = rest.match(/^(-|\*|\+)(?:(\s+\[[ xX]\])?\s+)/);
  if (bullet) {
    return { indent, marker: bullet[0], ordered: null, delimiter: "", task: bullet[0].includes("[") };
  }
  return null;
}

/**
 * Shift+Enter behavior: split the line, preserve indentation, continue
 * `1.` / `-` / `- [ ]` lists, and exit the list on an empty item.
 */
export function continuationForEnter(text: string, caret: number): TextEdit {
  const start = lineStartAt(text, caret);
  let lineEnd = text.indexOf("\n", caret);
  if (lineEnd === -1) lineEnd = text.length;
  const line = text.slice(start, lineEnd);
  const prefix = parseListPrefix(line);
  if (!prefix) {
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const insert = `\n${indent}`;
    return { text: text.slice(0, caret) + insert + text.slice(caret), start: caret + insert.length, end: caret + insert.length };
  }
  const content = line.slice(prefix.indent.length + prefix.marker.length);
  const caretInPrefix = caret - start < prefix.indent.length + prefix.marker.length;
  if (!content.trim() || caretInPrefix) {
    // Empty item (or caret still inside the marker): drop the marker.
    return { text: text.slice(0, start) + prefix.indent + text.slice(lineEnd), start: start + prefix.indent.length, end: start + prefix.indent.length };
  }
  const nextMarker = prefix.ordered != null && Number.isFinite(prefix.ordered)
    ? `${prefix.ordered + 1}${prefix.delimiter} `
    : prefix.task
      ? `${prefix.marker.trimStart()[0]} [ ] `
      : `${prefix.marker.trimStart()[0]} `;
  const insert = `\n${prefix.indent}${nextMarker}`;
  return { text: text.slice(0, caret) + insert + text.slice(caret), start: caret + insert.length, end: caret + insert.length };
}

export type WordAtCaret = { start: number; end: number; word: string };

const WORD_TAIL = /[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;
const WORD_BOUNDARY_AFTER = /^[\s)\].,;:!?"']|^$/;

/** The word the caret is completing, or null when mid-word / too short. */
export function currentWord(text: string, caret: number): WordAtCaret | null {
  const before = text.slice(0, caret);
  const match = before.match(WORD_TAIL);
  if (!match || match[0].length < 2) return null;
  if (!WORD_BOUNDARY_AFTER.test(text.slice(caret))) return null;
  const start = caret - match[0].length;
  return { start, end: caret, word: match[0] };
}

/** Completion only when exactly one candidate extends `word` — never guess between several. */
export function findUniqueCompletion(word: string, candidates: string[]): string | null {
  const lower = word.toLowerCase();
  let match: string | null = null;
  for (const candidate of candidates) {
    if (candidate.length > word.length && candidate.toLowerCase().startsWith(lower)) {
      if (match) return null;
      match = candidate;
    }
  }
  return match;
}

/** Common words that are never useful as (or as a prefix of) a completion. */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "yours", "with", "this", "that",
  "from", "they", "them", "their", "theirs", "have", "has", "had", "were", "been", "will",
  "would", "there", "what", "when", "where", "which", "while", "about", "into", "here",
  "can", "cannot", "could", "should", "shall", "may", "might", "must", "does", "did",
  "than", "then", "these", "those", "such", "only", "also", "just", "very", "much",
  "more", "most", "some", "any", "all", "each", "other", "same", "too", "how", "why",
  "who", "whom", "whose", "its", "our", "ours", "out", "over", "under", "again", "once",
]);

export function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase());
}

const CANDIDATE_WORD = /[A-Za-z_@#][A-Za-z0-9_./:-]*/g;

/**
 * Completion vocabulary from recent sources (most-recent-first).
 * Deduped case-insensitively; first (most recent) spelling wins.
 */
export function collectCandidates(sources: string[], limit = 500): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    CANDIDATE_WORD.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CANDIDATE_WORD.exec(source)) !== null && out.length < limit) {
      const word = match[0].replace(/[./:-]+$/, "");
      if (word.length < 3) continue;
      const key = word.toLowerCase();
      if (seen.has(key) || STOP_WORDS.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
    if (out.length >= limit) break;
  }
  return out;
}

export type SlashQuery = { start: number; query: string };

/** A `/command` typed alone on the current line, if any. */
export function slashQuery(text: string, caret: number): SlashQuery | null {
  const start = lineStartAt(text, caret);
  let lineEnd = text.indexOf("\n", caret);
  if (lineEnd === -1) lineEnd = text.length;
  if (!/^\s*$/.test(text.slice(caret, lineEnd))) return null;
  const before = text.slice(start, caret);
  const match = before.match(/^(\s*)\/([A-Za-z0-9-]*)$/);
  if (!match) return null;
  return { start: start + match[1].length, query: match[2] };
}

export type SlashCommand = { name: string; hint: string; prompt: string };

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "explain", hint: "Tour this codebase", prompt: "Give me a tour of this codebase: the architecture, the main entry points, and how the pieces fit together." },
  { name: "plan", hint: "Plan before coding", prompt: "Before making any changes, write a short step-by-step plan and wait for my approval." },
  { name: "fix", hint: "Find and fix a bug", prompt: "Look for a likely bug in this codebase, explain the root cause, and fix it." },
  { name: "test", hint: "Add missing tests", prompt: "Find the most important untested code in this codebase and write tests for it." },
  { name: "review", hint: "Review my changes", prompt: "Review my uncommitted changes for bugs, edge cases, and anything I should clean up before committing." },
  { name: "refactor", hint: "Clean up this code", prompt: "Refactor the code I am working on for clarity without changing behavior. Explain each change." },
  { name: "commit", hint: "Draft a commit message", prompt: "Look at my staged and unstaged changes and draft a concise commit message for them." },
];

/**
 * Commands the app runs itself, without a model turn. `/review` is the one
 * exception: it drafts a prompt for the review scope in view.
 * `needs` says what has to be open for the command to mean anything.
 */
export type BuiltinCommand = { name: string; hint: string; needs?: "thread" | "muse" | "museThread" | "liveMuseThread" | "liveCompactableThread" };

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "new", hint: "Start a new thread" },
  { name: "compact", hint: "Compact this thread's context", needs: "liveCompactableThread" },
  { name: "fork", hint: "Fork this thread", needs: "museThread" },
  { name: "rename", hint: "Rename this thread", needs: "thread" },
  { name: "model", hint: "Choose a model" },
  { name: "effort", hint: "Set reasoning effort" },
  { name: "permissions", hint: "Change permissions", needs: "muse" },
  { name: "init", hint: "Preview and write AGENTS.md", needs: "muse" },
  { name: "status", hint: "Show context, usage and session id", needs: "thread" },
  { name: "mcp", hint: "MCP servers in Settings" },
  { name: "skills", hint: "Skills in Settings" },
  { name: "export", hint: "Export this thread", needs: "liveMuseThread" },
  { name: "review", hint: "Review the changes in view" },
];

/** The built-ins that apply to what is open. Commands that could do nothing are left out, not disabled. */
export function availableBuiltins(context: { thread: boolean; muse: boolean; live: boolean; harness?: boolean }): BuiltinCommand[] {
  return BUILTIN_COMMANDS.filter((command) => {
    // Muse compacts in its CLI; the built-in agent summarizes its own history.
    if (command.needs === "liveCompactableThread") return context.thread && (context.muse || context.harness === true) && context.live;
    if (command.needs === "thread") return context.thread;
    if (command.needs === "muse") return context.muse;
    if (command.needs === "museThread") return context.thread && context.muse;
    if (command.needs === "liveMuseThread") return context.thread && context.muse && context.live;
    return true;
  });
}

const REVIEW_TAIL = "for bugs, edge cases, and anything I should clean up before committing.";

/** The `/review` prompt for a review scope, so the agent looks at what the Diff tab shows. */
export function reviewPrompt(scope: "all" | "lastTurn" | "staged" | "unstaged" | "branch", base = ""): string {
  if (scope === "staged") return `Review my staged changes ${REVIEW_TAIL}`;
  if (scope === "unstaged") return `Review my unstaged changes, including new files, ${REVIEW_TAIL}`;
  if (scope === "branch" && base.trim()) return `Review the commits on this branch since it diverged from ${base.trim()} ${REVIEW_TAIL}`;
  if (scope === "lastTurn") return "Review the file changes from your last turn for bugs, edge cases, and anything to clean up.";
  return `Review my uncommitted changes ${REVIEW_TAIL}`;
}

/** The commit draft prompt covers exactly the changes the requested commit will include. */
export function commitDraftPrompt(includeUnstaged: boolean): string {
  const request = includeUnstaged
    ? SLASH_COMMANDS.find((command) => command.name === "commit")!.prompt
    : "Look at only my staged changes and draft a concise commit message for them. Do not include unrelated unstaged or new files.";
  return `${request} Reply with only the commit message, subject line first.`;
}

export const COMMIT_DRAFT_PROMPT = commitDraftPrompt(true);

/** The subject line of a drafted commit message: the first line of real text, without markdown dressing. */
export function commitSubjectFromReply(reply: string): string {
  const fenced = reply.match(/```[^\n]*\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : reply;
  const line = body.split("\n").map((entry) => entry.trim()).find((entry) => entry && !/^(here('s| is)|sure|commit message:?$)/i.test(entry)) ?? "";
  return line.replace(/^[#>\s]+/, "").replace(/^[-*]\s+/, "").replace(/^\*\*(.*)\*\*$/, "$1").replace(/^`+|`+$/g, "").replace(/^["“](.*)["”]$/, "$1").trim().slice(0, 200);
}

export type SlashSkill = { selector: string; displayName?: string; description?: string; argumentHint?: string };

export const CUSTOM_COMMAND_LIMIT = 50;
const CUSTOM_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Why a custom command cannot be saved, or null when it can. */
export function customCommandProblem(command: CustomCommand, existing: readonly CustomCommand[]): string | null {
  if (!CUSTOM_NAME.test(command.name)) return "Use 1–32 lowercase letters, digits or hyphens for the name.";
  if (BUILTIN_COMMANDS.some((builtin) => builtin.name === command.name)) return `/${command.name} is a built-in command. Choose another name.`;
  if (existing.some((entry) => entry.name === command.name)) return `/${command.name} already exists. Remove it first to replace it.`;
  if (!command.body.trim()) return "Write the prompt this command inserts.";
  if (existing.length >= CUSTOM_COMMAND_LIMIT) return `You can keep up to ${CUSTOM_COMMAND_LIMIT} custom commands.`;
  return null;
}

/** Saved custom commands, with anything malformed dropped rather than trusted. */
export function normalizeCustomCommands(value: unknown): CustomCommand[] {
  if (!Array.isArray(value)) return [];
  const out: CustomCommand[] = [];
  for (const entry of value) {
    const name = typeof entry?.name === "string" ? entry.name : "";
    const body = typeof entry?.body === "string" ? entry.body.slice(0, 8000) : "";
    if (!CUSTOM_NAME.test(name) || !body.trim() || out.some((kept) => kept.name === name)) continue;
    out.push({ name, description: typeof entry.description === "string" ? entry.description.slice(0, 120) : "", body });
    if (out.length >= CUSTOM_COMMAND_LIMIT) break;
  }
  return out;
}

/**
 * What a custom command puts in the composer. `$ARGUMENTS` is where the user's
 * own words go: it is removed and the caret lands at the first one, so what
 * will be sent is always what is on screen.
 */
export function customCommandInsert(body: string): { text: string; caret: number } {
  const at = body.indexOf("$ARGUMENTS");
  const text = body.split("$ARGUMENTS").join("");
  return { text, caret: at < 0 ? text.length : at };
}

export type SlashEntry =
  | { kind: "builtin"; name: string; hint: string }
  | { kind: "custom"; name: string; hint: string; body: string }
  | { kind: "skill"; name: string; hint: string; selector: string; argumentHint?: string }
  | { kind: "macro"; name: string; hint: string; prompt: string };

/**
 * Slash menu entries, each name once: built-in commands first, then live
 * session skills (real invocations), then the user's custom commands, then
 * the static prompt macros that nothing else is named after. Any part may be empty; the menu never invents a
 * skill the catalog did not list. A skill named `review` replaces the built-in,
 * which only drafts a prompt.
 */
export function filterSlashCommands(query: string, skills: SlashSkill[] = [], builtins: BuiltinCommand[] = [], custom: readonly CustomCommand[] = [], limit = 50): SlashEntry[] {
  const lower = query.toLowerCase();
  const skillNames = new Set(skills.filter((row) => row.selector).map((row) => row.selector.replace(/^\//, "").toLowerCase()));
  const offered = builtins.filter((command) => !(command.name === "review" && skillNames.has("review")));
  const taken = new Set(offered.map((command) => command.name));
  const commands: SlashEntry[] = [
    ...offered.filter((command) => command.name.startsWith(lower)),
    ...offered.filter((command) => !command.name.startsWith(lower) && command.hint.toLowerCase().includes(lower)),
  ].map((command) => ({ kind: "builtin" as const, name: command.name, hint: command.hint }));
  const scored = skills
    .filter((row) => row.selector && !taken.has(row.selector.replace(/^\//, "").toLowerCase()))
    .map((row) => {
      const name = row.selector.replace(/^\//, "");
      const hay = `${name} ${row.displayName ?? ""} ${row.description ?? ""}`.toLowerCase();
      const rank = name.toLowerCase().startsWith(lower) ? 0 : hay.includes(lower) ? 1 : -1;
      return { rank, entry: { kind: "skill" as const, name, hint: row.displayName || row.description || "Skill", selector: row.selector, ...(row.argumentHint ? { argumentHint: row.argumentHint } : {}) } };
    })
    .filter((row) => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map((row) => row.entry);
  const starts = SLASH_COMMANDS.filter((command) => command.name.toLowerCase().startsWith(lower));
  const contains = SLASH_COMMANDS.filter((command) => !command.name.toLowerCase().startsWith(lower) && (command.name.toLowerCase().includes(lower) || command.hint.toLowerCase().includes(lower)));
  const own = custom.filter((command) => !taken.has(command.name) && !skillNames.has(command.name));
  const customNames = new Set(own.map((command) => command.name));
  const customs: SlashEntry[] = [
    ...own.filter((command) => command.name.startsWith(lower)),
    ...own.filter((command) => !command.name.startsWith(lower) && command.description.toLowerCase().includes(lower)),
  ].map((command) => ({ kind: "custom" as const, name: command.name, hint: command.description || "Custom command", body: command.body }));
  const macros: SlashEntry[] = [...starts, ...contains]
    .filter((command) => !taken.has(command.name) && !skillNames.has(command.name) && !customNames.has(command.name))
    .map((command) => ({ kind: "macro" as const, name: command.name, hint: command.hint, prompt: command.prompt }));
  return [...commands, ...scored, ...customs, ...macros].slice(0, limit);
}

const SKILL_INVOCATION = /^\/(\S+)[ \t]*([\s\S]*)$/;

/**
 * Parse a leading `/selector arguments` skill invocation. Selectors are
 * matched verbatim against the session catalog at submit; unknown
 * spellings stay plain text so typos never summon the wrong skill.
 */
export function parseSkillInvocation(text: string): { selector: string; args: string } | null {
  const match = text.trimStart().match(SKILL_INVOCATION);
  if (!match) return null;
  return { selector: match[1], args: (match[2] ?? "").trim() };
}

const SHELL_ESCAPE = /^![ \t]*(\S[\s\S]*)$/;

/**
 * Parse a leading `!command` shell escape (TUI parity). A bare `!` with no
 * command is not an escape: it stays plain text so the submit path can ask
 * for the command instead of running nothing.
 */
export function parseShellEscape(text: string): { command: string } | null {
  const match = text.trimStart().match(SHELL_ESCAPE);
  if (!match) return null;
  return { command: match[1].trim() };
}

/** Canonical typed spelling for a catalog selector: exactly one leading slash. */
export function skillSelectorText(selector: string): string {
  return `/${selector.replace(/^\//, "")}`;
}

/**
 * Draft text after pressing "Use" on a catalog skill. The invocation
 * leads (existing draft text becomes the skill's arguments) so submit
 * parses it back through `parseSkillInvocation`.
 */
export function skillUseText(selector: string, draft: string): string {
  const invocation = skillSelectorText(selector);
  return draft.trim() ? `${invocation} ${draft.trim()}` : `${invocation} `;
}
