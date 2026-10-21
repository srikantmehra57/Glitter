import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { CodeText, SyntaxCode } from "./SyntaxCode";
import { DiffLines } from "./DiffLines";
import { EditPreview } from "./EditPreview";
import { loadSyntaxHighlighter, SYNTAX_SOURCE_CAP, type SyntaxSpan } from "../lib/syntax";
import type { DiffLine } from "../lib/diff";

const hoisted = vi.hoisted(() => ({ real: undefined as unknown as typeof import("../lib/syntax").loadSyntaxHighlighter }));
vi.mock("../lib/syntax", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/syntax")>();
  hoisted.real = actual.loadSyntaxHighlighter;
  return { ...actual, loadSyntaxHighlighter: vi.fn(actual.loadSyntaxHighlighter) };
});

const loader = vi.mocked(loadSyntaxHighlighter);
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const fixed = (spans: readonly SyntaxSpan[]) => () => spans;

const settle = async (ms = 150) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
};

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: false }); loader.mockReset(); loader.mockImplementation(hoisted.real); });
afterEach(() => { vi.useRealTimers(); });

describe("useSyntax", () => {
  it("renders plain while the import is pending, then applies colors", async () => {
    const done = deferred<(s: string) => readonly SyntaxSpan[]>();
    loader.mockReturnValue(done.promise);
    const { container } = render(<SyntaxCode text="const x = 1" language="javascript" />);
    expect(container.querySelector(".syntax-keyword")).toBeNull();
    expect(container.textContent).toBe("const x = 1");
    await settle();
    done.resolve(fixed([{ start: 0, end: 5, kind: "keyword" }]));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".syntax-keyword")?.textContent).toBe("const");
    expect(container.textContent).toBe("const x = 1");
  });

  it("never applies a stale result to changed text", async () => {
    const first = deferred<(s: string) => readonly SyntaxSpan[]>();
    const second = deferred<(s: string) => readonly SyntaxSpan[]>();
    loader.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { container, rerender } = render(<SyntaxCode text="aaaa" language="javascript" />);
    await settle();
    // Text changes before the first compute resolves — its answer must be dropped.
    rerender(<SyntaxCode text="bbbbbbbb" language="javascript" />);
    first.resolve(fixed([{ start: 0, end: 4, kind: "keyword" }]));
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".syntax-keyword")).toBeNull();
    // The new text's own debounced compute still lands.
    await settle();
    second.resolve(fixed([{ start: 4, end: 8, kind: "literal" }]));
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe("bbbbbbbb");
    expect(container.querySelector(".syntax-literal")?.textContent).toBe("bbbb");
    expect(container.querySelector(".syntax-keyword")).toBeNull();
  });

  it("tokenizes only the settled source during rapid streaming", async () => {
    const seen: string[] = [];
    loader.mockImplementation(() => Promise.resolve((s: string) => { seen.push(s); return []; }));
    const { rerender } = render(<SyntaxCode text="a" language="javascript" />);
    rerender(<SyntaxCode text="aa" language="javascript" />);
    rerender(<SyntaxCode text="aaa" language="javascript" />);
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(seen).toEqual(["aaa"]);
  });

  it("stays plain on loader failure and does not load unknown or oversized input", async () => {
    loader.mockRejectedValue(new Error("boom"));
    const { container } = render(<SyntaxCode text="x" language="javascript" />);
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe("x");
    loader.mockClear();
    render(<SyntaxCode text="x" language="brainfuck" />);
    render(<SyntaxCode text={"y".repeat(SYNTAX_SOURCE_CAP + 1)} language="javascript" />);
    await settle();
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("CodeText", () => {
  it("composes language colors and word marks with exact textContent", () => {
    const { container } = render(<CodeText text="const n = 42" spans={[{ start: 0, end: 5, kind: "keyword" }, { start: 10, end: 12, kind: "literal" }]} marks={[{ start: 10, end: 12 }]} />);
    expect(container.textContent).toBe("const n = 42");
    const mark = container.querySelector("mark .syntax-literal");
    expect(mark?.textContent).toBe("42");
  });
});

describe("DiffLines", () => {
  const lines: DiffLine[] = [
    { type: "ctx", text: " const a = 1;", oldLine: 1, newLine: 1 },
    { type: "del", text: "-const b = 2;", oldLine: 2 },
    { type: "add", text: "+const b = 3;", newLine: 2 },
    { type: "meta", text: "diff --git a/x.ts b/x.ts" },
  ];
  it("highlights each side once and composes numbers/signs/word marks", async () => {
    // Real library + real debounce: wait for actual tokens.
    vi.useRealTimers();
    const { container } = render(<DiffLines lines={lines} numbered path="x.ts" />);
    await waitFor(() => expect(container.querySelector(".syntax-keyword")).not.toBeNull(), { timeout: 3000 });
    expect(loader).toHaveBeenCalledWith("typescript");
    // Numbers and signs intact; keyword colored; word mark composes.
    expect(container.querySelectorAll(".dl-no").length).toBe(8);
    const keyword = container.querySelector(".dl-add .syntax-keyword");
    expect(keyword?.textContent).toBe("const");
    const mark = container.querySelector(".dl-add mark");
    expect(mark?.textContent).toBe("3");
    expect(container.textContent).toContain("const a = 1;");
  });
  it("renders plain without a resolvable path", async () => {
    const { container } = render(<DiffLines lines={lines} numbered />);
    await settle();
    expect(loader).not.toHaveBeenCalled();
    expect(container.querySelector(".syntax-keyword")).toBeNull();
    expect(container.textContent).toContain("const b = 3;");
  });
});

describe("EditPreview", () => {
  it("colors each patch file with its own grammar under one cap", async () => {
    const diff = [
      "diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-const a = 1;", "+const a = 2;",
      "diff --git a/b.py b/b.py", "--- a/b.py", "+++ b/b.py", "@@ -1 +1 @@", "-x = 1", "+x = 2",
    ].join("\n");
    const { container } = render(<EditPreview preview={{ kind: "patch", diff }} />);
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(loader).toHaveBeenCalledWith("typescript");
    expect(loader).toHaveBeenCalledWith("python");
    // Each file renders its own diff chunk(s) — both grammars used.
    expect(container.querySelectorAll(".dl-lines").length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain("const a = 2;");
    expect(container.textContent).toContain("x = 2");
  });
  it("keeps replace previews unnumbered with path-based colors", async () => {
    const { container } = render(<EditPreview preview={{ kind: "replace", path: "a.ts", before: "let x = 1", after: "let x = 2" }} />);
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".dl-no")).toBeNull();
    expect(loader).toHaveBeenCalledWith("typescript");
    expect(container.querySelector(".syntax-keyword")?.textContent).toBe("let");
  });
});

describe("useSyntax keying and lifecycle", () => {
  it("renders the new language/source pair plain until its own result lands", async () => {
    const calls: [string, string][] = [];
    const pending: Record<string, (s: string) => readonly SyntaxSpan[]> = {};
    loader.mockImplementation((lang) => Promise.resolve((s: string) => { calls.push([lang, s]); return pending[lang] ? pending[lang](s) : []; }));
    const spans = (kind: "keyword" | "literal") => [{ start: 0, end: 1, kind }] as const;
    pending.c = () => spans("keyword");
    pending.css = () => spans("literal");
    // 'c'+'ssX' and 'css'+'X' share an undelimited key — the hook must key
    // on the pair, so the rerender shows plain text, never the stale spans.
    const { container, rerender } = render(<SyntaxCode text="ssX" language="c" />);
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".syntax-keyword")?.textContent).toBe("s");
    rerender(<SyntaxCode text="X" language="css" />);
    expect(container.querySelector(".syntax-keyword")).toBeNull();
    expect(container.textContent).toBe("X");
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(calls).toContainEqual(["css", "X"]);
    expect(calls).not.toContainEqual(["c", "X"]);
    expect(container.querySelector(".syntax-literal")?.textContent).toBe("X");
  });

  it("a language-only rerender drops the old colors immediately", async () => {
    loader.mockImplementation((lang) => Promise.resolve(() => lang === "python" ? [{ start: 0, end: 2, kind: "comment" as const }] : [{ start: 0, end: 2, kind: "keyword" as const }]));
    const { container, rerender } = render(<SyntaxCode text="if" language="javascript" />);
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".syntax-keyword")).not.toBeNull();
    rerender(<SyntaxCode text="if" language="python" />);
    // The old javascript-colored spans must not apply to the python render.
    expect(container.querySelector(".syntax-keyword")).toBeNull();
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".syntax-comment")).not.toBeNull();
  });

  it("never runs a pending compute after unmount, and compute-throw stays plain", async () => {
    const done = deferred<(s: string) => readonly SyntaxSpan[]>();
    const spy = vi.fn(fixed([]));
    loader.mockReturnValue(done.promise);
    const { unmount, container } = render(<SyntaxCode text="let x" language="javascript" />);
    await settle();
    unmount();
    done.resolve(spy);
    await act(async () => { await Promise.resolve(); });
    expect(spy).not.toHaveBeenCalled();
    loader.mockImplementation(() => Promise.resolve(() => { throw new Error("tokenize blew up"); }));
    render(<SyntaxCode text="let y" language="javascript" />);
    await settle();
    await act(async () => { await Promise.resolve(); });
    expect(container.textContent).toBe(""); // unmounted view left no nodes
    expect(document.body.textContent).toContain("let y");
  });
});

describe("DiffLines hunk isolation", () => {
  it("colors each hunk independently — an unclosed comment cannot leak", async () => {
    vi.useRealTimers();
    const lines: DiffLine[] = [
      { type: "hunk", text: "@@ -1,2 +1,2 @@", oldLine: 1, newLine: 1 },
      { type: "ctx", text: " int a = 1;", oldLine: 1, newLine: 1 },
      { type: "del", text: "-/* stray comment", oldLine: 2 },
      { type: "hunk", text: "@@ -9,2 +9,2 @@", oldLine: 9, newLine: 9 },
      { type: "del", text: "-int old = 0;", oldLine: 9 },
      { type: "add", text: "+const fresh = true;", newLine: 9 },
    ];
    const { container } = render(<DiffLines lines={lines} numbered path="x.c" />);
    await waitFor(() => expect(container.querySelector(".dl-add .syntax-keyword")).not.toBeNull(), { timeout: 3000 });
    // Hunk 2's 'const' must still color as a keyword — if the unclosed '/*'
    // in hunk 1's before side leaked, everything after it would be comment.
    const add = container.querySelector(".dl-add .dl-code");
    expect(add?.textContent).toBe("const fresh = true;");
    expect(add?.querySelector(".syntax-keyword")?.textContent).toBe("const");
    // The before side is where the stray comment actually lived: hunk 2's
    // deletion must still read as keywords, not comment text.
    const del = container.querySelectorAll(".dl-del .dl-code")[1];
    expect(del?.textContent).toBe("int old = 0;");
    expect(del?.querySelector(".syntax-keyword")?.textContent).toBe("int");
    expect(del?.querySelector(".syntax-comment")).toBeNull();
  });

  it("keeps before/after lexical state on the correct split side", async () => {
    vi.useRealTimers();
    const lines: DiffLine[] = [
      { type: "del", text: "-/* opens a comment", oldLine: 1 },
      { type: "add", text: "+const head = 1;", newLine: 1 },
      { type: "ctx", text: " const tail = 2;", oldLine: 2, newLine: 2 },
    ];
    const { container } = render(<DiffLines lines={lines} mode="split" numbered path="x.c" />);
    await waitFor(() => expect(container.querySelector(".dl-cell .syntax-keyword")).not.toBeNull(), { timeout: 3000 });
    const row = container.querySelectorAll(".dl-pair")[1]; // the shared ctx line
    const cells = row.querySelectorAll(".dl-cell");
    const left = cells[0].querySelector(".dl-code");
    const right = cells[1].querySelector(".dl-code");
    // Same ctx text: left/before saw the unclosed '/*' → comment; right/after
    // saw a clean `const` → keyword.
    expect(left?.querySelector(".syntax-comment")).not.toBeNull();
    expect(right?.querySelector(".syntax-keyword")?.textContent).toBe("const");
  });

  it("does not request an engine when a side is empty", async () => {
    loader.mockReset();
    const calls: string[] = [];
    loader.mockImplementation((lang) => Promise.resolve(() => { calls.push(lang); return []; }));
    const lines: DiffLine[] = [{ type: "add", text: "+const x = 1;", newLine: 1 }];
    render(<DiffLines lines={lines} numbered path="x.ts" />);
    await settle();
    await act(async () => { await Promise.resolve(); });
    // Only the 'after' side loaded — the empty 'before' side stayed plain.
    expect(loader).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["typescript"]);
  });
});

describe("EditPreview caps across files", () => {
  const filePatch = (path: string, count: number) => [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -1,${count} +1,${count} @@`,
    ...Array.from({ length: count }, (_, i) => `+line ${i} here;`),
  ].join("\n");

  it("applies one 200-row cap across files of different languages", async () => {
    vi.useRealTimers();
    const diff = `${filePatch("a.ts", 150)}\n${filePatch("b.py", 150)}`;
    const { container } = render(<EditPreview preview={{ kind: "patch", diff }} />);
    const rows = container.querySelectorAll(".dl:not(.dl-meta)");
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(container.textContent).toContain("Preview truncated");
    await waitFor(() => expect(loader).toHaveBeenCalledWith("typescript"), { timeout: 3000 });
    expect(loader).toHaveBeenCalledWith("python");
  });

  it("bounds write previews and never invents line numbers", () => {
    const content = Array.from({ length: 500 }, (_, i) => `write line ${i}`).join("\n");
    const { container } = render(<EditPreview preview={{ kind: "write", path: "out.md", content }} />);
    expect(container.querySelector(".dl-no")).toBeNull();
    expect(container.textContent).toContain("Preview truncated");
    expect(container.textContent).toContain("write line 0");
    expect(container.textContent).not.toContain("write line 300");
  });
});
