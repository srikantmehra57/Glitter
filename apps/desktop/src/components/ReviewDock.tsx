import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";
import { describeError } from "../lib/errors";
import { Check, ChevronLeft, Copy, Download, Ellipsis, ExternalLink, GitPullRequest, Maximize2, Upload, Minimize2, RefreshCw, Sparkles, Undo2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { parseUnifiedDiff, reviewTarget, type DiffLine, type FileDiff } from "../lib/diff";
import { DiffLines } from "./DiffLines";
import { commentContext, commentTarget, type LineComment } from "../lib/lineComments";
import { openPath, openUrl, saveOutputText } from "../lib/bridge";
import { editedPaths } from "../lib/agent";
import { humanizeGitStatus, isTauri } from "../lib/format";
import { clampDockWidth, dockWidthBounds, sidebarWidthFor, subscribeResize } from "../lib/reviewLayout";
import { FilesPanel } from "./FilesPanel";
import { shortcutText } from "../lib/commands";
import { usePresence } from "../lib/presence";
import { activeWorkspace, currentThread, currentWorkspace, inWorktree, useAppStore } from "../lib/store";
import { REVIEW_SCOPES, type GitFile, type ReviewScope } from "../lib/types";
import { TaskMonitor } from "./TaskMonitor";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

const NO_PATHS: string[] = [];
const NO_COMMENTS: LineComment[] = [];
const MORE_VIEW_OPTIONS: SelectMenuOption[] = [
  { value: "files", label: "Files", description: "Browse workspace files" },
  { value: "activity", label: "Monitor", description: "Goals, tasks and subagents" },
];
const SCOPE_LABELS: Record<ReviewScope, string> = { all: "All changes", lastTurn: "Last turn", staged: "Staged", unstaged: "Unstaged", branch: "Branch" };
const SCOPE_OPTIONS = REVIEW_SCOPES.map((scope) => ({ value: scope, label: SCOPE_LABELS[scope] }));
/** Honest one-line explanations for a `previewSkipped` marker on a new file. */
const SKIPPED_REASONS: Record<string, string> = {
  binary: "This looks like a binary file — no preview.",
  tooLarge: "This file is too large to preview.",
  unavailable: "This file could not be read.",
  unsupported: "This file cannot be previewed.",
  limit: "The preview limit for this snapshot was reached.",
};

export function ReviewDock() {
  const s = useAppStore(useShallow((state) => {
    const target = reviewTarget(state);
    return ({
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    git: state.git,
    gitLoading: state.gitLoading,
    gitError: state.gitError,
    reviewScope: state.reviewScope,
    reviewBase: state.reviewBase,
    review: state.review,
    reviewLoading: state.reviewLoading,
    reviewError: state.reviewError,
    reviewKey: target.key,
    reviewNotice: target.notice,
    refreshReview: state.refreshReview,
    setReviewScope: state.setReviewScope,
    setReviewBase: state.setReviewBase,
    preview: state.preview,
    dockOpen: state.dockOpen,
    dockWidth: state.dockWidth,
    sidebarWidth: state.sidebarWidth,
    dockExpanded: state.dockExpanded,
    sidebarCollapsed: state.sidebarCollapsed,
    shortcutOverrides: state.shortcutOverrides,
    inspectorTab: state.inspectorTab,
    diffTabs: state.diffTabs,
    diffActive: state.diffActive,
    refreshGit: state.refreshGit,
    openFileDiff: state.openFileDiff,
    closeFileDiff: state.closeFileDiff,
    setActiveDiff: state.setActiveDiff,
    setInspectorTab: state.setInspectorTab,
    setDockOpen: state.setDockOpen,
    setDockWidth: state.setDockWidth,
    setDockExpanded: state.setDockExpanded,
    initializeGit: state.initializeGit,
    discardGitFiles: state.discardGitFiles,
    discardGitHunk: state.discardGitHunk,
    discardAllGit: state.discardAllGit,
    stageGitFiles: state.stageGitFiles,
    commitGit: state.commitGit,
    lineComments: state.lineComments[state.selectedSessionId ? `thread:${state.selectedSessionId}` : `project:${state.selectedWorkspaceId}`] ?? NO_COMMENTS,
    addLineComment: state.addLineComment,
    removeLineComment: state.removeLineComment,
    sendLineComments: state.sendLineComments,
    pushBranch: state.pushBranch,
    pullBranch: state.pullBranch,
    pullRequest: state.pullRequest,
    pullRequestLoading: state.pullRequestLoading,
    refreshPullRequest: state.refreshPullRequest,
    commitDraft: state.commitDraft,
    commitDrafting: state.commitDrafting,
    draftCommitMessage: state.draftCommitMessage,
    confirm: state.confirm,
  }); }));
  // A worktree thread reviews its own checkout, not the workspace folder.
  const worktree = useAppStore((state) => currentThread(state)?.worktree);
  const workspace = useMemo(() => inWorktree(currentWorkspace(s), worktree), [s.workspaces, s.selectedWorkspaceId, worktree]);
  // Files the agent edited in this thread. The dock used to subscribe to *every*
  // thread and re-derive this from the whole transcript on each streamed token;
  // now it selects just the (usually unchanging) list, and only while it is open.
  const editedOpen = useAppStore(useShallow((state) => {
    if (!state.dockOpen) return NO_PATHS;
    const open = currentThread(state);
    return open ? editedPaths(open.items, activeWorkspace(state)?.path) : NO_PATHS;
  }));
  // The pane keeps the list it last showed while it slides shut.
  const lastEdited = useRef(editedOpen);
  if (s.dockOpen) lastEdited.current = editedOpen;
  const editedList = lastEdited.current;
  const pane = usePresence(s.dockOpen);
  const [showUntracked, setShowUntracked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Which mutation is in flight, so its trigger disables against a double click. */
  const [busy, setBusy] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  // A pull rewrites files under the agent; it waits for the turn to end.
  const threadRunning = useAppStore((state) => currentThread(state)?.status === "running");
  const [commenting, setCommenting] = useState<(Omit<LineComment, "id">) | null>(null);
  // A message the agent drafted lands in the commit box once, and stays editable.
  useEffect(() => { if (s.commitDraft) setCommitMessage(s.commitDraft.text); }, [s.commitDraft?.seq]);
  const [baseDraft, setBaseDraft] = useState(s.reviewBase);
  const scoped = s.inspectorTab === "diff" && s.reviewScope !== "all";
  const diffData = scoped ? s.review?.key === s.reviewKey ? s.review.data : null : s.git;
  const reviewLoading = scoped && s.reviewLoading === s.reviewKey;
  const visibleError = error || (scoped ? s.reviewError?.key === s.reviewKey ? s.reviewError.message : null : s.gitError);
  const parsed = useMemo(() => diffData?.diff ? parseUnifiedDiff(diffData.diff) : { files: [], truncated: false }, [diffData?.diff]);
  const autoOpen = parsed.files[0]?.path ?? null;
  const visible = s.diffTabs ?? (scoped ? diffData?.files.map((file) => file.path) ?? [] : autoOpen ? [autoOpen] : []);
  // Tabs model the paths the user actually opened, whether or not a diff block
  // exists for them: a skipped new file shows its own reason instead of
  // silently falling back to another file's patch.
  const openFileTabs = useMemo(() => {
    const diffs = new Map(parsed.files.map((file) => [file.path, file]));
    const entries = new Map((diffData?.files ?? []).map((file) => [file.path, file]));
    return visible
      .map((path): { path: string; diff?: FileDiff; entry?: GitFile } => ({ path, diff: diffs.get(path), entry: entries.get(path) }))
      .filter((tab) => tab.diff || tab.entry);
  }, [visible, parsed.files, diffData?.files]);
  const activeTab = openFileTabs.find((tab) => tab.path === s.diffActive) ?? openFileTabs[0];
  const activeFile = activeTab?.diff;
  const activeEntry = activeTab?.entry;
  const skippedReason = activeEntry?.previewSkipped ? SKIPPED_REASONS[activeEntry.previewSkipped] ?? "This file has no preview." : null;
  // Unified vs split is a preference; split only takes effect when the dock's
  // rendered width (not the saved value) has room for two columns.
  const [diffMode, setDiffMode] = useState<"unified" | "split">("unified");
  const asideRef = useRef<HTMLElement | null>(null);
  const [dockPx, setDockPx] = useState(0);
  // The aside unmounts while the dock is closed: rebind on every reopen so
  // split availability always tracks the live element.
  useEffect(() => {
    const node = asideRef.current;
    if (!node || typeof ResizeObserver === "undefined") { setDockPx(0); return; }
    const observer = new ResizeObserver((entries) => setDockPx(entries[0]?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [s.dockOpen]);
  const splitReady = diffMode === "split" && dockPx >= 640;
  // Dock width: the saved preference clamps against the live window so a
  // resize never rewrites the stored value.
  const viewport = useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1280);
  const sidebar = sidebarWidthFor(viewport, s.sidebarCollapsed, s.sidebarWidth);
  const bounds = dockWidthBounds(viewport, sidebar);
  const width = clampDockWidth(s.dockWidth, viewport, sidebar);
  const startWidth = useRef(width);
  startWidth.current = width;
  const stopResize = useRef<(() => void) | null>(null);
  useEffect(() => () => stopResize.current?.(), []);
  // Closing or expanding the dock hides the handle mid-drag too — release it.
  useEffect(() => { if (!s.dockOpen || s.dockExpanded) stopResize.current?.(); }, [s.dockOpen, s.dockExpanded]);
  const finishResize = () => {
    stopResize.current?.();
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    // A second gesture ends any capture the first one left behind, and the
    // body styles go back to whatever they were — not a blank wipe.
    stopResize.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const start = startWidth.current;
    handle.setPointerCapture?.(pointerId);
    const priorSelect = document.body.style.userSelect;
    const priorCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (moved: PointerEvent) => {
      if (moved.pointerId !== pointerId) return;
      const state = useAppStore.getState();
      // Dragging the left edge leftwards widens the dock.
      state.setDockWidth(clampDockWidth(start + (startX - moved.clientX), window.innerWidth, sidebarWidthFor(window.innerWidth, state.sidebarCollapsed, state.sidebarWidth)));
    };
    const end = (ended: PointerEvent) => { if (ended.pointerId === pointerId) finishResize(); };
    const cleanup = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      document.body.style.userSelect = priorSelect;
      document.body.style.cursor = priorCursor;
      stopResize.current = null;
    };
    stopResize.current = cleanup;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  };
  const resizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 96 : 24;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width + step;
    else if (event.key === "ArrowRight") next = width - step;
    else if (event.key === "Home") next = bounds.min;
    else if (event.key === "End") next = bounds.max;
    if (next == null) return;
    event.preventDefault();
    s.setDockWidth(clampDockWidth(next, viewport, sidebar));
  };
  const sessionPaths = useMemo(() => new Set(editedList), [editedList]);
  const sessionFiles = useMemo(() => (s.git?.files ?? []).filter((file) => sessionPaths.has(file.path)), [s.git?.files, sessionPaths]);
  const otherFiles = useMemo(() => (s.git?.files ?? []).filter((file) => !sessionPaths.has(file.path)), [s.git?.files, sessionPaths]);
  useEffect(() => { setShowUntracked(false); setError(null); }, [workspace?.id, s.reviewScope]);
  useEffect(() => { setBaseDraft(s.reviewBase); }, [workspace?.id, s.reviewBase]);
  useEffect(() => {
    if (s.dockOpen && s.inspectorTab === "diff" && s.reviewScope !== "all") void s.refreshReview();
  }, [s.dockOpen, s.inspectorTab, s.reviewKey, s.git, s.gitLoading]);
  useEffect(() => {
    if (workspace && !s.git && !s.gitLoading && !s.gitError && !s.preview) void s.refreshGit();
  }, [workspace?.id]);
  const lines = activeFile?.lines ?? [];
  // Hunk groups with true per-file indices (the native side counts the same
  // `@@` blocks from a fresh diff); the render cap cuts groups, never indices.
  const hunks = useMemo(() => {
    const groups: { index: number; header: DiffLine; lines: DiffLine[]; start: number }[] = [];
    lines.forEach((line, at) => {
      if (line.type === "hunk") groups.push({ index: groups.length, header: line, lines: [], start: at });
      else if (groups.length) groups[groups.length - 1].lines.push(line);
    });
    return groups;
  }, [lines]);
  const renderedHunks = useMemo(() => {
    const capped: typeof hunks = [];
    let count = 0;
    for (const group of hunks) {
      if (count >= 2000) break;
      capped.push(group);
      count += 1 + group.lines.length;
    }
    return capped;
  }, [hunks]);
  // Every hook runs before the dock can bail out: a closed dock that skipped
  // the hunk memos would render more hooks the moment it opened, which React
  // rejects outright (error #310).
  if (!pane.mounted) return null;
  const fileCount = s.git?.files.length ?? 0;
  const statFiles = s.inspectorTab === "diff" ? diffData?.files ?? [] : s.git?.files ?? [];
  const added = statFiles.reduce((sum, file) => sum + file.added, 0);
  const removed = statFiles.reduce((sum, file) => sum + file.removed, 0);
  const openFile = (path: string) => {
    setError(null);
    s.openFileDiff(path);
  };
  const closeFile = (path: string) => s.closeFileDiff(path);
  const granted = () => {
    if (workspace?.grantId || !isTauri()) return true;
    setError("This folder is not granted. Re-open it to restore access.");
    return false;
  };
  /** One git action at a time, with its failure shown in the dock. */
  const run = async (key: string, failure: string, action: () => Promise<unknown>) => {
    if (!workspace || !granted() || busy) return false;
    setError(null);
    setNotice(null);
    setBusy(key);
    try { await action(); return true; }
    catch (cause) { setError(describeError(failure, cause)); return false; }
    finally { setBusy(null); }
  };
  const push = async () => {
    const branch = s.git?.branch;
    if (!branch || busy) return;
    if (!(await s.confirm({ title: `Push ${branch}?`, body: "This sends the branch's commits to its remote using your own git credentials.", confirmLabel: "Push" }))) return;
    await run("push", "Could not push", async () => { const pushed = await s.pushBranch(); setNotice(`Pushed ${pushed.branch} to ${pushed.remote}.`); });
  };
  const commitAndPush = async () => {
    const branch = s.git?.branch;
    const text = commitMessage.trim();
    if (!branch || !text || busy) return;
    if (!(await s.confirm({ title: `Commit and push ${branch}?`, body: "This commits the staged files, then sends the branch's commits to its remote using your own git credentials.", confirmLabel: "Commit and push" }))) return;
    if (!(await run("commit", "Could not commit the staged changes", () => s.commitGit(text)))) return;
    setCommitMessage("");
    await run("push", "Committed, but could not push", async () => { const pushed = await s.pushBranch(); setNotice(`Committed and pushed ${pushed.branch} to ${pushed.remote}.`); });
  };
  const createPullRequest = async () => {
    const branch = s.git?.branch;
    if (!branch || busy) return;
    if (!(await s.confirm({ title: `Create a pull request for ${branch}?`, body: "This pushes the branch, then opens a pull request with the GitHub CLI. The title and description come from the branch's commits.", confirmLabel: "Create pull request" }))) return;
    if (!(await run("push", "Could not push", () => s.pushBranch()))) return;
    // The branch may already have one (made elsewhere, or before a relaunch): show it instead of failing.
    if (!(await run("pr", "Could not read the pull request", () => s.refreshPullRequest(false)))) return;
    const existing = useAppStore.getState().pullRequest;
    if (existing?.url) { setNotice("This branch already has a pull request."); return; }
    if (existing?.unavailable) return;
    await run("pr", "Could not create the pull request", () => s.refreshPullRequest(true));
  };
  const discardOne = async (file: GitFile) => {
    if (!workspace || !granted() || busy) return;
    const label = file.status === "??"
      ? `Delete new file ${file.path}?`
      : `Discard changes to ${file.path}?`;
    if (!(await s.confirm({ title: label, body: "This cannot be undone.", confirmLabel: file.status === "??" ? "Delete" : "Discard", danger: true }))) return;
    setError(null);
    setBusy(file.path);
    try {
      await s.discardGitFiles([file.path]);
    } catch (cause) {
      setError(describeError(`Could not discard ${file.path}`, cause));
    } finally {
      setBusy(null);
    }
  };
  const discardHunk = async (path: string, hunk: number) => {
    if (!workspace || !granted() || busy) return;
    if (!(await s.confirm({ title: `Discard hunk ${hunk + 1} of ${path}?`, body: "The file is unstaged first. This cannot be undone.", confirmLabel: "Discard", danger: true }))) return;
    setError(null);
    setBusy(path + "#" + hunk);
    try {
      await s.discardGitHunk(path, hunk);
    } catch (cause) {
      setError(describeError("Could not discard that change", cause));
    } finally {
      setBusy(null);
    }
  };
  const discardAll = async () => {
    if (!workspace || !fileCount || !granted() || busy) return;
    if (!(await s.confirm({ title: `Discard all ${fileCount} uncommitted change${fileCount === 1 ? "" : "s"}?`, body: "Tracked files restore, new files are deleted. This cannot be undone.", confirmLabel: "Discard all", danger: true }))) return;
    setError(null);
    setBusy("all");
    try {
      await s.discardAllGit();
    } catch (cause) {
      setError(describeError("Could not discard the changes", cause));
    } finally {
      setBusy(null);
    }
  };
  const initRepo = async () => {
    if (!workspace || !granted() || busy) return;
    const target = { id: workspace.id, grantId: workspace.grantId ?? null };
    if (!(await s.confirm({ title: `Initialize a git repository in ${workspace.name}?`, body: `This creates a .git folder inside ${workspace.name}. Existing files stay exactly as they are and nothing is committed.`, confirmLabel: "Initialize" }))) return;
    // The confirmation can outlive a workspace switch or a re-issued grant:
    // initialize only the folder the user just agreed to.
    const current = activeWorkspace(useAppStore.getState());
    if (!current || current.id !== target.id || (current.grantId ?? null) !== target.grantId) return;
    setError(null);
    setBusy("init");
    try {
      await s.initializeGit();
    } catch (cause) {
      const latest = currentWorkspace(useAppStore.getState());
      if (latest?.id === target.id && (latest.grantId ?? null) === target.grantId) setError(describeError("Could not initialize the repository", cause));
    } finally {
      setBusy(null);
    }
  };
  const toggleStage = async (file: GitFile) => {
    if (!workspace || !granted() || busy) return;
    const staged = file.status[0] !== " " && file.status[0] !== "?";
    setError(null);
    setBusy(file.path);
    try {
      await s.stageGitFiles([file.path], !staged);
    } catch (cause) {
      setError(describeError(`Could not ${staged ? "unstage" : "stage"} ${file.path}`, cause));
    } finally {
      setBusy(null);
    }
  };
  const renderRow = (file: GitFile) => {
    const separator = file.path.lastIndexOf("/");
    const name = file.path.slice(separator + 1);
    const directory = separator >= 0 ? file.path.slice(0, separator) : "";
    const staged = file.status[0] !== " " && file.status[0] !== "?";
    const statusLabel = humanizeGitStatus(file.status);
    return (
    <div key={file.path} className={`file-row ${activeTab?.path === file.path ? "active" : ""}`}>
      <button className="file-open" aria-label={`Open changes for ${file.path}`} title={`${statusLabel} · ${file.path}`} onClick={() => openFile(file.path)}>
        <span className="path"><span className="file-name">{name}</span>{directory ? <span className="file-directory">{directory}</span> : null}</span>
        {statusLabel !== "Modified" ? <span className={`file-status s-${file.status.trim().replace("??", "new") || "m"}`}>{statusLabel}</span> : null}
        {file.status !== "??" && <><span className={`add${file.added ? "" : " zero"}`}>+{file.added}</span><span className={`del${file.removed ? "" : " zero"}`}>−{file.removed}</span></>}
      </button>
      <button type="button" className="file-stage" role="checkbox" aria-label={`Stage ${file.path}`} title={staged ? "Unstage file" : "Stage file"} aria-checked={staged} disabled={busy === file.path} onClick={() => void toggleStage(file)}><span aria-hidden="true">{staged ? <Check size={11} strokeWidth={2.5} /> : null}</span></button>
      <button className="icon-btn small file-discard" aria-label={`Discard changes to ${file.path}`} data-tooltip-align="end" data-tooltip="Discard changes" disabled={busy === file.path} onClick={() => void discardOne(file)}><Undo2 size={13} /></button>
    </div>
    );
  };
  const stagedCount = (s.git?.files ?? []).filter((file) => file.status[0] !== " " && file.status[0] !== "?").length;
  const unstagedPaths = (s.git?.files ?? []).filter((file) => file.status === "??" || (file.status[1] ?? " ") !== " ").map((file) => file.path);
  const viewTitle = s.inspectorTab === "activity" ? "Monitor" : s.inspectorTab === "files" ? "Files" : "Changes";
  const reviewView = s.inspectorTab === "changes" || s.inspectorTab === "diff";
  const remoteOptions: SelectMenuOption[] = [];
  if (stagedCount && s.git?.branch) remoteOptions.push({ value: "commit-push", label: "Commit and push", description: "Commit staged files, then push this branch", disabled: !commitMessage.trim() || Boolean(busy), icon: <Check size={12} /> });
  if (s.git?.branch) {
    remoteOptions.push({ value: "pull", label: busy === "pull" ? "Pulling…" : "Pull", description: threadRunning ? "Available when the running turn ends" : `Fast-forward ${s.git.branch} to its upstream`, disabled: Boolean(busy) || threadRunning, icon: <Download size={12} /> });
    remoteOptions.push({ value: "push", label: busy === "push" ? "Pushing…" : "Push", description: `Push ${s.git.branch} with your git credentials`, disabled: Boolean(busy), icon: <Upload size={12} /> });
    if (!s.pullRequest?.url && !s.pullRequest?.unavailable) remoteOptions.push({ value: "pr", label: busy === "pr" ? "Creating…" : "Create pull request", description: "Push this branch and open a pull request", disabled: Boolean(busy) || s.pullRequestLoading, icon: <GitPullRequest size={12} /> });
  }
  const remoteAction = (value: string) => {
    if (value === "commit-push") void commitAndPush();
    else if (value === "pull") void run("pull", "Could not pull", async () => { await s.pullBranch(); setNotice(`Pulled ${s.git?.branch}.`); });
    else if (value === "push") void push();
    else if (value === "pr") void createPullRequest();
  };
  // Session files always show (new files the agent created included); unrelated
  // untracked files hide behind a toggle so the list stays scannable.
  const hiddenUntracked = otherFiles.filter((file) => file.status === "??");
  const visibleOther = showUntracked ? otherFiles : otherFiles.filter((file) => file.status !== "??");
  const untrackedToggle = hiddenUntracked.length ? (
    <button type="button" className="text-btn dock-toggle" aria-expanded={showUntracked} onClick={() => setShowUntracked((show) => !show)}>
      {showUntracked ? "Hide untracked files" : `Show ${hiddenUntracked.length} untracked file${hiddenUntracked.length === 1 ? "" : "s"}`}
    </button>
  ) : null;
  return <aside ref={asideRef} className={`dock${pane.closing ? " closing" : ""}`} aria-label="Inspector" style={{ "--dock-width": `${width}px` } as React.CSSProperties}>
    <div
      className="dock-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Changes pane"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={resizeKey}
    />
    <div className="dock-head">
      <div className="dock-view">
        {s.inspectorTab !== "changes" ? <button type="button" className="icon-btn small dock-back" aria-label="Back to changes" data-tooltip="Back to changes" onClick={() => s.setInspectorTab("changes")}><ChevronLeft size={14} /></button> : null}
        <span className="dock-title">{viewTitle}</span>
        {s.inspectorTab === "changes" && fileCount ? <span className="dock-count">{fileCount}</span> : null}
      </div>
      {reviewView && statFiles.length ? <span className="dock-stat"><span className={`add${added ? "" : " zero"}`}>+{added}</span><span className={`del${removed ? "" : " zero"}`}>−{removed}</span></span> : <span className="grow" />}
      <SelectMenu id="dock-more" className="action-menu dock-more" ariaLabel="More views" value="" placeholder="" options={MORE_VIEW_OPTIONS} onChange={(value) => { if (value === "files" || value === "activity") s.setInspectorTab(value); }} icon={<Ellipsis size={15} />} />
      <button className="icon-btn small" aria-label={s.dockExpanded ? "Restore split view" : `Expand ${viewTitle.toLowerCase()}`} aria-pressed={s.dockExpanded} data-tooltip-align="end" data-tooltip={s.dockExpanded ? "Restore split view" : `Expand ${viewTitle.toLowerCase()}`} onClick={() => s.setDockExpanded(!s.dockExpanded)}>{s.dockExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
      {reviewView ? <button className="icon-btn small" aria-label="Refresh changes" data-tooltip-align="end" data-tooltip="Refresh" disabled={!workspace || s.gitLoading || reviewLoading} onClick={() => { if (scoped) void s.refreshReview(); else void s.refreshGit(); }}><RefreshCw size={13} className={s.gitLoading || reviewLoading ? "spin" : ""} /></button> : null}
      <button className="icon-btn small" aria-label="Close changes" data-tooltip-align="end" data-tooltip={`Close  ${shortcutText("toggle-changes")}`} onClick={() => s.setDockOpen(false)}><X size={14} /></button>
    </div>
    {s.gitLoading && <p className="review-note">Refreshing changes…</p>}
    {visibleError && <div className="banner" role="alert"><span>{visibleError}</span><button className="ghost-btn small" onClick={() => { setError(null); if (scoped) void s.refreshReview(); else void s.refreshGit(); }}>Retry</button></div>}
    {s.inspectorTab === "files" ? null : !workspace ? <p className="review-note">Open a workspace to review changes.</p> : !scoped && !s.git && !s.gitLoading && !s.gitError ? <p className="review-note">Loading changes…</p> : null}
    <div id="dock-panel" role="region" aria-label={viewTitle}>
    {reviewView ? <>
      <div className="review-controls">
        <SelectMenu id="review-scope" ariaLabel="Review scope" value={s.inspectorTab === "changes" ? "all" : s.reviewScope} placeholder="All changes" options={SCOPE_OPTIONS} onChange={(value) => { const scope = REVIEW_SCOPES.find((scope) => scope === value); if (scope) { s.setReviewScope(scope); s.setInspectorTab("diff"); } }} />
        {s.inspectorTab === "diff" && diffData && diffData.files.length > 1 ? <SelectMenu id="review-file" className="review-file" ariaLabel="Review file" value={activeTab?.path} placeholder="Choose file" options={diffData.files.map((file) => ({ value: file.path, label: file.path }))} onChange={(path) => s.openFileDiff(path, true)} /> : null}
      </div>
      {s.inspectorTab === "diff" && s.reviewScope === "branch" ? <form className="review-base" onSubmit={(event) => { event.preventDefault(); if (baseDraft.trim() === s.reviewBase) void s.refreshReview(); else s.setReviewBase(baseDraft); }}>
        <input aria-label="Base branch or commit" placeholder="Base branch or commit" value={baseDraft} maxLength={256} onChange={(event) => setBaseDraft(event.target.value)} />
        <button type="submit" className="ghost-btn small" disabled={!baseDraft.trim()}>Compare</button>
      </form> : null}
      {s.inspectorTab === "diff" && scoped ? <p className="review-note review-scope-note">{s.reviewNotice ?? (s.reviewScope === "lastTurn" ? "Saved changes during the last finished run, including shell or other app edits made during that run." : s.reviewScope === "branch" ? `Committed changes since the common ancestor with ${s.reviewBase}.` : s.reviewScope === "staged" ? "Changes staged for the next commit." : "Edits not yet staged, including new files.")}</p> : null}
    </> : null}
    {s.inspectorTab === "files" ? <FilesPanel workspace={workspace} /> : s.inspectorTab === "activity" ? <TaskMonitor /> : s.git?.repository === false && !scoped ? <div className="nonrepo">
      <p className="review-note">Changes needs git to review edits in {workspace?.name ?? "this workspace"}.</p>
      <button className="primary nonrepo-init" disabled={busy === "init" || s.gitLoading} onClick={() => void initRepo()}>
        {busy === "init" || s.gitLoading ? "Initializing…" : "Initialize repository"}
      </button>
    </div> : s.git && s.inspectorTab === "changes" ? <div className="scroll">      {fileCount ? <form className="commit-box" onSubmit={(event) => {
        event.preventDefault();
        if (!workspace || !granted() || !commitMessage.trim() || !stagedCount) return;
        setError(null);
        setBusy("commit");
        void s.commitGit(commitMessage.trim()).then(() => setCommitMessage(""), (cause) => setError(describeError("Could not commit the staged changes", cause))).finally(() => setBusy(null));
      }}>
        <input aria-label="Commit message" placeholder={stagedCount ? `Commit ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}` : "Stage files to commit"} value={commitMessage} maxLength={2000} onChange={(event) => setCommitMessage(event.target.value)} />
        <button type="submit" className="primary commit-submit" disabled={!stagedCount || !commitMessage.trim() || Boolean(busy)} title={stagedCount ? "Commit staged changes" : "Stage files first"}><Check size={12} />Commit</button>
      </form> : null}
      <div className="git-actions">
        {fileCount && unstagedPaths.length ? <button type="button" className="ghost-btn small" disabled={Boolean(busy)} onClick={() => void run("stage", "Could not stage the files", () => s.stageGitFiles(unstagedPaths, true))}>Stage all</button> : null}
        {fileCount ? <button type="button" className="ghost-btn small" disabled={Boolean(busy) || Boolean(s.commitDrafting)} title="Ask the agent in this thread for a commit message" onClick={() => void run("draft", "Could not draft a message", s.draftCommitMessage)}><Sparkles size={12} />{s.commitDrafting ? "Drafting…" : "Draft message"}</button> : null}
        {remoteOptions.length ? <><span className="grow" /><SelectMenu id="git-actions" className="action-menu git-more" ariaLabel="Git actions" value="" placeholder="" options={remoteOptions} onChange={remoteAction} icon={<Ellipsis size={15} />} /></> : null}
      </div>
      {notice ? <p className="review-note" role="status">{notice}</p> : null}
      {s.pullRequest?.unavailable ? <p className="review-note">{s.pullRequest.unavailable}</p> : null}
      {s.pullRequest?.url ? <p className="review-note pr-line">
        <GitPullRequest size={12} aria-hidden="true" />
        <button type="button" className="text-btn" onClick={() => void openUrl(s.pullRequest!.url!).catch((cause) => setError(describeError("Could not open the pull request", cause)))}>Pull request #{s.pullRequest.number}</button>
        <span>{s.pullRequest.state === "MERGED" ? "merged" : s.pullRequest.state === "CLOSED" ? "closed" : s.pullRequest.checks === "none" || !s.pullRequest.checks ? "no checks" : `checks ${s.pullRequest.checks}`}</span>
        <button type="button" className="icon-btn small" aria-label="Refresh pull request status" data-tooltip-align="end" data-tooltip="Refresh pull request status" disabled={s.pullRequestLoading} onClick={() => void run("pr-refresh", "Could not read the pull request", () => s.refreshPullRequest(false))}><RefreshCw size={12} className={s.pullRequestLoading ? "spin" : ""} /></button>
      </p> : null}
      {sessionFiles.length ? <>
        <h3 className="dock-group">This thread</h3>
        {sessionFiles.map(renderRow)}
        {visibleOther.length || untrackedToggle ? <h3 className="dock-group">Other uncommitted changes</h3> : null}
        {visibleOther.map(renderRow)}
        {untrackedToggle}
      </> : <>
        {visibleOther.map(renderRow)}
        {untrackedToggle}
        {!s.git.files.length && <p className="review-note">Working tree is clean.</p>}
      </>}
      {fileCount > 1 ? <button type="button" className="text-btn dock-toggle dock-danger" disabled={busy === "all"} onClick={() => void discardAll()}>Discard all {fileCount} changes</button> : null}
    </div> : s.inspectorTab === "diff" ? <div className="diff-pane">
      {diffData?.truncated || parsed.truncated ? <p className="review-note">Diff truncated for performance.</p> : null}
      {/* One open file is already named by the file picker and the toolbar; tabs earn their row from two. */}
      {openFileTabs.length > 1 ? <div className="file-tabs" role="tablist" aria-label="Open files">{openFileTabs.map((tab) => <div key={tab.path} className={`file-tab ${tab.path === activeTab?.path ? "active" : ""}`}>
        <button role="tab" aria-selected={tab.path === activeTab?.path} title={tab.path} onClick={() => s.setActiveDiff(tab.path)}>{tab.path.split("/").pop()}</button>
        <button className="file-tab-close" aria-label={`Close ${tab.path}`} title="Close file" onClick={() => closeFile(tab.path)}><X size={11} /></button>
      </div>)}</div> : null}
      <div className="diff" role="log" aria-label={scoped ? `${SCOPE_LABELS[s.reviewScope]} diff` : "Uncommitted diff"} aria-busy={reviewLoading}>
        {activeTab ? <div className="diff-toolbar"><span className="path" title={activeTab.path}>{activeTab.path.split("/").pop()}</span>
          {activeFile ? <div className="segmented diff-mode" role="group" aria-label="Diff layout">
            <button className={diffMode === "unified" ? "active" : ""} aria-pressed={diffMode === "unified"} onClick={() => setDiffMode("unified")}>Unified</button>
            <button className={diffMode === "split" ? "active" : ""} aria-pressed={diffMode === "split"} onClick={() => setDiffMode("split")}>Split</button>
          </div> : null}
          <span className="grow" />
          <button className="icon-btn small" aria-label={scoped ? "Open current file" : "Open file"} data-tooltip-align="end" data-tooltip={scoped ? "Open current file" : "Open file"} onClick={() => { if (!workspace) return; if (!workspace.grantId && isTauri()) { setError("This folder is not granted. Re-open it to restore access."); return; } void openPath(`${workspace.path}/${activeTab.path}`, workspace.grantId ?? "preview", useAppStore.getState().editor).catch((cause) => setError(describeError(`Could not open ${activeTab.path}`, cause))); }}><ExternalLink size={13} /></button>
          {activeFile ? <button className="icon-btn small" aria-label="Copy patch" data-tooltip-align="end" data-tooltip="Copy patch" onClick={() => void navigator.clipboard.writeText(activeFile.patch)}><Copy size={13} /></button> : null}
          {activeFile ? <button className="icon-btn small" aria-label="Export patch" data-tooltip-align="end" data-tooltip="Export patch" onClick={() => { const name = activeTab.path.split("/").pop() ?? "patch"; void saveOutputText(`${name}.patch`, activeFile.patch, false).catch((cause) => setError(describeError(`Could not export ${name}.patch`, cause))); }}><Download size={13} /></button> : null}
          {activeEntry && !scoped ? <button className="icon-btn small" aria-label={`Discard changes to ${activeEntry.path}`} data-tooltip-align="end" data-tooltip="Discard changes" onClick={() => void discardOne(activeEntry)}><Undo2 size={13} /></button> : null}
        </div> : null}
        {diffMode === "split" && !splitReady && activeFile ? <p className="review-note">Widen Changes to use split view</p> : null}
        {activeFile?.header.some((line) => line.startsWith("old mode")) ? <p className="review-note">{activeFile.header.filter((line) => /^(old|new) mode /.test(line)).join(" · ")}</p> : null}
        {!lines.length && !s.reviewNotice && !visibleError && <p className="review-note">{scoped && !diffData ? reviewLoading || s.gitLoading ? "Loading review…" : "" : skippedReason ?? (activeFile?.header.some((line) => line.startsWith("new file mode")) ? "This new file is empty." : activeFile?.header.some((line) => line.startsWith("old mode")) ? "File mode changed." : activeTab && !activeFile ? "This file has no diff preview." : parsed.files.length && !openFileTabs.length ? "No file open. Choose a file above." : scoped ? `No ${s.reviewScope === "lastTurn" ? "saved changes in the last turn" : s.reviewScope === "branch" ? "committed changes against this base" : `${SCOPE_LABELS[s.reviewScope].toLowerCase()} changes`}.` : s.git?.dirty ? "Changed files are untracked or non-text. See Changes." : "No uncommitted changes.")}</p>}
        {renderedHunks.map((group) => (
          <div key={group.start} className="hunk-block">
            <div className="hunk hunk-head"><span>{group.header.text}</span>{activeFile && !scoped && activeEntry?.status !== "??" ? <button className="icon-btn small" aria-label={`Discard hunk ${group.index + 1} of ${activeTab?.path}`} data-tooltip-align="end" data-tooltip="Discard hunk (unstages the file)" disabled={busy === `${activeTab?.path}#${group.index}`} onClick={() => { if (activeTab) void discardHunk(activeTab.path, group.index); }}><Undo2 size={11} /></button> : null}</div>
            <DiffLines lines={group.lines} mode={splitReady ? "split" : "unified"} path={activeTab?.path} onComment={activeTab ? (line) => {
              const target = commentTarget(line);
              if (target) setCommenting({ path: activeTab.path, ...target, context: commentContext(group.header.text, group.lines, line), text: "" });
            } : undefined} />
          </div>
        ))}
        {renderedHunks.length < hunks.length ? <p className="review-note">Showing the first hunks of this file.</p> : null}
      </div>
      {commenting ? <form className="line-comment-form" onSubmit={(event) => {
        event.preventDefault();
        if (!commenting.text.trim()) return;
        s.addLineComment({ ...commenting, text: commenting.text.trim() });
        setCommenting(null);
      }}>
        <label htmlFor="line-comment">Comment on {commenting.path}:{commenting.line}{commenting.removed ? " (removed line)" : ""}</label>
        <textarea id="line-comment" autoFocus rows={2} maxLength={2000} value={commenting.text} onChange={(event) => setCommenting({ ...commenting, text: event.target.value })} onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setCommenting(null); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} />
        <div className="line-comment-row">
          <button type="button" className="ghost-btn small" onClick={() => setCommenting(null)}>Cancel</button>
          <button type="submit" className="ghost-btn small" disabled={!commenting.text.trim()}>Add comment</button>
        </div>
      </form> : null}
      {s.lineComments.length ? <section className="line-comments" aria-label="Pending comments">
        <ul>{s.lineComments.map((comment) => <li key={comment.id}>
          <button type="button" className="text-btn" title="Show this file" onClick={() => s.openFileDiff(comment.path, true)}>{comment.path.split("/").pop()}:{comment.line}</button>
          <span>{comment.text}</span>
          <button type="button" className="icon-btn small" aria-label={`Remove comment on ${comment.path}:${comment.line}`} data-tooltip-align="end" data-tooltip="Remove comment" onClick={() => s.removeLineComment(comment.id)}><X size={12} /></button>
        </li>)}</ul>
        <button type="button" className="ghost-btn small" disabled={Boolean(busy)} title="Send every comment to the agent as one message" onClick={() => void run("comments", "Could not send the comments", s.sendLineComments)}>{busy === "comments" ? "Sending…" : `Send ${s.lineComments.length} comment${s.lineComments.length === 1 ? "" : "s"}`}</button>
      </section> : null}
    </div> : null}
    </div>
  </aside>;
}
