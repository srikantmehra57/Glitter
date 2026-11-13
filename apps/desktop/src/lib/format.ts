import type { Thread, TranscriptItem } from "./types";

export function uid(): string {
  return crypto.randomUUID();
}

/**
 * The lowercased searchable text of one item (text, fallback text, tool args and
 * visible output), kept for as long as the item lives. Items are replaced, never
 * edited, so this is exact — and a search no longer lowercases every large tool
 * output of every thread on every keystroke.
 */
const searchable = new WeakMap<TranscriptItem, string>();

function searchTextOf(item: TranscriptItem): string {
  let text = searchable.get(item);
  if (text === undefined) {
    // A search term never contains whitespace, so joining with a newline cannot
    // create a match that spans two fields.
    text = [item.text, item.fallbackText, item.args, item.visibleOutput].filter(Boolean).join("\n").toLowerCase();
    searchable.set(item, text);
  }
  return text;
}

/**
 * Sidebar/palette thread search: every whitespace-separated term must appear
 * (case-insensitive) in the title or in any item's text, fallback text, tool
 * args, or visible output. Scans at most the last 400 items per thread.
 */
export function threadMatches(thread: Thread, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const title = thread.title.toLowerCase();
  const first = Math.max(0, thread.items.length - 400);
  return terms.every((term) => {
    if (title.includes(term)) return true;
    for (let index = first; index < thread.items.length; index += 1) {
      if (searchTextOf(thread.items[index]).includes(term)) return true;
    }
    return false;
  });
}

/**
 * What deleting these threads does to their worktrees, for the confirm dialog.
 * A worktree goes only when every thread in it is being deleted. Empty when
 * nothing is removed.
 */
export function worktreeRemovalNote(threads: Array<Pick<Thread, "sessionId" | "worktree">>, deleting: string[]): string {
  const going = new Set(deleting);
  const branches = new Map<string, string>();
  for (const thread of threads) {
    if (thread.worktree && going.has(thread.sessionId)) branches.set(thread.worktree.grantId, thread.worktree.branch);
  }
  for (const thread of threads) {
    if (thread.worktree && !going.has(thread.sessionId)) branches.delete(thread.worktree.grantId);
  }
  if (!branches.size) return "";
  const names = [...branches.values()];
  const what = names.length === 1 ? `the worktree on branch ${names[0]}` : `${names.length} worktrees (${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""})`;
  return `This also removes ${what}, including any uncommitted changes there. A branch is kept when it has commits that are not on another branch.`;
}

/** Blocked on the user: an approval to decide or a question to answer. */
export function needsAttention(thread: Pick<Thread, "pendingApproval" | "userInputs">): boolean {
  return Boolean(thread.pendingApproval) || Boolean(thread.userInputs?.length);
}

/**
 * The first thread after `currentId` in list order (wrapping) that needs the
 * user, or null. The current thread comes back only when it is the one waiting.
 */
export function nextAttentionThread<T extends Pick<Thread, "sessionId" | "pendingApproval" | "userInputs">>(threads: T[], currentId: string | null): T | null {
  const start = threads.findIndex((thread) => thread.sessionId === currentId);
  for (let step = 1; step <= threads.length; step += 1) {
    const candidate = threads[(start + step) % threads.length];
    if (needsAttention(candidate)) return candidate;
  }
  return null;
}

export function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(delta / 60000);
  if (Number.isNaN(minutes)) return "";
  if (Math.abs(minutes) < 1) return "now";
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)}h`;
  const days = Math.round(hours / 24);
  return `${Math.abs(days)}d`;
}

export function titleFromText(text: string): string {
  // Attachment markers a prompt can carry ("[Image #1]", "[Screenshot]") are not
  // words a title should lead with; drop them so the title starts at real text.
  const stripped = text.replace(/\[(?:image|screenshot|attachment|file)\s*(?:#?\d+)?\]/gi, " ");
  const clean = stripped.replace(/\s+/g, " ").trim();
  if (!clean) return "Untitled thread";
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean;
}

export function untitledThreadTitle(updatedAt?: string): string {
  if (!updatedAt) return "Untitled thread";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "Untitled thread";
  return `Untitled thread · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read file",
  read: "Read file",
  edit_file: "Edit file",
  multi_edit: "Edit file",
  write_file: "Write file",
  write: "Write file",
  str_replace: "Edit file",
  apply_patch: "Edit file",
  list_files: "List files",
  glob: "Search files",
  grep: "Search",
  codebase_search: "Search codebase",
  shell: "Terminal",
  bash: "Terminal",
  bash_output: "Shell output",
  kill_shell: "Stop shell",
  web_search: "Web search",
  web_fetch: "Web lookup",
  browser: "Browser",
};

export function humanizeToolName(tool?: string, kind?: string): string {
  if (tool && TOOL_LABELS[tool]) return TOOL_LABELS[tool];
  if (tool) {
    // The server segment may itself contain single underscores; the next `__` ends it.
    const clean = tool.replace(/^mcp__(?:.+?)__/, "").replace(/_/g, " ").trim();
    if (clean) return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
  if (kind === "userShell") return "Terminal";
  return "Tool";
}

export function humanizeModelId(modelId: string): string {
  const clean = modelId.replace(/-/g, " ").trim();
  if (!clean) return modelId;
  return clean.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function humanizeProvider(providerId?: string): string | undefined {
  if (!providerId) return undefined;
  if (providerId.toLowerCase() === "meta") return "Meta";
  return providerId;
}

export function humanizeModelLabel(modelId: string, displayLabel?: string): string {
  if (displayLabel && displayLabel !== modelId) return displayLabel;
  return humanizeModelId(modelId);
}

const GIT_STATUS_LABELS: Record<string, string> = {
  "M": "Modified",
  "A": "Added",
  "D": "Deleted",
  "R": "Renamed",
  "C": "Copied",
  "U": "Conflict",
  "??": "Untracked",
  "!!": "Ignored",
};

export function humanizeGitStatus(status: string): string {
  const trimmed = status.trim();
  if (GIT_STATUS_LABELS[trimmed]) return GIT_STATUS_LABELS[trimmed];
  if (GIT_STATUS_LABELS[status]) return GIT_STATUS_LABELS[status];
  // Combined codes like "MM", "AM" — describe first meaningful letter.
  for (const ch of trimmed) {
    if (GIT_STATUS_LABELS[ch]) return GIT_STATUS_LABELS[ch];
  }
  return "Changed";
}

/** Both provider wires, one label each: Anthropic's names and OpenAI's for the same endings. */
const STOP_REASONS: Record<string, string> = {
  end_turn: "End turn",
  stop: "Stopped",
  stop_sequence: "Stop sequence",
  tool_use: "Tool use",
  tool_calls: "Tool use",
  function_call: "Tool use",
  max_tokens: "Cut off",
  max_output_tokens: "Cut off",
  length: "Cut off",
  content_filter: "Filtered",
  refusal: "Refusal",
  pause_turn: "Paused",
};

/** A provider's finish reason in the app's own words. An unknown one reads as reported. */
export function humanizeStopReason(reason?: string | null): string {
  if (!reason) return "—";
  return STOP_REASONS[reason] ?? reason.replaceAll("_", " ");
}

/** Shorten a `algo:hex` digest for display (`sha256:df5e43fed1bd…`); plain text truncates at 24 chars. */
export function shortHash(value?: string | null): string {
  if (!value) return "";
  const match = value.match(/^([a-z0-9]+:)?([0-9a-f]{13,})/i);
  if (!match) return value.length > 24 ? `${value.slice(0, 24)}…` : value;
  return `${match[1] ?? ""}${match[2].slice(0, 12)}…`;
}

export function summarizeArgs(toolName: string, args?: string): string {
  if (!args) return "";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const path = ["path", "file", "filePath", "target"].map((k) => parsed[k]).find((v) => typeof v === "string") as string | undefined;
    const command = ["command", "cmd", "query", "url", "pattern"].map((k) => parsed[k]).find((v) => typeof v === "string") as string | undefined;
    if (toolName === "bash" || toolName === "shell") return typeof command === "string" ? command : formatArgs(args);
    if (path && command && path !== command) return `${path} · ${command}`.slice(0, 240);
    if (path) return path;
    if (command) return String(command).slice(0, 240);
    const keys = Object.keys(parsed);
    if (keys.length <= 2) return keys.map((k) => `${k}: ${String(parsed[k]).slice(0, 80)}`).join(" · ");
    return formatArgs(args);
  } catch {
    return args.length > 240 ? `${args.slice(0, 240)}…` : args;
  }
}

export function composePrompt(text: string, refs?: { path: string }[]): string {
  const listed = (refs ?? []).map((ref) => `@${ref.path}`).filter(Boolean);
  if (!listed.length) return text;
  return text.trim() ? `${listed.join("\n")}\n\n${text}` : listed.join("\n");
}

export function workspaceName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function formatArgs(args?: string): string {
  if (!args) return "";
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** True on macOS. `platform` override exists for tests; defaults to the live navigator value. */
export function isMacPlatform(platform?: string): boolean {
  const value = platform ?? (typeof navigator !== "undefined" ? navigator.platform ?? "" : "");
  return /mac/i.test(value);
}

/**
 * Modifier glyph matching the App.tsx shortcut handler (`metaKey || ctrlKey`):
 * "⌘" on macOS, "Ctrl" elsewhere.
 */
export function modGlyph(platform?: string): string {
  return isMacPlatform(platform) ? "⌘" : "Ctrl";
}

/** "⌘K" on macOS, "Ctrl+K" elsewhere. */
export function shortcutLabel(key: string, platform?: string): string {
  return isMacPlatform(platform) ? `${modGlyph(platform)}${key}` : `${modGlyph(platform)}+${key}`;
}

/** One plain sentence per known approval scope (`ApprovalChoiceScope` in the SDK); "" for anything else. */
export function describeApprovalScope(scope: string): string {
  switch (scope) {
    case "once": return "Allows this call only.";
    case "session": return "Allows every matching call for the rest of this thread.";
    case "localPersistent": return "Saved for this workspace; the agent will not ask again.";
    default: return "";
  }
}

/** Compact, locale-neutral token counts: 20448 → "20.4K", 1007997 → "1M". */
/** Elapsed time for status lines: "8s", "1m 12s", "1h 4m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const [value, unit] = count < 1_000_000 ? [count / 1000, "K"] : [count / 1_000_000, "M"];
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10}${unit}`;
}

/** A share as a percent: 0.625 of the whole reads "62.5%", and a whole number drops the decimal. */
export function formatShare(part: number, total: number): string {
  if (!(total > 0) || !(part > 0)) return "0%";
  const pct = (part / total) * 100;
  if (pct < 0.1) return "<0.1%";
  let rounded = Math.round(pct * 10) / 10;
  if (rounded >= 100 && pct < 100) rounded = 99.9;
  const text = rounded.toFixed(1);
  return `${text.endsWith(".0") ? text.slice(0, -2) : text}%`;
}

export type ContextPart = { id: "prompt" | "cached" | "write"; label: string; tokens: number };

/**
 * How the used window splits, when the agent reported it.
 * Cache reads and writes count as parts only when they add up to the used
 * total. Otherwise they stay absolute counts, so a mismatched report is not
 * drawn as a share of the window. The hit rate is null until a cache read is reported.
 */
export function contextComposition(context: { usedTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): { parts: ContextPart[]; partitioned: boolean; hitRate: number | null } {
  const used = Math.max(0, context.usedTokens ?? 0);
  const read = Math.max(0, context.cacheReadTokens ?? 0);
  const write = Math.max(0, context.cacheWriteTokens ?? 0);
  const partitioned = (read > 0 || write > 0) && read + write <= used;
  const parts: ContextPart[] = [];
  if (partitioned) {
    if (used - read - write > 0) parts.push({ id: "prompt", label: "Prompt", tokens: used - read - write });
    if (read > 0) parts.push({ id: "cached", label: "Cached", tokens: read });
    if (write > 0) parts.push({ id: "write", label: "Cache write", tokens: write });
  } else {
    if (read > 0) parts.push({ id: "cached", label: "Cached", tokens: read });
    if (write > 0) parts.push({ id: "write", label: "Cache write", tokens: write });
  }
  let hitRate: number | null = null;
  if (context.cacheReadTokens != null) {
    const fresh = partitioned ? used - read - write : Math.max(0, used - Math.min(read, used));
    const base = fresh + read;
    hitRate = base > 0 ? read / base : 0;
  }
  return { parts, partitioned, hitRate };
}

/** What `/status` shows: one fact per line, only the ones the agent reported. */
export function threadStatusLines(thread: Pick<Thread, "sessionId" | "config" | "context" | "usage" | "hostBranch" | "worktree">, agentName: string): string[] {
  const lines = [`Session: ${thread.sessionId}`, `Agent: ${agentName}`];
  if (thread.config?.modelId) lines.push(`Model: ${thread.config.modelId}`);
  const used = thread.context?.usedTokens;
  const window = thread.context?.windowTokens;
  if (used != null && window) lines.push(`Context: ${formatTokens(used)} of ${formatTokens(window)} tokens (${Math.min(100, Math.round((used / window) * 100))}%)`);
  const cacheRead = thread.usage?.cacheReadTokens || thread.context?.cacheReadTokens;
  const cacheWrite = thread.usage?.cacheWriteTokens || thread.context?.cacheWriteTokens;
  if (cacheRead || cacheWrite) lines.push(`Cache: ${[cacheRead ? `${formatTokens(cacheRead)} read` : "", cacheWrite ? `${formatTokens(cacheWrite)} written` : ""].filter(Boolean).join(", ")}`);
  if (thread.usage?.totalTokens != null) lines.push(`Tokens this session: ${formatTokens(thread.usage.totalTokens)}${thread.usage.outputTokens != null ? ` (${formatTokens(thread.usage.outputTokens)} output)` : ""}`);
  if (thread.worktree) lines.push(`Worktree: ${thread.worktree.branch}, started from ${thread.worktree.base}`);
  else if (thread.hostBranch) lines.push(`Branch: ${thread.hostBranch}`);
  return lines;
}

/** Clipboard write with a legacy fallback for webviews without async clipboard. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Session-list time filter cutoff as an RFC 3339 timestamp for `updatedAfter`. */
export function timeFilterCutoff(filter: "day" | "week" | "month", now = Date.now()): string {
  const span = filter === "day" ? 24 * 3600_000 : filter === "week" ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000;
  return new Date(now - span).toISOString();
}

/** Stored-byte counts for the output viewer: 512 → "512 B", 20480 → "20 KB", 6 MiB → "6 MB". */
export function formatBytes(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0 B";
  if (count < 1024) return `${Math.floor(count)} B`;
  const [value, unit] = count < 1024 * 1024 ? [count / 1024, "KB"] : [count / (1024 * 1024), "MB"];
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}
