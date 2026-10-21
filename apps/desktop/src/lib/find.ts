import type { AgentRun } from "./agent";

export type FindMatch = { runId: string; itemId: string };

/**
 * Messages in a thread that contain `query`, oldest first. Find reads the
 * transcript model rather than the page, because runs scrolled far away are
 * not rendered. Only what the conversation shows is searched: user and agent
 * messages, not collapsed tool arguments or output.
 */
export function findMatches(runs: Array<Pick<AgentRun, "id" | "steps">>, query: string): FindMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: FindMatch[] = [];
  for (const run of runs) {
    for (const step of run.steps) {
      if (step.kind !== "user" && step.kind !== "message") continue;
      const text = step.detail?.toLowerCase() ?? "";
      for (let at = text.indexOf(needle); at >= 0 && matches.length < 2000; at = text.indexOf(needle, at + needle.length)) {
        matches.push({ runId: run.id, itemId: step.id });
      }
    }
  }
  return matches;
}

/** Text ranges under `root` that contain `query`, for painting highlights. Bounded so a huge transcript cannot stall a keystroke. */
export function textRanges(root: Node, query: string, limit = 2000): Range[] {
  const needle = query.trim().toLowerCase();
  const ranges: Range[] = [];
  if (!needle) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && ranges.length < limit; node = walker.nextNode()) {
    const text = node.nodeValue?.toLowerCase() ?? "";
    for (let at = text.indexOf(needle); at >= 0 && ranges.length < limit; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}
