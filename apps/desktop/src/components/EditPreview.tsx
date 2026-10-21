import type { ApprovalPreview } from "../lib/approvalPreview";
import { parseUnifiedDiff, type DiffLine } from "../lib/diff";
import { DiffLines } from "./DiffLines";

const LINE_CAP = 200;
const TEXT_CAP = 24_000;

/** Shared, bounded argument preview. It describes the tool call, not the current file on disk. */
export function EditPreview({ preview, completed = false }: { preview: NonNullable<ApprovalPreview>; completed?: boolean }) {
  let lines: DiffLine[];
  let truncated = false;
  let groups: { path?: string; lines: DiffLine[] }[] = [];
  const bounded = (text: string) => {
    if (text.length > TEXT_CAP) truncated = true;
    return text.slice(0, TEXT_CAP);
  };
  if (preview.kind === "patch") {
    const parsed = parseUnifiedDiff(bounded(preview.diff), LINE_CAP);
    truncated ||= parsed.truncated;
    // One cap across the whole preview — files keep their own path so each
    // hunk colors against the right grammar.
    let used = 0;
    groups = parsed.files.map((file) => {
      const all: DiffLine[] = [...file.header.map((text): DiffLine => ({ type: "meta", text })), ...file.lines];
      const shown = all.slice(0, Math.max(0, LINE_CAP - used));
      used += shown.length;
      if (shown.length < all.length) truncated = true;
      return { path: file.path, lines: shown };
    });
    lines = [];
  } else {
    lines = preview.path ? [{ type: "meta", text: bounded(preview.path) }] : [];
    if (preview.kind === "replace") {
      const before = bounded(preview.before).split("\n");
      const after = bounded(preview.after).split("\n");
      const half = Math.floor((LINE_CAP - lines.length) / 2);
      truncated ||= before.length > half || after.length > half;
      lines.push(...before.slice(0, half).map((text): DiffLine => ({ type: "del", text: `- ${text}` })),
        ...after.slice(0, half).map((text): DiffLine => ({ type: "add", text: `+ ${text}` })));
    } else {
      lines.push(...bounded(preview.content).split("\n").map((text): DiffLine => ({ type: "add", text: `+ ${text}` })));
    }
    groups = [{ path: preview.path, lines: lines.slice(0, LINE_CAP) }];
    truncated ||= lines.length > LINE_CAP;
  }
  const label = completed ? "Edit preview" : preview.kind === "patch" ? "Proposed patch" : preview.kind === "write" ? "Proposed file content" : "Proposed change";
  return <div className="diff approval-diff" aria-label={label}>
    {groups.map((group, index) => <DiffLines key={index} lines={group.lines} numbered={preview.kind === "patch"} path={group.path} />)}
    {truncated ? <div className="dl dl-meta"><span className="dl-code">Preview truncated</span></div> : null}
  </div>;
}
