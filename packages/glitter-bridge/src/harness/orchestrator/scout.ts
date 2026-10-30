import type { ContextPack } from "./handoffs.js";

/**
 * The Scout's fixed contract. It reads a few files and hands the Lead a
 * validated context pack; it never edits, runs shell or asks the user. The
 * stage is enabled only through the internal tuning flag.
 */

const EXAMPLE = {
  kind: "context-pack",
  version: 1,
  excerpts: [{ path: "src/example.ts", startLine: 10, endLine: 24, symbol: "changedFunction", text: "A short excerpt from that range." }],
  notes: ["One sentence the Lead should know before planning."],
};

export const SCOUT_INSTRUCTIONS = [
  "You are the Scout in a two-model coding pipeline. Use only read_file, list_files and grep to gather the files, symbols and short excerpts the Lead needs to write the plan.",
  "Do not edit files, run shell commands, use MCP, ask the user or delegate. Do not paste whole files; use the smallest useful line range.",
  "Return exactly one JSON object and no prose, fences or extra fields. It must match this shape:",
  JSON.stringify(EXAMPLE),
].join("\n\n");

export function scoutPrompt(input: { brief: string; maxPackChars: number; maxExcerptChars: number; maxExcerpts?: number }): string {
  const maxExcerpts = input.maxExcerpts ?? 20;
  return [
    "Gather context for this request:",
    input.brief,
    "Return one context-pack JSON object.",
    `Keep the whole pack under ${input.maxPackChars} characters, each excerpt under ${input.maxExcerptChars}, and use at most ${maxExcerpts} excerpts. Paths are workspace-relative; include line ranges and symbols where useful.`,
  ].join("\n\n");
}

export function scoutRetryPrompt(errors: readonly string[]): string {
  return [
    "The context pack was rejected for these reasons:",
    ...errors.map((error) => `- ${error}`),
    "Return the corrected JSON object only. Read more only if the correction needs it.",
  ].join("\n");
}

/** A short, user-visible summary of the pack; the raw JSON stays for the Lead. */
export function scoutPackSummary(pack: ContextPack): string {
  const files = [...new Set(pack.excerpts.map((excerpt) => excerpt.path))];
  return [
    `${files.length} file${files.length === 1 ? "" : "s"} · ${pack.excerpts.length} excerpt${pack.excerpts.length === 1 ? "" : "s"}`,
    ...files.slice(0, 20).map((path) => `- ${path}`),
    ...(pack.notes.length ? ["Notes:", ...pack.notes.slice(0, 10)] : []),
  ].join("\n").slice(0, 12_000);
}
