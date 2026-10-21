import { Fragment, useEffect, useMemo, useState } from "react";
import { loadSyntaxHighlighter, segmentCode, syntaxLanguage, syntaxSourceAllowed, type SyntaxSpan } from "../lib/syntax";
import type { TextRange } from "../lib/diff";

const EMPTY: readonly SyntaxSpan[] = [];
const SYNTAX_DEBOUNCE_MS = 120;

/**
 * Async syntax spans for `source`. Unknown/oversized input and a pending or
 * failed import all render plain. Debounced so streaming text does not
 * tokenize per frame; cancellation and a source+language key guard keep a
 * stale answer from ever applying to newer text.
 */
export function useSyntax(source: string, language?: string): readonly SyntaxSpan[] {
  const key = JSON.stringify([language ?? "", source]);
  const [applied, setApplied] = useState<{ key: string; spans: readonly SyntaxSpan[] }>({ key: "", spans: EMPTY });
  useEffect(() => {
    if (!language || !source || !syntaxSourceAllowed(source)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void loadSyntaxHighlighter(language).then((highlight) => {
        // Cancel before the synchronous tokenization pass, not after.
        if (cancelled) return;
        let spans: readonly SyntaxSpan[] = EMPTY;
        try { spans = highlight(source); } catch { /* engine failure stays plain */ }
        if (!cancelled) setApplied({ key, spans });
      }).catch(() => {});
    }, SYNTAX_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [key, source, language]);
  // A key mismatch means this text was never tokenized — render it plain.
  return applied.key === key ? applied.spans : EMPTY;
}

/**
 * Code with syntax spans and word-change marks composed at shared boundaries.
 * Output is plain text + fixed `syntax-*` classes + <mark> — no HTML.
 */
export function CodeText({ text, spans = [], marks = [] }: { text: string; spans?: readonly SyntaxSpan[]; marks?: readonly TextRange[] }) {
  const segments = useMemo(() => segmentCode(text, spans, marks), [text, spans, marks]);
  return <>{segments.map((segment, index) => {
    const inner = segment.kind ? <span className={`syntax-${segment.kind}`}>{segment.text}</span> : segment.text;
    return segment.changed ? <mark key={index}>{inner}</mark> : <Fragment key={index}>{inner}</Fragment>;
  })}</>;
}

/** Colored code block: explicit fence language, else the path's extension. */
export function SyntaxCode({ text, language, path }: { text: string; language?: string; path?: string }) {
  const spans = useSyntax(text, syntaxLanguage(language, path));
  return <CodeText text={text} spans={spans} />;
}
