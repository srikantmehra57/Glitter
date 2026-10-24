import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { backgroundAgents, describeAgents, describeLive, estimateTurnTokens, hasVisibleReply, trailingWork } from "../lib/agent";
import { ArrowDown, TriangleAlert, Bug, ChevronRight, CircleAlert, FlaskConical, FolderOpen, GitBranch, GitCompareArrows, GitFork, Globe2, History, LoaderCircle, PanelRight, Pencil, RotateCcw, ScanSearch, Sparkles, SquareTerminal, WifiOff, X } from "lucide-react";
import { Orb } from "./Orb";
import { BranchMenu } from "./BranchMenu";
import { FindBar } from "./FindBar";
import { TurnRail } from "./TurnRail";
import { WorkLocation } from "./WorkLocation";
import { TerminalPane } from "./TerminalPane";
import { BrowserPane } from "./BrowserPane";
import { shortcutText } from "../lib/commands";
import { EXIT_FAST_MS, usePresence, useRetained } from "../lib/presence";
import { Collapse } from "./Presence";
import { currentThread, currentWorkspace, needsGrant, needsWorkspace, turnTokens, useAppStore } from "../lib/store";
import { formatDuration, formatTokens } from "../lib/format";
import { formatTokenSpeed, readTokenSpeed } from "../lib/tokenSpeed";
import type { Thread } from "../lib/types";
import { AgentTimeline, PlanMenu, WorkingIndicator } from "./AgentTimeline";
import { ReviewDock } from "./ReviewDock";
import { defaultTier, isPeak, modelFor, tiersFor } from "../lib/effort";
import { ApprovalCard } from "./ApprovalCard";
import { Composer } from "./Composer";
import { UserInputCards } from "./UserInputCards";
import { AGENT_LABELS, type AgentId } from "../lib/types";

function Activity({ thread, closing = false }: { thread: Thread; closing?: boolean }) {
  const waiting = !!thread.pendingApproval || Boolean(thread.userInputs?.length);
  // Turns the host started (or ones already running when the thread opened) have no send time; count from when we saw them.
  const [seen] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const reported = turnTokens(thread) ?? 0;
  const estimated = estimateTurnTokens(thread.items);
  // Prefer the host's count; until it catches up, show the streamed estimate marked with "~".
  const tokens = reported >= estimated ? (reported ? `${formatTokens(reported)} tokens` : "") : `~${formatTokens(estimated)} tokens`;
  const speedReading = readTokenSpeed(thread.tokenSpeed, now);
  const speed = !closing && !waiting && !thread.cancelRequested && speedReading && !speedReading.idle ? formatTokenSpeed(speedReading.tokensPerSecond) : "";
  const meta = [formatDuration(now - (thread.turnStartedAt ?? seen)), tokens, speed].filter(Boolean).join(" · ");
  const live = useMemo(() => trailingWork(thread.items), [thread.items]);
  const label = thread.userInputs?.length ? "Waiting for your answer" : thread.pendingApproval ? "Waiting for approval" : thread.cancelRequested ? "Stopping…" : describeLive(live) ?? describeAgents(backgroundAgents(thread.items)) ?? thread.goal?.currentWork ?? "Thinking";
  const models = useAppStore((state) => state.models);
  const model = modelFor(models, thread.config ?? {});
  const tiers = tiersFor(model, thread.agentId);
  const peak = isPeak(thread.config?.effort ?? defaultTier(model, tiers), tiers);
  const agentId: AgentId = thread.agentId ?? "muse";
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId]);
  const retry = thread.retry && (!thread.activeTurnId || thread.activeTurnId === thread.retry.turnId) ? thread.retry : null;
  const retryIn = retry ? Math.max(0, Math.ceil((retry.retryAt - now) / 1000)) : 0;
  const stop = useAppStore((state) => state.stopTurn);
  return (
    <>
      <WorkingIndicator label={/retrying/i.test(thread.notice?.message ?? "") ? "Retrying" : thread.notice?.level === "warning" ? "Couldn't complete" : label} paused={waiting || thread.cancelRequested} peak={peak} meta={meta} live={live} agentId={agentId} agentName={agentName} closing={closing} />
      {retry ? (
        <div className="agent-notice info retry-notice" role="status">
          <LoaderCircle size={13} className="spin" aria-hidden="true" />
          <span>Attempt {retry.attempt} of {retry.maxAttempts} failed ({retry.reason}) · retrying{retryIn > 0 ? ` in ${retryIn}s` : "…"}</span>
          <button type="button" className="ghost-btn small" disabled={thread.cancelRequested} onClick={() => void stop()}>Stop</button>
        </div>
      ) : null}
      {thread.notice ? <div className={`agent-notice ${thread.notice.level}`} role="status"><TriangleAlert size={13} aria-hidden="true" /><span>{thread.notice.message}</span></div> : null}
    </>
  );
}

/** Agents launched by a finished turn can keep working; say so, so the thread doesn't look stopped. */
function BackgroundAgents({ thread, closing = false }: { thread: Thread; closing?: boolean }) {
  const running = useMemo(() => backgroundAgents(thread.items), [thread.items]);
  const label = describeAgents(running);
  const agentId: AgentId = thread.agentId ?? "muse";
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId]);
  if (!label) return null;
  return <WorkingIndicator label={`${label} in the background`} agentId={agentId} agentName={agentName} closing={closing} />;
}

const SUGGESTIONS = [
  { icon: ScanSearch, title: "Explain this codebase", prompt: "Give me a tour of this codebase: the architecture, the main entry points, and how the pieces fit together." },
  { icon: Bug, title: "Find and fix a bug", prompt: "Look for a likely bug in this codebase, explain the root cause, and fix it." },
  { icon: FlaskConical, title: "Add missing tests", prompt: "Find the most important untested code in this codebase and write tests for it." },
  { icon: GitCompareArrows, title: "Review my changes", prompt: "Review my uncommitted changes for bugs, edge cases, and anything I should clean up before committing." },
];

export function ThreadView() {
  const thread = useAppStore(currentThread);
  const workspace = useAppStore(currentWorkspace);
  const s = useAppStore(useShallow((state) => ({
    restoringSession: state.restoringSession,
    pendingSend: state.pendingSend,
    error: state.error,
    agents: state.agents,
    git: state.git,
    dockOpen: state.dockOpen,
    dockExpanded: state.dockExpanded,
    inspectorTab: state.inspectorTab,
    shortcutOverrides: state.shortcutOverrides,
    offline: state.offline,
    renameThread: state.renameThread,
    forkThread: state.forkThread,
    setInspectorTab: state.setInspectorTab,
    setDockOpen: state.setDockOpen,
    chooseProject: state.chooseProject,
    rebuildThread: state.rebuildThread,
    selectThread: state.selectThread,
    setSettingsOpen: state.setSettingsOpen,
    dismissError: state.dismissError,
    persistNotice: state.persistNotice,
    dismissPersistNotice: state.dismissPersistNotice,
    setComposer: state.setComposer,
    loadOlderHistory: state.loadOlderHistory,
    suggestions: state.suggestions,
    suggestionsEnabled: state.suggestionsEnabled,
    refreshSuggestions: state.refreshSuggestions,
    selectedSessionId: state.selectedSessionId,
    fileIndex: state.fileIndex,
    openViewer: state.openViewer,
  })));
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const positions = useRef(new Map<string, { top: number; follow: boolean }>());
  const [showLatest, setShowLatest] = useState(false);
  // Active plans float above the composer by default; completed plans return to their place in the thread.
  const planFloating = Boolean(thread && thread.status === "running" && thread.plan?.some((item) => item.status === "pending" || item.status === "inProgress"));
  const findOpen = useAppStore((state) => state.findOpen);
  const terminalOpen = useAppStore((state) => state.terminalOpen);
  const setTerminalOpen = useAppStore((state) => state.setTerminalOpen);
  const browserOpen = useAppStore((state) => state.browserOpen);
  const setBrowserOpen = useAppStore((state) => state.setBrowserOpen);
  const [editingTitle, setEditingTitle] = useState(false);
  const titleEditRequest = useAppStore((state) => state.titleEditRequest);
  const seenTitleEdit = useRef(titleEditRequest);
  useEffect(() => {
    if (seenTitleEdit.current === titleEditRequest) return;
    seenTitleEdit.current = titleEditRequest;
    setEditingTitle(true);
  }, [titleEditRequest]);
  const empty = !thread || thread.items.length === 0;
  const turnFault = thread?.lastOutcome === "failed" || thread?.lastOutcome === "cancelled";
  const error = s.error || (turnFault ? null : thread?.error);
  // What a banner shows while it shrinks away, after its cause has cleared.
  const shownError = useRetained(error);
  const persistNotice = useRetained(s.persistNotice);
  const viewHealth = useRetained(thread?.viewHealth);
  const viewGapAfter = useRetained(thread?.viewGap?.state === "failed" ? thread.viewGap.after : null);
  const jump = useCallback(() => {
    following.current = true;
    setShowLatest(false);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, []);
  const latest = usePresence(showLatest, EXIT_FAST_MS);
  useEffect(() => {
    const node = scroller.current;
    const id = thread?.sessionId;
    const saved = id ? positions.current.get(id) : undefined;
    following.current = saved?.follow ?? true;
    setShowLatest(!following.current);
    if (node) node.scrollTop = following.current ? node.scrollHeight : saved?.top ?? 0;
    if (positions.current.size > 30) {
      const oldest = Array.from(positions.current.keys()).slice(0, positions.current.size - 30);
      for (const key of oldest) positions.current.delete(key);
    }
  }, [thread?.sessionId]);
  useEffect(() => {
    const node = scroller.current;
    const inner = content.current;
    if (!node || !inner) return;
    const follow = () => {
      if (following.current) node.scrollTop = node.scrollHeight;
      else setShowLatest(node.scrollHeight - node.scrollTop - node.clientHeight > 80);
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [thread?.sessionId, empty]);
  const activeAgentId: AgentId = thread?.agentId ?? "muse";
  const activeAgentName = s.agents.find((agent) => agent.id === activeAgentId)?.name ?? AGENT_LABELS[activeAgentId];
  useEffect(() => { document.title = `${thread?.title ?? (workspace ? "No thread selected" : "Welcome")} · ${activeAgentName}`; }, [activeAgentName, thread?.title, workspace?.name]);

  const topTitle = thread?.title ?? (workspace ? "No thread selected" : "Welcome");
  const branch = s.git?.branch ?? thread?.hostBranch;
  const starting = !thread && workspace && s.pendingSend?.workspaceId === workspace.id ? s.pendingSend : null;
  const newThreadView = !thread || (empty && thread.status !== "running");
  const find = usePresence(Boolean(findOpen && thread && workspace && !newThreadView), EXIT_FAST_MS);
  // The live cards leave on the shared `closing` convention: presence keeps them
  // mounted for one rise-out exit instead of dropping them on the same frame.
  const activity = usePresence(Boolean(thread && thread.status === "running" && !hasVisibleReply(thread.items)));
  const background = usePresence(Boolean(thread && thread.status !== "running" && describeAgents(backgroundAgents(thread.items))));
  const refreshSuggestions = s.refreshSuggestions;
  const git = s.git;
  // Predicted starters belong to the workspace draft only. An empty thread
  // whose items have not loaded yet, and a restore still in flight, are not
  // that draft — refreshing them would spend a turn the user never sees.
  const suggestionDraft = !s.selectedSessionId && !s.restoringSession && Boolean(workspace);
  useEffect(() => {
    if (!suggestionDraft) return;
    void refreshSuggestions();
  }, [suggestionDraft, workspace?.id, git, s.fileIndex, s.suggestionsEnabled, refreshSuggestions]);
  // At launch the previous thread is reopened in the background; until it is
  // listed there is no thread yet, and offering a blank one would be a lie.
  const restoring = !thread && Boolean(s.restoringSession);
  // Same visibility the welcome card used: the draft's own stage, not an
  // opening thread, a restore, or a history failure.
  const suggestionsVisible = Boolean(workspace && newThreadView && !starting && !restoring && !thread?.opening && !thread?.historyFailed);
  // The chips fade out with the empty state instead of vanishing under the first message.
  const starters = usePresence(suggestionsVisible, EXIT_FAST_MS);
  // The empty state lifts the composer to the middle of the column. A terminal
  // opens beside the thread, so it does not change that vertical placement.
  const centered = Boolean(workspace && newThreadView && !starting);
  const aboveComposer = useMemo(() => {
    const planMenu = planFloating && thread?.plan ? <PlanMenu key={thread.sessionId} items={thread.plan} /> : null;
    const jumpRow = latest.mounted ? <div className="jump-latest-row"><button className={`jump-latest${latest.closing ? " closing" : ""}`} tabIndex={latest.closing ? -1 : undefined} onClick={jump}><ArrowDown size={13} />Jump to latest</button></div> : null;
    // Starter chips hug the composer's top edge; centred on the empty stage they read as decoration.
    if (!starters.mounted || !workspace) return planMenu || jumpRow ? <>{planMenu}{jumpRow}</> : undefined;
    const predicted = s.suggestionsEnabled && s.suggestions?.workspaceId === workspace.id ? s.suggestions : null;
    const chips: Array<{ icon?: typeof Sparkles; title: string; prompt: string }> = predicted?.items ?? SUGGESTIONS;
    const agentName = predicted?.agentId ? s.agents.find((agent) => agent.id === predicted.agentId)?.name ?? AGENT_LABELS[predicted.agentId] : null;
    return <>
      {planMenu}
      {/* A fresh prediction re-pops the chips so the swap-in is noticed. */}
      <div className={`suggestions${starters.closing ? " closing" : ""}`} key={predicted?.signature ?? "static"} inert={starters.closing}>
        {predicted ? <p className="suggestion-src">Predicted from workspace state{agentName ? ` by ${agentName}` : ""}</p> : null}
        {chips.map(({ icon: Icon = Sparkles, title, prompt }, index) => (
          <button key={title} className="suggestion" style={{ "--i": index } as CSSProperties} onClick={() => { s.setComposer(prompt); document.getElementById("prompt")?.focus(); }}>
            <Icon size={14} aria-hidden="true" />
            <span>{title}</span>
          </button>
        ))}
      </div>
      {jumpRow}
    </>;
  }, [latest.mounted, latest.closing, jump, starters.mounted, starters.closing, workspace, s.suggestionsEnabled, s.suggestions, s.agents, s.setComposer, planFloating, thread?.plan, thread?.sessionId]);
  // The title bar is the window's own strip on the shell; the panel below it is the canvas.
  return <>
    <header className="topbar" data-tauri-drag-region>
      <nav className="crumbs" aria-label="Location">
        {workspace ? <><span className="crumb-root" title={workspace.path}>{workspace.name}</span><ChevronRight size={13} className="crumb-sep" aria-hidden="true" /></> : null}
        {editingTitle && thread ? (
          <input
            className="title-edit"
            defaultValue={thread.title}
            autoFocus
            aria-label="Thread name"
            onFocus={(event) => event.target.select()}
            onBlur={(event) => { s.renameThread(thread.sessionId, event.target.value); setEditingTitle(false); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { s.renameThread(thread.sessionId, (event.target as HTMLInputElement).value); setEditingTitle(false); }
              if (event.key === "Escape") setEditingTitle(false);
            }}
          />
        ) : (
          <>
            <h1 title={thread ? `${topTitle} — double-click to rename` : topTitle} onDoubleClick={() => thread && setEditingTitle(true)}>{thread ? topTitle : workspace ? "New thread" : "Welcome"}</h1>
            {thread ? <button className="icon-btn title-rename" aria-label="Rename thread" data-tooltip="Rename" onClick={() => setEditingTitle(true)}><Pencil size={12} /></button> : null}
            {thread?.forkedFrom ? <span className="fork-chip" title={thread.forkedFrom.firstMessage ? `Started from an edited first message in ${thread.forkedFrom.title}; no earlier history` : `Branched from ${thread.forkedFrom.title}`}><GitFork size={11} aria-hidden="true" />{thread.forkedFrom.firstMessage ? "Edited from" : "Fork of"} {thread.forkedFrom.title}</span> : null}
          </>
        )}
        {thread?.status === "running" ? <span className="live-pill"><i aria-hidden="true" />Running</span> : null}
      </nav>
      <span className="grow" />
      {thread && !thread.agentId ? <button className="icon-btn topbar-action" aria-label="Fork thread" data-tooltip="Fork into a new thread" onClick={() => void s.forkThread(thread.sessionId)}><GitFork size={15} /><span>Fork</span></button> : null}
      <WorkLocation />
      {branch ? <BranchMenu branch={branch} worktree={Boolean(thread?.worktree)} locked={thread?.status === "running"} /> : null}
      {workspace ? <button className="icon-btn topbar-action" aria-label="Toggle browser" aria-pressed={browserOpen} data-tooltip="Browser" onClick={() => setBrowserOpen(!browserOpen)}><Globe2 size={15} /><span>Browser</span></button> : null}
      {workspace ? <button className="icon-btn topbar-action" aria-label="Toggle terminal" aria-pressed={terminalOpen} data-tooltip={`Terminal  ${shortcutText("terminal")}`} onClick={() => setTerminalOpen(!terminalOpen)}><SquareTerminal size={15} /><span>Terminal</span></button> : null}
      {/* One button for the side pane. Its tabs (Changes, Diff, Files, Monitor)
          choose the view; a second title-bar button for Monitor duplicated them. */}
      <button className="icon-btn topbar-action" aria-label="Toggle changes" aria-pressed={s.dockOpen} data-tooltip={`Changes  ${shortcutText("toggle-changes")}`} data-tooltip-align="end" onClick={() => {
        if (s.dockOpen) s.setDockOpen(false);
        else { s.setInspectorTab("changes"); s.setDockOpen(true); }
      }}><PanelRight size={15} /><span>Changes</span></button>
      {/* Compact widths and the expanded dock show Changes full-pane; the
          thread is still one tap away without losing the composer. */}
      {!browserOpen ? <div className="review-toggle segmented" role="group" aria-label="Thread or Changes view">
        <button aria-pressed={!s.dockOpen} onClick={() => s.setDockOpen(false)}>Thread</button>
        <button aria-pressed={s.dockOpen} onClick={() => { if (s.inspectorTab === "activity") s.setInspectorTab("changes"); s.setDockOpen(true); }}>Changes</button>
      </div> : null}
    </header>
    <main id="main-content" tabIndex={-1} className={`main ${s.dockOpen ? "" : "solo"}${s.dockExpanded && s.dockOpen ? " dock-focused" : ""}`}>
    {/* Banners grow in and shrink out, so the panel below them slides instead of jumping. */}
    <Collapse open={s.offline}>{() => <div className="banner warn" role="status"><WifiOff size={14} aria-hidden="true" /><span>You are offline. Agents can’t reach their model providers until the network returns.</span></div>}</Collapse>
    <Collapse open={Boolean(s.persistNotice)}>{() => <div className="banner warn" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>{persistNotice}</span><button className="icon-btn small" aria-label="Dismiss" onClick={s.dismissPersistNotice}><X size={13} /></button></div>}</Collapse>
    <Collapse open={Boolean(error)}>{() => <div className="banner" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>{shownError}</span>{needsGrant(shownError ?? "") && <button className="ghost-btn small" onClick={() => void s.chooseProject()}><FolderOpen size={13} />Open workspace</button>}{needsWorkspace(shownError ?? "") && <button className="ghost-btn small" onClick={() => void s.chooseProject()}><FolderOpen size={13} />Open a workspace</button>}{thread && (thread.viewGap?.state === "failed" || thread.historyFailed) && <button className="ghost-btn small" onClick={() => void s.rebuildThread()}>Retry rebuild</button>}{thread && !thread.opened && <button className="ghost-btn small" onClick={() => void s.selectThread(thread.sessionId)}>Reconnect</button>}<button className="ghost-btn small" onClick={() => s.setSettingsOpen(true)}>Settings</button><button className="icon-btn small" aria-label="Dismiss" onClick={s.dismissError}><X size={13} /></button></div>}</Collapse>
    <Collapse open={thread?.viewGap?.state === "filling"}>{() => <div className="banner info" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" /><span>Recovering dropped events…</span></div>}</Collapse>
    <Collapse open={thread?.viewGap?.state === "failed" && !error}>{() => <div className="banner" role="alert"><CircleAlert size={14} aria-hidden="true" /><span>Events after {viewGapAfter?.slice(-8)} never arrived. Retry the rebuild to replay them from the log.</span><button className="ghost-btn small" onClick={() => void s.rebuildThread()}>Retry rebuild</button></div>}</Collapse>
    <Collapse open={Boolean(thread?.viewHealth)}>{() => <div className="banner warn" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>Live updates unavailable{viewHealth?.noneReason ? ` (${viewHealth.noneReason})` : ""}. Reconnect to restore them.</span>{thread && <button className="ghost-btn small" onClick={() => void s.selectThread(thread.sessionId)}>Reconnect</button>}</div>}</Collapse>
    <div className={`review-layout${s.dockOpen ? " docked" : ""}${s.dockExpanded && s.dockOpen ? " expanded" : ""}${browserOpen ? " browser-docked" : ""}`}>
    <div className={`thread-main${centered ? " centered" : ""}`}>
    <div className="thread-transcript">
    {thread && workspace && !newThreadView ? <TurnRail key={thread.sessionId} thread={thread} scroller={scroller} /> : null}
    {find.mounted && thread ? <FindBar key={`find-${thread.sessionId}`} thread={thread} scroller={scroller} closing={find.closing} /> : null}
    {!workspace ? (
      <div className="empty welcome-stage">
        <section className="welcome-card" aria-labelledby="workspace-welcome-title">
        <span className="eyebrow">Local workspace / Endless possibilities</span>
        <h2 id="workspace-welcome-title">Open a workspace<span className="welcome-subtitle">Make room for your next idea.</span></h2>
        <p>Pick a folder. An agent can plan, edit files, and run commands inside it.</p>
        <button className="primary lg" onClick={() => void s.chooseProject()}><FolderOpen size={15} />Open a workspace<kbd>{shortcutText("open-workspace")}</kbd></button>
        </section>
      </div>
    ) : starting ? (
      // The first message of a new thread, shown at once while its session starts.
      <div className="conversation" aria-label="Agent"><div className="conversation-inner">
        <div className="timeline"><section className="run running"><article className="msg user"><div className="bubble">
          {starting.images.length ? <div className="submitted-images">{starting.images.map((image, index) => (
            <button key={`${image.name}-${index}`} type="button" className="submitted-image" aria-label={`Preview ${image.name}`} title={image.name} onClick={() => s.openViewer(starting.images, index)}>
              <img src={`data:${image.mediaType};base64,${image.base64Data}`} alt={image.name} />
            </button>
          ))}</div> : null}
          {starting.text ? <p className="pending-text">{starting.text}</p> : null}
        </div></article></section></div>
        <WorkingIndicator label="Starting thread" />
      </div></div>
    ) : newThreadView ? (
      <div className="empty welcome-stage thread-welcome">
        <section className="welcome-card" aria-labelledby="thread-welcome-title">
        {thread?.opening || restoring ? <Orb state="connecting" size={64} aria-label="Connecting" /> : null}
        <h2 id="thread-welcome-title">{thread?.opening ? "Opening thread…" : restoring ? "Restoring your last thread…" : "What should we build next?"}</h2>
        {restoring ? <p className="welcome-meta">Reconnecting to your workspace.</p> : (
          <p className="welcome-meta">
            <span className="welcome-meta-name" title={workspace.path}>{workspace.name}</span>
            {branch ? <span className="welcome-meta-branch"><GitBranch size={12} aria-hidden="true" />{branch}</span> : null}
          </p>
        )}
        {!restoring && !thread?.opening && thread?.historyFailed ? (
          <button className="primary lg" onClick={() => void s.rebuildThread()} disabled={thread.opening}><RotateCcw size={15} />Retry loading history</button>
        ) : null}
        </section>
      </div>
    ) : <div className="conversation" ref={scroller} aria-label="Agent" onScroll={() => {
        const node = scroller.current;
        if (!node) return;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        setShowLatest(!following.current);
        if (thread) positions.current.set(thread.sessionId, { top: node.scrollTop, follow: following.current });
      }}><div className="conversation-inner" ref={content} role="log" aria-label="Agent activity" aria-live="off">
        {thread && !thread.agentId && !thread.historyExhausted && thread.historyCursor ? (
          <div className="history-pager">
            <button type="button" className="ghost-btn small" disabled={thread.historyLoading} onClick={() => void s.loadOlderHistory()}>
              {thread.historyLoading ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <History size={13} aria-hidden="true" />}
              {thread.historyLoading ? "Loading older history…" : "Load older history"}
            </button>
          </div>
        ) : null}
        {thread ? <AgentTimeline thread={thread} scrollContainerRef={scroller} planFloating={planFloating} /> : null}
        <ApprovalCard />
        <UserInputCards />
        {activity.mounted && thread ? <Activity key={thread.sessionId} thread={thread} closing={activity.closing} /> : null}
        {background.mounted && thread ? <BackgroundAgents thread={thread} closing={background.closing} /> : null}
        {thread?.lastOutcome === "cancelled" && thread.status !== "running" && !thread.items.length ? <p className="muted">Turn cancelled.</p> : null}
      </div></div>}
    </div>
    <Composer above={aboveComposer} />
    </div>
    {workspace ? <BrowserPane /> : null}
    {workspace ? <TerminalPane /> : null}
    <ReviewDock />
    </div>
    </main>
  </>;
}
