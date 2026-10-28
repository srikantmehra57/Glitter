import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type DragEvent as ReactDragEvent } from "react";
import { describeError } from "../lib/errors";
import { useShallow } from "zustand/react/shallow";
import { ArrowUp, AtSign, FileText, FileUp, GitBranch, Hammer, Lock, Paperclip, Play, RotateCcw, ShieldAlert, ShieldCheck, Square, Terminal, TriangleAlert, X } from "lucide-react";
import { AGENT_LABELS, APPROVAL_DESCRIPTIONS, APPROVAL_LABELS, APPROVAL_ORDER, agentEnabled, approvalModeForAgent, type ApprovalMode, type ContextRef, type OrchestratorGoal, type Thread, type TranscriptItem } from "../lib/types";
import { defaultTier, isPeak, modelFor, tiersFor, withUnlistedModels } from "../lib/effort";
import { contextComposition, formatShare, formatTokens, humanizeModelLabel, isTauri, uid } from "../lib/format";
import { fuzzyScore } from "../lib/fuzzy";
import { listen } from "@tauri-apps/api/event";
import { acceptsBusySend, activeAgentId, activeConfig, currentThread, currentWorkspace, useAppStore } from "../lib/store";
import { runBuiltinCommand } from "../lib/commands";
import { estimateCost, formatCost } from "../lib/cost";
import { groupUsage, ledgerSlices } from "../lib/usageLedger";
import { customProviders, providerName } from "../lib/providers";
import { orchestratorFromSettings } from "../lib/orchestrator";
import { ModelPicker, modelKey } from "./ModelPicker";
import { EffortPicker } from "./EffortPicker";
import { GoalPicker, type OrchestratorOverride } from "./GoalPicker";
import { SelectMenu } from "./SelectMenu";
import { availableBuiltins, collectCandidates, customCommandInsert, continuationForEnter, currentWord, filterSlashCommands, findUniqueCompletion, indentText, isStopWord, outdentText, parseShellEscape, slashQuery } from "../lib/composerText";
import { MAX_DROP_FILES, isImageFile, refPathForDrop } from "../lib/drop";
import { EXIT_FAST_MS, usePresence } from "../lib/presence";

function filePath(file: File): string {
  const withPath = file as File & { path?: string };
  return typeof withPath.path === "string" && withPath.path ? withPath.path : file.name;
}

function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|[\s])@([^\s@]*)$/);
  if (!match || match.index == null) return null;
  return { start: match.index + match[1].length, query: match[2] };
}

function hasFileDrag(event: ReactDragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

const NO_ITEMS: TranscriptItem[] = [];
const NO_CANDIDATES: string[] = [];
/** The open thread's transcript, read on demand: the composer never subscribes to it. */
const openTranscript = (): TranscriptItem[] => currentThread(useAppStore.getState())?.items ?? NO_ITEMS;

/**
 * The composer re-renders on every keystroke and must not also re-render on every
 * streamed token. Its thread is therefore a projection of the open thread's
 * *settings and status* — values that keep their identity while the transcript
 * grows — plus one boolean about the transcript, so a stream frame changes nothing
 * this component selects.
 */
function pickComposerThread(state: Parameters<typeof currentThread>[0]) {
  const open = currentThread(state);
  if (!open) return null;
  return {
    sessionId: open.sessionId,
    agentId: open.agentId,
    status: open.status,
    opening: open.opening,
    opened: open.opened,
    configPending: open.configPending,
    snapshotPending: open.snapshotPending,
    rewindPending: open.rewindPending,
    cancelRequested: open.cancelRequested,
    lastOutcome: open.lastOutcome,
    config: open.config,
    context: open.context,
    usage: open.usage,
    skills: open.skills,
    modes: open.modes,
    queuedTurns: open.queuedTurns,
    approvalFeedback: open.approvalFeedback,
    notice: open.notice,
    configNotice: open.configNotice,
    worktree: open.worktree,
    hasItems: open.items.length > 0,
  };
}

function ComposerView({ above }: { above?: ReactNode }) {
  const s = useAppStore(useShallow((state) => ({
    booting: state.booting,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    drafts: state.drafts,
    enabledAgents: state.enabledAgents,
    defaultAgentId: state.defaultAgentId,
    defaultModel: state.defaultModel,
    defaultProviderId: state.defaultProviderId,
    defaultApprovalMode: state.defaultApprovalMode,
    defaultEffort: state.defaultEffort,
    orchestratorEnabled: state.orchestratorEnabled,
    orchestratorGoal: state.orchestratorGoal,
    orchestratorModels: state.orchestratorModels,
    agents: state.agents,
    detection: state.detection,
    models: state.models,
    modelsAgentId: state.modelsAgentId,
    agentModes: state.agentModes,
    modelsLoading: state.modelsLoading,
    modelsError: state.modelsError,
    hideAgentCapabilities: state.hideAgentCapabilities,
    confirmOpen: Boolean(state.confirmDialog),
    confirm: state.confirm,
    commitSettings: state.commitSettings,
    setSettingsOpen: state.setSettingsOpen,
    starting: state.starting,
    submitting: state.submitting,
    preview: state.preview,
    offline: state.offline,
    composer: state.composer,
    images: state.images,
    contextRefs: state.contextRefs,
    git: state.git,
    fileIndex: state.fileIndex,
    providerStatus: state.providerStatus,
    setComposer: state.setComposer,
    handoffWorktree: state.handoffWorktree,
    customCommands: state.customCommands,
    addContextRefs: state.addContextRefs,
    attachImages: state.attachImages,
    removeContextRef: state.removeContextRef,
    openViewer: state.openViewer,
    clearImages: state.clearImages,
    unqueueTurn: state.unqueueTurn,
    reclaimApprovalFeedback: state.reclaimApprovalFeedback,
    sendPrompt: state.sendPrompt,
    stopTurn: state.stopTurn,
    switchThreadAgent: state.switchThreadAgent,
    chooseAgentModel: state.chooseAgentModel,
    peekModelCatalog: state.peekModelCatalog,
    hiddenModels: state.hiddenModels,
    hiddenProviders: state.hiddenProviders,
    refreshDetection: state.refreshDetection,
    refreshModels: state.refreshModels,
    setSessionConfig: state.setSessionConfig,
    compactThread: state.compactThread,
    usageLedger: state.usageLedger,
    continueThread: state.continueThread,
    retryLast: state.retryLast,
    startHost: state.startHost,
  })));
  const thread = useAppStore(useShallow(pickComposerThread));
  const workspace = currentWorkspace(s);
  // `activeConfig` / `activeAgentId` read the thread by id; hand them just the
  // fields they use rather than the (constantly replaced) full thread list.
  const openThreads = useMemo(() => (thread ? [{ sessionId: thread.sessionId, agentId: thread.agentId, config: thread.config } as Thread] : []), [thread?.sessionId, thread?.agentId, thread?.config]);
  const config = activeConfig({ ...s, threads: openThreads });
  const agentId = activeAgentId({ ...s, threads: openThreads });
  const pickerAgents = s.agents.filter((item) => agentEnabled(s, item.id));
  const agent = s.agents.find((item) => item.id === agentId);
  const agentName = agent?.name ?? AGENT_LABELS[agentId];
  const approval = approvalModeForAgent(agentId, config.approvalMode);
  const approvalModes: ApprovalMode[] = approval === "denyUnmatched" ? ["denyUnmatched", ...APPROVAL_ORDER] : [...APPROVAL_ORDER];
  // A draft has no session to report its modes yet; the agent's catalog lists
  // them, so Build/Plan shows before the first message as well as after it.
  const agentModes = thread ? thread.modes : agentId !== "muse" ? s.agentModes[agentId]?.modes : undefined;
  const modeValue = config.mode ?? (thread ? undefined : s.agentModes[agentId]?.defaultMode);
  const capabilitiesShown = useRef(new Set<string>());
  const showCapabilities = useCallback(() => {
    void s.confirm({
      title: `${agentName} capabilities in Glitter`,
      body: `Threads, file edits, tool approvals, and the agent’s models and modes are supported.\n\nThis adapter does not support fork/export, older history paging, compaction, queued messages, ! shell commands, or Muse’s goal and background-task controls. Stop a running turn before sending another message.\n\nThese are Glitter adapter limits, rather than limits of the ${agentName} CLI. You can reopen this information from the model picker’s Agent section.`,
      confirmLabel: "Don’t show again",
      info: true,
    }).then((hide) => { if (hide) void s.commitSettings({ hideAgentCapabilities: true }); });
  }, [agentName, s.confirm, s.commitSettings]);
  useEffect(() => {
    if (agentId === "muse" || agentId === "harness" || !workspace || s.booting || s.hideAgentCapabilities || s.confirmOpen || capabilitiesShown.current.has(agentId)) return;
    capabilitiesShown.current.add(agentId);
    showCapabilities();
  }, [agentId, workspace?.id, s.booting, s.hideAgentCapabilities, s.confirmOpen, showCapabilities]);
  // Models in the store may still belong to the previous agent while the new list loads.
  const catalog = s.modelsAgentId === agentId ? s.models : [];
  // A Muse model this thread or the saved default names stays in the picker even when Muse no longer lists it.
  const models = useMemo(
    () => agentId === "muse" ? withUnlistedModels(catalog, [{ modelId: config.modelId, providerId: config.providerId }, { modelId: s.defaultModel, providerId: s.defaultProviderId }]) : catalog,
    [agentId, catalog, config.modelId, config.providerId, s.defaultModel, s.defaultProviderId],
  );
  const model = modelFor(models, config);
  // Orchestrator applies to built-in agent threads. A live session's own block
  // wins; a draft follows Settings until the model chip switches it either way.
  const settingsOrchestrator = useMemo(
    () => orchestratorFromSettings({ orchestratorGoal: s.orchestratorGoal, orchestratorModels: s.orchestratorModels }),
    [s.orchestratorGoal, s.orchestratorModels],
  );
  const orchestrator = agentId !== "harness" ? null
    : thread ? config.orchestrator ?? null
    : config.orchestrator !== undefined ? config.orchestrator
    : s.orchestratorEnabled ? settingsOrchestrator ?? null
    : null;
  const orchestratorOn = Boolean(orchestrator);
  // The next message's requested shape; Auto lets the policy decide. A new
  // thread or mode clears it, and a delivered message returns it to Auto.
  const [override, setOverride] = useState<OrchestratorOverride>("auto");
  useEffect(() => { setOverride("auto"); }, [s.selectedSessionId, agentId, orchestratorOn]);
  const customProviderList = useMemo(() => customProviders(s.providerStatus ?? []), [s.providerStatus]);
  // The built-in agent is addressed by its model, the way the picker shows it.
  // Before any model resolves, the connected provider names it; with none
  // connected it is "the built-in agent" — never the code name.
  const connectedProvider = s.providerStatus?.find((row) => row.configured);
  const fallbackSpeaker = agentId === "harness"
    ? connectedProvider ? providerName(connectedProvider.id, customProviderList) : "the built-in agent"
    : agentName;
  const speaker = agentId === "harness" && model ? humanizeModelLabel(model.modelId, model.displayLabel) : fallbackSpeaker;
  const tiers = tiersFor(model, agentId);
  const fallbackTier = defaultTier(model, tiers);
  const peak = isPeak(config.effort ?? fallbackTier, tiers);
  const running = thread?.status === "running";
  const busy = s.starting || s.submitting || thread?.opening || thread?.configPending || !!thread?.snapshotPending || !!thread?.rewindPending;
  const locked = busy || running || !workspace || (!!thread && !thread.opened && !s.preview);
  // Effort choices stay available during an apply: the store merges further
  // picks into a trailing call instead of losing clicks during ACP round-trips.
  const pickerLocked = s.starting || s.submitting || thread?.opening || running || !workspace || (!!thread && !thread.opened && !s.preview) || !!thread?.snapshotPending || !!thread?.rewindPending;
  // Applying a setting locks the controls for a moment. When that is the only
  // lock, they keep their look for that long, so the toolbar does not blink.
  const settling = Boolean(thread?.configPending) && !pickerLocked;
  // Busy sends are Muse and Harness. ACP agents and preview keep the Stop-to-send lock.
  const busySend = Boolean(running && thread && acceptsBusySend(thread.agentId) && !s.preview);
  const [disposition, setDisposition] = useState<"queue" | "steer" | "replace">("queue");
  const queued = thread?.queuedTurns ?? [];
  const inputDisabled = !workspace || s.starting || s.submitting || s.offline;
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const historyCursor = useRef<{ entries: string[]; index: number; draft: string; value: string } | null>(null);
  useEffect(() => { historyCursor.current = null; }, [s.selectedWorkspaceId, s.selectedSessionId]);
  useEffect(() => {
    if (historyCursor.current?.value !== s.composer) historyCursor.current = null;
  }, [s.composer]);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const mentionTriggerRef = useRef<HTMLButtonElement>(null);
  const mentionMenuRef = useRef<HTMLUListElement>(null);
  const slashMenuRef = useRef<HTMLUListElement>(null);
  const contextControlRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const [caret, setCaret] = useState(0);
  const [picker, setPicker] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [ghostDismissed, setGhostDismissed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const empty = !s.composer.trim() && s.images.length === 0 && s.contextRefs.length === 0;
  const canContinue = Boolean(thread && thread.status !== "running" && (thread.lastOutcome === "failed" || thread.lastOutcome === "cancelled" || thread.lastOutcome === "interrupted"));
  const modelValue = model ? modelKey(model) : undefined;
  const lockReason = !workspace ? "Open a workspace to enable the composer" : running ? "Stop the current turn to change settings" : busy ? "Please wait…" : thread && !thread.opened ? "Reconnect the thread to change settings" : undefined;
  const busySendTitle = disposition === "steer" ? "Steer the running turn (Enter)" : disposition === "replace" ? "Replace the running turn (Enter)" : "Queue behind the running turn (Enter)";
  const sendTitle = !workspace ? "Open a workspace to start" : busySend ? busySendTitle : running ? "Stop" : empty ? "Type a message or attach context" : "Send (Enter)";
  const mentionListId = useId();
  const slashListId = useId();
  const context = thread?.context;
  const contextPercent = context?.windowTokens && context.usedTokens != null ? Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100)) : null;
  const composition = context ? contextComposition(context) : null;
  const threadCost = thread?.usage && model ? estimateCost(thread.usage, model.cost) : undefined;
  const todayModels = useMemo(() => {
    const now = Date.now();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const groups = groupUsage(ledgerSlices(s.usageLedger).filter((slice) => slice.at >= start.getTime() && slice.at <= now), (slice) => slice.modelId);
    const total = groups.reduce((sum, group) => sum + group.inputTokens + group.outputTokens, 0);
    return groups.filter((group) => group.inputTokens + group.outputTokens > 0).slice(0, 4).map((group, index) => {
      const tokens = group.inputTokens + group.outputTokens;
      const name = group.id.includes("/") ? group.id.slice(group.id.lastIndexOf("/") + 1) : group.id;
      return { id: group.id, label: name, tokens, share: total ? tokens / total : 0, slot: index < 5 ? index + 1 : 0, approx: group.estimatedTurns ? "≈" : "" };
    });
  }, [s.usageLedger]);
  // The host's pressure flag can lag behind (or disagree with) the real numbers, so the
  // warning follows what the user can see: only "blocked" is taken from the host as-is.
  const contextLevel = contextPercent == null ? "" : context?.pressure === "blocked" || contextPercent >= 95 ? "blocked" : contextPercent >= 80 ? "warning" : "";
  const mention = mentionQuery(s.composer, caret);
  const wantsMentions = picker || Boolean(mention && !mentionDismissed);
  const suggestions = useMemo(() => {
    // Nothing to compute (or to re-parse from the transcript) while the menu is closed.
    if (!wantsMentions) return NO_CANDIDATES;
    const files = [
      ...(s.git?.files.map((file) => file.path) ?? []),
      ...openTranscript().map((item) => {
        try { const parsed = item.args ? JSON.parse(item.args) as { path?: string } : {}; return typeof parsed.path === "string" ? parsed.path : ""; }
        catch { return ""; }
      }),
    ].filter(Boolean);
    const referencedPaths = new Set(s.contextRefs.map((ref) => ref.path));
    const known = [...new Set(files)].filter((path) => !referencedPaths.has(path));
    const knownPaths = new Set(known);
    const indexed = (s.fileIndex && s.fileIndex.workspaceId === workspace?.id ? s.fileIndex.paths : []).filter((path) => !knownPaths.has(path) && !referencedPaths.has(path));
    const query = mention?.query ?? "";
    // Empty query keeps the recent/git order first; a query fuzzy-ranks the
    // merged recent + workspace index lists together.
    if (!query) return [...known, ...indexed].slice(0, 8);
    return [...known, ...indexed]
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((entry): entry is { path: string; score: number } => entry.score != null)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.path)
      .slice(0, 8);
  }, [wantsMentions, s.git, s.contextRefs, s.fileIndex, workspace?.id, mention?.query, thread?.status]);
  const mentionOpen = suggestions.length > 0 && wantsMentions;

  const slash = slashQuery(s.composer, caret);
  const slashKey = slash ? slash.query : null;
  const sessionSkills = useMemo(() => thread?.skills ?? [], [thread?.skills]);
  const builtins = useMemo(() => availableBuiltins({ thread: Boolean(thread), muse: agentId === "muse", live: !s.preview }), [Boolean(thread), agentId, s.preview]);
  const slashOptions = useMemo(() => (slashKey == null ? [] : filterSlashCommands(slashKey, sessionSkills, builtins, s.customCommands)), [slashKey, sessionSkills, builtins, s.customCommands]);
  const slashOpen = slash != null && !slashDismissed && slashOptions.length > 0 && !mention && Boolean(workspace);
  // Both popups leave with a short fade, drawing the list they last showed.
  const mentionPop = usePresence(mentionOpen, EXIT_FAST_MS);
  const slashPop = usePresence(slashOpen, EXIT_FAST_MS);
  const lastMentions = useRef(suggestions);
  if (mentionOpen) lastMentions.current = suggestions;
  const lastSlash = useRef(slashOptions);
  if (slashOpen) lastSlash.current = slashOptions;
  const shellEscape = agentId === "muse" ? parseShellEscape(s.composer) : null;

  const word = useMemo(() => (focused && !ghostDismissed && !inputDisabled ? currentWord(s.composer, caret) : null), [focused, ghostDismissed, inputDisabled, s.composer, caret]);
  const wantsGhostWord = word != null && word.word.length >= 3 && !isStopWord(word.word);
  const candidates = useMemo(() => {
    // Tokenising the last sixty items is only worth doing once a word is actually
    // being completed, and not again for every letter typed after that.
    if (!wantsGhostWord) return NO_CANDIDATES;
    const texts = openTranscript().slice(-60).reverse().map((item) => item.text ?? item.fallbackText ?? "");
    const paths = [...(s.git?.files.map((file) => file.path).reverse() ?? []), ...s.contextRefs.map((ref) => ref.path).reverse()];
    return collectCandidates([...texts, ...paths]);
  }, [wantsGhostWord, s.git, s.contextRefs, thread?.status, thread?.lastOutcome]);
  const completion = wantsGhostWord && word ? findUniqueCompletion(word.word, candidates) : null;
  const ghostSuffix = completion && word ? completion.slice(word.word.length) : "";
  const showGhost = Boolean(ghostSuffix) && !mentionOpen && !slashOpen;

  useEffect(() => { setMentionIndex(0); }, [mention?.query, suggestions.length, picker]);
  useEffect(() => { setSlashIndex(0); }, [slashKey]);
  useEffect(() => {
    mentionMenuRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, mentionOpen]);
  useEffect(() => {
    slashMenuRef.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [slashIndex, slashOpen]);
  useEffect(() => {
    if (!s.composer && areaRef.current) areaRef.current.style.height = "auto";
  }, [s.composer]);
  const focusRequest = useAppStore((state) => state.composerFocus);
  useEffect(() => { if (focusRequest) areaRef.current?.focus(); }, [focusRequest]);

  useEffect(() => {
    if (!mentionOpen && !slashOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (mentionMenuRef.current?.contains(target) || slashMenuRef.current?.contains(target) || mentionTriggerRef.current?.contains(target)) return;
      setPicker(false);
      setMentionDismissed(true);
      setSlashDismissed(true);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [mentionOpen, slashOpen]);

  // Native OS drops arrive with real paths via the window drag events; the Rust
  // shell inspects them (see attachDroppedPaths). The HTML5 handlers below are
  // the browser/preview fallback, where File objects carry no usable path.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        // Each listener lands in `unlisteners` as it resolves, so a rejection
        // partway through still lets the effect cleanup release the rest.
        unlisteners.push(await listen("tauri://drag-enter", () => { if (!cancelled) setDragging(true); }));
        unlisteners.push(await listen("tauri://drag-leave", () => { if (!cancelled) setDragging(false); }));
        unlisteners.push(await listen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
          if (cancelled) return;
          setDragging(false);
          const paths = event.payload.paths ?? [];
          if (paths.length) void useAppStore.getState().attachDroppedPaths(paths);
        }));
      } catch {
        // Older shells without drag events keep the HTML5 fallback.
      }
    })();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!contextOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!contextControlRef.current?.contains(event.target as Node)) setContextOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [contextOpen]);

  const syncGhostScroll = () => {
    const area = areaRef.current;
    const mirror = mirrorRef.current;
    if (area && mirror) {
      mirror.scrollTop = area.scrollTop;
      mirror.scrollLeft = area.scrollLeft;
    }
  };

  const resize = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    syncGhostScroll();
  };

  const applyEdit = (next: string, selStart: number, selEnd?: number, restoreFocus = true) => {
    const end = selEnd ?? selStart;
    s.setComposer(next);
    setCaret(selStart);
    requestAnimationFrame(() => {
      const el = areaRef.current;
      if (!el) return;
      el.selectionStart = Math.min(selStart, next.length);
      el.selectionEnd = Math.min(end, next.length);
      resize(el);
      if (restoreFocus) el.focus();
    });
  };

  const addPath = (path: string) => {
    const ref: ContextRef = { id: uid(), kind: path.endsWith("/") ? "folder" : "file", path };
    s.addContextRefs([ref]);
    setPicker(false);
    setMentionDismissed(true);
    if (mention && areaRef.current) {
      const next = `${s.composer.slice(0, mention.start)}${s.composer.slice(caret)}`.replace(/  +/g, " ");
      s.setComposer(next);
      areaRef.current.focus();
    }
  };

  const acceptMention = (index: number) => {
    const path = suggestions[Math.min(Math.max(index, 0), suggestions.length - 1)];
    if (path) addPath(path);
  };

  const acceptSlash = (index: number) => {
    const current = slashQuery(s.composer, caret);
    const command = slashOptions[Math.min(Math.max(index, 0), slashOptions.length - 1)];
    if (!current || !command) return;
    setSlashDismissed(true);
    // Built-ins act at once and leave the draft as it was without the command.
    // Skills stay typed (`/selector args`) so submit invokes them for real;
    // macros expand to their prompt text as before.
    if (command.kind === "custom") {
      // The template lands as plain text with the caret where the user's own words go.
      const insert = customCommandInsert(command.body);
      applyEdit(`${s.composer.slice(0, current.start)}${insert.text}${s.composer.slice(caret)}`, current.start + insert.caret);
      return;
    }
    const opensPicker = command.kind === "builtin" && ["model", "effort", "permissions"].includes(command.name);
    // Updating the draft must not take focus back from the picker it opens.
    if (command.kind === "builtin") applyEdit(`${s.composer.slice(0, current.start)}${s.composer.slice(caret)}`, current.start, undefined, !opensPicker);
    const insert = command.kind === "skill" ? `/${command.name} ` : command.kind === "macro" ? command.prompt : runBuiltinCommand(command.name) ?? "";
    if (command.kind === "builtin" && !insert) return;
    applyEdit(`${s.composer.slice(0, current.start)}${insert}${s.composer.slice(caret)}`, current.start + insert.length);
  };

  const acceptGhost = () => {
    if (!word || !ghostSuffix || !areaRef.current) return;
    applyEdit(s.composer.slice(0, word.end) + ghostSuffix + s.composer.slice(word.end), word.end + ghostSuffix.length);
  };

  const ingestFiles = (files: FileList | File[]) => {
    const list = Array.from(files);
    const capped = list.slice(0, MAX_DROP_FILES);
    const images = capped.filter((file) => isImageFile(file));
    const others = capped.filter((file) => !isImageFile(file));
    if (images.length) void s.attachImages(images);
    if (others.length) {
      const root = workspace?.path;
      s.addContextRefs(others.map((file) => ({ id: uid(), kind: "file", path: refPathForDrop(filePath(file), root) })));
    }
    if (list.length > MAX_DROP_FILES) useAppStore.setState({ error: `Only the first ${MAX_DROP_FILES} files were attached.` });
  };


  const statusText = s.offline ? "Offline — reconnect to send" : s.starting ? "Starting thread…" : thread?.opening ? "Opening thread…" : thread?.configPending ? "Applying thread settings…" : thread?.configNotice ?? null;

  const setOrchestratorMode = (enabled: boolean) => {
    if (!enabled) { void s.setSessionConfig({ orchestrator: null }); return; }
    // Incomplete roles cannot route a turn: the model chip leads to Settings.
    if (!settingsOrchestrator) { s.setSettingsOpen(true, "Orchestrator"); return; }
    void s.setSessionConfig({ orchestrator: settingsOrchestrator });
  };
  const chooseGoal = (goal: OrchestratorGoal) => {
    const current = orchestrator ?? settingsOrchestrator;
    if (!current) return;
    void s.setSessionConfig({ orchestrator: { ...current, goal } });
  };
  /** Send with the queued per-message shape, then return the control to Auto. */
  const submit = async (options?: { disposition?: "queue" | "steer" | "replace" }) => {
    // A steer joins the running turn, which keeps its route: hold the shape for the next message.
    const shape = orchestratorOn && override !== "auto" && options?.disposition !== "steer" ? override : undefined;
    const sent = await s.sendPrompt({ ...(options?.disposition ? { disposition: options.disposition } : {}), ...(shape ? { shape } : {}) });
    if (sent && shape) setOverride("auto");
  };

  return (
    <div className="composer-wrap">
      {above}
      {/* A quiet border pulse follows the running turn. */}
      <div className={`composer-beam ${running ? "active" : ""} ${peak ? "peak" : ""}`}>
        <div
          className={`composer ${running ? "running" : ""} ${!workspace ? "disabled" : ""} ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => {
            if (isTauri() || !hasFileDrag(event)) return;
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => {
            if (isTauri() || !hasFileDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            if (isTauri() || !hasFileDrag(event)) return;
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={(event) => {
            dragDepth.current = 0;
            setDragging(false);
            if (isTauri() || !hasFileDrag(event)) return;
            event.preventDefault();
            if (event.dataTransfer.files.length) ingestFiles(event.dataTransfer.files);
          }}
        >
          <div className="composer-status" role="status">
            {!s.booting && (s.modelsError || (!s.modelsLoading && !s.models.length)) ? <span className="status-issue"><span>{s.modelsError || "No models found."}</span><button className="ghost-btn small" onClick={() => void (agentId === "muse" ? s.startHost() : s.refreshModels()).catch((error) => useAppStore.setState({ modelsError: describeError(`Could not load ${agentName} models`, error) }))}>Retry</button></span> : null}
            {canContinue && !thread?.hasItems ? <span className="status-actions">
              <button className="ghost-btn small" onClick={() => void s.continueThread()}><Play size={11} />Continue</button>
              <button className="ghost-btn small" onClick={() => void s.retryLast()}><RotateCcw size={11} />Retry last prompt</button>
            </span> : null}
            {thread?.notice && !running ? <span className={`status-notice ${thread.notice.level}`}><TriangleAlert size={11} aria-hidden="true" />{thread.notice.message}</span> : null}
            {statusText ? <span>{statusText}</span> : null}
          </div>
          {thread?.worktree ? <p className="work-location" title={thread.worktree.path}><GitBranch size={12} aria-hidden="true" />Worktree on <code>{thread.worktree.branch}</code>, started from {thread.worktree.base}. <button type="button" className="text-btn" disabled={running || busy} title="Apply this worktree's changes to the workspace folder" onClick={() => void s.handoffWorktree()}>Apply to Local</button></p> : null}
          {dragging ? (
            <div className="drop-hint" aria-hidden="true">
              <FileUp size={20} />
              <strong>Drop to attach</strong>
              <span>Images attach inline · other files become @references</span>
            </div>
          ) : null}
          {s.contextRefs.length || s.images.length ? <div className="attachments">
            {s.contextRefs.map((ref) => (
              <span key={ref.id} className="attachment" title={ref.path}>
                <FileText size={12} aria-hidden="true" />
                <span>{ref.path.split("/").pop()}</span>
                <button type="button" className="attachment-x" aria-label={`Remove ${ref.path}`} disabled={s.submitting} onClick={() => s.removeContextRef(ref.id)}><X size={11} /></button>
              </span>
            ))}
            {s.images.map((image, index) => (
              <figure key={`${image.name}-${index}`} className="thumb" title={image.name}>
                <button type="button" className="thumb-open" aria-label={`Preview ${image.name}`} onClick={() => s.openViewer(s.images, index)}>
                  <img src={`data:${image.mediaType};base64,${image.base64Data}`} alt={image.name} />
                </button>
                <button type="button" className="thumb-remove" aria-label={`Remove ${image.name}`} disabled={s.submitting} onClick={() => useAppStore.setState((state) => ({ images: state.images.filter((_, i) => i !== index) }))}><X size={11} /></button>
              </figure>
            ))}
            {s.images.length > 1 ? <button type="button" className="ghost-btn small" disabled={s.submitting} onClick={s.clearImages}>Clear images</button> : null}
          </div> : null}
          {queued.length ? <div className="queued-strip" role="list" aria-label="Queued turns">
            {queued.map((entry, index) => (
              <span key={entry.turnId} className="queued-item" role="listitem" title={entry.text}>
                <span className="queued-tag">Queued{queued.length > 1 ? ` ${index + 1}` : ""}</span>
                <span className="queued-text">{entry.text || "(images)"}</span>
                <button type="button" className="attachment-x" aria-label={`Reclaim queued message ${index + 1}`} title="Reclaim before it runs" onClick={() => void s.unqueueTurn(entry.turnId)}><X size={11} /></button>
              </span>
            ))}
          </div> : null}
          {thread?.approvalFeedback?.length ? <div className="feedback-queue" aria-label="Denial feedback" role="status">
            {thread.approvalFeedback.map((entry) => <div key={entry.id}>
              <span>{entry.state === "queued" ? "Feedback queued until this turn finishes" : entry.state === "sending" ? "Sending feedback…" : entry.error ?? "Feedback was not sent"}</span>
              <p>{entry.text}</p>
              {entry.state !== "sending" ? <button type="button" className="ghost-btn small" onClick={() => s.reclaimApprovalFeedback(thread.sessionId, entry.id)}>Move feedback to draft</button> : null}
            </div>)}
          </div> : null}
          <label className="visually-hidden" htmlFor="prompt">Message {agentName}</label>
          <div className="composer-input">
            <div ref={mirrorRef} className="ghost-mirror" aria-hidden="true">
              {s.composer.slice(0, caret)}
              {showGhost ? <span className="ghost-suffix">{ghostSuffix}</span> : null}
              {s.composer.slice(caret)}
              {"\u200b"}
            </div>
            <textarea
              id="prompt"
              ref={areaRef}
              // The mention and slash popups are listboxes this field drives:
              // the combobox wiring is what announces them and the active option.
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={mentionOpen || slashOpen}
              aria-controls={mentionOpen ? (slashOpen ? `${mentionListId} ${slashListId}` : mentionListId) : slashOpen ? slashListId : undefined}
              aria-activedescendant={mentionOpen ? `${mentionListId}-${mentionIndex}` : slashOpen ? `${slashListId}-${slashIndex}` : undefined}
              value={s.composer}
              disabled={inputDisabled}
              placeholder={!workspace ? "Open a workspace to start" : busySend ? disposition === "steer" ? "Steer the running turn…" : disposition === "replace" ? "Replace the running turn…" : "Queue a follow-up — runs when this turn finishes…" : running ? `${speaker} is working — Stop to send a new message` : thread?.hasItems ? "Ask a follow-up…" : `Ask ${speaker} to plan, edit, or run anything in ${workspace.name}`}
              rows={1}
              onChange={(event) => {
                historyCursor.current = null;
                s.setComposer(event.target.value);
                setCaret(event.target.selectionStart);
                setMentionDismissed(false);
                setSlashDismissed(false);
                setGhostDismissed(false);
                resize(event.target);
              }}
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onClick={(event) => setCaret(event.currentTarget.selectionStart)}
              onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
              onScroll={syncGhostScroll}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onPaste={(event) => {
                const files: File[] = [];
                if (event.clipboardData.files.length) files.push(...Array.from(event.clipboardData.files));
                else {
                  for (const item of Array.from(event.clipboardData.items)) {
                    if (item.kind !== "file") continue;
                    const file = item.getAsFile();
                    if (file) files.push(file);
                  }
                }
                if (files.length) {
                  event.preventDefault();
                  ingestFiles(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (mentionOpen) {
                    event.preventDefault();
                    setPicker(false);
                    setMentionDismissed(true);
                    return;
                  }
                  if (slashOpen) {
                    event.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                  if (showGhost) {
                    event.preventDefault();
                    setGhostDismissed(true);
                    return;
                  }
                  // Nothing left to dismiss: Esc is the Stop button's shortcut, as its tooltip says.
                  if (running && !thread?.cancelRequested) {
                    event.preventDefault();
                    void s.stopTurn();
                  }
                  return;
                }
                if ((event.key === "ArrowDown" || event.key === "ArrowUp") && (mentionOpen || slashOpen)) {
                  event.preventDefault();
                  const delta = event.key === "ArrowDown" ? 1 : -1;
                  if (mentionOpen) setMentionIndex((index) => (index + delta + suggestions.length) % suggestions.length);
                  else setSlashIndex((index) => (index + delta + slashOptions.length) % slashOptions.length);
                  return;
                }
                if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !wantsMentions && !slashOpen && !contextOpen
                  && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
                  && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  const el = event.currentTarget;
                  const up = event.key === "ArrowUp";
                  const boundary = up ? !el.value.slice(0, el.selectionStart).includes("\n") : !el.value.slice(el.selectionEnd).includes("\n");
                  if (boundary && el.selectionStart === el.selectionEnd && workspace) {
                    let cursor = historyCursor.current;
                    if (!cursor && up) {
                      const entries = useAppStore.getState().promptHistory[workspace.id] ?? [];
                      if (entries.length) cursor = { entries, index: entries.length, draft: el.value, value: el.value };
                    }
                    if (cursor) {
                      event.preventDefault();
                      cursor.index = Math.max(0, Math.min(cursor.entries.length, cursor.index + (up ? -1 : 1)));
                      cursor.value = cursor.entries[cursor.index] ?? cursor.draft;
                      historyCursor.current = cursor;
                      setMentionDismissed(true);
                      setSlashDismissed(true);
                      setGhostDismissed(true);
                      applyEdit(cursor.value, up ? 0 : cursor.value.length);
                      return;
                    }
                  }
                }
                if (event.key === "Tab") {
                  if (mentionOpen && suggestions.length) {
                    event.preventDefault();
                    acceptMention(mentionIndex);
                    return;
                  }
                  if (slashOpen && slashOptions.length) {
                    event.preventDefault();
                    acceptSlash(slashIndex);
                    return;
                  }
                  // WCAG 2.1.2 (No Keyboard Trap, Level A). Tab must be able to
                  // leave this field. It is only claimed by explicit editing
                  // gestures — a pending ghost completion, or text that is actually
                  // selected. Otherwise Tab moves focus normally and Send/Stop/attach
                  // stay reachable by keyboard alone. Every Tab-capturing state has
                  // a one-keystroke exit: Escape dismisses the ghost and the popups.
                  const el = event.currentTarget;
                  if (showGhost && word && el.selectionStart === el.selectionEnd && el.selectionStart === word.end) {
                    event.preventDefault();
                    acceptGhost();
                    return;
                  }
                  const hasSelection = el.selectionStart !== el.selectionEnd;
                  if (!hasSelection) return;
                  event.preventDefault();
                  if (event.shiftKey) {
                    const edit = outdentText(el.value, el.selectionStart, el.selectionEnd);
                    applyEdit(edit.text, edit.start, edit.end);
                  } else {
                    const edit = indentText(el.value, el.selectionStart, el.selectionEnd);
                    applyEdit(edit.text, edit.start, edit.end);
                  }
                  return;
                }
                if (event.key === "ArrowRight" && showGhost && word && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
                  && event.currentTarget.selectionStart === event.currentTarget.selectionEnd && event.currentTarget.selectionStart === word.end) {
                  event.preventDefault();
                  acceptGhost();
                  return;
                }
                if (event.key === "Enter" && event.shiftKey) {
                  event.preventDefault();
                  const el = event.currentTarget;
                  const base = el.value.slice(0, el.selectionStart) + el.value.slice(el.selectionEnd);
                  const edit = continuationForEnter(base, el.selectionStart);
                  applyEdit(edit.text, edit.start, edit.end);
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                  if (mentionOpen && suggestions.length) {
                    event.preventDefault();
                    acceptMention(mentionIndex);
                    return;
                  }
                  if (slashOpen && slashOptions.length) {
                    event.preventDefault();
                    acceptSlash(slashIndex);
                    return;
                  }
                  event.preventDefault();
                  if (!running && !busy) void submit();
                  else if (busySend && !busy) void submit({ disposition });
                }
              }}
            />
          </div>
          {mentionPop.mounted ? (
            <ul ref={mentionMenuRef} id={mentionListId} className={`menu mention-list${mentionPop.closing ? " closing" : ""}`} role="listbox" aria-label="File references">
              <li className="menu-heading">Reference a file</li>
              {lastMentions.current.map((path, index) => (
                <li key={path}>
                  <button
                    type="button"
                    id={`${mentionListId}-${index}`}
                    role="option"
                    aria-selected={index === mentionIndex}
                    className={index === mentionIndex ? "active" : ""}
                    onMouseEnter={() => setMentionIndex(index)}
                    onMouseDown={(event) => { event.preventDefault(); acceptMention(index); }}
                  >
                    <FileText size={13} aria-hidden="true" />
                    <span className="mention-name">{path.split("/").pop()}</span>
                    <span className="mention-path">{path}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {slashPop.mounted ? (
            <ul ref={slashMenuRef} id={slashListId} className={`menu mention-list slash-list${slashPop.closing ? " closing" : ""}`} role="listbox" aria-label="Slash commands">
              <li className="menu-heading">Commands</li>
              {lastSlash.current.map((command, index) => (
                <li key={`${command.kind}:${command.name}`}>
                  <button
                    type="button"
                    id={`${slashListId}-${index}`}
                    role="option"
                    aria-selected={index === slashIndex}
                    className={index === slashIndex ? "active" : ""}
                    onMouseEnter={() => setSlashIndex(index)}
                    onMouseDown={(event) => { event.preventDefault(); acceptSlash(index); }}
                  >
                    <Terminal size={13} aria-hidden="true" />
                    <span className="mention-name">/{command.name}</span>
                    {command.kind === "skill" && command.argumentHint ? <span className="slash-args">{command.argumentHint}</span> : null}
                    <span className="mention-path">{command.kind === "skill" ? `Skill · ${command.hint}` : command.kind === "custom" ? `Custom · ${command.hint}` : command.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className={`composer-foot${settling ? " settling" : ""}`}>
            <div className="composer-tools">
            <button className="icon-btn" aria-label="Attach files" data-tooltip-side="top" data-tooltip-align="start" data-tooltip={!workspace ? "Open a workspace to attach files" : "Attach files or images — or drag & drop / paste them"} disabled={!workspace || s.submitting || s.starting} onClick={() => fileRef.current?.click()}><Paperclip size={15} /></button>
            <input ref={fileRef} type="file" accept="image/*,*/*" hidden multiple onChange={(event) => {
              if (event.target.files) ingestFiles(event.target.files);
              event.target.value = "";
            }} />
            <button ref={mentionTriggerRef} className="icon-btn" aria-label="Add file reference" data-tooltip-side="top" data-tooltip-align="start" data-tooltip="Reference a file  @" aria-pressed={picker} disabled={!workspace || s.submitting} onClick={() => { setMentionDismissed(false); setPicker((open) => !open); }}><AtSign size={15} /></button>
            </div>
            <div className="composer-settings">
            {shellEscape ? <span className="shell-chip" role="status" title={`Shell command: runs in ${workspace?.path ?? "the workspace"} and streams output into the thread`}><Terminal size={13} aria-hidden="true" />Shell command</span> : null}
            <ModelPicker
              models={models}
              agentId={agentId}
              agents={pickerAgents}
              customProviders={customProviderList}
              agentDisabled={Boolean(busy || running || !workspace)}
              value={modelValue}
              loading={s.modelsLoading || s.modelsAgentId !== agentId || s.booting}
              disabled={Boolean(pickerLocked)}
              applying={Boolean(thread?.configPending)}
              title={thread?.configPending ? "Applying your last change…" : lockReason}
              hidden={s.hiddenModels}
              hiddenProviders={s.hiddenProviders}
              onChange={(next) => void s.setSessionConfig({ modelId: next.modelId, providerId: next.providerId })}
              onChooseOther={(id, next) => void s.chooseAgentModel(id, next)}
              loadCatalog={s.peekModelCatalog}
              onRescan={async () => { await s.refreshDetection(); await s.refreshModels(true); }}
              onShowCapabilities={agentId !== "muse" && agentId !== "harness" ? showCapabilities : undefined}
              onManageModels={() => s.setSettingsOpen(true, "Models")}
              onManageProviders={() => s.setSettingsOpen(true, "Providers")}
              orchestrator={agentId === "harness" ? orchestrator : undefined}
              orchestratorReady={Boolean(settingsOrchestrator)}
              onOrchestratorChange={agentId === "harness" ? setOrchestratorMode : undefined}
              onManageOrchestrator={() => s.setSettingsOpen(true, "Orchestrator")}
            />
            {/* Orchestrator replaces effort with its goal in the same footprint. */}
            {orchestrator ? (
              <GoalPicker
                goal={orchestrator.goal}
                override={override}
                disabled={Boolean(pickerLocked)}
                applying={Boolean(thread?.configPending)}
                onGoal={chooseGoal}
                onOverride={setOverride}
              />
            ) : model && tiers.length && fallbackTier && !(s.modelsLoading && s.modelsAgentId !== agentId) ? (
              <EffortPicker
                key={`${agentId}:${modelValue ?? ""}`}
                value={config.effort}
                tiers={tiers}
                fallback={fallbackTier}
                disabled={Boolean(pickerLocked)}
                applying={Boolean(thread?.configPending)}
                onChange={(effort) => void s.setSessionConfig({ effort })}
              />
            ) : null}
            {/* One permission menu for every agent. The app decides for every model. */}
            <div className={`selector-chip${approval === "allowAll" ? " danger" : ""}`} title={lockReason ?? "Permissions"}>
              <SelectMenu
                id="approval"
                icon={approval === "allowAll" ? <TriangleAlert size={13} aria-hidden="true" /> : approval === "guarded" ? <ShieldAlert size={13} aria-hidden="true" /> : approval === "denyUnmatched" ? <Lock size={13} aria-hidden="true" /> : <ShieldCheck size={13} aria-hidden="true" />}
                ariaLabel="Permissions"
                heading="Permissions"
                className="approval-select"
                value={approval}
                placeholder="Permissions"
                options={approvalModes.map((mode) => ({
                  value: mode,
                  label: APPROVAL_LABELS[mode],
                  description: APPROVAL_DESCRIPTIONS[mode],
                  icon: mode === "allowAll" ? <TriangleAlert size={15} aria-hidden="true" /> : mode === "denyUnmatched" ? <Lock size={15} aria-hidden="true" /> : mode === "guarded" ? <ShieldAlert size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />,
                  ...(mode === "allowAll" ? { tone: "danger" as const } : {}),
                }))}
                disabled={locked}
                onChange={(value) => void s.setSessionConfig({ approvalMode: value as ApprovalMode })}
              />
            </div>
            {agentModes?.length ? (
              <div className="selector-chip" title={lockReason ?? `${agentName} mode`}>
                <SelectMenu
                  id="agent-mode"
                  icon={<Hammer size={13} aria-hidden="true" />}
                  ariaLabel={`${agentName} mode`}
                  heading={`${agentName} mode`}
                  value={modeValue}
                  placeholder="Mode"
                  options={agentModes.map((mode) => ({ value: mode.value, label: mode.name ? mode.name.charAt(0).toUpperCase() + mode.name.slice(1) : mode.value, description: mode.description }))}
                  disabled={locked}
                  onChange={(value) => void s.setSessionConfig({ mode: value })}
                />
              </div>
            ) : null}
            </div>
            <div className="composer-actions">
            {showGhost ? <span className="ghost-hint" aria-hidden="true"><kbd>Tab</kbd> to complete</span> : null}
            {busySend && !empty ? <SelectMenu
              id="busy-disposition"
              icon={<Play size={13} aria-hidden="true" />}
              ariaLabel="What to do with this message while a turn runs"
              value={disposition}
              placeholder="Queue"
              options={[
                { value: "queue", label: "Queue next", description: "Run after the current turn finishes" },
                { value: "steer", label: "Steer turn", description: "Fold into the running turn" },
                { value: "replace", label: "Replace turn", description: "Interrupt and start over", tone: "danger" },
              ]}
              onChange={(value) => setDisposition(value as "queue" | "steer" | "replace")}
            /> : null}
            {context && contextPercent != null ? (
              <div ref={contextControlRef} className={`context-control ${contextOpen ? "open" : ""}`}>
                <button
                  type="button"
                  className={`context-meter ${contextLevel}`}
                  aria-label={`Context window: ${contextPercent}% used`}
                  aria-expanded={contextOpen}
                  aria-controls="context-details"
                  onClick={() => setContextOpen((open) => !open)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setContextOpen(false);
                      event.currentTarget.focus();
                    }
                  }}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" className="track" /><circle cx="8" cy="8" r="6" className="fill" strokeDasharray={`${(contextPercent / 100) * 37.7} 37.7`} /></svg>
                  <span>{contextPercent}%</span>
                </button>
                <div id="context-details" className={`context-popover ${contextLevel}`} role="tooltip">
                  <div className="context-pop-head"><span>Context window</span><strong>{formatTokens(context.usedTokens ?? 0)}/{formatTokens(context.windowTokens ?? 0)} ({formatShare(context.usedTokens ?? 0, context.windowTokens ?? 0)})</strong></div>
                  <div className="context-bar" aria-hidden="true">
                    {composition?.partitioned ? composition.parts.map((part) => <span key={part.id} data-part={part.id} style={{ width: `${((part.tokens / (context.windowTokens ?? 1)) * 100)}%` }} />) : <span data-part="used" style={{ width: `${contextPercent}%` }} />}
                  </div>
                  {composition?.parts.length ? <ul className="context-parts">
                    {composition.parts.map((part) => <li key={part.id}><i className="context-dot" data-part={part.id} aria-hidden="true" /><span>{part.label}</span><span title={part.tokens.toLocaleString("en-US")}>{composition.partitioned ? formatShare(part.tokens, context.usedTokens ?? 0) : formatTokens(part.tokens)}</span></li>)}
                  </ul> : null}
                  {composition?.hitRate != null || (threadCost != null && model) ? <div className="context-group">
                    {composition?.hitRate != null ? <div className="context-rate"><span>Average cache hit rate</span><strong>{formatShare(composition.hitRate, 1)}</strong></div> : null}
                    {threadCost != null && model ? <div className="context-rate"><span>Est. cost</span><strong title={`Estimated from reported usage at ${humanizeModelLabel(model.modelId, model.displayLabel)} rates`}>{formatCost(threadCost, model.cost?.currency)}</strong></div> : null}
                  </div> : null}
                  {todayModels.length ? <div className="context-group">
                    <div className="context-pop-head"><span>Today</span></div>
                    <div className="context-today">
                      {todayModels.map((item) => (
                        <div key={item.id} className="context-today-model">
                          <span className="context-today-name">{item.label}</span>
                          <span className="context-today-meta">{item.approx}{formatTokens(item.tokens)} · {formatShare(item.share, 1)}</span>
                          <span className="context-today-bar" data-slot={item.slot} aria-hidden="true"><span style={{ width: `${Math.min(100, item.share * 100)}%` }} /></span>
                        </div>
                      ))}
                    </div>
                  </div> : null}
                  {contextLevel ? <span className={`context-pressure ${contextLevel}`}><TriangleAlert size={12} aria-hidden="true" />{contextLevel === "blocked" ? "Context limit reached. Compact or start a new thread to continue." : "Context is getting full. Older turns may be compacted."}</span> : null}
                  {thread && !thread.agentId && !s.preview ? <button type="button" className="ghost-btn small context-compact" disabled={thread.status === "running"} title={thread.status === "running" ? "Compact when the turn finishes" : "Compact this thread's context now"} onClick={() => { setContextOpen(false); void s.compactThread(); }}>Compact now</button> : null}
                </div>
              </div>
            ) : null}
            {running ? <>{busySend && !empty ? <button className="send" disabled={busy || s.offline} aria-label={sendTitle} title={sendTitle} onClick={() => void submit({ disposition })}><ArrowUp size={16} strokeWidth={2.4} /></button> : null}<button className="send stop" aria-label="Stop" title="Stop  Esc" disabled={thread?.cancelRequested} onClick={() => void s.stopTurn()}><Square size={11} fill="currentColor" /></button></>
              : <button className={`send${settling && !empty && !s.offline ? " settling" : ""}`} disabled={empty || locked || s.offline} aria-label="Send" title={sendTitle} onClick={() => void submit()}><ArrowUp size={16} strokeWidth={2.4} /></button>}
            </div>
          </div>
        </div>
        <span className="beam-ring" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Stable content above the composer keeps transcript stream updates outside this memo. */
export const Composer = memo(ComposerView);
