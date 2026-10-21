import type { DiffLine } from "./diff";

/** A comment on one line of a diff, waiting to be sent to the agent. */
export type LineComment = {
  id: string;
  path: string;
  /** Line number in the new file, or in the old file for a removed line. */
  line: number;
  removed: boolean;
  /** The hunk header and the lines around the commented one, verbatim from the patch. */
  context: string;
  text: string;
};

const CONTEXT_LINES = 2;
/** Pending comments kept per thread; past this the oldest drop off. */
export const LINE_COMMENT_LIMIT = 50;

/** Saved pending comments, with anything malformed dropped. */
export function normalizeLineComments(value: unknown): Record<string, LineComment[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, LineComment[]> = {};
  for (const [key, list] of Object.entries(value)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((entry): entry is LineComment => Boolean(entry) && typeof entry.id === "string" && typeof entry.path === "string" && Number.isInteger(entry.line) && typeof entry.text === "string" && typeof entry.context === "string")
      .map((entry) => ({ id: entry.id, path: entry.path, line: entry.line, removed: entry.removed === true, context: entry.context.slice(0, 4000), text: entry.text.slice(0, 2000) }))
      .slice(-LINE_COMMENT_LIMIT);
    if (kept.length) out[key] = kept;
  }
  return out;
}

/** The slice of a hunk worth quoting for a comment on `line`: its header and a few lines either side. */
export function commentContext(header: string, lines: readonly DiffLine[], line: DiffLine): string {
  const body = lines.filter((entry) => entry.type === "add" || entry.type === "del" || entry.type === "ctx");
  const at = body.indexOf(line);
  if (at < 0) return header;
  return [header, ...body.slice(Math.max(0, at - CONTEXT_LINES), at + CONTEXT_LINES + 1).map((entry) => entry.text)].join("\n");
}

/** Where a diff line can take a comment: changed and context lines with a number, never headers. */
export function commentTarget(line: DiffLine): { line: number; removed: boolean } | null {
  if (line.type === "del" && line.oldLine != null) return { line: line.oldLine, removed: true };
  if ((line.type === "add" || line.type === "ctx") && line.newLine != null) return { line: line.newLine, removed: false };
  return null;
}

/** One prompt for every pending comment, in file and line order, each with the code it is about. */
export function composeLineComments(comments: readonly LineComment[]): string {
  const ordered = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  const blocks = ordered.map((comment, index) => {
    // A fence longer than any backtick run inside keeps quoted code from closing it.
    const fence = "`".repeat(Math.max(3, ...Array.from(comment.context.matchAll(/`+/g), (run) => run[0].length + 1)));
    return `${index + 1}. ${comment.path}:${comment.line}${comment.removed ? " (removed line)" : ""} — ${comment.text.trim()}\n${fence}diff\n${comment.context}\n${fence}`;
  });
  return `Please address these review comments on the current changes:\n\n${blocks.join("\n\n")}`;
}
