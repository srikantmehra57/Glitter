import { useMemo } from "react";
import { splitDiffLines, type DiffLine, type TextRange } from "../lib/diff";
import { commentTarget } from "../lib/lineComments";
import { syntaxLanguage, syntaxLines, type SyntaxSpan } from "../lib/syntax";
import { CodeText, useSyntax } from "./SyntaxCode";

const SIGN: Record<DiffLine["type"], string> = { add: "+", del: "-", ctx: " ", hunk: "", meta: "" };
const SIGNED = new Set<DiffLine["type"]>(["add", "del", "ctx"]);

/** The code portion of a diff line: the sign column already carries +/-/space. */
const codeText = (line: DiffLine) => SIGNED.has(line.type) ? line.text.slice(1) : line.text;

type Side = "before" | "after";
type SpanMap = Map<DiffLine, { before?: readonly SyntaxSpan[]; after?: readonly SyntaxSpan[] }>;

/** The gutter button that starts a comment on a line. Present only where the caller takes comments. */
function CommentButton({ line, onComment }: { line?: DiffLine; onComment?: (line: DiffLine) => void }) {
  const target = line && onComment ? commentTarget(line) : null;
  if (!line || !onComment || !target) return null;
  return <button type="button" className="dl-comment" aria-label={`Comment on ${target.removed ? "removed " : ""}line ${target.line}`} title="Comment on this line" onClick={() => onComment(line)}>+</button>;
}

function Cell({ line, marks, spans, lineNo, numbered, onComment }: { line?: DiffLine; marks?: TextRange[]; spans?: readonly SyntaxSpan[]; lineNo?: number; numbered: boolean; onComment?: (line: DiffLine) => void }) {
  return (
    <div className={`dl-cell ${line ? `dl-${line.type}` : "dl-empty"}`}>
      <CommentButton line={line} onComment={onComment} />
      {numbered ? <span className="dl-no" aria-hidden="true">{lineNo ?? ""}</span> : null}
      <span className="dl-sign" aria-hidden="true">{line ? SIGN[line.type] : ""}</span>
      <span className="dl-code">{line ? <CodeText text={codeText(line)} spans={spans} marks={marks} /> : null}</span>
    </div>
  );
}

/**
 * Shared diff renderer. `unified` keeps the patch's line order with old+new
 * number columns; `split` pairs del/add runs side by side. Word marks come
 * from the same pairing in both modes. When `path` resolves to a known
 * grammar, each side (before = del+ctx, after = add+ctx) is highlighted once
 * per hunk chunk — a `hunk` row always ends the previous colored region, so
 * lexical state (e.g. an unclosed comment) never bleeds across omitted
 * sections. Metadata renders verbatim.
 */
export function DiffLines(props: { lines: readonly DiffLine[]; mode?: "unified" | "split"; numbered?: boolean; path?: string; onComment?: (line: DiffLine) => void }) {
  const chunks = useMemo(() => {
    const out: DiffLine[][] = [];
    let current: DiffLine[] = [];
    for (const line of props.lines) {
      if (line.type === "hunk" && current.length) { out.push(current); current = []; }
      current.push(line);
    }
    if (current.length) out.push(current);
    return out;
  }, [props.lines]);
  if (chunks.length <= 1) return <DiffLinesChunk {...props} lines={props.lines} />;
  return <>{chunks.map((chunk, index) => <DiffLinesChunk key={index} {...props} lines={chunk} />)}</>;
}

function DiffLinesChunk({ lines, mode = "unified", numbered = true, path, onComment }: { lines: readonly DiffLine[]; mode?: "unified" | "split"; numbered?: boolean; path?: string; onComment?: (line: DiffLine) => void }) {
  const rows = useMemo(() => mode === "split" ? splitDiffLines(lines) : null, [lines, mode]);
  // Unified order is the raw line order; pairing still supplies word marks.
  const marks = useMemo(() => {
    if (mode !== "unified") return null;
    const map = new Map<DiffLine, TextRange[]>();
    for (const row of splitDiffLines(lines)) {
      if (row.left && row.leftChanges) map.set(row.left, row.leftChanges);
      if (row.right && row.rightChanges) map.set(row.right, row.rightChanges);
    }
    return map;
  }, [lines, mode]);
  const sides = useMemo(() => {
    const beforeLines = lines.filter((line) => line.type === "del" || line.type === "ctx");
    const afterLines = lines.filter((line) => line.type === "add" || line.type === "ctx");
    return {
      beforeLines,
      afterLines,
      beforeText: beforeLines.map(codeText).join("\n"),
      afterText: afterLines.map(codeText).join("\n"),
    };
  }, [lines]);
  const language = syntaxLanguage(undefined, path);
  const beforeSpans = useSyntax(sides.beforeText, language);
  const afterSpans = useSyntax(sides.afterText, language);
  const spans = useMemo<SpanMap | null>(() => {
    if (!beforeSpans.length && !afterSpans.length) return null;
    const map: SpanMap = new Map();
    const put = (side: Side) => (lineSpans: SyntaxSpan[], index: number) => {
      if (!lineSpans.length) return;
      const line = (side === "before" ? sides.beforeLines : sides.afterLines)[index];
      if (!line) return;
      const entry = map.get(line) ?? {};
      entry[side] = lineSpans;
      map.set(line, entry);
    };
    syntaxLines(sides.beforeText, beforeSpans).forEach(put("before"));
    syntaxLines(sides.afterText, afterSpans).forEach(put("after"));
    return map;
  }, [sides, beforeSpans, afterSpans]);
  const spansFor = (line: DiffLine, side: Side) => spans?.get(line)?.[side];
  if (mode === "split" && rows) {
    return (
      <div className="dl-lines dl-split">
        {rows.map((row, index) => row.meta
          ? <div key={index} className={`dl dl-${row.meta.type}`}><span className="dl-code">{row.meta.text}</span></div>
          : <div key={index} className="dl dl-pair">
              <Cell line={row.left} marks={row.leftChanges} spans={row.left && spansFor(row.left, "before")} lineNo={row.left?.oldLine} numbered={numbered} onComment={onComment} />
              <Cell line={row.right} marks={row.rightChanges} spans={row.right && spansFor(row.right, "after")} lineNo={row.right?.newLine} numbered={numbered} onComment={onComment} />
            </div>)}
      </div>
    );
  }
  return (
    <div className="dl-lines">
      {lines.map((line, index) => (
        <div key={index} className={`dl dl-${line.type}`}>
          <CommentButton line={line} onComment={onComment} />
          {numbered ? <>
            <span className="dl-no" aria-hidden="true">{line.oldLine ?? ""}</span>
            <span className="dl-no" aria-hidden="true">{line.newLine ?? ""}</span>
          </> : null}
          <span className="dl-sign" aria-hidden="true">{SIGN[line.type]}</span>
          <span className="dl-code"><CodeText text={codeText(line)} spans={SIGNED.has(line.type) ? spansFor(line, line.type === "del" ? "before" : "after") : undefined} marks={marks?.get(line)} /></span>
        </div>
      ))}
    </div>
  );
}
