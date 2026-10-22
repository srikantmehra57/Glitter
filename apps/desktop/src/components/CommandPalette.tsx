import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Archive, ArrowDown, ArrowUp, Bell, CornerDownLeft, Keyboard, Cpu, Download, FileText, FolderOpen, Gauge, GitFork, History, Info, MessageSquare, Minimize2, Monitor, Moon, PanelLeft, PanelRight, Pencil, Play, RotateCcw, Search, Settings, ShieldCheck, Square, SquarePen, SquareTerminal, Sun, TextCursorInput } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { exportThread, runBuiltinCommand, shortcutText } from "../lib/commands";
import { availableBuiltins } from "../lib/composerText";
import { afterDialogRestore, closeDialog, rememberDialogFocus } from "../lib/dialogFocus";
import { fuzzyScore } from "../lib/fuzzy";
import { needsAttention, threadMatches } from "../lib/format";
import { paletteRows, type PaletteItem } from "../lib/palette";
import { currentThread, currentWorkspace, useAppStore } from "../lib/store";
import { agentEnabled, SETTINGS_TABS, type ThemeMode } from "../lib/types";
import { SETTINGS_TAB_LABELS } from "../lib/settingsNav";

type Command = PaletteItem & {
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
  hidden?: boolean;
  /** Runs once the dialog has closed and handed focus back, for commands that move focus themselves. */
  defer?: boolean;
  /** Threads and files are places, not commands: they never enter Recent. */
  transient?: boolean;
};

const THEMES: Array<{ mode: ThemeMode; label: string; icon: ReactNode }> = [
  { mode: "light", label: "Use light theme", icon: <Sun size={14} /> },
  { mode: "dark", label: "Use dark theme", icon: <Moon size={14} /> },
  { mode: "system", label: "Match system theme", icon: <Monitor size={14} /> },
];
const THREAD_LIMIT = 8;
const SEARCH_LIMIT = 12;

export function CommandPalette() {
  const s = useAppStore(useShallow((state) => ({
    paletteOpen: state.paletteOpen,
    setPaletteOpen: state.setPaletteOpen,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    enabledAgents: state.enabledAgents,
    drafts: state.drafts,
    defaultAgentId: state.defaultAgentId,
    preview: state.preview,
    theme: state.theme,
    shortcutOverrides: state.shortcutOverrides,
    fileIndex: state.fileIndex,
    recentCommands: state.recentCommands,
    noteCommand: state.noteCommand,
    dockOpen: state.dockOpen,
    terminalOpen: state.terminalOpen,
    setTerminalOpen: state.setTerminalOpen,
    setDockOpen: state.setDockOpen,
    sidebarCollapsed: state.sidebarCollapsed,
    setSidebarCollapsed: state.setSidebarCollapsed,
    selectThread: state.selectThread,
    selectAdjacentThread: state.selectAdjacentThread,
    setFindOpen: state.setFindOpen,
    selectNextAttentionThread: state.selectNextAttentionThread,
    archiveThread: state.archiveThread,
    newThread: state.newThread,
    openLastThread: state.openLastThread,
    chooseProject: state.chooseProject,
    setSettingsOpen: state.setSettingsOpen,
    commitSettings: state.commitSettings,
    openFile: state.openFile,
    stopTurn: state.stopTurn,
    continueThread: state.continueThread,
    retryLast: state.retryLast,
  })));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const workspace = currentWorkspace(s);
  const thread = currentThread(s);
  const searching = Boolean(query.trim());
  const commands = useMemo<Command[]>(() => {
    const agentId = thread ? thread.agentId ?? "muse" : s.drafts[`project:${s.selectedWorkspaceId}`]?.config?.agentId ?? s.defaultAgentId ?? "muse";
    const builtin = new Set(availableBuiltins({ thread: Boolean(thread), muse: agentId === "muse", live: !s.preview }).map((command) => command.name));
    const act = (name: string) => () => { runBuiltinCommand(name); };
    const actions: Command[] = [
      { id: "new", label: "New thread", icon: <SquarePen size={14} />, shortcut: shortcutText("new-thread"), run: () => void s.newThread() },
      { id: "last", label: "Open last thread", icon: <History size={14} />, run: () => void s.openLastThread() },
      { id: "attention", label: "Next thread needing attention", icon: <Bell size={14} />, shortcut: shortcutText("attention"), hidden: !s.threads.some((item) => item.sessionId !== s.selectedSessionId && !item.archived && needsAttention(item)), run: () => void s.selectNextAttentionThread() },
      { id: "stop", label: "Stop agent", icon: <Square size={14} />, hidden: thread?.status !== "running", run: () => void s.stopTurn() },
      { id: "continue", label: "Continue thread", icon: <Play size={14} />, hidden: thread?.status === "running" || !thread?.lastOutcome || thread.lastOutcome === "completed", run: () => void s.continueThread() },
      { id: "retry", label: "Retry last prompt", icon: <RotateCcw size={14} />, hidden: thread?.status === "running" || !thread?.items.some((item) => item.kind === "userMessage"), run: () => void s.retryLast() },
      { id: "model", label: "Switch model", icon: <Cpu size={14} />, shortcut: shortcutText("model"), hidden: !workspace, defer: true, run: act("model") },
      { id: "effort", label: "Set reasoning effort", icon: <Gauge size={14} />, shortcut: shortcutText("effort"), hidden: !workspace, defer: true, run: act("effort") },
      { id: "permissions", label: "Change permissions", icon: <ShieldCheck size={14} />, shortcut: shortcutText("permissions"), keywords: "approval mode", hidden: !workspace || !builtin.has("permissions"), defer: true, run: act("permissions") },
      { id: "fork", label: "Fork thread", icon: <GitFork size={14} />, hidden: !builtin.has("fork"), run: act("fork") },
      { id: "compact", label: "Compact thread", icon: <Minimize2 size={14} />, keywords: "context", hidden: !builtin.has("compact") || thread?.status === "running", run: act("compact") },
      { id: "rename", label: "Rename thread", icon: <Pencil size={14} />, hidden: !builtin.has("rename"), defer: true, run: act("rename") },
      { id: "status", label: "Thread status", icon: <Info size={14} />, keywords: "context usage session id", hidden: !builtin.has("status"), defer: true, run: act("status") },
      { id: "export", label: "Export thread (share-safe JSON)", icon: <Download size={14} />, hidden: !builtin.has("export"), defer: true, run: () => { if (thread) void exportThread(thread, true); } },
      { id: "export-raw", label: "Export thread (raw JSON)", icon: <Download size={14} />, hidden: !builtin.has("export"), defer: true, run: () => { if (thread) void exportThread(thread, false); } },
      { id: "export-md", label: "Export thread (share-safe Markdown)", icon: <ShieldCheck size={14} />, hidden: !builtin.has("export"), defer: true, run: () => { if (thread) void exportThread(thread, true, "markdown"); } },
      { id: "export-md-raw", label: "Export thread (raw Markdown)", icon: <FileText size={14} />, hidden: !builtin.has("export"), defer: true, run: () => { if (thread) void exportThread(thread, false, "markdown"); } },
      { id: "archive", label: "Archive thread", icon: <Archive size={14} />, shortcut: shortcutText("archive"), hidden: !thread, run: () => { if (thread) s.archiveThread(thread.sessionId); } },
      { id: "open", label: "Open workspace", icon: <FolderOpen size={14} />, run: () => void s.chooseProject() },
      { id: "init", label: "Preview and write AGENTS.md", icon: <FileText size={14} />, keywords: "init set up workspace", hidden: !workspace || !builtin.has("init"), defer: true, run: act("init") },
      { id: "find", label: "Find in thread", icon: <Search size={14} />, shortcut: shortcutText("find"), hidden: !thread?.items.length, defer: true, run: () => s.setFindOpen(true) },
      { id: "search", label: "Search threads", icon: <Search size={14} />, shortcut: shortcutText("search-threads"), defer: true, run: () => document.getElementById("thread-search")?.focus() },
      { id: "next-thread", label: "Next thread", icon: <ArrowDown size={14} />, shortcut: shortcutText("next-thread"), hidden: !thread, run: () => void s.selectAdjacentThread(1) },
      { id: "previous-thread", label: "Previous thread", icon: <ArrowUp size={14} />, shortcut: shortcutText("previous-thread"), hidden: !thread, run: () => void s.selectAdjacentThread(-1) },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: <Keyboard size={14} />, shortcut: shortcutText("shortcuts"), run: () => s.setSettingsOpen(true, "Shortcuts") },
      { id: "composer", label: "Focus composer", icon: <TextCursorInput size={14} />, defer: true, run: () => document.getElementById("prompt")?.focus() },
      { id: "terminal", label: s.terminalOpen ? "Hide terminal" : "Show terminal", icon: <SquareTerminal size={14} />, shortcut: shortcutText("terminal"), hidden: !workspace, run: () => s.setTerminalOpen(!s.terminalOpen) },
      { id: "inspector", label: s.dockOpen ? "Hide changes" : "Show changes", icon: <PanelRight size={14} />, shortcut: shortcutText("toggle-changes"), run: () => s.setDockOpen(!s.dockOpen) },
      { id: "sidebar", label: s.sidebarCollapsed ? "Show sidebar" : "Hide sidebar", icon: <PanelLeft size={14} />, shortcut: shortcutText("toggle-sidebar"), run: () => s.setSidebarCollapsed(!s.sidebarCollapsed) },
      ...THEMES.map((theme) => ({ id: `theme-${theme.mode}`, label: theme.label, icon: theme.icon, keywords: "appearance", hidden: s.theme === theme.mode, run: () => void s.commitSettings({ theme: theme.mode }) })),
    ].map((command) => ({ ...command, section: "Actions" as const }));
    // The list shows this workspace's latest threads; a search reaches every workspace.
    const names = new Map(s.workspaces.map((item) => [item.path, item.name]));
    const pool = s.threads.filter((item) => !item.archived && names.has(item.workspacePath) && agentEnabled(s, item.agentId ?? "muse"));
    const shown = searching
      ? pool.filter((item) => threadMatches(item, query)).sort((a, b) => Number(b.workspacePath === workspace?.path) - Number(a.workspacePath === workspace?.path)).slice(0, SEARCH_LIMIT)
      : pool.filter((item) => !workspace || item.workspacePath === workspace.path).slice(0, THREAD_LIMIT);
    const threads: Command[] = shown.map((item) => ({
      id: `thread-${item.sessionId}`,
      label: item.workspacePath === workspace?.path ? item.title : `${item.title} · ${names.get(item.workspacePath)}`,
      section: "Threads",
      icon: <MessageSquare size={14} />,
      matched: true,
      transient: true,
      run: () => void s.selectThread(item.sessionId),
    }));
    const indexed = searching && workspace && s.fileIndex?.workspaceId === workspace.id ? s.fileIndex.paths : [];
    const files: Command[] = indexed
      .map((path) => ({ path, score: fuzzyScore(query.trim(), path) }))
      .filter((entry): entry is { path: string; score: number } => entry.score != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, THREAD_LIMIT)
      .map(({ path }) => ({
        id: `file-${path}`,
        label: `Open file · ${path}`,
        section: "Files",
        icon: <FileText size={14} />,
        matched: true,
        transient: true,
        defer: true,
        run: () => void s.openFile(path),
      }));
    const settings: Command[] = [
      { id: "settings", label: "Open settings", section: "Settings", icon: <Settings size={14} />, shortcut: shortcutText("settings"), run: () => s.setSettingsOpen(true) },
      ...SETTINGS_TABS.map((tab) => ({ id: `settings-${tab}`, label: `Settings · ${SETTINGS_TAB_LABELS[tab]}`, section: "Settings" as const, icon: <Settings size={14} />, keywords: tab === "Agents" ? "muse connection sign in api key" : tab === "Extensions" ? "mcp skills plugins" : tab === "Models" ? "hide show test" : undefined, run: () => s.setSettingsOpen(true, tab) })),
    ];
    return [...actions, ...threads, ...files, ...settings];
  }, [s, thread, workspace, query, searching]);
  const visible = useMemo(() => paletteRows(commands.filter((command) => !command.hidden), query, s.recentCommands), [commands, query, s.recentCommands]);
  // The list can shrink without a query change (threads finish, recents
  // shift): read the active row clamped so Enter, the highlight and
  // aria-activedescendant never point past the last row.
  const activeRow = visible.length ? Math.min(active, visible.length - 1) : 0;
  // A native dialog is the trap: Tab cycles inside it, the backdrop blocks the
  // app behind, and focus returns to whatever opened the palette on close.
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (s.paletteOpen) {
      node.removeAttribute("data-closing");
      if (!node.open) {
        rememberDialogFocus();
        setQuery("");
        setActive(0);
        node.showModal();
      }
      return;
    }
    if (!node.open) return;
    const cleanup = closeDialog(node);
    return cleanup;
  }, [s.paletteOpen]);
  // Arrowing past the visible rows must scroll them into view.
  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [activeRow, query]);
  const choose = (command: Command) => {
    s.setPaletteOpen(false);
    if (!command.transient) s.noteCommand(command.id);
    // The closing dialog returns focus to whatever opened it. A command that
    // moves focus itself has to run after that restore, or loses focus.
    if (command.defer) afterDialogRestore(command.run);
    else command.run();
  };
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Command palette"
      onClose={() => s.setPaletteOpen(false)}
      onClick={(event) => { if (event.target === event.currentTarget) s.setPaletteOpen(false); }}
    >
        <div className="palette-search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={input}
          // The result list is a listbox this field drives: the combobox wiring
          // is what announces it and the active option (same pattern as #prompt).
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={visible.length > 0}
          aria-controls={visible.length ? listId : undefined}
          aria-activedescendant={visible.length ? `${listId}-${activeRow}` : undefined}
          value={query}
          placeholder={workspace ? "Run a command, open a thread or a file…" : "Open a workspace first…"}
          aria-label="Filter commands"
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); s.setPaletteOpen(false); }
            if (event.key === "ArrowDown") { event.preventDefault(); setActive(Math.min(visible.length - 1, activeRow + 1)); }
            if (event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(0, activeRow - 1)); }
            if (event.key === "Enter" && visible[activeRow]) { event.preventDefault(); choose(visible[activeRow].item); }
          }}
        />
        <kbd>esc</kbd>
        </div>
        <ul ref={list} id={listId} role="listbox" aria-label="Commands">
          {visible.map(({ item: command, section }, index) => (
            <li key={command.id}>
              {index === 0 || visible[index - 1].section !== section ? <div className="menu-heading palette-heading" role="presentation">{section}</div> : null}
              <button type="button" id={`${listId}-${index}`} role="option" aria-selected={index === activeRow} className={index === activeRow ? "active" : ""} onMouseEnter={() => setActive(index)} onClick={() => choose(command)}>
                <span className="palette-icon" aria-hidden="true">{command.icon}</span>
                <span className="palette-label">{command.label}</span>
                {command.shortcut ? <kbd>{command.shortcut}</kbd> : index === activeRow ? <CornerDownLeft size={13} className="palette-enter" aria-hidden="true" /> : null}
              </button>
            </li>
          ))}
          {!visible.length ? <li className="muted empty-note">No matching commands</li> : null}
      </ul>
    </dialog>
  );
}
