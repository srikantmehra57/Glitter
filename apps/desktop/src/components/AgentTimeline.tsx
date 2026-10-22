import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { describeError } from "../lib/errors";
import {
  BellRing, Bot, Brain, Check, CircleDot, ChevronRight, CircleAlert, CircleSlash, Clock3, Copy, Eye, FilePen, FileText, GitFork, Globe, Info, Layers, ListChecks,
  LoaderCircle, Maximize2, MessageCircle, Pencil, Pin, PinOff, Play, RotateCcw, Search, Send, SkipForward, SquareTerminal, Target, Undo2, Workflow, Wrench, X,
} from "lucide-react";
import { Orb } from "./Orb";
import { ACTIVITY_KINDS, agentCounts, backgroundAgents, computeVirtualWindow, estimateRunHeight, groupAgentRuns, messageRewindBoundary, parseWorkflowMessage, type AgentState, relativeToWorkspace, runSummary, showTerminalReceipt, stabilizeRuns, type AgentRun, type AgentStep, type AgentStepKind } from "../lib/agent";
import { copyText, formatArgs, formatBytes, formatDuration, formatTokens, humanizeModelLabel, humanizeProvider, humanizeToolName, shortcutLabel, summarizeArgs } from "../lib/format";
import { estimateCost, formatCost } from "../lib/cost";
import { modelFor } from "../lib/effort";
import { currentThread, useAppStore } from "../lib/store";
import { agentEnabled } from "../lib/types";
import { AGENT_LABELS, type AgentId, type PlanItem, type Thread } from "../lib/types";
import { approvalPreview } from "../lib/approvalPreview";
import { EditPreview } from "./EditPreview";
import { Markdown } from "./Markdown";
import { Collapse } from "./Presence";
import { AgentMark as ProductAgentMark, ModelIcon } from "./AgentPicker";


const LABELS: Partial<Record<AgentStepKind, [running: string, done: string]>> = {
  reasoning: ["Thinking", "Thought"],
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  search: ["Searching", "Searched"],
  command: ["Running", "Ran"],
  web: ["Looking up", "Looked up"],
  tool: ["Calling", "Called"],
  compaction: ["Compacting context", "Compacted context"],
};

function StepIcon({ kind }: { kind: AgentStepKind }) {
  const props = { size: 13, "aria-hidden": true } as const;
  switch (kind) {
    case "reasoning": return <Brain {...props} />;
    case "read": return <FileText {...props} />;
    case "edit": return <FilePen {...props} />;
    case "search": return <Search {...props} />;
    case "command": return <SquareTerminal {...props} />;
    case "web": return <Globe {...props} />;
    case "subagent": return <Bot {...props} />;
    case "workflow": return <Workflow {...props} />;
    case "compaction": return <Layers {...props} />;
    case "reminder": return <BellRing {...props} />;
    case "other": return <CircleDot {...props} />;
    default: return <Wrench {...props} />;
  }
}

function seconds(ms?: number) {
  if (ms == null) return "";
  const value = ms / 1000;
  return value < 10 ? `${Math.max(0.1, Math.round(value * 10) / 10)}s` : value < 60 ? `${Math.round(value)}s` : `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

function PlanMark({ status }: { status: PlanItem["status"] }) {
  if (status === "completed") return <span className="plan-mark done"><Check size={10} strokeWidth={3} aria-hidden="true" /></span>;
  if (status === "inProgress") return <span className="plan-mark active"><LoaderCircle size={12} className="spin" aria-hidden="true" /></span>;
  if (status === "failed") return <span className="plan-mark failed"><X size={10} strokeWidth={3} aria-hidden="true" /></span>;
  if (status === "cancelled" || status === "skipped") return <span className="plan-mark skipped"><CircleSlash size={12} aria-hidden="true" /></span>;
  return <span className="plan-mark" />;
}

/**
 * A pinned plan lives above the scroller and starts as a compact strip.
 * `live` is whether a turn is running: once it has stopped, a step the agent
 * left in progress is shown as not done, without a spinner nothing is behind.
 */
export function PlanView({ items, pinnable, pinned, onPin, live = true }: { items: PlanItem[]; pinnable?: boolean; pinned?: boolean; onPin?: (pinned: boolean) => void; live?: boolean }) {
  const [open, setOpen] = useState(!pinned);
  const [toggled, setToggled] = useState(false);
  if (!items.length) return null;
  const done = items.filter((item) => item.status === "completed").length;
  const pct = Math.round((done / items.length) * 100);
  return (
    <section className={`card plan ${pinned ? "pinned" : ""}`} aria-label="Plan">
      <div className="plan-head">
        <button type="button" className="card-head" aria-expanded={open} onClick={() => { setToggled(true); setOpen(!open); }}>
          <ListChecks size={14} aria-hidden="true" />
          <span className="card-title">Plan</span>
          <span className="plan-count">{done} of {items.length}</span>
          <span className="plan-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
          <ChevronRight size={13} className={`caret ${open ? "open" : ""}`} aria-hidden="true" />
        </button>
        {pinnable ? (
          <button type="button" className="icon-btn small plan-pin" aria-pressed={pinned} aria-label={pinned ? "Unpin plan from top" : "Pin plan to top"} data-tooltip={pinned ? "Unpin from top" : "Pin to top"} onClick={() => onPin?.(!pinned)}>
            {pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
        ) : null}
      </div>
      <Collapse open={open} animate={toggled}>{() => (
        <ol>
          {items.map((item) => {
            const status = !live && item.status === "inProgress" ? "pending" : item.status;
            return (
              <li key={item.id} className={`plan-item ${status}`}>
                <PlanMark status={status} />
                <span>{item.activeForm && status === "inProgress" ? item.activeForm : item.text}</span>
              </li>
            );
          })}
        </ol>
      )}</Collapse>
    </section>
  );
}

const OUTPUT_UNAVAILABLE: Record<string, string> = {
  missing: "no longer stored",
  unsupported: "not servable by this host",
  accessFailed: "could not be read",
};

/** Running tool tasks can move to the background or stop (`task/*`); the flip folds back onto the step. */
function TaskButtons({ step }: { step: AgentStep }) {
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const controlTask = useAppStore((s) => s.controlTask);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = step.item;
  if (!sessionId) return null;
  const run = (action: string) => {
    setBusy(true);
    setError(null);
    void controlTask(sessionId, action, item.itemId)
      .catch((cause) => setError(describeError("Could not load that", cause)))
      .finally(() => setBusy(false));
  };
  return (
    <span className="task-buttons">
      {!item.background ? <button type="button" className="agent-btn" disabled={busy} onClick={() => run("background")} title="Keep running in the background">Background</button> : null}
      {item.background ? <button type="button" className="agent-btn danger" disabled={busy} onClick={() => run("stop")} title="Stop this background task"><X size={12} />Stop task</button> : null}
      {error ? <span className="agent-error" role="alert">{error}</span> : null}
    </span>
  );
}

/** Truncated tool output offers the stored full bytes (`item/readOutput`) in a viewer. */
function FullOutputLink({ step }: { step: AgentStep }) {
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const openOutput = useAppStore((s) => s.openOutput);
  const ref = step.item.outputRef;
  if (!step.item.truncated && !ref) return null;
  if (!ref || ref.availability !== "available") {
    const reason = ref ? OUTPUT_UNAVAILABLE[ref.availability] ?? "unavailable" : "unavailable";
    return <span className="output-truncated">Output truncated · full output {reason}</span>;
  }
  return (
    <button
      type="button"
      className="output-full"
      onClick={() => { if (sessionId) void openOutput(sessionId, step.item.itemId); }}
      title={`View the full stored output (${formatBytes(ref.byteLen)})`}
    >
      <Maximize2 size={12} aria-hidden="true" />View full output · {formatBytes(ref.byteLen)}
    </button>
  );
}

/** A write that replaced an existing file shows the saved before/after. Other edits keep the preview parsed from the call arguments. */
function completedEditPreview(item: AgentStep["item"]) {
  const fromArgs = approvalPreview(item.tool ?? "", item.args);
  const meta = item.presentation;
  if (meta?.kind === "diff" && typeof meta.oldText === "string" && meta.oldText.length > 0 && typeof meta.newText === "string" && (fromArgs == null || fromArgs.kind === "write")) {
    return { kind: "replace" as const, path: meta.path, before: meta.oldText, after: meta.newText };
  }
  return fromArgs;
}

function StepRowView({ step }: { step: AgentStep }) {
  const openFile = useAppStore((state) => state.openFile);
  const setInspectorTab = useAppStore((state) => state.setInspectorTab);
  const setDockOpen = useAppStore((state) => state.setDockOpen);
  const failed = step.status === "failed";
  const running = step.status === "running";
  const labels = LABELS[step.kind];
  const verb = step.kind === "subagent" ? "Agent" : step.kind === "workflow" ? "Workflow" : step.kind === "reminder" ? "Reminder" : step.kind === "other" ? step.title : labels ? labels[running ? 0 : 1] : step.title;
  const summary = step.kind === "reasoning"
    ? (step.detail ?? "").replace(/[#*_`>]/g, "").split("\n").map((line) => line.trim()).find(Boolean) ?? ""
    : step.kind === "subagent" ? step.title
    : step.kind === "reminder" || step.kind === "other" ? (step.detail ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? ""
    : step.kind === "tool" ? humanizeToolName(step.item.tool ?? "", step.item.kind)
    : step.path || step.command || summarizeArgs(step.item.tool ?? "", step.item.args);
  const toolArgs = step.kind === "tool" ? summarizeArgs(step.item.tool ?? "", step.item.args) : "";
  const body = step.kind === "reminder" || step.kind === "other"
    ? (step.detail && step.detail.includes("\n") ? step.detail : undefined)
    : step.kind === "reasoning" || step.kind === "subagent" || step.kind === "workflow" || step.kind === "compaction"
    ? step.detail
    : step.output || step.error || (step.item.args && formatArgs(step.item.args));
  const [open, setOpen] = useState(failed);
  // Only detail the user opens or closes animates; a failed step restored open must not shift the scroll.
  const [toggled, setToggled] = useState(false);
  useEffect(() => { if (failed) setOpen(true); }, [failed]);
  const duration = seconds(step.durationMs);
  const preview = step.kind === "edit" && step.status === "completed" ? completedEditPreview(step.item) : null;
  const expandable = Boolean(body || preview);
  return (
    <li className={`step ${step.kind} ${step.status} ${open ? "open" : ""}`}>
      <span className="step-node" aria-hidden="true">
        {failed ? <CircleAlert size={13} /> : <StepIcon kind={step.kind} />}
      </span>
      <div className="step-main">
        <button type="button" className="step-head" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => { setToggled(true); setOpen(!open); }}>
          <span className={`step-verb ${running ? "shimmer" : ""}`}>{verb}</span>
          {summary && !(step.kind === "reasoning" && open) ? <span className="step-summary" title={summary}>{summary}</span> : null}
          {toolArgs ? <span className="step-args" title={toolArgs}>{toolArgs}</span> : null}
          <span className="step-meta">
            {step.item.background ? <span className="task-bg" title={step.item.backgroundInitiator ? `Backgrounded by ${step.item.backgroundInitiator}` : "Running in the background"}>background</span> : null}
            {step.item.exitCode != null && step.item.exitCode !== 0 ? <span className="exit bad">exit {step.item.exitCode}</span> : null}
            {duration ? <span>{duration}</span> : null}
            {expandable ? <ChevronRight size={12} className={`caret ${open ? "open" : ""}`} aria-hidden="true" /> : null}
          </span>
        </button>
        <Collapse open={open} animate={toggled}>{() => <>
        {preview ? <div className="step-edit">
          <EditPreview preview={preview} completed />
          <button type="button" className="ghost-btn small" onClick={() => { setInspectorTab("changes"); setDockOpen(true); }}>Open in Changes</button>
          {step.path ? <button type="button" className="ghost-btn small" onClick={() => void openFile(step.path!)}>Open file</button> : null}
          {step.output ? <details><summary>Tool output</summary><pre className="step-body">{step.output}</pre></details> : null}
        </div> : body ? (
          step.kind === "reasoning" ? <div className="thought"><Markdown>{body}</Markdown></div>
            : step.kind === "command" ? (
              <div className="terminal">
                {step.command ? <div className="terminal-cmd"><span className="prompt">$</span>{step.command}</div> : null}
                <pre>{step.output || step.error || "No output"}</pre>
                {step.item.exitCode != null ? <div className={`terminal-exit ${step.item.exitCode === 0 ? "ok" : "bad"}`}>Exit {step.item.exitCode}</div> : null}
              </div>
            )
            : <pre className={`step-body ${failed ? "failed" : ""}`}>{body}</pre>
        ) : null}
        {step.kind === "read" && step.path ? <button type="button" className="ghost-btn small step-open" onClick={() => void openFile(step.path!)}>Open file</button> : null}
        {step.item.presentation?.artifactPath ? <button type="button" className="ghost-btn small step-open" onClick={() => void openFile(step.item.presentation!.artifactPath!)}>Open saved output</button> : null}
        <FullOutputLink step={step} />
        </>}</Collapse>
        {running && (step.item.kind === "toolCall" || step.item.kind === "userShell") && !step.item.failureReason ? <TaskButtons step={step} /> : null}
      </div>
    </li>
  );
}

const StepRow = memo(StepRowView);

function ActivityGroupView({ steps, live }: { steps: AgentStep[]; live: boolean }) {
  const total = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const failed = steps.some((step) => step.status === "failed");
  const [open, setOpen] = useState(live || failed);
  // Only a group the user opens animates; one restored by the virtual list must not shift the scroll.
  const [toggled, setToggled] = useState(false);
  useEffect(() => { if (live || failed) setOpen(true); }, [live, failed]);
  const counts = useMemo(() => {
    const plural = (count: number, one: string) => (count ? `${count} ${one}${count === 1 ? "" : "s"}` : "");
    const files = new Set(steps.filter((step) => step.kind === "read" || step.kind === "edit").map((step) => step.path).filter(Boolean)).size;
    return [
      plural(steps.filter((step) => step.kind === "reasoning").length, "thought"),
      plural(steps.filter((step) => step.kind === "edit").length, "edit"),
      plural(files, "file"),
      plural(steps.filter((step) => step.kind === "command").length, "command"),
    ].filter(Boolean).join(" · ");
  }, [steps]);
  if (steps.length < 2) {
    return <ol className="steps">{steps.map((step) => <StepRow key={step.id} step={step} />)}</ol>;
  }
  return (
    <div className={`activity-group ${open ? "open" : ""}`}>
      <button type="button" className={`group-head${live ? " live" : ""}${failed ? " failed" : ""}`} aria-expanded={open} onClick={() => { setToggled(true); setOpen(!open); }}>
        <ChevronRight size={12} className={`caret ${open ? "open" : ""}`} aria-hidden="true" />
        <span className="group-title">{steps.length} steps</span>
        {counts ? <span className="group-meta">{counts}</span> : null}
        {total && !live ? <span className="group-meta">{seconds(total)}</span> : null}
      </button>
      <Collapse open={open} animate={toggled}>{() => <ol className="steps">{steps.map((step) => <StepRow key={step.id} step={step} />)}</ol>}</Collapse>
    </div>
  );
}

const ActivityGroup = memo(ActivityGroupView, (previous, next) => previous.live === next.live && previous.steps.length === next.steps.length && previous.steps.every((step, index) => step === next.steps[index]));

function MessageActions({ text, onEdit, editLabel, onRetry, retryLabel, busy }: {
  text: string;
  onEdit?: () => void;
  editLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
  busy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  if (!text && !onRetry) return null;
  return (
    <div className="msg-actions" role="toolbar" aria-label="Message actions">
      {text ? (
        <button
          type="button"
          className="icon-btn small"
          aria-label={copied ? "Copied to clipboard" : "Copy message"}
          data-tooltip={copied ? "Copied" : "Copy"}
          onClick={() => {
            void copyText(text).then((ok) => {
              if (!ok) return;
              setCopied(true);
              if (timer.current != null) window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        </button>
      ) : null}
      {onEdit ? (
        <button type="button" className="icon-btn small" aria-label={editLabel ?? "Edit message"} data-tooltip={editLabel ?? "Edit"} disabled={busy} onClick={onEdit}>
          <Pencil size={13} aria-hidden="true" />
        </button>
      ) : null}
      {onRetry ? (
        <button type="button" className="icon-btn small" aria-label={retryLabel ?? "Retry"} data-tooltip={retryLabel ?? "Retry"} disabled={busy} onClick={onRetry}>
          <RotateCcw size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** Whether the open thread is mid-turn or mid-change: a boolean, so it flips rarely instead of tracking every streamed frame. */
const selectThreadBusy = (state: Parameters<typeof currentThread>[0] & { submitting: boolean; starting: boolean }) => {
  const thread = currentThread(state);
  return thread?.status === "running" || state.submitting || state.starting || Boolean(thread?.opening) || Boolean(thread?.configPending) || Boolean(thread?.snapshotPending) || Boolean(thread?.rewindPending);
};

function UserMessageView({ step }: { step: AgentStep }) {
  const openFile = useAppStore((state) => state.openFile);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [resetFiles, setResetFiles] = useState(false);
  const [firstMessage, setFirstMessage] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const openViewer = useAppStore((state) => state.openViewer);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
  const rewindMessage = useAppStore((state) => state.rewindMessage);
  const sessionId = useAppStore((state) => state.selectedSessionId);
  const canRewind = useAppStore((state) => !currentThread(state)?.agentId);
  const canReset = useAppStore((state) => {
    const snapshot = step.item.turnId ? currentThread(state)?.snapshots?.[step.item.turnId] : undefined;
    return snapshot?.state === "ready" && snapshot.files.length > 0;
  });
  const rewindError = useAppStore((state) => {
    const error = currentThread(state)?.rewindError;
    return error?.itemId === step.id ? error.message : undefined;
  });
  const busy = useAppStore(selectThreadBusy);
  const text = step.detail ?? "";
  const resendable = Boolean(text || step.item.images?.length || step.item.refs?.length);
  useEffect(() => {
    if (!editing) return;
    const el = editRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);
  const resend = (value: string) => {
    useAppStore.setState({ composer: value, images: step.item.images ?? [], contextRefs: step.item.refs ?? [] });
    void sendPrompt({ resetTaskState: true });
  };
  const save = async () => {
    if (!draft.trim() || busy) return;
    if (canRewind && sessionId) {
      if (await rewindMessage(sessionId, step.id, draft, resetFiles)) setEditing(false);
    } else { setEditing(false); resend(draft.trim()); }
  };
  return (
    <article className="msg user" data-item={step.id}>
      <div className="bubble">
        {step.item.refs?.length ? <div className="bubble-refs">{step.item.refs.map((ref) => ref.kind === "folder"
          ? <span key={ref.id} className="attachment" title={ref.path}><FileText size={11} aria-hidden="true" />{ref.path.split("/").pop()}</span>
          : <button key={ref.id} type="button" className="attachment" title={`${ref.path} — open file`} onClick={() => void openFile(ref.path)}><FileText size={11} aria-hidden="true" />{ref.path.split("/").pop()}</button>)}</div> : null}
        {step.item.images?.length ? <div className="submitted-images">{step.item.images.map((image, index) => (
          <button key={`${image.name}-${index}`} type="button" className="submitted-image" aria-label={`Preview ${image.name}`} title={image.name} onClick={() => openViewer(step.item.images ?? [], index)}>
            <img src={`data:${image.mediaType};base64,${image.base64Data}`} alt={image.name} />
          </button>
        ))}</div> : null}
        {editing ? (
          <div className="msg-edit">
            <textarea
              ref={editRef}
              aria-label="Edit message"
              rows={3}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !busy) {
                  event.preventDefault();
                  setEditing(false);
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && draft.trim() && !busy) {
                  event.preventDefault();
                  void save();
                }
              }}
            />
            {canRewind ? <>
              <p className="msg-edit-note">{firstMessage ? "First message: starts a new thread with no earlier history." : "Creates a fork before this message. The original thread is kept."}</p>
              {canReset || resetFiles ? <label className="msg-edit-reset"><input type="checkbox" checked={resetFiles} disabled={busy} onChange={(event) => setResetFiles(event.target.checked)} />Reset files too</label> : null}
              {resetFiles ? <p className="msg-edit-note">Resets only this turn’s saved files. Other later changes remain; changed files can block the reset.</p> : null}
              {rewindError ? <p className="msg-edit-error" role="alert">{rewindError}</p> : null}
            </> : null}
            <div className="msg-edit-row">
              <button type="button" className="chip small" disabled={!draft.trim() || busy} title={canRewind ? "Send the edited message from this point in a new thread" : "Send the edited message as a new turn"} onClick={() => void save()}>{canRewind ? firstMessage ? "Start and send" : "Fork and send" : "Resend"}</button>
              <button type="button" className="ghost-btn small" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
              <span className="msg-edit-hint">{shortcutLabel("↵")} to send</span>
            </div>
          </div>
        ) : step.detail ? <Markdown>{step.detail}</Markdown> : null}
      </div>
      {!editing ? (
        <MessageActions
          text={text}
          busy={busy}
          onEdit={text ? () => {
            const thread = currentThread(useAppStore.getState());
            const boundary = thread ? messageRewindBoundary(thread, step.id) : null;
            setFirstMessage(Boolean(boundary && !("error" in boundary) && !boundary.lastTurnId));
            setResetFiles(false);
            setDraft(text);
            setEditing(true);
          } : undefined}
          editLabel={canRewind ? "Edit and rewind" : "Edit and resend"}
          onRetry={resendable ? () => resend(text) : undefined}
          retryLabel="Resend this message"
        />
      ) : null}
    </article>
  );
}

const UserMessage = memo(UserMessageView);

/** `final` marks the run's settled answer. The notes an agent writes between its steps carry no actions, so they reserve no row for them either. */
function AgentMessageView({ step, final, canRetry }: { step: AgentStep; final: boolean; canRetry: boolean }) {
  const retryLast = useAppStore((state) => state.retryLast);
  const busy = useAppStore((state) => currentThread(state)?.status === "running" || state.submitting);
  const text = step.detail ?? "";
  const agentId: AgentId = useAppStore((state) => currentThread(state)?.agentId ?? "muse");
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId]);
  return (
    <article className="msg agent" data-item={step.id}>
      <div className="agent-message-head"><ProductAgentMark id={agentId} size={18} /><span>{agentName}</span></div>
      <div className="agent-message-body"><Markdown>{text}</Markdown></div>
      {final ? <MessageActions text={text} busy={busy} onRetry={canRetry ? () => void retryLast() : undefined} retryLabel="Retry last turn" /> : null}
    </article>
  );
}

const AgentMessage = memo(AgentMessageView);

function completedTurnStats(thread: Thread | undefined, run: AgentRun, isLast: boolean) {
  const stats = thread?.turnStats;
  return isLast && thread && thread.status !== "running" && stats && stats.turnId === run.turnId
    && stats.turnId === thread.lastTurnId && !backgroundAgents(thread.items).length ? stats : undefined;
}

/**
 * Observe one stable boolean so historical runs don't subscribe to every
 * receipt action. The latest run also carries its matching usage summary.
 */
function Completion({ run, isLast }: { run: AgentRun; isLast: boolean }) {
  const hasDetails = useAppStore((state) => {
    const thread = currentThread(state);
    const snapshot = run.turnId ? thread?.snapshots?.[run.turnId] : undefined;
    const stats = completedTurnStats(thread, run, isLast);
    return Boolean(snapshot?.files.length || snapshot?.state === "unavailable" || stats);
  });
  if (run.status === "running" || run.status === "waiting") return null;
  if (run.status === "completed" ? !hasDetails && !runSummary(run).changed.length : !isLast) return null;
  return <Receipt run={run} isLast={isLast} />;
}

function ReceiptView({ run, isLast }: { run: AgentRun; isLast: boolean }) {
  const continueThread = useAppStore((state) => state.continueThread);
  const retryLast = useAppStore((state) => state.retryLast);
  const switchThreadAgent = useAppStore((state) => state.switchThreadAgent);
  const sessionId = useAppStore((state) => state.selectedSessionId);
  const workspacePath = useAppStore((state) => currentThread(state)?.workspacePath);
  const threadError = useAppStore((state) => currentThread(state)?.error);
  const agentId: AgentId = useAppStore((state) => currentThread(state)?.agentId ?? "muse");
  const grokReady = useAppStore((state) => state.agents.some((agent) => agent.id === "grok" && agent.found && agentEnabled(state, "grok")));
  const busy = useAppStore(selectThreadBusy);
  const openFileDiff = useAppStore((state) => state.openFileDiff);
  const forkThread = useAppStore((state) => state.forkThread);
  const snapshot = useAppStore((state) => run.turnId ? currentThread(state)?.snapshots?.[run.turnId] : undefined);
  const snapshotPending = useAppStore((state) => currentThread(state)?.snapshotPending);
  const snapshotError = useAppStore((state) => currentThread(state)?.snapshotError?.turnId === run.turnId ? currentThread(state)?.snapshotError?.message : undefined);
  const restoreSnapshot = useAppStore((state) => state.restoreSnapshot);
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId]);
  const stats = useAppStore((state) => completedTurnStats(currentThread(state), run, isLast));
  const costModel = useAppStore((state) => {
    const thread = currentThread(state);
    return state.modelsAgentId === (thread?.agentId ?? "muse") ? modelFor(state.models, thread?.config ?? {}) : undefined;
  });
  const turnCost = stats && costModel ? estimateCost({ promptTokens: stats.inputTokens, outputTokens: stats.outputTokens }, costModel.cost) : undefined;
  const metrics = stats ? <span className="turn-stats" aria-label="Turn usage">
    {costModel ? <span className="turn-model" title={costModel.providerId ? `${humanizeModelLabel(costModel.modelId, costModel.displayLabel)} via ${humanizeProvider(costModel.providerId)}` : undefined}><ModelIcon modelId={costModel.modelId} providerId={costModel.providerId} size={14} badge fallback={<ProductAgentMark id={agentId} size={14} />} />{humanizeModelLabel(costModel.modelId, costModel.displayLabel)}</span> : null}
    <span className="turn-duration" title="Time spent on this turn"><Clock3 size={12} aria-hidden="true" />{formatDuration(stats.durationMs)}</span>
    {stats.outputTokens ? <span title="Output tokens for this turn">{stats.estimated ? "~" : ""}{formatTokens(stats.outputTokens)} tokens</span> : null}
    {turnCost != null && costModel ? <span title="Estimated cost for this turn">≈{formatCost(turnCost, costModel.cost?.currency)}</span> : null}
  </span> : null;
  const openDiff = (raw: string) => openFileDiff(relativeToWorkspace(raw, workspacePath) ?? raw);
  if (run.status !== "completed" && !showTerminalReceipt(run.status, isLast, busy)) return null;
  const summary = runSummary(run);
  const changed = snapshot?.state === "ready" || snapshot?.state === "undone" ? snapshot.files : summary.changed;
  const fileCount = changed.length;
  const snapshotActions = <>
    {snapshot && fileCount > 0 && ["ready", "undone"].includes(snapshot.state) && sessionId && run.turnId ? <button type="button" className="ghost-btn small" disabled={busy || !!snapshotPending} title={snapshot.state === "undone" ? "Restore this turn’s saved changes" : "Restore the file state from before this turn"} onClick={() => void restoreSnapshot(sessionId, run.turnId!)}><Undo2 size={11} aria-hidden="true" />{snapshotPending === run.turnId ? "Restoring…" : snapshot.state === "undone" ? "Reapply" : "Undo"}</button> : null}
  </>;
  const snapshotMessage = snapshotError ?? (snapshot?.state === "unavailable" ? snapshot.reason ?? "No saved file state is available for this turn."
    : snapshot?.state === "undone" ? "Files restored to their state before this turn. Thread history is kept."
    : !snapshot && fileCount ? "Undo is unavailable for turns without a saved file state." : null);
  const snapshotNote = snapshotMessage ? <span className={`receipt-note${snapshotError ? " danger" : ""}`} role={snapshotError ? "alert" : undefined}><Info size={12} aria-hidden="true" /><span>{snapshotMessage}</span></span> : null;
  if (run.status === "completed") {
    if (!fileCount && snapshot?.state !== "unavailable" && !stats) return null;
    const cuttable = agentId === "muse" && run.turnId != null && !run.turnId.startsWith("local:") && run.turnId !== "history";
    return (
      <section className="receipt completed" aria-label="Done">
        <div className="receipt-head">
          <span className="receipt-status"><span className="receipt-icon"><Check size={14} strokeWidth={2.2} aria-hidden="true" /></span><strong>Done</strong></span>
          {metrics}
          <span className="receipt-actions">
            {snapshotActions}
            {cuttable && sessionId ? <button type="button" className="ghost-btn small" title="Fork the thread with history up to this turn" onClick={() => void forkThread(sessionId, run.turnId)}><GitFork size={12} aria-hidden="true" />Fork here</button> : null}
          </span>
        </div>
        {fileCount ? <div className="receipt-files"><span className="receipt-change-count">Changed {fileCount} file{fileCount === 1 ? "" : "s"}</span>{changed.slice(0, 4).map((path) => <button key={path} type="button" className="attachment attachment-btn" title={`${path} — open diff`} onClick={() => openDiff(path)}><FilePen size={11} aria-hidden="true" />{path.split("/").pop()}</button>)}{changed.length > 4 ? <span className="muted">+{changed.length - 4} more</span> : null}</div> : null}
        {snapshotNote}
      </section>
    );
  }
  const label = run.status === "cancelled" ? "Stopped" : run.status === "failed" ? "Run failed" : "Interrupted";
  const zenStuck = agentId === "opencode" && /rate limit|access is disabled|insufficient (?:account )?funds|didn't respond|stopped responding/i.test(threadError ?? "");
  const detail = run.status === "interrupted" ? `${agentName} disconnected mid-run. Completed steps are kept.`
    : run.status === "cancelled" ? "You stopped this run. Completed steps are kept."
    : threadError || "Review the last step, then retry or continue.";
  return (
    <section className={`receipt ${run.status}`} aria-label={label}>
      <span className="receipt-icon">{run.status === "failed" ? <CircleAlert size={13} aria-hidden="true" /> : <CircleSlash size={12} aria-hidden="true" />}</span>
      <span className="receipt-text"><strong>{label}</strong> <span className="muted">{detail}</span></span>
      {metrics}
      <span className="receipt-actions">
        {zenStuck && grokReady ? (
          <button className="ghost-btn small" onClick={() => void switchThreadAgent("grok").then(() => retryLast())}>Switch to Grok</button>
        ) : (
          <button className="ghost-btn small" onClick={() => void continueThread()}><Play size={11} />Continue</button>
        )}
        <button className="ghost-btn small" onClick={() => void retryLast()}><RotateCcw size={11} />Retry</button>
        {snapshotActions}
      </span>
      {snapshotNote}
    </section>
  );
}

const Receipt = memo(ReceiptView);

/**
 * One live status at a time (like Claude desktop): the working indicator under the run says
 * "Thinking", so an in-progress thought only joins the list once it's done. Host reminder
 * child sessions with nothing but the generic placeholder are bookkeeping, not work.
 */
function hiddenStep(step: AgentStep) {
  if (step.kind === "reasoning" && step.status === "running") return true;
  return step.kind === "reminder" && !step.item.text?.trim();
}

function AgentStateMark({ state }: { state: AgentState }) {
  if (state === "running") return <LoaderCircle size={13} className="spin" aria-label="Running" />;
  if (state === "completed") return <Check size={13} strokeWidth={2.6} aria-label="Done" />;
  if (state === "failed") return <CircleAlert size={13} aria-label="Failed" />;
  if (state === "cancelled") return <CircleSlash size={13} aria-label="Stopped" />;
  return <CircleDot size={13} aria-label="Waiting" />;
}

/**
 * Lifecycle controls for one child (`subagent/*`): message a runner, consume a
 * ready result, or resume/reopen/close it. Outcomes fold back onto the card.
 */
function SubagentControls({ step }: { step: AgentStep }) {
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const controlSubagent = useAppStore((s) => s.controlSubagent);
  const openChild = useAppStore((s) => s.openChild);
  const [composing, setComposing] = useState<"sendMessage" | "followupTask" | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const item = step.item;
  const subagentId = item.subagentId;
  // A harness child has no subagent lifecycle to control; its card only drills
  // into the read-only transcript.
  if (item.readOnly) {
    return sessionId && item.childSessionId ? (
      <div className="agent-controls">
        <div className="agent-buttons" role="toolbar" aria-label="Subagent controls">
          <button type="button" className="agent-btn" onClick={() => void openChild(sessionId, item.itemId)} title="Read the child transcript without attaching"><FileText size={12} />Transcript</button>
        </div>
      </div>
    ) : null;
  }
  if (!subagentId || !sessionId) return null;
  const control = item.controlStatus;
  const running = step.status === "running" || control === "running" || control === "starting" || control === "accepted";
  const ready = control === "resultReady" || (!running && item.result != null);
  const recoverable = control === "recoveryPending" || control === "manualReconciliation";
  const ended = !running && !ready && !recoverable;
  const run = (action: string, extra?: { body?: string; reason?: string }) => {
    setBusy(true);
    setError(null);
    void controlSubagent(sessionId, subagentId, action, extra)
      .then(() => { setComposing(null); setDraft(""); })
      .catch((cause) => setError(describeError("Could not load that", cause)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="agent-controls">
      <div className="agent-buttons" role="toolbar" aria-label="Subagent controls">
        {running ? <button type="button" className="agent-btn" disabled={busy} onClick={() => setComposing(composing ? null : "sendMessage")} title="Send the running child a note"><MessageCircle size={12} />Message</button> : null}
        {running ? <button type="button" className="agent-btn" disabled={busy} onClick={() => run("interrupt")} title="Ask the child to yield at its next boundary">Interrupt</button> : null}
        {running ? <button type="button" className="agent-btn danger" disabled={busy} onClick={() => run("stop")} title="Stop the running child"><X size={12} />Stop</button> : null}
        {ready ? <button type="button" className="agent-btn" disabled={busy} onClick={() => void openChild(sessionId, item.itemId)} title="Read the result and the child transcript"><Eye size={12} />Result</button> : null}
        {ready || ended ? <button type="button" className="agent-btn" disabled={busy} onClick={() => setComposing(composing ? null : "followupTask")} title="Queue a follow-up task for the child">Follow up</button> : null}
        {recoverable ? <button type="button" className="agent-btn" disabled={busy} onClick={() => run("resume")} title="Resume the child as a later attempt"><Play size={12} />Resume</button> : null}
        {ended ? <button type="button" className="agent-btn" disabled={busy} onClick={() => run("reopen")} title="Reopen the child as a later attempt"><RotateCcw size={12} />Reopen</button> : null}
        {item.childSessionId ? <button type="button" className="agent-btn" disabled={busy} onClick={() => void openChild(sessionId, item.itemId)} title="Read the child transcript without attaching"><FileText size={12} />Transcript</button> : null}
        {control !== "closed" && control !== "closing" ? <button type="button" className="agent-btn" disabled={busy} onClick={() => run("close")} title="Close the child">Close</button> : null}
      </div>
      {composing ? (
        <form
          className="agent-compose"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) run(composing, { body: draft.trim() });
          }}
        >
          <input type="text" value={draft} autoFocus disabled={busy} maxLength={100000} placeholder={composing === "sendMessage" ? "Note for the running child…" : "Follow-up task for the child…"} aria-label={composing === "sendMessage" ? "Note for the child" : "Follow-up task"} onChange={(event) => setDraft(event.target.value)} />
          <button type="submit" className="agent-btn emphasis" disabled={busy || !draft.trim()}><Send size={12} />Send</button>
        </form>
      ) : null}
      {error ? <p className="agent-error" role="alert">{error}</p> : null}
    </div>
  );
}

/**
 * A workflow or subagent as its own card, one row per agent, updating live. Agents can keep
 * running after the turn that launched them ends, so they never hide inside a step group.
 */
function AgentsCardView({ step }: { step: AgentStep }) {
  const workflow = step.kind === "workflow";
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const controlWorkflow = useAppStore((s) => s.controlWorkflow);
  const counts = workflow ? agentCounts(step.item) : null;
  const state: AgentState = step.status === "running" ? "running" : step.status === "failed" ? "failed" : step.status === "cancelled" ? "cancelled" : "completed";
  const [open, setOpen] = useState(true);
  // Only a click animates the card body; a remount in the virtual list does not.
  const [toggled, setToggled] = useState(false);
  const [wfBusy, setWfBusy] = useState(false);
  const [wfError, setWfError] = useState<string | null>(null);
  const outcome = useMemo(() => workflow && state !== "running" ? parseWorkflowMessage(step.item.message) : null, [workflow, state, step.item.message]);
  const runId = step.item.workflowRunId;
  const runWorkflow = (action: string, child?: { childId: string; attempt: number }) => {
    if (!sessionId || !runId) return;
    setWfBusy(true);
    setWfError(null);
    void controlWorkflow(sessionId, runId, action, child)
      .catch((cause) => setWfError(describeError("Could not load that", cause)))
      .finally(() => setWfBusy(false));
  };
  const rows = workflow
    ? (step.item.children ?? []).map((child, index) => {
        const activity = outcome?.activity.get(child.childId);
        return {
        id: `${child.childId}:${child.attempt}`,
        state: counts!.states[index] as AgentState,
        title: child.label || `Agent ${index + 1}`,
        detail: [child.phase, child.attempt > 1 ? `attempt ${child.attempt}` : "", activity?.toolCalls ? `${activity.toolCalls} tool calls` : ""].filter(Boolean).join(" · "),
        durationMs: child.durationMs ?? activity?.durationMs,
        tokens: child.usage?.outputTokens,
        childId: child.childId,
        attempt: child.attempt,
      }; })
    : [{ id: step.id, state, title: step.item.objective || "Subagent", detail: [step.item.role, step.item.controlStatus].filter(Boolean).join(" · "), durationMs: step.item.durationMs, tokens: undefined as number | undefined, childId: undefined as string | undefined, attempt: undefined as number | undefined }];
  const status = state === "running"
    ? counts ? counts.total ? `${counts.completed} of ${counts.total} done` : "Starting…" : "Running"
    : state === "failed" ? `Failed${step.item.reason ? ` · ${step.item.reason}` : ""}${counts?.total ? ` · ${counts.completed} of ${counts.total} finished` : ""}`
    : state === "cancelled" ? "Stopped"
    : counts ? `${counts.total} agents finished` : "Finished";
  return (
    <section className={`card agents ${state}`} aria-label={workflow ? "Workflow agents" : "Subagent"}>
      <button type="button" className="card-head" aria-expanded={open} onClick={() => { setToggled(true); setOpen(!open); }}>
        {workflow ? <Workflow size={14} aria-hidden="true" /> : <Bot size={14} aria-hidden="true" />}
        <span className="card-title">{workflow ? [counts?.total ? `${counts.total} agents` : "Workflow", step.title !== "Workflow" ? step.title : ""].filter(Boolean).join(" · ") : "Agent"}</span>
        <span className={`agents-status ${state}`}>{state === "running" ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : null}{status}</span>
        <ChevronRight size={13} className={`caret ${open ? "open" : ""}`} aria-hidden="true" />
      </button>
      <Collapse open={open} animate={toggled}>{() => <>
        <ol className="agent-rows">
          {rows.map((row) => (
            <li key={row.id} className={`agent-row-item ${row.state}`}>
              <span className="agent-state"><AgentStateMark state={row.state} /></span>
              <span className="agent-name" title={row.title}>{row.title}</span>
              {row.detail ? <span className="agent-detail">{row.detail}</span> : null}
              <span className="agent-meta">{[row.durationMs ? seconds(row.durationMs) : "", row.tokens ? `${row.tokens.toLocaleString("en-US")} tokens` : ""].filter(Boolean).join(" · ")}</span>
              {workflow && runId && row.childId != null && row.attempt != null && (row.state === "pending" || row.state === "running") ? (
                <button type="button" className="agent-btn" disabled={wfBusy} onClick={() => runWorkflow("skip", { childId: row.childId as string, attempt: row.attempt as number })} title={`Skip ${row.title} (attempt ${row.attempt})`}><SkipForward size={12} />Skip</button>
              ) : null}
              {workflow && runId && row.childId != null && row.attempt != null && row.state === "failed" ? (
                <button type="button" className="agent-btn" disabled={wfBusy} onClick={() => runWorkflow("retry", { childId: row.childId as string, attempt: row.attempt as number })} title={`Retry ${row.title} (attempt ${row.attempt})`}><RotateCcw size={12} />Retry</button>
              ) : null}
            </li>
          ))}
          {workflow && !rows.length ? <li className="agent-message">{state === "running" ? "Starting agents…" : "No agents ran."}</li> : null}
          {outcome?.text ? <li className="agent-message"><Markdown>{outcome.text}</Markdown></li> : null}
          {outcome?.evidence.length ? <li className="agent-message"><strong>Evidence</strong><ul>{outcome.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul></li> : null}
          {outcome?.unresolved.length ? <li className="agent-message"><strong>Unresolved</strong><ul>{outcome.unresolved.map((entry, index) => <li key={index}>{entry}</li>)}</ul></li> : null}
          {outcome?.failure ? <li className="agent-message failed">{outcome.failure}</li> : null}
        </ol>
      {workflow && runId && state === "running" ? (
        <div className="agent-controls">
          <div className="agent-buttons" role="toolbar" aria-label="Workflow controls">
            <button type="button" className="agent-btn danger" disabled={wfBusy} onClick={() => runWorkflow("cancel")} title="Cancel this workflow run"><X size={12} />Cancel run</button>
          </div>
          {wfError ? <p className="agent-error" role="alert">{wfError}</p> : null}
        </div>
      ) : workflow && wfError ? (
        <div className="agent-controls"><p className="agent-error" role="alert">{wfError}</p></div>
      ) : null}
      {!workflow ? <SubagentControls step={step} /> : null}
      </>}</Collapse>
    </section>
  );
}

const AgentsCard = memo(AgentsCardView);

function RunViewView({ run, header, inline, isLast, onHeightChange }: { run: AgentRun; header?: ReactNode; inline?: { after: string; node: ReactNode }; isLast: boolean; onHeightChange?: (id: string, height: number) => void }) {
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined" || !onHeightChange) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const h = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        if (h > 0) onHeightChange(run.id, h);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [run.id, onHeightChange]);

  const live = run.status === "running" || run.status === "waiting";
  const blocks: ReactNode[] = [];
  let buffer: AgentStep[] = [];
  let placed = false;
  const lastMessageId = [...run.steps].reverse().find((step) => step.kind === "message")?.id;
  const flush = () => {
    if (!buffer.length) return;
    blocks.push(<ActivityGroup key={`g-${buffer[0].id}`} steps={buffer} live={live && buffer.some((step) => step.status === "running")} />);
    buffer = [];
  };
  // A plan is shown where the agent made it, splitting the activity around it.
  const place = (step: AgentStep) => {
    if (!inline || step.id !== inline.after) return;
    flush();
    blocks.push(<div key="run-inline" className="run-inline">{inline.node}</div>);
  };
  for (const step of run.steps) {
    if (hiddenStep(step)) { place(step); continue; }
    if (ACTIVITY_KINDS.has(step.kind)) { buffer.push(step); place(step); continue; }
    flush();
    if (step.kind === "user") {
      blocks.push(<UserMessage key={step.id} step={step} />);
      if (header && !placed) { blocks.push(<div key="run-header" className="run-header">{header}</div>); placed = true; }
    }
    else if (step.kind === "workflow" || step.kind === "subagent") blocks.push(<AgentsCard key={step.id} step={step} />);
    else if (step.kind === "error") blocks.push(<div key={step.id} className="system-note" role="alert"><CircleAlert size={13} aria-hidden="true" /><span>{step.detail || "Something went wrong."}</span></div>);
    else if (step.detail) blocks.push(<AgentMessage key={step.id} step={step} final={!live && step.id === lastMessageId} canRetry={isLast && step.id === lastMessageId} />);
    place(step);
  }
  // While the run is live, the work since the last message belongs to the live status line
  // (it opens to show it), so it isn't repeated above that line.
  if (live && isLast) buffer = [];
  flush();
  if (header && !placed) blocks.unshift(<div key="run-header" className="run-header">{header}</div>);
  return (
    <section ref={rootRef} className={`run ${run.status}`} data-run={run.id}>
      {blocks}
      <Completion run={run} isLast={isLast} />
    </section>
  );
}

const RunView = memo(RunViewView);

/** The single live status line. Opens (like Claude desktop's thinking row) to show what the agent is doing right now. */
export function WorkingIndicator({ label, paused, peak, meta, live, agentId = "muse", agentName = "Muse", closing = false }: { label: string; paused?: boolean; peak?: boolean; meta?: string; live?: AgentStep[]; agentId?: AgentId; agentName?: string; closing?: boolean }) {
  const thinkingOrb = useAppStore((state) => state.thinkingOrb ?? "auto");
  const [open, setOpen] = useState(false);
  const thought = live?.find((step) => step.kind === "reasoning" && step.status === "running");
  const actions = live?.filter((step) => step !== thought) ?? [];
  return (
    <div className={`working-wrap${closing ? " closing" : ""}`} aria-live="polite">
      <button type="button" className={`working ${peak ? "peak" : ""}`} aria-expanded={live ? open : undefined} disabled={!live} onClick={() => setOpen(!open)}>
        {agentId === "muse" ? <Orb state={paused ? "breathing" : thinkingOrb !== "auto" ? thinkingOrb : peak ? "solving" : "working"} size={20} speed={peak && !paused ? 1.9 : 1} paused={paused} aria-label={agentName} /> : <span className={`working-agent ${paused ? "paused" : ""}`} aria-label={agentName}><ProductAgentMark id={agentId} size={20} /><i aria-hidden="true" /></span>}
        <span className={`working-label ${paused ? "" : "shimmer"}`} title={label}>{label}</span>
        {meta ? <span className="working-meta">{meta}</span> : null}
        {live ? <ChevronRight size={12} className={`caret ${open ? "open" : ""}`} aria-hidden="true" /> : null}
      </button>
      <Collapse open={open && Boolean(live)}>{() => (
        <div className="working-detail">
          {actions.length ? <ol className="steps">{actions.map((step) => <StepRow key={step.id} step={step} />)}</ol> : null}
          {thought?.detail ? <div className="thought live"><Markdown>{thought.detail}</Markdown></div> : null}
          {!thought?.detail && !actions.length ? <p className="working-empty">{thought ? "Reasoning privately. The model hasn't shared its thoughts yet." : "Waiting on the model."}</p> : null}
        </div>
      )}</Collapse>
    </div>
  );
}

export function AgentTimeline({ thread, scrollContainerRef, planPinned = false, onPlanPin }: { thread: Thread; scrollContainerRef?: React.RefObject<HTMLDivElement | null>; planPinned?: boolean; onPlanPin?: (pinned: boolean) => void }) {
  // Last render's runs, so a stream frame hands every settled run back as the same
  // object and only the run being written re-renders (see `stabilizeRuns`).
  const previousRuns = useRef<AgentRun[]>([]);
  const runs = useMemo(() => {
    const next = stabilizeRuns(previousRuns.current, groupAgentRuns(thread.items, { activeTurnId: thread.activeTurnId, lastTurnId: thread.lastTurnId, lastOutcome: thread.lastOutcome, waiting: Boolean(thread.pendingApproval || thread.userInputs?.length), threadRunning: thread.status === "running" }));
    previousRuns.current = next;
    return next;
  }, [thread.items, thread.activeTurnId, thread.lastTurnId, thread.lastOutcome, thread.pendingApproval, thread.userInputs, thread.status]);
  const heightsRef = useRef<Map<string, number>>(new Map());
  const [scrollState, setScrollState] = useState({ top: 0, height: 0 });

  const onHeightChange = useCallback((id: string, height: number) => {
    heightsRef.current.set(id, height);
  }, []);

  const getHeight = useCallback((run: AgentRun) => {
    return heightsRef.current.get(run.id) ?? estimateRunHeight(run);
  }, []);

  // The window on screen, as of the last render, and the newest runs — both read
  // from the scroll handler without making it re-render.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const shownWindow = useRef<{ start: number; end: number; virtualized: boolean; height: number } | null>(null);

  useEffect(() => {
    const scroller = scrollContainerRef?.current;
    if (!scroller) return;
    let frame: number | null = null;
    const measure = () => {
      const top = scroller.scrollTop;
      const height = scroller.clientHeight;
      const next = computeVirtualWindow(runsRef.current, top, height, getHeight, 4, 10);
      const shown = shownWindow.current;
      // Scrolling within the slice that is already rendered changes nothing on
      // screen, so it must not re-render the timeline (this used to happen on
      // every scroll frame, re-running every visible run).
      if (shown && shown.start === next.startIndex && shown.end === next.endIndex && shown.virtualized === next.isVirtualized && shown.height === height) return;
      setScrollState({ top, height });
    };
    const updateScroll = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };
    updateScroll();
    scroller.addEventListener("scroll", updateScroll, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateScroll) : null;
    ro?.observe(scroller);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", updateScroll);
      ro?.disconnect();
    };
  }, [scrollContainerRef, getHeight]);

  useEffect(() => {
    const activeIds = new Set(runs.map((r) => r.id));
    for (const key of heightsRef.current.keys()) {
      if (!activeIds.has(key)) heightsRef.current.delete(key);
    }
  }, [runs]);

  const executing = thread.status === "running" && Boolean(thread.plan?.some((item) => item.status === "pending" || item.status === "inProgress"));
  const plan = thread.plan?.length && !planPinned ? (
    <PlanView items={thread.plan} pinnable={executing && Boolean(onPlanPin)} pinned={false} onPin={onPlanPin} live={thread.status === "running"} />
  ) : null;
  const anchor = plan && thread.planAnchor ? thread.planAnchor : undefined;
  const anchorRun = anchor ? runs.findIndex((run) => run.steps.some((step) => step.id === anchor)) : -1;
  const headerPlan = anchorRun < 0 ? plan : null;
  const goal = thread.goal?.objective ? (
    <section className="card goal" aria-label="Goal">
      <div className="card-head static">
        <Target size={14} aria-hidden="true" />
        <span className="card-title">{thread.goal.objective}</span>
        {thread.goal.percentComplete != null ? <span className="plan-count">{Math.round(thread.goal.percentComplete)}%</span> : null}
      </div>
      {thread.goal.currentWork || thread.goal.nextWork ? (
        <dl className="goal-body">
          {thread.goal.currentWork ? <><dt>Now</dt><dd>{thread.goal.currentWork}</dd></> : null}
          {thread.goal.nextWork ? <><dt>Next</dt><dd>{thread.goal.nextWork}</dd></> : null}
        </dl>
      ) : null}
    </section>
  ) : null;
  const header = goal || headerPlan ? <>{goal}{headerPlan}</> : undefined;

  const virtualWindow = useMemo(() => {
    if (!scrollContainerRef?.current) {
      return { startIndex: 0, endIndex: Math.max(0, runs.length - 1), totalHeight: 0, isVirtualized: false };
    }
    return computeVirtualWindow(runs, scrollState.top, scrollState.height, getHeight, 4, 10);
  }, [runs, scrollState, getHeight, scrollContainerRef]);
  // What this render shows, so the scroll handler can tell a move that matters from one that does not.
  useEffect(() => {
    shownWindow.current = { start: virtualWindow.startIndex, end: virtualWindow.endIndex, virtualized: virtualWindow.isVirtualized, height: scrollState.height };
  });

  const isVisible = (index: number) => {
    if (!virtualWindow.isVirtualized) return true;
    if (index === runs.length - 1) return true;
    if (anchorRun >= 0 && index === anchorRun) return true;
    return index >= virtualWindow.startIndex && index <= virtualWindow.endIndex;
  };

  return (
    <div className="timeline">
      {runs.map((run, index) => {
        if (!isVisible(index)) {
          const h = heightsRef.current.get(run.id) ?? estimateRunHeight(run);
          return <div key={run.id} data-virtual-run={run.id} className="run-placeholder" style={{ height: h }} aria-hidden="true" />;
        }
        return (
          <RunView
            key={run.id}
            run={run}
            isLast={index === runs.length - 1}
            header={index === runs.length - 1 ? header : undefined}
            inline={anchor && index === anchorRun ? { after: anchor, node: plan } : undefined}
            onHeightChange={onHeightChange}
          />
        );
      })}
      {!runs.length && header ? <div className="run-header">{header}</div> : null}
    </div>
  );
}
