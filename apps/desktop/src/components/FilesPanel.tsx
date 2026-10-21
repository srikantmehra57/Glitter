import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChevronRight, Copy, ExternalLink, FileText, Folder, MessageSquarePlus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { openPath } from "../lib/bridge";
import { describeError } from "../lib/errors";
import { buildFileTree, formatBytes, statusBadge, type FileNode } from "../lib/fileTree";
import { isTauri, uid } from "../lib/format";
import { fuzzyScore } from "../lib/fuzzy";
import { useAppStore } from "../lib/store";
import type { Workspace } from "../lib/types";
import { SyntaxCode } from "./SyntaxCode";

const FLAT_LIMIT = 200;

/** The Files tab: the workspace's files as a tree, and a read-only view of one file. */
export function FilesPanel({ workspace }: { workspace: Workspace | undefined }) {
  const s = useAppStore(useShallow((state) => ({
    fileIndex: state.fileIndex,
    fileView: state.fileView,
    refreshFileIndex: state.refreshFileIndex,
    git: state.git,
    openFile: state.openFile,
    closeFile: state.closeFile,
    addContextRefs: state.addContextRefs,
  })));
  const [filter, setFilter] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const paths = workspace && s.fileIndex?.workspaceId === workspace.id ? s.fileIndex.paths : null;
  // The index is normally loaded with the workspace. Ask for it when it is not there yet.
  useEffect(() => { if (workspace && !paths) s.refreshFileIndex(); }, [workspace?.id, workspace?.grantId, paths === null]);
  const status = useMemo(() => new Map((s.git?.files ?? []).map((file) => [file.path, statusBadge(file.status)])), [s.git]);
  const shown = useMemo(() => (changedOnly ? (paths ?? []).filter((path) => status.has(path)) : paths ?? []), [paths, changedOnly, status]);
  const query = filter.trim();
  const flat = useMemo(() => !query ? null : shown
    .map((path) => ({ path, score: fuzzyScore(query, path) }))
    .filter((entry): entry is { path: string; score: number } => entry.score != null)
    .sort((a, b) => b.score - a.score)
    .slice(0, FLAT_LIMIT)
    .map((entry) => entry.path), [shown, query]);
  const tree = useMemo(() => (flat ? [] : buildFileTree(shown)), [shown, flat]);

  if (s.fileView) {
    const view = s.fileView;
    const file = view.file;
    return <div className="file-view">
      <div className="file-view-head">
        <button type="button" className="icon-btn small" aria-label="Back to files" data-tooltip-align="start" data-tooltip="Back to files" onClick={() => { setError(null); s.closeFile(); }}><ArrowLeft size={14} /></button>
        <span className="file-view-path" title={view.path}>{view.path}</span>
        {file ? <span className="file-view-size">{formatBytes(file.size)}</span> : null}
        <button type="button" className="icon-btn small" aria-label="Add to thread" data-tooltip="Add to thread" onClick={() => { s.addContextRefs([{ id: uid(), kind: "file", path: view.path }]); document.getElementById("prompt")?.focus(); }}><MessageSquarePlus size={13} /></button>
        <button type="button" className="icon-btn small" aria-label="Copy path" data-tooltip="Copy path" onClick={() => void navigator.clipboard.writeText(view.path)}><Copy size={13} /></button>
        <button type="button" className="icon-btn small" aria-label="Open in editor" data-tooltip-align="end" data-tooltip="Open in your editor (chosen in Settings → General)" onClick={() => {
          if (!workspace) return;
          if (!workspace.grantId && isTauri()) { setError("This folder is not granted. Re-open it to restore access."); return; }
          void openPath(`${workspace.path}/${view.path}`, workspace.grantId ?? "preview", useAppStore.getState().editor).catch((cause) => setError(describeError(`Could not open ${view.path}`, cause)));
        }}><ExternalLink size={13} /></button>
      </div>
      {error || view.error ? <p className="review-note" role="alert">{error ?? view.error}</p> : null}
      {view.loading ? <p className="review-note">Loading file…</p> : null}
      {file?.skipped === "binary" ? <p className="review-note">This file is not text, so it has no preview. Open it in its default app instead.</p> : null}
      {file?.truncated ? <p className="review-note">Showing the first {formatBytes(new Blob([file.content ?? ""]).size)} of {formatBytes(file.size)}.</p> : null}
      {file?.content != null ? file.content ? <pre className="file-view-body" tabIndex={0} aria-label={`Contents of ${view.path}`}><SyntaxCode text={file.content} path={view.path} /></pre> : <p className="review-note">This file is empty.</p> : null}
    </div>;
  }

  const toggle = (path: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  const fileRow = (path: string, label: string, depth: number) => (
    <li key={path}>
      <button type="button" className="tree-row" style={{ paddingLeft: 10 + depth * 14 }} title={path} onClick={() => void s.openFile(path)}>
        <FileText size={13} aria-hidden="true" />
        <span className="tree-name">{label}</span>
        {status.has(path) ? <span className={`tree-badge ${status.get(path) === "U" || status.get(path) === "A" ? "add" : status.get(path) === "D" ? "del" : ""}`} aria-label={`git status ${status.get(path)}`}>{status.get(path)}</span> : null}
      </button>
    </li>
  );
  const rows = (nodes: FileNode[], depth: number): React.ReactNode => nodes.map((node) => {
    if (!node.children) return fileRow(node.path, node.name, depth);
    // "Changed only" is a short list: show it opened out.
    const open = changedOnly || expanded.has(node.path);
    return <li key={`dir:${node.path}`}>
      <button type="button" className="tree-row dir" style={{ paddingLeft: 10 + depth * 14 }} aria-expanded={open} onClick={() => toggle(node.path)}>
        <ChevronRight size={12} className={`caret ${open ? "open" : ""}`} aria-hidden="true" />
        <Folder size={13} aria-hidden="true" />
        <span className="tree-name">{node.name}</span>
      </button>
      {open ? <ul>{rows(node.children, depth + 1)}</ul> : null}
    </li>;
  });

  return <div className="files-panel">
    <div className="files-controls">
      <input aria-label="Filter files" placeholder="Filter files" value={filter} spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
      <label><input type="checkbox" checked={changedOnly} onChange={(event) => setChangedOnly(event.target.checked)} />Changed only</label>
    </div>
    {!workspace ? <p className="review-note">Open a workspace to browse files.</p>
      : !paths ? <p className="review-note">Loading files…</p>
      : !shown.length ? <p className="review-note">{changedOnly ? "No changed files." : "No files in this workspace."}</p>
      : flat ? flat.length ? <ul className="file-tree" aria-label="Matching files">{flat.map((path) => fileRow(path, path, 0))}</ul> : <p className="review-note">No files match “{query}”.</p>
      : <ul className="file-tree" aria-label="Files">{rows(tree, 0)}</ul>}
    {flat && flat.length === FLAT_LIMIT ? <p className="review-note">Showing the first {FLAT_LIMIT} matches. Narrow the filter to see more.</p> : null}
  </div>;
}
