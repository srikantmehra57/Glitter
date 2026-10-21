/**
 * Split markdown into top-level blocks that render independently.
 *
 * A streamed reply grows one token at a time, and rendering it as one document
 * re-parses and re-renders *everything written so far* on every frame — the
 * cost of a frame grows with the length of the reply. Cut into blocks, all but
 * the last are unchanged from frame to frame, so a memoized view re-renders only
 * the paragraph, list or code block currently being written.
 *
 * Two properties make that safe, and both are tested against real documents:
 *
 * - Lossless and equivalent. `blocks.join("") === source`, and rendering the
 *   blocks separately gives the same elements as rendering the whole. A cut is
 *   made only where CommonMark itself ends a block: after a blank line, before a
 *   line that starts at column 0, outside a fenced code block, and that does not
 *   look like a list marker or an indented continuation. Anything whose meaning
 *   can reach across blocks (link reference definitions, footnotes, raw HTML that
 *   spans blank lines) turns splitting off for the whole document.
 * - Prefix-stable. A cut is decided from complete lines only, so once a block is
 *   followed by another it never changes as more text arrives — which is what lets
 *   the memoized view skip it.
 */

/**
 * Constructs whose meaning is not confined to one block: never split a document
 * containing them. Link reference definitions and footnotes reach across blocks;
 * comments, `<pre>`-like elements and any tag that starts a line open a raw HTML
 * block, which renders as loose text whose spacing depends on its neighbours.
 * (An autolink such as `<https://example.com>` is inline and does not match.)
 */
const CROSS_BLOCK = /^ {0,3}\[[^\]\n]+\]:\s*\S|\[\^|<!--|<(?:script|pre|style|textarea)\b|^ {0,3}<[!?]|^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s|\/?>|$)/im;

/**
 * Only a truly empty line separates blocks here. A line of nothing but spaces is
 * blank in the specification, but inside nested lists the parser can still treat
 * it as continuing the item; cutting after one changed the result in fuzzing.
 */
const EMPTY = /^\r?$/;
/** A list marker at the very start of a line (bullet, or ordered `1.` / `1)`), which may continue an earlier list. */
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const OPEN_BACKTICK = /^ {0,3}(`{3,})[^`]*$/;
const OPEN_TILDE = /^ {0,3}(~{3,}).*$/;
const CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * A fence indented by one to three spaces almost always sits inside a list item
 * or block quote, and the container ending closes it implicitly — something this
 * line-by-line scan does not model. From such a line on, nothing is cut.
 */
const INDENTED_FENCE = /^ {1,3}(?:`{3,}[^`]*|~{3,}.*)$/;

type Fence = { char: string; length: number };

function opening(line: string): Fence | null {
  const found = OPEN_BACKTICK.exec(line) ?? OPEN_TILDE.exec(line);
  return found ? { char: found[1][0], length: found[1].length } : null;
}

export function splitMarkdownBlocks(source: string): string[] {
  if (!source.includes("\n") || CROSS_BLOCK.test(source)) return [source];
  const cuts: number[] = [];
  let fence: Fence | null = null;
  let previousBlank = false;
  let cutting = true;
  let offset = 0;
  while (offset < source.length) {
    const newline = source.indexOf("\n", offset);
    const terminated = newline >= 0;
    const end = terminated ? newline : source.length;
    const line = source.slice(offset, end);
    if (fence) {
      const close = CLOSE_FENCE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      previousBlank = false;
    } else {
      const blank = EMPTY.test(line);
      // A cut needs the whole line, so it can never be reclassified by text still to come.
      if (cutting && !blank && previousBlank && terminated && offset > 0 && !/^\s/.test(line) && !LIST_MARKER.test(line)) cuts.push(offset);
      if (!blank && INDENTED_FENCE.test(line)) cutting = false;
      if (!blank) fence = opening(line);
      previousBlank = blank;
    }
    offset = terminated ? newline + 1 : source.length;
  }
  if (!cuts.length) return [source];
  const blocks: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    blocks.push(source.slice(from, cut));
    from = cut;
  }
  blocks.push(source.slice(from));
  return blocks;
}
