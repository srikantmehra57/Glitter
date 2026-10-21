import { isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { openUrl } from "../lib/bridge";
import { relativeToWorkspace } from "../lib/agent";
import { indexedPath } from "../lib/fileTree";
import { copyText } from "../lib/format";
import { activeWorkspace, useAppStore } from "../lib/store";
import { splitMarkdownBlocks } from "../lib/markdownBlocks";
import { SyntaxCode } from "./SyntaxCode";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children.props : null;
  if (!code) return <pre>{children}</pre>;
  const lang = /language-(\S+)/.exec(code.className ?? "")?.[1];
  const text = textOf(code.children);
  const copy = () => {
    void copyText(text.replace(/\n$/, "")).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <span className="codeblock-lang">{lang ?? "code"}</span>
        <button type="button" className="codeblock-copy" aria-label={copied ? "Copied to clipboard" : "Copy code"} onClick={copy}>
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre><code className={code.className}><SyntaxCode text={text} language={lang} /></code></pre>
    </div>
  );
}

/**
 * Inline code. When it names a file in the workspace index it opens that file
 * in the viewer; anything else renders as plain code. Fenced blocks never come
 * through here: `CodeBlock` renders its own element.
 */
function InlineCode({ className, children }: { className?: string; children?: ReactNode }) {
  const text = textOf(children);
  const path = useAppStore((state) => {
    const workspace = activeWorkspace(state);
    return workspace && state.fileIndex?.workspaceId === workspace.id ? indexedPath(text, state.fileIndex.paths, (raw) => relativeToWorkspace(raw, workspace.path)) : null;
  });
  const openFile = useAppStore((state) => state.openFile);
  if (!path) return <code className={className}>{children}</code>;
  return <button type="button" className="code-link" title={`Open ${path}`} onClick={() => void openFile(path)}><code className={className}>{children}</code></button>;
}

const REMARK_PLUGINS = [remarkGfm];

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault();
        if (href) void openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  pre: CodeBlock,
  code: InlineCode,
  table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
};

/** One top-level block, parsed and rendered on its own; unchanged blocks are skipped outright. */
function MarkdownBlockView({ source }: { source: string }) {
  return <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>{source}</ReactMarkdown>;
}

const MarkdownBlock = memo(MarkdownBlockView);

/**
 * A streamed reply is re-rendered on every frame. Cut into blocks (see
 * `splitMarkdownBlocks`), only the block being written changes — the rest of the
 * reply is not parsed or rendered again.
 */
function MarkdownView({ children }: { children: string }) {
  const blocks = useMemo(() => splitMarkdownBlocks(children), [children]);
  return (
    <div className="prose">
      {blocks.map((block, index) => <MarkdownBlock key={index} source={block} />)}
    </div>
  );
}

export const Markdown = memo(MarkdownView);
