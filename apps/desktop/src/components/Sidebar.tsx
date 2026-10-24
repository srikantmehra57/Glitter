import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { Archive, Bug, ChartColumn, ChevronRight, ChevronsUpDown, Copy, Download, ExternalLink, FileText, Folder, FolderOpen, GitBranch, GitFork, Keyboard, LoaderCircle, LogOut, Mail, MailOpen, MoreHorizontal, Palette, PanelLeft, Pencil, Pin, PinOff, Plus, RotateCcw, ScanSearch, Search, Settings, ShieldCheck, SquarePen, Trash2, X } from "lucide-react";
import { formatResetIn, formatTokens, isMacPlatform, needsAttention, relativeTime, shortCliVersion, threadMatches, usageWindowLabel, windowPercent, worktreeRemovalNote } from "../lib/format";
import { openPath } from "../lib/bridge";
import { describeError } from "../lib/errors";
import { exportThread, shortcutText } from "../lib/commands";
import { copyAppLogPath, copySessionId, copyThreadLogPath, copyThreadPath, openAppConfig, openThreadFolder, reportThreadIssue } from "../lib/threadActions";
import { activeWorkspace, currentWorkspace, readyAgents, useAppStore } from "../lib/store";
import { threadChangeCounts } from "../lib/agent";
import { AgentMark } from "./AgentPicker";
import { EXIT_FAST_MS, usePresence } from "../lib/presence";

/** The sidebar column closes over --dur-3 (styles.css `.app` grid transition). */
const SIDEBAR_EXIT_MS = 240;
import { sidebarWidthBounds, sidebarWidthFor, subscribeResize } from "../lib/reviewLayout";
import { Collapse } from "./Presence";
import { totalsSince } from "../lib/usageLedger";
import { EDITOR_LABELS, agentEnabled, type AgentId, type CliUpdateOutcome, type CliUpdateStatus, type EditorChoice, type SettingsTab, type SubscriptionUsage, type Thread, type Workspace } from "../lib/types";

/**
 * What one sidebar row needs from a thread, and nothing that changes while a
 * reply streams. The sidebar selects these instead of the threads themselves, so
 * a token arriving in the open thread does not touch the sidebar at all.
 */
type ThreadRow = {
  sessionId: string;
  workspacePath: string;
  title: string;
  status: Thread["status"];
  lastOutcome: Thread["lastOutcome"];
  unread: boolean;
  /** Waiting on an approval or an answer from the user. */
  attention: boolean;
  pinned: boolean;
  archived: boolean;
  agentId?: AgentId;
  /** Branch of the thread's own worktree, when it has one. */
  branch?: string;
  /** Uncommitted lines in files this thread edited. Zero when unknown: only the folder in view has a git snapshot. */
  added: number;
  removed: number;
  order: number;
  opened: boolean;
  /** Relative label ("5m"); empty while running. */
  time: string;
  /** Tooltip source. Deliberately not compared: it moves on every item event. */
  updatedAt: string;
};

function toRow(thread: Thread, changes: { added: number; removed: number }): ThreadRow {
  return {
    added: changes.added,
    removed: changes.removed,
    sessionId: thread.sessionId,
    workspacePath: thread.workspacePath,
    title: thread.title,
    status: thread.status,
    lastOutcome: thread.lastOutcome,
    unread: Boolean(thread.unread),
    attention: needsAttention(thread),
    pinned: Boolean(thread.pinned),
    archived: Boolean(thread.archived),
    agentId: thread.agentId,
    branch: thread.worktree?.branch,
    order: thread.order ?? 0,
    opened: Boolean(thread.opened),
    time: thread.status === "running" ? "" : relativeTime(thread.updatedAt),
    updatedAt: thread.updatedAt,
  };
}

const sameRow = (a: ThreadRow, b: ThreadRow) =>
  a.sessionId === b.sessionId && a.workspacePath === b.workspacePath && a.title === b.title && a.status === b.status && a.lastOutcome === b.lastOutcome
  && a.unread === b.unread && a.attention === b.attention && a.pinned === b.pinned && a.archived === b.archived && a.agentId === b.agentId && a.branch === b.branch && a.added === b.added && a.removed === b.removed && a.order === b.order && a.opened === b.opened && a.time === b.time;

/**
 * A selector that hands back the *same array and the same row objects* whenever
 * nothing a row shows has changed, however many times the store updates.
 */
const NO_CHANGES = { added: 0, removed: 0 };
type RowState = Pick<ReturnType<typeof useAppStore.getState>, "threads" | "git" | "workspaces" | "selectedWorkspaceId" | "selectedSessionId">;

function createRowSelector() {
  let rowsById = new Map<string, ThreadRow>();
  let list: ThreadRow[] = [];
  return (state: RowState): ThreadRow[] => {
    const next: ThreadRow[] = [];
    const byId = new Map<string, ThreadRow>();
    // The git snapshot describes one folder: the selected workspace, or the open
    // thread's worktree. Only threads working in that folder can be counted.
    const view = activeWorkspace(state);
    const files = state.git?.files;
    for (const thread of state.threads) {
      const here = view && files?.length && thread.workspacePath === currentWorkspace(state)?.path && (thread.worktree?.path ?? thread.workspacePath) === view.path;
      const fresh = toRow(thread, here ? threadChangeCounts(thread.items, view.path, files) : NO_CHANGES);
      const previous = rowsById.get(thread.sessionId);
      const row = previous && sameRow(previous, fresh) ? previous : fresh;
      byId.set(thread.sessionId, row);
      next.push(row);
    }
    rowsById = byId;
    if (next.length === list.length && next.every((row, index) => row === list[index])) return list;
    list = next;
    return list;
  };
}

function ThreadStatus({ thread }: { thread: Pick<ThreadRow, "status" | "lastOutcome" | "unread" | "attention"> }) {
  // role="img" so the label is honored: aria-label on a bare span names nothing,
  // and the state would exist only as a dot's colour. It also folds the state
  // into the thread button's accessible name.
  // Outranks the spinner: a blocked thread is "running" too, but it will not move until the user acts.
  if (thread.attention) return <span className="thread-status attention" role="img" aria-label="Needs your attention" title="Needs your attention" />;
  if (thread.status === "running") return <span className="thread-status running" role="img" aria-label="Running" />;
  if (thread.status === "error" || thread.lastOutcome === "failed") return <span className="thread-status error" role="img" aria-label="Failed" />;
  if (thread.unread) return <span className="thread-status unread" role="img" aria-label="Unread" />;
  return null;
}

/** `percent` is null once the window has reset since the reading: the bar empties rather than show a spent figure. */
function UsageBar({ percent }: { percent: number | null }) {
  const rounded = Math.round(percent ?? 0);
  const tone = percent == null ? "" : rounded >= 100 ? " over" : rounded >= 80 ? " high" : "";
  return (
    <span className={`usage-bar${tone}`} role="img" aria-label={percent == null ? "No current reading" : `${rounded}% used`}>
      <span style={{ width: `${Math.min(100, Math.max(0, rounded))}%` }} />
    </span>
  );
}

function UsageRow({ label, percent, resetsAtMs, now }: { label: string; percent: number; resetsAtMs: number; now: number }) {
  const current = windowPercent(percent, resetsAtMs, now);
  return (
    <div className="usage-row">
      <div className="usage-row-head"><span>{label}</span><span className="usage-pct">{current == null ? "—" : `${Math.round(current)}%`}</span></div>
      <UsageBar percent={current} />
      <div className="usage-sub">{current == null ? "Reset since this reading" : formatResetIn(resetsAtMs, now)}</div>
    </div>
  );
}

function UsageCard({ usage, now, refreshing, onRefresh }: { usage: SubscriptionUsage; now: number; refreshing: boolean; onRefresh: () => void }) {
  const ago = relativeTime(new Date(usage.observedAtMs).toISOString());
  return (
    <div className="usage-pop sidebar-usage" role="status" aria-label="Subscription usage">
      <div className="usage-head">
        <span className="usage-title">Subscription usage</span>
        <button
          type="button"
          className="icon-btn small usage-refresh"
          aria-label="Refresh usage"
          title="Refresh usage"
          disabled={refreshing}
          onClick={(event) => { event.stopPropagation(); onRefresh(); }}
        >
          {refreshing ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
        </button>
      </div>
      <UsageRow label={usageWindowLabel(usage.window.windowDurationMins)} percent={usage.window.usedPercent} resetsAtMs={usage.window.resetsAtMs} now={now} />
      <UsageRow label="Weekly" percent={usage.weekly.usedPercent} resetsAtMs={usage.weekly.resetsAtMs} now={now} />
      <div className="usage-foot"><span>as of {ago === "now" ? "now" : `${ago} ago`}</span></div>
    </div>
  );
}

/** The subscription meter and its empty, loading and error states. Shown from the sidebar's Usage control. */
export function AccountUsage() {
  const usage = useAppStore((state) => state.subscriptionUsage);
  const loading = useAppStore((state) => state.subscriptionUsageLoading);
  const error = useAppStore((state) => state.subscriptionUsageError);
  const authenticated = useAppStore((state) => state.detection?.authenticated);
  const refresh = useAppStore((state) => state.refreshSubscriptionUsage);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);
  if (usage) return <UsageCard usage={usage} now={now} refreshing={loading} onRefresh={() => void refresh(true)} />;
  if (loading) return <div className="usage-pop sidebar-usage" role="status"><div className="usage-state"><LoaderCircle size={13} className="spin" aria-hidden="true" />Reading usage…</div></div>;
  if (error) {
    return (
      <div className="usage-pop sidebar-usage" role="alert">
        <div className="usage-state">{error}</div>
        <button type="button" className="ghost-btn small" onClick={(event) => { event.stopPropagation(); void refresh(true); }}><RotateCcw size={11} />Retry</button>
      </div>
    );
  }
  return (
    <div className="usage-pop sidebar-usage" role="status">
      <div className="usage-state">{authenticated === false ? "Sign in with the Muse CLI to see usage." : "No usage observed yet — it appears after your first turn."}</div>
      {authenticated !== false ? <button type="button" className="ghost-btn small" onClick={(event) => { event.stopPropagation(); void refresh(true); }}><RotateCcw size={11} />Check again</button> : null}
    </div>
  );
}

/** Local midnight, so the sidebar chip matches the Usage view's Today. */
function startOfToday(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Glitter's own usage: a button that opens the Usage page. In the sidebar's
 * foot it carries today's tokens, counted on this Mac across every agent,
 * beside its mark; in the collapsed title-bar group it is the bare icon.
 */
function SidebarUsage({ showToday = false }: { showToday?: boolean }) {
  const ledger = useAppStore((state) => state.usageLedger);
  const now = Date.now();
  const today = totalsSince(ledger, startOfToday(now), now);
  const chip = today.tokens > 0 ? `${today.estimated ? "≈" : ""}${formatTokens(today.tokens)}` : null;
  return (
    <button
      type="button"
      className={`icon-btn${showToday && chip ? " usage-today" : ""}`}
      aria-label={chip ? `Usage, ${chip} tokens today` : "Usage"}
      data-tooltip={chip ? `Usage · ${chip} today` : "Usage"}
      data-tooltip-side={showToday ? "top" : undefined}
      data-tooltip-align={showToday ? "end" : undefined}
      onClick={() => useAppStore.getState().setSettingsOpen(true, "Usage")}
    >
      <ChartColumn size={showToday ? 15 : 16} />
      {showToday && chip ? <span aria-hidden="true">{chip}</span> : null}
    </button>
  );
}

/** Release-channel update popover: versions, urgency, channel notes, and the update itself. */
function CliUpdateCard({ status, updating, checking, error, result, checkedAt, closing, onUpdate, onRefresh, onClose }: {
  status: CliUpdateStatus;
  updating: boolean;
  checking: boolean;
  error: string | null;
  result: CliUpdateOutcome | null;
  checkedAt: number | null;
  closing: boolean;
  onUpdate: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const ago = checkedAt ? relativeTime(new Date(checkedAt).toISOString()) : null;
  return (
    <div className={`update-pop${closing ? " closing" : ""}`} role="dialog" aria-label="Muse CLI update" onClick={(event) => event.stopPropagation()}>
      <div className="usage-head">
        <span className="usage-title">Muse CLI update</span>
        <button
          type="button"
          className="icon-btn small usage-refresh"
          aria-label="Check again"
          title="Check again"
          disabled={checking || updating}
          onClick={(event) => { event.stopPropagation(); onRefresh(); }}
        >
          {checking ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
        </button>
      </div>
      <div className="update-vers">
        <span>{shortCliVersion(status.current) || "unknown"}</span>
        <span aria-hidden="true">→</span>
        <strong>{shortCliVersion(status.latest)}</strong>
        {status.urgency !== "none" ? <em className={`update-urgency ${status.urgency}`}>{status.urgency === "must_download" ? "Required" : "Recommended"}</em> : null}
      </div>
      {status.notification ? <p className="update-notes">{status.notification}</p> : null}
      {result ? <p className="update-result" role="status">{result.updated ? `Updated to ${shortCliVersion(result.to ?? result.version)}.` : "Already on the latest version."}</p> : null}
      {error ? <p className="update-error" role="alert">{error}</p> : null}
      <div className="update-actions">
        <button type="button" className="primary accent" disabled={checking || updating} onClick={(event) => { event.stopPropagation(); onUpdate(); }}>
          {updating ? <><LoaderCircle size={13} className="spin" aria-hidden="true" />Updating…</> : "Update now"}
        </button>
        <button type="button" className="ghost-btn" onClick={(event) => { event.stopPropagation(); onClose(); }}>Later</button>
      </div>
      {ago ? <div className="usage-foot"><span>checked {ago === "now" ? "now" : `${ago} ago`}</span></div> : null}
    </div>
  );
}

/**
 * The keyboard contract a `role="menu"` popover owes once it is open:
 * ArrowUp/ArrowDown roam its items with wraparound, Home/End land on the ends,
 * and Escape or a Tab taken from an item closes it. `close` hands focus back to
 * the opener — the item that had focus is about to unmount, and without the
 * hand-off the key would leave the keyboard on <body>. Nested content that is
 * not a menu item (an expanded export group) keeps normal Tab traversal.
 */
function menuKeys(event: ReactKeyboardEvent<HTMLElement>, close: () => void) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = index < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
    return;
  }
  if (items.length && event.key === "Home") { event.preventDefault(); items[0].focus(); return; }
  if (items.length && event.key === "End") { event.preventDefault(); items[items.length - 1].focus(); return; }
  if (event.key === "Escape" || (event.key === "Tab" && (event.target as HTMLElement).closest('[role="menuitem"]'))) {
    event.preventDefault();
    event.stopPropagation();
    close();
  }
}

/** Everything a row can do. Created once, so a memoized row never re-renders because its handlers were rebuilt. */
type ThreadActions = {
  open: (id: string) => void;
  toggleMenu: (id: string) => void;
  showMenu: (id: string) => void;
  closeMenu: () => void;
  startRename: (id: string) => void;
  finishRename: (id: string, title: string) => void;
  cancelRename: () => void;
  pin: (id: string) => void;
  archive: (id: string) => void;
  setUnread: (id: string, unread: boolean) => void;
  openFolder: (id: string) => void;
  copyPath: (id: string) => void;
  copyTaskPath: (id: string) => void;
  copyLogPath: () => void;
  copySessionId: (id: string) => void;
  openConfig: () => void;
  viewTrajectory: (id: string) => void;
  reportIssue: (id: string) => void;
  exportThread: (row: ThreadRow, redacted: boolean, format?: "json" | "markdown") => void;
  fork: (id: string) => void;
  preview: (id: string) => void;
  remove: (row: ThreadRow) => void;
  dragStart: (event: DragEvent, id: string) => void;
  dragOver: (event: DragEvent, row: ThreadRow) => void;
  dragLeave: (id: string) => void;
  drop: (event: DragEvent, row: ThreadRow) => void;
  dragEnd: () => void;
};

type ThreadItemProps = {
  row: ThreadRow;
  active: boolean;
  menuOpen: boolean;
  renaming: boolean;
  dragging: boolean;
  dropTarget: boolean;
  reorderable: boolean;
  preview: boolean;
  agentName?: string;
  actions: ThreadActions;
};

function ThreadItemView({ row, active, menuOpen, renaming, dragging, dropTarget, reorderable, preview, agentName, actions }: ThreadItemProps) {
  const menu = usePresence(menuOpen, EXIT_FAST_MS);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // The menu hangs below its row inside the scrolling list; a row near the foot
  // of the list opens it upward instead, so the list never clips it.
  const [menuUp, setMenuUp] = useState(false);
  useLayoutEffect(() => {
    if (!menuOpen) { setExportOpen(false); return; }
    const node = menuRef.current;
    const list = node?.closest(".scroll");
    if (!node || !list) return;
    const room = list.getBoundingClientRect().bottom - node.parentElement!.getBoundingClientRect().bottom;
    // Measured with the export group open, so expanding it later never runs off the end.
    setMenuUp(room < node.scrollHeight + 4 * 32 + 8);
  }, [menuOpen]);
  // Opening lands focus on the first item, as the role="menu" contract says.
  useEffect(() => {
    if (menuOpen) menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);
  const closeMenu = () => {
    actions.closeMenu();
    moreRef.current?.focus();
  };
  return (
    <div
      role="listitem"
      className={`thread-wrap ${menuOpen ? "menu-open" : ""} ${dragging ? "dragging" : ""} ${dropTarget ? "drop-target" : ""}`}
      onKeyDown={(event) => {
        // Escape reaches here when focus is on the trigger or the row itself;
        // inside the menu, menuKeys handles it first and stops propagation.
        if (event.key === "Escape" && menuOpen) { event.preventDefault(); closeMenu(); }
      }}
      draggable={reorderable && !renaming}
      onDragStart={(event) => actions.dragStart(event, row.sessionId)}
      onDragOver={(event) => actions.dragOver(event, row)}
      onDragLeave={() => actions.dragLeave(row.sessionId)}
      onDrop={(event) => actions.drop(event, row)}
      onDragEnd={actions.dragEnd}
    >
      {renaming ? (
        <input
          className="rename"
          defaultValue={row.title}
          autoFocus
          aria-label="Thread name"
          onFocus={(event) => event.target.select()}
          onBlur={(event) => actions.finishRename(row.sessionId, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") actions.finishRename(row.sessionId, (event.target as HTMLInputElement).value);
            if (event.key === "Escape") actions.cancelRename();
          }}
        />
      ) : (
        <>
          <button
            className={`thread ${active ? "active" : ""} ${row.unread ? "unread" : ""}`}
            title={`${row.title} · ${new Date(row.updatedAt).toLocaleString()}`}
            aria-current={active ? "page" : undefined}
            onClick={() => actions.open(row.sessionId)}
            // A clipped title rolls to its tail on hover; marking it lets the
            // stylesheet fade the edges the text slides under.
            onPointerEnter={(event) => {
              const title = event.currentTarget.querySelector<HTMLElement>(".title");
              if (title) event.currentTarget.toggleAttribute("data-clipped", title.scrollWidth > title.clientWidth);
            }}
            onContextMenu={(event) => { event.preventDefault(); actions.showMenu(row.sessionId); }}
            onDoubleClick={() => actions.startRename(row.sessionId)}
          >
            {/* The agent's mark fills the sidebar's icon column, under the
                workspace's folder, so every title starts on the same line as
                the names above it. The thread's state rides at the row's end,
                in the time's slot — a running thread has no time. */}
            <span className="thread-mark" title={agentName}><AgentMark id={row.agentId ?? "muse"} size={15} /></span>
            <span className="title"><span className="title-text">{row.title}</span></span>
            {row.pinned ? <Pin size={11} className="pin-mark" aria-label="Pinned" /> : null}
            {row.branch ? <span className="thread-branch" title={`Worktree on ${row.branch}`}><GitBranch size={10} aria-hidden="true" />{row.branch}</span> : null}
            {row.added || row.removed ? <span className="thread-changes" title="Uncommitted lines in files this thread edited">{row.added ? <span className="add">+{row.added}</span> : null}{row.removed ? <span className="del">−{row.removed}</span> : null}</span> : null}
            <ThreadStatus thread={row} />
            <span className="time">{row.time}</span>
          </button>
          <button
            ref={moreRef}
            className="icon-btn small thread-more"
            aria-label={`Actions for ${row.title}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => { event.stopPropagation(); actions.toggleMenu(row.sessionId); }}
            onKeyDown={(event) => {
              // Menu-button pattern: ArrowDown opens onto the first item.
              if (event.key === "ArrowDown" && !menuOpen) { event.preventDefault(); actions.showMenu(row.sessionId); }
            }}
          >
            <MoreHorizontal size={14} />
          </button>
        </>
      )}
      {menu.mounted ? (
        <div ref={menuRef} className={`menu thread-menu${menuUp ? " up" : ""}${menu.closing ? " closing" : ""}`} role="menu" aria-label={`Actions for ${row.title}`} onKeyDown={(event) => menuKeys(event, closeMenu)}>
          <button type="button" role="menuitem" onClick={() => actions.startRename(row.sessionId)}><Pencil size={13} />Rename</button>
          <button type="button" role="menuitem" onClick={() => actions.pin(row.sessionId)}>{row.pinned ? <PinOff size={13} /> : <Pin size={13} />}{row.pinned ? "Unpin" : "Pin"}</button>
          <button type="button" role="menuitem" onClick={() => actions.archive(row.sessionId)}><Archive size={13} />Archive</button>
          <button type="button" role="menuitem" onClick={() => actions.setUnread(row.sessionId, !row.unread)}>{row.unread ? <MailOpen size={13} /> : <Mail size={13} />}{row.unread ? "Mark as read" : "Mark as unread"}</button>
          <div className="menu-sep" />
          <button type="button" role="menuitem" onClick={() => actions.openFolder(row.sessionId)}><FolderOpen size={13} />Open in Finder</button>
          <button type="button" role="menuitem" onClick={() => actions.copyPath(row.sessionId)}><Copy size={13} />Copy path</button>
          {!preview && row.agentId === "harness" ? <button type="button" role="menuitem" onClick={() => actions.copyTaskPath(row.sessionId)}><FileText size={13} />Copy task path</button> : null}
          {!preview ? <button type="button" role="menuitem" onClick={actions.copyLogPath}><FileText size={13} />Copy log path</button> : null}
          <button type="button" role="menuitem" onClick={() => actions.copySessionId(row.sessionId)}><Copy size={13} />Copy session ID</button>
          {!preview ? <button type="button" role="menuitem" onClick={actions.openConfig}><Settings size={13} />Go to config</button> : null}
          {(row.agentId ?? "muse") === "muse" && !preview ? <>
            <button type="button" role="menuitem" onClick={() => actions.fork(row.sessionId)}><GitFork size={13} />Fork thread</button>
            {/* The four export formats fold under one item instead of filling the menu. */}
            <button type="button" role="menuitem" aria-expanded={exportOpen} onClick={(event) => { event.stopPropagation(); setExportOpen((open) => !open); }}>
              <Download size={13} />Export<ChevronRight size={12} className={`caret ${exportOpen ? "open" : ""}`} aria-hidden="true" />
            </button>
            <Collapse open={exportOpen}>{() => (
              <div className="menu-sub" role="group" aria-label="Export formats">
                <button type="button" role="menuitem" aria-label="Export share-safe JSON" onClick={() => actions.exportThread(row, true)}><ShieldCheck size={13} />Share-safe JSON</button>
                <button type="button" role="menuitem" aria-label="Export share-safe Markdown" onClick={() => actions.exportThread(row, true, "markdown")}><ShieldCheck size={13} />Share-safe Markdown</button>
                <button type="button" role="menuitem" aria-label="Export raw JSON" onClick={() => actions.exportThread(row, false)}><FileText size={13} />Raw JSON</button>
                <button type="button" role="menuitem" aria-label="Export raw Markdown" onClick={() => actions.exportThread(row, false, "markdown")}><FileText size={13} />Raw Markdown</button>
              </div>
            )}</Collapse>
            {!row.opened ? <button type="button" role="menuitem" onClick={() => actions.preview(row.sessionId)}><ScanSearch size={13} />Preview without opening</button> : null}
          </> : null}
          <div className="menu-sep" />
          <button type="button" role="menuitem" onClick={() => actions.viewTrajectory(row.sessionId)}><ChartColumn size={13} />View model trajectory</button>
          {!preview ? <button type="button" role="menuitem" onClick={() => actions.reportIssue(row.sessionId)}><Bug size={13} />Report issue</button> : null}
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="danger" onClick={() => actions.remove(row)}>
            <Trash2 size={13} />Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

const ThreadItem = memo(ThreadItemView);

/** The sidebar's right edge: drag or arrow keys to resize, double-click to return to the default width. */
function SidebarResize() {
  const saved = useAppStore((state) => state.sidebarWidth);
  const setSidebarWidth = useAppStore((state) => state.setSidebarWidth);
  const viewport = useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1280);
  const bounds = sidebarWidthBounds(viewport);
  const width = sidebarWidthFor(viewport, false, saved);
  const startWidth = useRef(width);
  startWidth.current = width;
  const stopResize = useRef<(() => void) | null>(null);
  useEffect(() => () => stopResize.current?.(), []);
  const clamp = (next: number) => sidebarWidthFor(window.innerWidth, false, next);
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopResize.current?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const start = startWidth.current;
    handle.setPointerCapture?.(pointerId);
    const root = document.documentElement;
    const priorSelect = document.body.style.userSelect;
    const priorCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    // The column follows the pointer directly; its open/close transition would trail behind it.
    root.dataset.sidebarResizing = "true";
    const move = (moved: PointerEvent) => {
      if (moved.pointerId === pointerId) setSidebarWidth(clamp(start + (moved.clientX - startX)));
    };
    const end = (ended: PointerEvent) => { if (ended.pointerId === pointerId) stopResize.current?.(); };
    const cleanup = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      document.body.style.userSelect = priorSelect;
      document.body.style.cursor = priorCursor;
      delete root.dataset.sidebarResizing;
      stopResize.current = null;
    };
    stopResize.current = cleanup;
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  };
  const resizeKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 96 : 24;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = width + step;
    else if (event.key === "ArrowLeft") next = width - step;
    else if (event.key === "Home") next = bounds.min;
    else if (event.key === "End") next = bounds.max;
    if (next == null) return;
    event.preventDefault();
    setSidebarWidth(clamp(next));
  };
  return (
    <div
      className="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · Double-click to reset"
      onPointerDown={startResize}
      onDoubleClick={() => setSidebarWidth(null)}
      onKeyDown={resizeKey}
    />
  );
}

type WorkspaceAction = "finder" | "editor" | "copy" | "trust" | "regrant" | "remove";

/**
 * A workspace's ⋯ menu: opening the folder, copying its path, trust, and
 * removal. Removal lives here rather than as a bare button on the row, where it
 * sat one slip away from New thread.
 */
function WorkspaceMenu({ workspace, editor, closing, onClose, onPick }: {
  workspace: Workspace;
  editor: EditorChoice;
  closing: boolean;
  onClose: () => void;
  onPick: (action: WorkspaceAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Hangs below its row, or opens upward when the list would clip it.
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const node = ref.current;
    const list = node?.closest(".scroll");
    if (!node || !list) return;
    setUp(list.getBoundingClientRect().bottom - node.parentElement!.getBoundingClientRect().bottom < node.scrollHeight + 8);
  }, []);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, []);
  const granted = Boolean(workspace.grantId);
  return (
    <div ref={ref} className={`menu workspace-menu${up ? " up" : ""}${closing ? " closing" : ""}`} role="menu" aria-label={`Actions for ${workspace.name}`} onKeyDown={(event) => menuKeys(event, onClose)}>
      {granted ? <>
        <button type="button" role="menuitem" onClick={() => onPick("finder")}><FolderOpen size={13} />{isMacPlatform() ? "Show in Finder" : "Open folder"}</button>
        {editor !== "default" ? <button type="button" role="menuitem" onClick={() => onPick("editor")}><ExternalLink size={13} />Open in {EDITOR_LABELS[editor]}</button> : null}
      </> : <button type="button" role="menuitem" onClick={() => onPick("regrant")}><RotateCcw size={13} />Choose folder again…</button>}
      <button type="button" role="menuitem" onClick={() => onPick("copy")}><Copy size={13} />Copy path</button>
      {granted && !workspace.trusted ? <button type="button" role="menuitem" onClick={() => onPick("trust")}><ShieldCheck size={13} />Trust workspace…</button> : null}
      <div className="menu-sep" />
      <button type="button" role="menuitem" className="danger" onClick={() => onPick("remove")}><X size={13} />Remove from sidebar</button>
    </div>
  );
}

/** A long list shows this many threads until asked for the rest. One only a couple longer shows them all. */
const LIST_CAP = 8;

export function Sidebar({ onOpenThreads }: { onOpenThreads?: () => void } = {}) {
  const s = useAppStore(useShallow((state) => ({
    threadsLoading: state.threadsLoading,
    threadSearch: state.threadSearch,
    threadSearchOpen: state.threadSearchOpen,
    enabledAgents: state.enabledAgents,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    preview: state.preview,
    offline: state.offline,
    detection: state.detection,
    detectionChecked: state.detectionChecked,
    agents: state.agents,
    starting: state.starting,
    editor: state.editor,
    sidebarCollapsed: state.sidebarCollapsed,
    shortcutOverrides: state.shortcutOverrides,
    cliUpdate: state.cliUpdate,
    cliUpdateLoading: state.cliUpdateLoading,
    cliUpdateError: state.cliUpdateError,
    cliUpdateAt: state.cliUpdateAt,
    cliUpdating: state.cliUpdating,
    cliUpdateResult: state.cliUpdateResult,
    loadWorkspaceThreads: state.loadWorkspaceThreads,
    newThread: state.newThread,
    exitPreview: state.exitPreview,
    setThreadSearch: state.setThreadSearch,
    setThreadSearchOpen: state.setThreadSearchOpen,
    selectWorkspace: state.selectWorkspace,
    selectNextAttentionThread: state.selectNextAttentionThread,
    chooseProject: state.chooseProject,
    removeWorkspace: state.removeWorkspace,
    openTrustDialog: state.openTrustDialog,
    setSidebarCollapsed: state.setSidebarCollapsed,
    setSettingsOpen: state.setSettingsOpen,
    signOut: state.signOut,
    refreshCliUpdate: state.refreshCliUpdate,
    updateCli: state.updateCli,
    confirm: state.confirm,
  })));
  // The rows, not the threads: identical objects until something a row shows changes.
  const rowSelector = useRef<ReturnType<typeof createRowSelector> | null>(null);
  rowSelector.current ??= createRowSelector();
  const rows = useAppStore(rowSelector.current);
  const workspace = useAppStore(currentWorkspace);
  const [menu, setMenu] = useState<string | null>(null);
  const [wsMenu, setWsMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const profilePop = usePresence(profileOpen, EXIT_FAST_MS);
  const profileRef = useRef<HTMLButtonElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);
  const profileFocusEnd = useRef(false);
  const updatePop = usePresence(updateOpen, EXIT_FAST_MS);
  const wsMenuPop = usePresence(wsMenu !== null, EXIT_FAST_MS);
  // A closing workspace menu still names its workspace until it unmounts.
  const wsMenuFor = useRef<string | null>(null);
  if (wsMenu) wsMenuFor.current = wsMenu;
  const railPop = usePresence(s.sidebarCollapsed, EXIT_FAST_MS);
  // The sidebar stays drawn while its column closes, clipped to it and fading, so
  // hiding it is the open animation in reverse rather than a blank column sliding shut.
  const sidebarPop = usePresence(!s.sidebarCollapsed, SIDEBAR_EXIT_MS);
  // The folder in view opens on its own; any other opens from its caret and
  // stays open beside it, so work in several projects can be watched at once.
  const [expanded, setExpanded] = useState<string[]>(() => s.selectedWorkspaceId ? [s.selectedWorkspaceId] : []);
  // The workspace the user just opened: only that list animates open, never one restored on launch.
  const [revealed, setRevealed] = useState<string | null>(null);
  // Workspaces listing every thread, past the first LIST_CAP.
  const [showAll, setShowAll] = useState<string[]>([]);
  // A search opens every folder with a match; the caret hides one for this search only.
  const [hiddenInSearch, setHiddenInSearch] = useState<string[]>([]);
  const loaded = useRef(new Set<string>());
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Collapsing drops the loaded mark, so the next expand refetches the list.
  const toggleOpen = (id: string) => {
    setRevealed(id);
    setExpanded((ids) => {
      if (!ids.includes(id)) return [...ids, id];
      loaded.current.delete(id);
      return ids.filter((item) => item !== id);
    });
  };
  const toggleInSearch = (id: string) => setHiddenInSearch((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);

  // Typing in the search box stays instant; the list catches up a beat later.
  const search = useDeferredValue(s.threadSearch);
  const listed = useMemo(() => {
    // Content search reads the threads themselves, only while a search is active.
    const threads = search ? new Map(useAppStore.getState().threads.map((thread) => [thread.sessionId, thread])) : null;
    return rows
      .filter((row) => !row.archived)
      .filter((row) => agentEnabled(s, row.agentId ?? "muse"))
      .filter((row) => !threads || threadMatches(threads.get(row.sessionId)!, search))
      .slice()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.order - a.order);
  }, [rows, search, s.enabledAgents]);
  // One group per workspace, in the store's sidebar order, so the thread shortcuts walk what is drawn.
  const groups = useMemo(() => s.workspaces.map((item) => ({ item, threads: listed.filter((row) => row.workspacePath === item.path) })), [s.workspaces, listed]);
  // What a closed folder flags on its row. Read from every thread, not just a search's matches.
  const flags = useMemo(() => {
    const byPath = new Map<string, { attention: boolean; running: boolean }>();
    for (const row of rows) {
      if (row.archived || !agentEnabled(s, row.agentId ?? "muse")) continue;
      const flag = byPath.get(row.workspacePath) ?? { attention: false, running: false };
      flag.attention ||= row.attention;
      flag.running ||= row.status === "running";
      byPath.set(row.workspacePath, flag);
    }
    return byPath;
  }, [rows, s.enabledAgents]);
  // Work blocked on the user, in every workspace.
  const attentionCount = useMemo(() => {
    const paths = new Set(s.workspaces.map((item) => item.path));
    return rows.reduce((count, row) => count + (row.attention && !row.archived && paths.has(row.workspacePath) && agentEnabled(s, row.agentId ?? "muse") ? 1 : 0), 0);
  }, [rows, s.workspaces, s.enabledAgents]);
  // The row keeps its last count while it folds away, rather than reading "0 threads".
  const attentionShown = useRef(attentionCount);
  if (attentionCount) attentionShown.current = attentionCount;
  const archivedCount = useMemo(() => rows.filter((row) => row.archived).length, [rows]);

  // Selecting a workspace, or opening one of its threads from anywhere, opens its folder.
  useEffect(() => {
    const id = s.selectedWorkspaceId;
    if (id) setExpanded((ids) => ids.includes(id) ? ids : [...ids, id]);
  }, [s.selectedWorkspaceId]);

  // An expanded workspace fills its own list; the selected one is already
  // loading through selectWorkspace, so mark it instead of listing twice.
  useEffect(() => {
    for (const id of expanded) {
      if (id === s.selectedWorkspaceId) { loaded.current.add(id); continue; }
      if (loaded.current.has(id)) continue;
      loaded.current.add(id);
      void s.loadWorkspaceThreads(id);
    }
  }, [expanded, s.selectedWorkspaceId]);

  // A search spans every workspace, so it lists the threads of folders never opened.
  useEffect(() => {
    if (!search) { setHiddenInSearch([]); return; }
    for (const item of s.workspaces) {
      if (loaded.current.has(item.id)) continue;
      loaded.current.add(item.id);
      if (item.id !== s.selectedWorkspaceId) void s.loadWorkspaceThreads(item.id);
    }
  }, [Boolean(search), s.workspaces, s.selectedWorkspaceId, s.loadWorkspaceThreads]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const timer = window.setTimeout(() => document.addEventListener("click", close), 0);
    return () => { window.clearTimeout(timer); document.removeEventListener("click", close); };
  }, [menu]);

  useEffect(() => {
    if (!wsMenu) return;
    const close = () => setWsMenu(null);
    const timer = window.setTimeout(() => document.addEventListener("click", close), 0);
    return () => { window.clearTimeout(timer); document.removeEventListener("click", close); };
  }, [wsMenu]);

  useEffect(() => {
    if (!updateOpen) return;
    const close = () => setUpdateOpen(false);
    const timer = window.setTimeout(() => document.addEventListener("click", close), 0);
    return () => { window.clearTimeout(timer); document.removeEventListener("click", close); };
  }, [updateOpen]);

  const closeProfileMenu = () => {
    setProfileOpen(false);
    profileRef.current?.focus();
  };

  useEffect(() => {
    if (!profileOpen) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (profileRef.current?.contains(target) || profileMenuRef.current?.contains(target)) return;
      setProfileOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [profileOpen]);

  // A menu opens with a useful item focused, not with keyboard focus left on its trigger.
  useEffect(() => {
    if (!profileOpen) return;
    const items = profileMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)');
    if (!items?.length) return;
    items[profileFocusEnd.current ? items.length - 1 : 0].focus();
  }, [profileOpen]);

  useEffect(() => { if (s.sidebarCollapsed) setProfileOpen(false); }, [s.sidebarCollapsed]);

  // Dragging reorders within one workspace and one pin group; the dropped list
  // is handed to the store verbatim so what you see is what gets saved. The
  // lists and the dragged id live in refs so the row handlers never change.
  const lists = useRef<Record<string, ThreadRow[]>>({});
  const draggingId = useRef<string | null>(null);
  const onOpenThreadsRef = useRef(onOpenThreads);
  onOpenThreadsRef.current = onOpenThreads;
  const actions = useMemo<ThreadActions>(() => {
    const store = () => useAppStore.getState();
    const canDrop = (target: ThreadRow) => {
      const source = (lists.current[target.workspacePath] ?? []).find((row) => row.sessionId === draggingId.current);
      return Boolean(source && source.sessionId !== target.sessionId && source.pinned === target.pinned);
    };
    return {
      open: (id) => { onOpenThreadsRef.current?.(); void store().selectThread(id); },
      toggleMenu: (id) => { setWsMenu(null); setMenu((current) => current === id ? null : id); },
      showMenu: (id) => { setWsMenu(null); setMenu(id); },
      closeMenu: () => setMenu(null),
      startRename: (id) => { setRenaming(id); setMenu(null); },
      finishRename: (id, title) => { store().renameThread(id, title); setRenaming(null); },
      cancelRename: () => setRenaming(null),
      pin: (id) => { store().pinThread(id); setMenu(null); },
      archive: (id) => { store().archiveThread(id); setMenu(null); },
      setUnread: (id, unread) => { store().setThreadUnread(id, unread); setMenu(null); },
      openFolder: (id) => { setMenu(null); void openThreadFolder(id); },
      copyPath: (id) => { setMenu(null); void copyThreadPath(id); },
      copyTaskPath: (id) => { setMenu(null); void copyThreadLogPath(id); },
      copyLogPath: () => { setMenu(null); void copyAppLogPath(); },
      copySessionId: (id) => { setMenu(null); void copySessionId(id); },
      openConfig: () => { setMenu(null); void openAppConfig(); },
      viewTrajectory: (id) => { setMenu(null); store().openThreadTrajectory(id); },
      reportIssue: (id) => { setMenu(null); void reportThreadIssue(id); },
      exportThread: (row, redacted, format) => {
        setMenu(null);
        void exportThread(row, redacted, format);
      },
      fork: (id) => { setMenu(null); void store().forkThread(id); },
      preview: (id) => { setMenu(null); void store().openPreview(id); },
      remove: (row) => {
        setMenu(null);
        void store().confirm({ title: `Delete “${row.title}”?`, body: ["It is removed from Glitter. This cannot be undone.", worktreeRemovalNote(store().threads, [row.sessionId])].filter(Boolean).join(" "), confirmLabel: "Delete", danger: true }).then((ok) => { if (ok) store().deleteThread(row.sessionId); });
      },
      dragStart: (event, id) => { draggingId.current = id; setDragging(id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", id); },
      dragOver: (event, row) => {
        if (!canDrop(row)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropTarget(row.sessionId);
      },
      dragLeave: (id) => setDropTarget((current) => current === id ? null : current),
      drop: (event, target) => {
        if (!canDrop(target)) return;
        event.preventDefault();
        setDropTarget(null);
        const list = lists.current[target.workspacePath] ?? [];
        const from = list.findIndex((row) => row.sessionId === draggingId.current);
        const to = list.findIndex((row) => row.sessionId === target.sessionId);
        draggingId.current = null;
        setDragging(null);
        if (from < 0 || to < 0 || from === to) return;
        const next = list.slice();
        next.splice(to, 0, ...next.splice(from, 1));
        store().reorderThreads(next.map((row) => row.sessionId));
      },
      dragEnd: () => { draggingId.current = null; setDragging(null); setDropTarget(null); },
    };
  }, []);

  const ready = readyAgents(s);
  const installed = s.agents.filter((agent) => agent.found);
  // Until detection has answered, "no agent found" would be a claim we cannot make yet.
  const checking = !s.detectionChecked && !s.preview;
  // A healthy connection says nothing. The row exists only while something blocks work.
  const alert: { tone: "idle" | "warn" | "bad"; label: string; tab?: SettingsTab } | null = s.preview ? null
    : checking ? { tone: "idle", label: "Checking agents…" }
    : s.offline ? { tone: "bad", label: "Offline" }
    : ready.length ? null
    : installed.length ? { tone: "warn", label: "Sign in needed", tab: "Agents" }
    : { tone: "bad", label: "No agent CLI found", tab: "Agents" };
  const statusTitle = installed.map((agent) => `${agent.name}${agent.version ? ` ${agent.version}` : ""} — ${agent.path}`).join("\n") || undefined;
  const profileName = s.preview ? "Preview" : s.detection?.accountName || s.detection?.accountEmail || "Profile";
  const profileDetail = s.preview ? "Demo data" : s.detection?.authenticated
    ? s.detection.accountEmail && s.detection.accountEmail !== profileName ? s.detection.accountEmail : "Muse connected"
    : "Preferences on this Mac";
  const profileInitial = Array.from(profileName.trim())[0]?.toUpperCase() ?? "P";
  const newThread = () => { onOpenThreads?.(); void s.newThread(); };
  // Selecting a workspace opens its draft, so a new thread elsewhere is one click too.
  const newThreadIn = (item: Workspace) => {
    if (item.id !== s.selectedWorkspaceId) void s.selectWorkspace(item.id);
    newThread();
  };
  const openSettings = (tab?: SettingsTab) => { setProfileOpen(false); s.setSettingsOpen(true, tab); };
  const searchShown = s.threadSearchOpen || Boolean(s.threadSearch);
  const updateAvailable = !s.preview && s.cliUpdate?.available === true && Boolean(s.cliUpdate.latest);
  const closeWorkspaceMenu = (id: string) => {
    setWsMenu(null);
    document.getElementById(`workspace-more-${id}`)?.focus();
  };
  const workspaceAction = (item: Workspace, action: WorkspaceAction) => {
    setWsMenu(null);
    if (action === "remove") {
      void s.confirm({ title: `Remove ${item.name} from the sidebar?`, body: `Running turns in this workspace will be stopped.${useAppStore.getState().threads.some((thread) => thread.worktree && thread.workspacePath === item.path) ? " Its worktrees are removed too, except any with uncommitted changes, which stay on disk." : ""}`, confirmLabel: "Remove", danger: true }).then((ok) => { if (ok) s.removeWorkspace(item.id); });
      return;
    }
    if (action === "regrant") { void s.chooseProject(); return; }
    if (action === "trust") { void s.openTrustDialog(item.id); return; }
    if (action === "copy") { void navigator.clipboard?.writeText(item.path); return; }
    const editor = action === "editor" ? s.editor ?? "default" : "default";
    void openPath(item.path, item.grantId ?? "preview", editor).catch((cause) => useAppStore.setState({ error: describeError(`Could not open ${item.name}`, cause) }));
  };
  const rowNode = (row: ThreadRow, reorderable: boolean) => (
    <ThreadItem
      key={row.sessionId}
      row={row}
      active={row.sessionId === s.selectedSessionId}
      menuOpen={menu === row.sessionId}
      renaming={renaming === row.sessionId}
      dragging={dragging === row.sessionId}
      dropTarget={dropTarget === row.sessionId}
      reorderable={reorderable}
      preview={s.preview}
      agentName={s.agents.find((agent) => agent.id === (row.agentId ?? "muse"))?.name}
      actions={actions}
    />
  );
  const anyMatch = groups.some((group) => group.threads.length > 0);

  return (
    <>
      {/* The sidebar's buttons in the title bar: Show/Hide sidebar and Search, as
          icons. Open, they sit at the sidebar's right edge; collapsed, they slide
          to the window controls and the actions from the sidebar's rows and foot
          join them. The toggle is one button throughout, so it never re-mounts. */}
      <div className="sidebar-rail" role="group" aria-label="Sidebar">
        <button
          className="icon-btn"
          aria-label={s.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
          aria-controls="sidebar-navigation"
          aria-expanded={!s.sidebarCollapsed}
          data-tooltip={`${s.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}  ${shortcutText("toggle-sidebar")}`}
          data-tooltip-align="start"
          onClick={() => s.setSidebarCollapsed(!s.sidebarCollapsed)}
        ><PanelLeft size={16} /></button>
        <button
          className="icon-btn"
          aria-label="Search threads"
          // Keeps the field's blur (which folds an empty search) from closing it before this click toggles it.
          onMouseDown={(event) => event.preventDefault()}
          aria-expanded={!s.sidebarCollapsed && searchShown}
          aria-controls={!s.sidebarCollapsed && searchShown ? "thread-search" : undefined}
          data-tooltip={`Search threads  ${shortcutText("search-threads")}`}
          onClick={() => {
            if (!s.sidebarCollapsed && searchShown) { s.setThreadSearchOpen(false); return; }
            s.setThreadSearchOpen(true);
            window.setTimeout(() => document.getElementById("thread-search")?.focus(), 0);
          }}
        ><Search size={16} /></button>
        {railPop.mounted ? (
          <div className={`sidebar-rail-more${railPop.closing ? " closing" : ""}`} aria-hidden={railPop.closing || undefined} inert={railPop.closing}>
            <button className="icon-btn" aria-label="New thread" data-tooltip={`New thread  ${shortcutText("new-thread")}`} disabled={s.starting || !workspace} onClick={newThread}><SquarePen size={16} /></button>
            <button className="icon-btn" aria-label="Open workspace" data-tooltip={`Open workspace  ${shortcutText("open-workspace")}`} onClick={() => void s.chooseProject()}><Plus size={16} /></button>
            <button className="icon-btn" aria-label="Settings" data-tooltip={`Settings  ${shortcutText("settings")}`} onClick={() => openSettings()}><Settings size={16} /></button>
            <SidebarUsage />
            {updateAvailable ? <button className="icon-btn update-dot" aria-label="CLI update available — show sidebar" title="CLI update available" onClick={() => s.setSidebarCollapsed(false)}><Download size={16} /></button> : null}
          </div>
        ) : null}
      </div>
      {sidebarPop.mounted ? <aside id="sidebar-navigation" className={`sidebar${sidebarPop.closing ? " closing" : ""}`} aria-hidden={sidebarPop.closing || undefined} inert={sidebarPop.closing}>
      <div className="drag" data-tauri-drag-region />
      {/* Clears the title bar. Session tools start below the window controls. */}
      <div className="sidebar-top" />

      {/* Start a thread, find one, and — only while something is blocked — get to
          the work waiting on you. */}
      <div className="sidebar-tools">
        <button type="button" className="nav-row new-thread" aria-label="New thread" disabled={s.starting || !workspace} onClick={newThread}>
          <SquarePen size={15} />
          <span aria-hidden="true">New thread</span>
          <kbd aria-hidden="true">{shortcutText("new-thread")}</kbd>
        </button>
        {/* Search folds behind its title-bar icon, and grows in when opened. It stays while it holds a query. */}
        <Collapse open={searchShown}>{() => (
          <label className="search-field">
            <Search size={13} aria-hidden="true" />
            <input
              id="thread-search"
              value={s.threadSearch}
              placeholder="Search threads"
              aria-label="Search threads"
              onChange={(event) => s.setThreadSearch(event.target.value)}
              onBlur={(event) => { if (!event.target.value) s.setThreadSearchOpen(false); }}
              onKeyDown={(event) => { if (event.key === "Escape") { s.setThreadSearchOpen(false); (event.target as HTMLInputElement).blur(); } }}
            />
            {s.threadSearch ? <button type="button" className="search-clear" aria-label="Clear search" onClick={() => s.setThreadSearch("")}><X size={12} /></button> : null}
          </label>
        )}</Collapse>
        {/* Approvals and questions in any workspace, as one row while they last.
            Each click opens the next waiting thread, as the shortcut does. */}
        <Collapse open={attentionCount > 0}>{() => (
          <button
            type="button"
            className="nav-row attention-row"
            data-tooltip={`Open the next one  ${shortcutText("attention")}`}
            onClick={() => { onOpenThreads?.(); void s.selectNextAttentionThread(); }}
          >
            <i className="thread-status attention" aria-hidden="true" />
            <span>{attentionShown.current === 1 ? "1 thread needs you" : `${attentionShown.current} threads need you`}</span>
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        )}</Collapse>
      </div>

      {s.preview ? (
        <nav className="sidebar-nav" aria-label="Primary">
          <button type="button" className="nav-row exit-preview" onClick={() => void s.exitPreview()}><LogOut size={15} /><span>Exit preview</span></button>
        </nav>
      ) : null}

      <div className="section-label">
        <span>Workspaces</span>
        <span className="section-actions">
          {archivedCount ? <button className="icon-btn small" aria-label={`Archived threads (${archivedCount})`} data-tooltip="Archived threads" onClick={() => s.setSettingsOpen(true, "Threads")}><Archive size={13} /></button> : null}
          <button className="icon-btn small" aria-label="Open workspace" data-tooltip={`Open workspace  ${shortcutText("open-workspace")}`} data-tooltip-align="end" onClick={() => void s.chooseProject()}><Plus size={14} /></button>
        </span>
      </div>

      {/* One group per workspace: the folder, then its threads. The folder in view
          opens on its own and is set in stronger ink; a closed one flags work
          waiting on you or still running. A search opens every folder with a match. */}
      <div className="scroll thread-scroll">
        {!s.workspaces.length ? (
          <button className="tree-empty" onClick={() => void s.chooseProject()}>
            <FolderOpen size={15} />
            <span>Open a workspace</span>
          </button>
        ) : null}
        {groups.map(({ item, threads }) => {
          const active = item.id === s.selectedWorkspaceId;
          const loadingList = s.threadsLoading.includes(item.id);
          // A search keeps the folders with a match, and the one in view so its empty note has a home.
          if (search && !threads.length && !active && !loadingList) {
            lists.current[item.path] = [];
            return null;
          }
          lists.current[item.path] = threads;
          const open = search ? !hiddenInSearch.includes(item.id) : expanded.includes(item.id);
          const flag = flags.get(item.path);
          const long = !search && threads.length > LIST_CAP + 2;
          // Past the cap, the open thread and anything waiting or running stay listed, in place.
          const visible = long && !showAll.includes(item.id)
            ? threads.filter((row, index) => index < LIST_CAP || row.sessionId === s.selectedSessionId || row.attention || row.status === "running")
            : threads;
          const more = threads.length - visible.length;
          const menuShown = wsMenuPop.mounted && wsMenuFor.current === item.id;
          const toggle = () => (search ? toggleInSearch(item.id) : toggleOpen(item.id));
          return (
            <div key={item.id} className={`workspace-group${active ? " active" : ""}`}>
              <div className={`workspace-row${active ? " active" : ""}${menuShown ? " menu-open" : ""}`}>
                {/* The folder mark turns into the caret under the pointer. */}
                <button className="workspace-toggle" aria-label={`${open ? "Collapse" : "Expand"} ${item.name}`} aria-expanded={open} onClick={toggle}>
                  {open ? <FolderOpen size={15} className="ws-folder" aria-hidden="true" /> : <Folder size={15} className="ws-folder" aria-hidden="true" />}
                  <ChevronRight size={14} className="ws-caret" aria-hidden="true" />
                </button>
                <button
                  className="workspace"
                  title={item.path}
                  onClick={() => {
                    if (active) { toggle(); return; }
                    setRevealed(item.id);
                    void s.selectWorkspace(item.id);
                  }}
                >
                  <span className="workspace-name">{item.name}</span>
                  {open ? null
                    : flag?.attention ? <span className="thread-status attention" role="img" aria-label="A thread needs your attention" title="A thread needs your attention" />
                    : flag?.running ? <span className="thread-status running" role="img" aria-label="A thread is running" title="A thread is running" />
                    : null}
                </button>
                <div className="row-actions">
                  <button className="icon-btn small" aria-label={`New thread in ${item.name}`} data-tooltip={active ? `New thread  ${shortcutText("new-thread")}` : "New thread"} disabled={s.starting || !item.grantId} onClick={() => newThreadIn(item)}><SquarePen size={13} /></button>
                  <button
                    id={`workspace-more-${item.id}`}
                    className="icon-btn small"
                    aria-label={`Actions for ${item.name}`}
                    aria-haspopup="menu"
                    aria-expanded={wsMenu === item.id}
                    onClick={(event) => { event.stopPropagation(); setMenu(null); setWsMenu((current) => current === item.id ? null : item.id); }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && wsMenu !== item.id) { event.preventDefault(); setMenu(null); setWsMenu(item.id); }
                      if (event.key === "Escape" && wsMenu === item.id) { event.preventDefault(); setWsMenu(null); }
                    }}
                  ><MoreHorizontal size={14} /></button>
                </div>
                {menuShown ? <WorkspaceMenu workspace={item} editor={s.editor ?? "default"} closing={wsMenuPop.closing} onClose={() => closeWorkspaceMenu(item.id)} onPick={(action) => workspaceAction(item, action)} /> : null}
              </div>

              <Collapse open={open} animate={revealed === item.id}>{() => (
                <div className="workspace-threads">
                  {!item.grantId ? (
                    <button type="button" className="workspace-regrant" onClick={() => void s.chooseProject()}>Glitter lost access to this folder. Choose it again…</button>
                  ) : null}
                  {visible.length ? (
                    <div className="thread-list" role="list" aria-label={`Threads in ${item.name}`}>
                      {visible.map((row) => rowNode(row, !search))}
                    </div>
                  ) : null}
                  {more ? (
                    <button type="button" className="list-more" onClick={() => setShowAll((ids) => [...ids, item.id])}>Show {more} more</button>
                  ) : long ? (
                    <button type="button" className="list-more" onClick={() => setShowAll((ids) => ids.filter((id) => id !== item.id))}>Show less</button>
                  ) : null}
                  {!threads.length ? (
                    <div className="tree-note">
                      {loadingList || (active && checking && !search)
                        ? <span className="tree-loading"><LoaderCircle size={12} className="spin" aria-hidden="true" />Loading threads…</span>
                        : search ? "No matching threads"
                        : "No threads yet"}
                    </div>
                  ) : null}
                </div>
              )}</Collapse>
            </div>
          );
        })}
        {search && s.workspaces.length && !anyMatch && !workspace ? <div className="tree-note">No matching threads</div> : null}
      </div>

      {/* The foot: an update or a blocked agent while they last, then Settings and today's usage. */}
      <div className="sidebar-bottom">
        {updateAvailable && s.cliUpdate ? <div className="update-wrap" onKeyDown={(event) => { if (event.key === "Escape") setUpdateOpen(false); }}>
          <button
            type="button"
            className="nav-row update-row"
            aria-label={`Muse CLI update available, ${shortCliVersion(s.cliUpdate.current) || "unknown"} to ${shortCliVersion(s.cliUpdate.latest)}`}
            aria-expanded={updateOpen}
            onClick={() => setUpdateOpen((open) => !open)}
          >
            <Download size={15} />
            <span>CLI update</span>
            <em className="update-ver">{shortCliVersion(s.cliUpdate.latest)}</em>
          </button>
          {updatePop.mounted ? <CliUpdateCard
            closing={updatePop.closing}
            status={s.cliUpdate}
            updating={s.cliUpdating}
            checking={s.cliUpdateLoading}
            error={s.cliUpdateError}
            result={s.cliUpdateResult}
            checkedAt={s.cliUpdateAt}
            onUpdate={() => void s.updateCli()}
            onRefresh={() => void s.refreshCliUpdate(true)}
            onClose={() => setUpdateOpen(false)}
          /> : null}
        </div> : null}
        <div className="sidebar-foot">
          {alert ? (
            alert.tab ? (
              <button type="button" className={`sidebar-alert ${alert.tone}`} title={statusTitle} onClick={() => openSettings(alert.tab)}>
                <i aria-hidden="true" />
                <span>{alert.label}</span>
              </button>
            ) : (
              <div className={`sidebar-alert ${alert.tone}`} role="status" title={statusTitle}>
                <i aria-hidden="true" />
                <span>{alert.label}</span>
              </div>
            )
          ) : null}
          <div className="sidebar-utilities">
            <button
              ref={profileRef}
              type="button"
              className="profile-trigger"
              aria-label={`Profile menu, ${profileName}`}
              aria-haspopup="menu"
              aria-expanded={profileOpen}
              aria-controls={profileOpen ? "sidebar-profile-menu" : undefined}
              onClick={() => { profileFocusEnd.current = false; setProfileOpen((open) => !open); }}
              onKeyDown={(event) => {
                if (!profileOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
                  event.preventDefault();
                  profileFocusEnd.current = event.key === "ArrowUp";
                  setProfileOpen(true);
                } else if (event.key === "Escape" && profileOpen) {
                  event.preventDefault();
                  closeProfileMenu();
                }
              }}
            >
              <span className="profile-avatar" aria-hidden="true">{profileInitial}</span>
              <span className="profile-name">{profileName}</span>
              <ChevronsUpDown size={13} className="profile-caret" aria-hidden="true" />
            </button>
            {profilePop.mounted ? (
              <div
                ref={profileMenuRef}
                id="sidebar-profile-menu"
                className={`menu profile-menu${profilePop.closing ? " closing" : ""}`}
                role="menu"
                aria-label="Profile"
                aria-hidden={profilePop.closing || undefined}
                inert={profilePop.closing}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => menuKeys(event, closeProfileMenu)}
              >
                <div className="profile-menu-head">
                  <span className="profile-avatar profile-avatar-large" aria-hidden="true">{profileInitial}</span>
                  <span className="profile-menu-copy"><strong>{profileName}</strong><span>{profileDetail}</span></span>
                </div>
                <div className="menu-sep" aria-hidden="true" />
                <button type="button" role="menuitem" onClick={() => openSettings("Theme")}><Palette size={13} aria-hidden="true" />App theme</button>
                <button type="button" role="menuitem" onClick={() => openSettings("Usage")}><ChartColumn size={13} aria-hidden="true" />Usage stats</button>
                <button type="button" role="menuitem" onClick={() => openSettings("Shortcuts")}><Keyboard size={13} aria-hidden="true" />Commands &amp; shortcuts</button>
                <button type="button" role="menuitem" onClick={() => openSettings()}><Settings size={13} aria-hidden="true" />Settings<span className="menu-hint">{shortcutText("settings")}</span></button>
                {!s.preview && s.detection?.authenticated ? <>
                  <div className="menu-sep" aria-hidden="true" />
                  <button type="button" role="menuitem" onClick={() => { setProfileOpen(false); void s.signOut(); }}><LogOut size={13} aria-hidden="true" />Sign out of Muse</button>
                </> : null}
              </div>
            ) : null}
            <SidebarUsage showToday />
            <button type="button" className="icon-btn" aria-label="Settings" data-tooltip={`Settings  ${shortcutText("settings")}`} data-tooltip-side="top" data-tooltip-align="end" onClick={() => openSettings()}><Settings size={16} /></button>
          </div>
        </div>
      </div>
      {!s.sidebarCollapsed ? <SidebarResize /> : null}
      </aside> : null}
    </>
  );
}
