import type { GitSnapshot, Model, Suggestion, Thread, Workspace } from "./types";

/**
 * Predicted starter prompts for the new-thread empty state. The renderer
 * assembles a small snapshot of workspace state (names and metadata only —
 * never file contents) and one agent's cheapest model drafts four prompt
 * ideas from it. Everything here is pure so the shape stays testable.
 */

/** A result this old is refetched even when the signature matches. */
export const SUGGESTION_TTL_MS = 15 * 60 * 1000;
/** Minimum spacing between generation calls for one workspace. */
export const SUGGESTION_MIN_GAP_MS = 60 * 1000;
export const SUGGESTION_TIMEOUT_MS = 30_000;
/** Quiet-host start is capped at 45s. The bridge budget covers that start plus one turn. */
export const SUGGESTION_START_BUDGET_MS = 45_000;
export const SUGGESTION_BUDGET_MS = SUGGESTION_START_BUDGET_MS + SUGGESTION_TIMEOUT_MS;
/** Slightly longer than the bridge budget, so the sidecar aborts the turn before the UI gives up. */
export const SUGGESTION_BRIDGE_TIMEOUT_MS = SUGGESTION_BUDGET_MS + 10_000;
export const SUGGESTION_COUNT = 4;

const MAX_FILES = 120;
const MAX_DIRTIES = 40;
const MAX_THREADS = 6;
const TITLE_LIMIT = 42;
const PROMPT_LIMIT = 240;

export type SuggestionInput = {
  workspace: Pick<Workspace, "id" | "name" | "path">;
  git: GitSnapshot | null;
  files: string[];
  threads: Array<Pick<Thread, "title" | "updatedAt" | "lastOutcome"> & { percentComplete?: number }>;
  prompts: string[];
};

/**
 * Workspace state cheap enough to recompute on every empty-state render. The
 * suggestion cache keys on this; when nothing relevant changed, the last
 * answer is reused instead of another model call.
 */
export function suggestionSignature(input: SuggestionInput): string {
  const dirty = (input.git?.files ?? []).map((file) => `${file.status}:${file.path}`).sort();
  return JSON.stringify({
    workspace: input.workspace.id,
    branch: input.git?.branch ?? null,
    dirty,
    fileCount: input.files.length,
    files: input.files.slice(0, MAX_FILES).sort(),
    threadCount: input.threads.length,
    titles: input.threads.slice(0, MAX_THREADS).map((thread) => thread.title),
    latest: input.threads[0]?.updatedAt ?? null,
  });
}

/** Compact project brief the tiny model turns into prompt ideas. */
export function buildSuggestionPrompt(input: SuggestionInput): string {
  const lines: string[] = [
    "You suggest the next tasks a developer is likely to start in this codebase.",
    `Reply with a JSON array of ${SUGGESTION_COUNT} objects: [{"title": "imperative title, max 6 words", "prompt": "first-person instruction to a coding agent, 1-2 sentences"}].`,
    "Ground suggestions in the workspace state below: prefer continuing uncommitted work, recent threads, and gaps the file list implies. Do not run tools, do not explain, output JSON only.",
    "",
    `Workspace: ${input.workspace.name}`,
  ];
  if (input.git) {
    const dirty = input.git.files.slice(0, MAX_DIRTIES);
    lines.push(`Branch: ${input.git.branch || "detached"}${input.git.files.length ? ` · ${input.git.files.length} uncommitted change${input.git.files.length === 1 ? "" : "s"}` : " · clean"}`);
    for (const file of dirty) lines.push(`  ${file.status.trim() || "?"} ${file.path}`);
    if (input.git.files.length > dirty.length) lines.push(`  … ${input.git.files.length - dirty.length} more`);
  }
  if (input.files.length) {
    const shown = input.files.slice(0, MAX_FILES);
    lines.push(`Workspace files (${input.files.length}):`);
    for (const path of shown) lines.push(`  ${path}`);
    if (input.files.length > shown.length) lines.push(`  … ${input.files.length - shown.length} more`);
  }
  if (input.threads.length) {
    lines.push("Recent threads:");
    for (const thread of input.threads.slice(0, MAX_THREADS)) lines.push(`  - "${thread.title}"`);
  }
  return lines.join("\n");
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Best-effort extraction of the JSON array from a reply that may wrap it in
 * prose or a code fence. Anything unparseable or mis-shaped becomes [] so the
 * caller falls back to the static suggestions.
 */
export function parseSuggestions(text: string): Suggestion[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const items: Suggestion[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const title = (entry as { title?: unknown }).title;
    const prompt = (entry as { prompt?: unknown }).prompt;
    if (typeof title !== "string" || !title.trim() || typeof prompt !== "string" || !prompt.trim()) continue;
    items.push({ title: clip(title.trim(), TITLE_LIMIT), prompt: clip(prompt.trim(), PROMPT_LIMIT) });
    if (items.length >= SUGGESTION_COUNT) break;
  }
  return items;
}

const costNumber = (value: string | undefined) => {
  const parsed = value ? Number(value.replace(/[^0-9.]/g, "")) : NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
};

/**
 * The suggestion run should cost as little as possible: the cheapest listed
 * input price wins, the catalog's default is the tiebreak, and anything the
 * agent marked unavailable is skipped.
 */
export function cheapestModel(models: Model[]): Model | undefined {
  const usable = models.filter((model) => !model.unavailable);
  if (!usable.length) return undefined;
  return [...usable].sort((a, b) => {
    const diff = costNumber(a.cost?.input) - costNumber(b.cost?.input);
    if (diff) return diff;
    return (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0);
  })[0];
}
