import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BellRing, Bot, Brain, Check, CircleDot, ChevronRight, ChevronUp, CircleAlert, CircleSlash, Copy, FilePen, FileText, Globe, Info, Layers, ListChecks,
  LoaderCircle, Pencil, Play, RotateCcw, Search, SquareTerminal, Target, Undo2, Workflow, Wrench, X,
} from "lucide-react";
import { Orb } from "./Orb";
import { ACTIVITY_KINDS, activitySummary, activityTitle, agentCounts, backgroundAgents, computeVirtualWindow, estimateRunHeight, groupAgentRuns, parseWorkflowMessage, relativeToWorkspace, runSummary, showTerminalReceipt, stabilizeRuns, type AgentState, type AgentRun, type AgentStep, type AgentStepKind } from "../lib/agent";
import { copyText, formatArgs, formatDuration, formatTokens, humanizeModelLabel, humanizeProvider, humanizeToolName, shortcutLabel, summarizeArgs } from "../lib/format";
import { estimateCallCost, formatCost } from "../lib/cost";
import { formatTokenSpeed, readTokenSpeed, TOKEN_SPEED_ESTIMATE } from "../lib/tokenSpeed";
import { modelFor } from "../lib/effort";
import { orchestratorRouteCallFact, orchestratorRouteExecution, orchestratorRouteFacts, orchestratorRouteFallback, orchestratorRouteFloor, orchestratorRouteLabel, orchestratorRouteTitle } from "../lib/orchestrator";
import { currentThread, useAppStore } from "../lib/store";
import { AGENT_LABELS, type AgentId, type PlanItem, type Thread, type TokenSpeed } from "../lib/types";
import { approvalPreview } from "../lib/approvalPreview";
import { EditPreview } from "./EditPreview";
import { Markdown } from "./Markdown";
import { Collapse } from "./Presence";
import { menuPosition } from "../lib/menuPosition";
import { EXIT_FAST_MS, usePresence } from "../lib/presence";
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

function Disclosure({ open }: { open: boolean }) {
  return <span className="disclosure" aria-hidden="true"><ChevronRight size={12} className={`caret ${open ? "open" : ""}`} /></span>;
}

/** One quiet mark: the kind of work at rest, its state when that needs attention. */
function StepStatus({ step }: { step: AgentStep }) {
  if (step.status === "failed") return <CircleAlert size={14} aria-hidden="true" />;
  if (step.status === "running") return <LoaderCircle size={13} className="spin" aria-hidden="true" />;
  if (step.status === "cancelled" || step.status === "skipped") return <CircleSlash size={13} aria-hidden="true" />;
  return <StepIcon kind={step.kind} />;
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
 * The inline plan card is also the checklist inside the floating PlanMenu.
 * `live` is whether a turn is running: once it has stopped, a step the agent
 * left in progress is shown as not done, without a spinner nothing is behind.
 */
export function PlanView({ items, floating = false, live = true }: { items: PlanItem[]; floating?: boolean; live?: boolean }) {
  const [open, setOpen] = useState(true);
  const [toggled, setToggled] = useState(false);
  if (!items.length) return null;
  const done = items.filter((item) => item.status === "completed").length;
  const pct = Math.round((done / items.length) * 100);
  const heading = <>
    <ListChecks size={14} aria-hidden="true" />
    <span className="card-title">Plan</span>
    <span className="plan-count">{done} of {items.length}</span>
    <span className="plan-progress" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
  </>;
  return (
    <section className={`card plan ${floating ? "floating" : ""}`} aria-label="Plan">
      <div className="plan-head">
        {floating ? (
          <div className="card-head plan-popup-head">{heading}</div>
        ) : (
          <button type="button" className="card-head" aria-expanded={open} onClick={() => { setToggled(true); setOpen(!open); }}>
            {heading}
            <ChevronRight size={13} className={`caret ${open ? "open" : ""}`} aria-hidden="true" />
          </button>
        )}
      </div>
      <Collapse open={floating || open} animate={!floating && toggled}>{() => (
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

/** An active plan floats over the composer; its checklist opens above and to the pill's right. */
export function PlanMenu({ items, live = true }: { items: PlanItem[]; live?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = `${useId()}-plan`;
  const [open, setOpen] = useState(false);
  const pop = usePresence(open, EXIT_FAST_MS);
  const [position, setPosition] = useState<(ReturnType<typeof menuPosition> & { position: "fixed" }) | null>(null);
  const done = items.filter((item) => item.status === "completed").length;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    // Capture before the composer sees Escape: dismiss this popup, not the turn.
    document.addEventListener("keydown", closeOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    const update = () => {
      const width = Math.min(320, Math.max(0, window.innerWidth - 16));
      const previousWidth = popover.style.width;
      popover.style.width = `${width}px`;
      const contentHeight = Math.ceil(popover.scrollHeight + popover.offsetHeight - popover.clientHeight);
      popover.style.width = previousWidth;
      const height = Math.min(380, contentHeight);
      const triggerRect = trigger.getBoundingClientRect();
      const anchor = { left: triggerRect.right + 12, right: triggerRect.right + 12, top: triggerRect.top, bottom: triggerRect.bottom };
      setPosition({
        ...menuPosition(
          anchor,
          { width, height },
          { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
          false,
        ),
        position: "fixed",
      });
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    const composer = trigger.closest(".composer-wrap");
    if (composer) observer?.observe(composer);
    update();
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [items, open]);

  return (
    <div ref={rootRef} className="plan-menu">
      <button
        ref={triggerRef}
        type="button"
        className="plan-menu-trigger"
        aria-label={`Plan: ${done} of ${items.length} completed`}
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => {
          if (!open) setPosition(null);
          setOpen(!open);
        }}
      >
        <ListChecks size={14} aria-hidden="true" />
        <span>Plan</span>
        <span className="plan-menu-count">{done}/{items.length}</span>
        <ChevronUp size={12} className="plan-menu-chevron" aria-hidden="true" />
      </button>
      {pop.mounted ? (
        <div
          ref={popoverRef}
          id={popoverId}
          className={`plan-popover${pop.closing ? " closing" : ""}`}
          style={position ?? { visibility: "hidden" }}
        >
          <PlanView items={items} floating live={live} />
        </div>
      ) : null}
    </div>
  );
}


/** Truncated tool output says so; the Harness saves the full text in the workspace and names it in the result. */
function FullOutputLink({ step }: { step: AgentStep }) {
  if (!step.item.truncated) return null;
  return <span className="output-truncated">Output truncated</span>;
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
  const [open, setOpen] = useState(false);
  // A failure that happens while this row is on screen opens itself. One restored
  // already failed stays a single line, so a past error does not dump its log into the thread.
  const [toggled, setToggled] = useState(false);
  const wasFailed = useRef(failed);
  useEffect(() => {
    if (!wasFailed.current && failed) { setToggled(true); setOpen(true); }
    wasFailed.current = failed;
  }, [failed]);
  const preview = step.kind === "edit" && step.status === "completed" ? completedEditPreview(step.item) : null;
  const expandable = Boolean(body || preview);
  return (
    <li className={`step ${step.kind} ${step.status} ${open ? "open" : ""}`}>
      <span className="step-node" aria-hidden="true">
        <StepStatus step={step} />
      </span>
      <div className="step-main">
        <button type="button" className="step-head" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => { setToggled(true); setOpen(!open); }}>
          <span className="step-verb">{verb}</span>
          {summary && !(step.kind === "reasoning" && open) ? <span className="step-summary" title={summary}>{summary}</span> : null}
          {toolArgs ? <span className="step-args" title={toolArgs}>{toolArgs}</span> : null}
          <span className="step-meta">
            {step.item.background ? <span className="task-bg" title={step.item.backgroundInitiator ? `Backgrounded by ${step.item.backgroundInitiator}` : "Running in the background"}>background</span> : null}
            {step.item.exitCode != null && step.item.exitCode !== 0 ? <span className="exit bad">exit {step.item.exitCode}</span> : null}
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
      </div>
    </li>
  );
}

const StepRow = memo(StepRowView);

function ActivityGroupView({ steps, live }: { steps: AgentStep[]; live: boolean }) {
  const failed = steps.some((step) => step.status === "failed");
  // Closed until the reader opens it, including while it is running and when a step failed.
  // A restored group mounts closed and still; only a click animates it.
  const [open, setOpen] = useState(false);
  const [toggled, setToggled] = useState(false);
  const summary = useMemo(() => activitySummary(steps), [steps]);
  const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  if (steps.length < 2) {
    return <div className="activity-body single"><ol className="steps">{steps.map((step) => <StepRow key={step.id} step={step} />)}</ol></div>;
  }
  // The counts stay in the tooltip: the collapsed row itself says what ran, not its composition.
  const facts = [
    plural(steps.length, "step"),
    summary.thoughts ? plural(summary.thoughts, "thought") : "",
    summary.edits ? plural(summary.edits, "edit") : "",
    summary.files ? plural(summary.files, "file") : "",
    summary.commands ? plural(summary.commands, "command") : "",
    failed ? plural(summary.failures || 1, "failure") : "",
    summary.durationMs ? seconds(summary.durationMs) : "",
  ].filter(Boolean).join(" · ");
  return (
    <div className={`activity-group ${open ? "open" : ""}${live ? " live" : ""}`}>
      <button type="button" className={`group-head${live ? " live" : ""}${failed ? " failed" : ""}`} aria-expanded={open} title={facts} onClick={() => { setToggled(true); setOpen(!open); }}>
        <Disclosure open={open} />
        <span className="group-title">{activityTitle(steps, live)}</span>
        {failed ? <span className="group-fail">{plural(summary.failures || 1, "failure")}</span> : null}
        {summary.durationMs ? <span className="group-meta">{seconds(summary.durationMs)}</span> : null}
      </button>
      <Collapse open={open} animate={toggled}>{() => (
        <div className="activity-body">
          <ol className="steps">{steps.map((step) => <StepRow key={step.id} step={step} />)}</ol>
        </div>
      )}</Collapse>
    </div>
  );
}

const ActivityGroup = memo(ActivityGroupView, (previous, next) => previous.live === next.live && previous.steps.length === next.steps.length && previous.steps.every((step, index) => step === next.steps[index]));

function messageTimeValue(recordedAt?: string) {
  if (!recordedAt) return undefined;
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return undefined;
  return {
    text: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    title: date.toLocaleString(),
  };
}

function MessageActions({ text, recordedAt, tooltipAlign = "start", onEdit, editLabel, onRetry, retryLabel, busy }: {
  text: string;
  recordedAt?: string;
  tooltipAlign?: "start" | "end";
  onEdit?: () => void;
  editLabel?: string;
  onRetry?: () => void;
  retryLabel?: string;
  busy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);
  const time = messageTimeValue(recordedAt);
  if (!text && !onRetry && !time) return null;
  return (
    <div className="msg-foot">
      {text || onRetry ? (
        <div className="msg-actions" role="toolbar" aria-label="Message actions">
          {text ? (
            <button
              type="button"
              className="icon-btn small"
              aria-label={copied ? "Copied to clipboard" : "Copy message"}
              data-tooltip={copied ? "Copied" : "Copy"}
              data-tooltip-side="top"
              data-tooltip-align={tooltipAlign}
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
            <button type="button" className="icon-btn small" aria-label={editLabel ?? "Edit message"} data-tooltip={editLabel ?? "Edit"} data-tooltip-side="top" data-tooltip-align={tooltipAlign} disabled={busy} onClick={onEdit}>
              <Pencil size={13} aria-hidden="true" />
            </button>
          ) : null}
          {onRetry ? (
            <button type="button" className="icon-btn small" aria-label={retryLabel ?? "Retry"} data-tooltip={retryLabel ?? "Retry"} data-tooltip-side="top" data-tooltip-align={tooltipAlign} disabled={busy} onClick={onRetry}>
              <RotateCcw size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
      {time ? <time className="msg-time" dateTime={recordedAt} title={time.title}>{time.text}</time> : null}
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
  const editRef = useRef<HTMLTextAreaElement>(null);
  const openViewer = useAppStore((state) => state.openViewer);
  const sendPrompt = useAppStore((state) => state.sendPrompt);
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
  const save = () => {
    if (!draft.trim() || busy) return;
    setEditing(false);
    resend(draft.trim());
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
                  save();
                }
              }}
            />
            <div className="msg-edit-row">
              <button type="button" className="chip small" disabled={!draft.trim() || busy} title="Send the edited message as a new turn" onClick={save}>Resend</button>
              <button type="button" className="ghost-btn small" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
              <span className="msg-edit-hint">{shortcutLabel("↵")} to send</span>
            </div>
          </div>
        ) : step.detail ? <Markdown>{step.detail}</Markdown> : null}
      </div>
      {!editing ? (
        <MessageActions
          text={text}
          recordedAt={step.item.recordedAt}
          tooltipAlign="end"
          busy={busy}
          onEdit={text ? () => {
            setDraft(text);
            setEditing(true);
          } : undefined}
          editLabel="Edit and resend"
          onRetry={resendable ? () => resend(text) : undefined}
          retryLabel="Resend this message"
        />
      ) : null}
    </article>
  );
}

const UserMessage = memo(UserMessageView);

function StreamingTokenSpeed({ speed }: { speed: TokenSpeed }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const reading = readTokenSpeed(speed, now);
  if (!reading || reading.idle) return null;
  return <span className="turn-stats msg-speed" title={TOKEN_SPEED_ESTIMATE}>{formatTokenSpeed(reading.tokensPerSecond)}</span>;
}

/** The answer a turn settles on. `final` adds its actions once the turn has ended. */
function AgentMessageView({ step, final, canRetry, tokenSpeed }: { step: AgentStep; final: boolean; canRetry: boolean; tokenSpeed?: TokenSpeed }) {
  const retryLast = useAppStore((state) => state.retryLast);
  const busy = useAppStore((state) => currentThread(state)?.status === "running" || state.submitting);
  const text = step.detail ?? "";
  return (
    <article className="msg agent" data-item={step.id}>
      <div className="agent-message-body"><Markdown>{text}</Markdown></div>
      {!final && canRetry && tokenSpeed ? <StreamingTokenSpeed speed={tokenSpeed} /> : null}
      {final ? <MessageActions text={text} recordedAt={step.item.recordedAt} busy={busy} onRetry={canRetry ? () => void retryLast() : undefined} retryLabel="Retry last turn" /> : null}
    </article>
  );
}

const AgentMessage = memo(AgentMessageView);

/**
 * A note the agent wrote between steps: narration, not the answer. One quiet
 * line until the reader opens it, including the newest note of a live turn.
 * A note the reader opened stays open.
 */
function AgentNoteView({ step }: { step: AgentStep }) {
  const text = step.detail ?? "";
  const summary = text.replace(/[#*_`>]/g, "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  const [open, setOpen] = useState(false);
  // Only a note the reader opens animates; one restored folded must not shift the scroll.
  const [toggled, setToggled] = useState(false);
  return (
    <div className={`trace-note${open ? " open" : ""}`} data-item={step.id}>
      <div className="trace-note-main">
        <button
          type="button"
          className="trace-note-head"
          aria-expanded={open}
          aria-label={open ? "Fold note" : undefined}
          title={open ? "Fold note" : summary}
          onClick={() => { setToggled(true); setOpen(!open); }}
        >
          <Disclosure open={open} />
          {open ? null : <span className="trace-note-summary">{summary}</span>}
        </button>
        <Collapse open={open} animate={toggled}>{() => (
          <div className="trace-note-body"><Markdown>{text}</Markdown></div>
        )}</Collapse>
      </div>
    </div>
  );
}

const AgentNote = memo(AgentNoteView);

/** A seam in the transcript: older turns are no longer carried in full, so the work that follows starts fresh. */
function ContextDivider({ step }: { step: AgentStep }) {
  const failed = step.status === "failed";
  const running = step.status === "running";
  const label = failed ? "Context compaction failed" : running ? "Compacting context" : "Context compacted";
  return (
    <div className={`context-divider${failed ? " failed" : ""}${running ? " running" : ""}`} role="separator" aria-label={label} data-item={step.id} title={step.detail || undefined}>
      <span className="context-line" aria-hidden="true" />
      <span className="context-chip">
        {running ? <LoaderCircle size={12} className="spin" aria-hidden="true" /> : <Layers size={12} aria-hidden="true" />}
        {label}
      </span>
      <span className="context-line" aria-hidden="true" />
    </div>
  );
}

type TraceEntry = { node: ReactNode; loose?: boolean };

/**
 * A turn's notes and steps form one flat work stream. Once the turn settles on
 * an answer, that work folds to one line above it, so the answer reads on its
 * own. Cards, errors and the plan are `loose`: they never hide inside the fold.
 */
function Trace({ entries, steps, holds, foldable, run, isLast }: { entries: TraceEntry[]; steps: AgentStep[]; holds: string[]; foldable: boolean; run: AgentRun; isLast: boolean }) {
  const [open, setOpen] = useState(!foldable);
  const [toggled, setToggled] = useState(false);
  const wasFoldable = useRef(foldable);
  useEffect(() => {
    // A turn settling in view folds its work away; one restored by the virtual list mounts folded and still.
    if (foldable && !wasFoldable.current) { setToggled(true); setOpen(false); }
    wasFoldable.current = foldable;
  }, [foldable]);
  const turnMs = useAppStore((state) => completedTurnStats(currentThread(state), run, isLast)?.durationMs);
  const summary = useMemo(() => activitySummary(steps), [steps]);
  const inside = foldable ? entries.filter((entry) => !entry.loose) : entries;
  if (!entries.length) return null;
  const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  const duration = turnMs ? formatDuration(turnMs) : summary.durationMs ? `~${formatDuration(summary.durationMs)}` : "";
  const stepFact = duration && summary.steps ? plural(summary.steps, "step") : "";
  return <>
    {foldable ? (
      <button type="button" className={`trace-head${summary.failures ? " failed" : ""}`} aria-expanded={open} data-holds={holds.join(" ")} onClick={() => { setToggled(true); setOpen(!open); }}>
        <Disclosure open={open} />
        <span className="trace-title">{duration ? `Worked for ${duration}` : plural(summary.steps, "step")}</span>
        {summary.failures ? <span className="group-fail">{plural(summary.failures, "failure")}</span> : null}
        {stepFact ? <span className="trace-facts">{stepFact}</span> : null}
      </button>
    ) : null}
    <Collapse open={!foldable || open} animate={toggled}>{() => <div className="trace">{inside.map((entry) => entry.node)}</div>}</Collapse>
    {foldable ? entries.filter((entry) => entry.loose).map((entry) => entry.node) : null}
  </>;
}

/** The message a run settles on: its last, with no work after it. While a run is live, a message the agent then works past becomes a note. */
function settledAnswerId(steps: AgentStep[]) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step.kind === "error" || hiddenStep(step)) continue;
    return step.kind === "message" && step.detail ? step.id : undefined;
  }
  return undefined;
}

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
    return Boolean(snapshot?.files.length || stats);
  });
  if (run.status === "running" || run.status === "waiting") return null;
  const hasAnswer = Boolean(settledAnswerId(run.steps));
  if (run.status === "completed" ? !hasDetails && !runSummary(run).changed.length && !hasAnswer : !isLast) return null;
  return <Receipt run={run} isLast={isLast} />;
}

/** Provider totals when they were reported; the reply estimate otherwise. Input includes cache, matching what the provider billed. */
function tokenFact(stats: { inputTokens?: number; cachedTokens?: number; outputTokens?: number; estimated?: boolean }) {
  const input = (stats.inputTokens ?? 0) + (stats.cachedTokens ?? 0);
  const output = stats.outputTokens ?? 0;
  const mark = stats.estimated ? "~" : "";
  if (input > 0) {
    const text = output > 0 ? `${mark}${formatTokens(input)} in · ${mark}${formatTokens(output)} out` : `${mark}${formatTokens(input)} in`;
    return <span title={stats.estimated ? "Estimated tokens for this turn" : "Input and output tokens reported for this turn"}>{text}</span>;
  }
  if (!output) return null;
  return <span title={stats.estimated ? "Estimated output tokens for this turn" : "Output tokens for this turn"}>{mark}{formatTokens(output)} tokens</span>;
}

function ReceiptView({ run, isLast }: { run: AgentRun; isLast: boolean }) {
  const continueThread = useAppStore((state) => state.continueThread);
  const stopRecovery = useAppStore((state) => state.stopRecovery);
  const retryLast = useAppStore((state) => state.retryLast);
  const sessionId = useAppStore((state) => state.selectedSessionId);
  const workspacePath = useAppStore((state) => currentThread(state)?.workspacePath);
  const threadError = useAppStore((state) => currentThread(state)?.error);
  const recoveryDismissed = useAppStore((state) => currentThread(state)?.recoveryDismissed);
  const recoveryNotice = useAppStore((state) => currentThread(state)?.notice?.message);
  const agentId: AgentId = "harness";
  const busy = useAppStore(selectThreadBusy);
  const openFileDiff = useAppStore((state) => state.openFileDiff);
  const setInspectorTab = useAppStore((state) => state.setInspectorTab);
  const setDockOpen = useAppStore((state) => state.setDockOpen);
  const [filesOpen, setFilesOpen] = useState(false);
  const snapshot = useAppStore((state) => run.turnId ? currentThread(state)?.snapshots?.[run.turnId] : undefined);
  const snapshotPending = useAppStore((state) => currentThread(state)?.snapshotPending);
  const snapshotError = useAppStore((state) => currentThread(state)?.snapshotError?.turnId === run.turnId ? currentThread(state)?.snapshotError?.message : undefined);
  const restoreSnapshot = useAppStore((state) => state.restoreSnapshot);
  const agentName = AGENT_LABELS[agentId];
  const stats = useAppStore((state) => completedTurnStats(currentThread(state), run, isLast));
  const costModel = useAppStore((state) => {
    const thread = currentThread(state);
    return modelFor(state.models, thread?.config ?? {});
  });
  const route = useAppStore((state) => (run.turnId ? currentThread(state)?.routes?.[run.turnId] : undefined));
  const routeExecution = route ? orchestratorRouteExecution(route) : undefined;
  const routeCatalogModel = useAppStore((state) => (routeExecution
    ? state.models.find((model) => model.modelId === routeExecution.modelId && (!model.providerId || model.providerId === routeExecution.providerId))
      ?? state.models.find((model) => model.modelId === routeExecution.modelId)
    : undefined));
  const turnCalls = useAppStore((state) => currentThread(state)?.turnCalls);
  // A routed turn's cost spans the models it used, so the single-model estimate would be wrong.
  const turnCost = !route && stats && costModel ? estimateCallCost({ inputTokens: (stats.inputTokens ?? 0) + (stats.cachedTokens ?? 0), cachedTokens: stats.cachedTokens ?? 0, outputTokens: stats.outputTokens ?? 0 }, costModel.cost) : undefined;
  // Hosts that report no per-turn usage still reported each step's time; their
  // sum, marked ~, fills the receipt's otherwise-empty metrics row.
  const derivedMs = run.steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  const routeCallFact = route ? orchestratorRouteCallFact(turnCalls, route.routeId) : undefined;
  // A floor raised the user's per-message choice; a fallback is routing's own recovery.
  const routeFloor = route ? orchestratorRouteFloor(route) : undefined;
  const routeFallback = route ? orchestratorRouteFallback(route) : undefined;
  const routeFacts = route ? orchestratorRouteFacts(route) : [];
  const receiptModel = routeExecution ?? costModel;
  // A route's model is the one the bridge actually ran; its provider prefix would only repeat the provider name.
  const receiptModelLabel = routeExecution
    ? humanizeModelLabel(routeExecution.modelId.slice(routeExecution.modelId.indexOf("/") + 1), routeCatalogModel?.displayLabel)
    : costModel ? humanizeModelLabel(costModel.modelId, costModel.displayLabel) : undefined;
  const receiptModelTitle = routeExecution
    ? `${receiptModelLabel} as ${routeExecution.role}${routeExecution.providerId ? ` via ${humanizeProvider(routeExecution.providerId)}` : ""}`
    : costModel?.providerId ? `${receiptModelLabel} via ${humanizeProvider(costModel.providerId)}` : undefined;
  // One quiet line of facts, most useful first: time, speed, tokens, cost, the route, then the model that did the work.
  const metrics = stats || route ? <span className="turn-stats" aria-label="Turn usage">
    {stats ? <span className="turn-duration" title="Time spent on this turn">{formatDuration(stats.durationMs)}</span> : derivedMs > 0 ? <span className="turn-duration" title="Sum of the step times the agent reported">~{formatDuration(derivedMs)}</span> : null}
    {stats?.tokensPerSecond != null ? <span title={TOKEN_SPEED_ESTIMATE}>{formatTokenSpeed(stats.tokensPerSecond)}</span> : null}
    {stats ? tokenFact(stats) : null}
    {turnCost != null && costModel ? <span title={turnCost.partial ? "Partial estimated cost; unpriced tokens are excluded" : "Estimated cost for this turn"}>≈{formatCost(turnCost.amount, turnCost.currency)}{turnCost.partial ? " partial" : ""}</span> : null}
    {route ? <span className="turn-route" title={orchestratorRouteTitle(route)}>{orchestratorRouteLabel(route)}{routeFloor ? " · floor" : routeFallback ? " · fallback" : ""}</span> : null}
    {routeCallFact ? <span className="turn-route-calls" title="Model calls this turn made">{routeCallFact}</span> : null}
    {receiptModel && receiptModelLabel ? <span className="turn-model" title={receiptModelTitle}><ModelIcon modelId={receiptModel.modelId} providerId={receiptModel.providerId} size={12} fallback={<ProductAgentMark size={12} />} />{receiptModelLabel}</span> : null}
  </span> : derivedMs > 0 ? <span className="turn-stats" aria-label="Turn duration">
    <span className="turn-duration" title="Sum of the step times the agent reported">~{formatDuration(derivedMs)}</span>
  </span> : null;
  const openDiff = (raw: string) => openFileDiff(relativeToWorkspace(raw, workspacePath) ?? raw);
  if (run.status !== "completed" && !showTerminalReceipt(run.status, isLast, busy)) return null;
  const summary = runSummary(run);
  const changed = snapshot?.state === "ready" || snapshot?.state === "undone" ? snapshot.files : summary.changed;
  const fileCount = changed.length;
  const undone = snapshot?.state === "undone";
  const snapshotActions = <>
    {snapshot && fileCount > 0 && ["ready", "undone"].includes(snapshot.state) && sessionId && run.turnId ? <button type="button" className="ghost-btn small" disabled={busy || !!snapshotPending} title={undone ? "Restore this turn’s saved changes" : "Restore the file state from before this turn"} onClick={() => void restoreSnapshot(sessionId, run.turnId!)}><Undo2 size={12} aria-hidden="true" />{snapshotPending === run.turnId ? "Restoring…" : undone ? "Reapply" : "Undo"}</button> : null}
  </>;
  // Undo appears only when it can run. Why it cannot (no saved state, a large
  // file, a busy shell) is not something to act on, so the strip says nothing;
  // only an Undo or Reapply the user started and that failed gets a line.
  const snapshotNote = snapshotError ? <span className="receipt-note danger" role="alert"><Info size={12} aria-hidden="true" /><span>{snapshotError}</span></span> : null;
  const reviewAction = <button type="button" className="ghost-btn small" title="Open this turn’s changes in the Changes panel" onClick={() => { setInspectorTab("changes"); setDockOpen(true); }}>Review</button>;
  if (run.status === "completed") {
    const hasAnswer = Boolean(settledAnswerId(run.steps));
    if (!fileCount && !stats && !hasAnswer) return null;
    return (
      <section className="receipt completed" aria-label="Done">
        <div className="receipt-head">
          {/* An undone turn says so in place of Done; its files are back to their state before it. */}
          <span className={`receipt-status${undone ? " undone" : ""}`} title={undone ? "Files restored to their state before this turn. Thread history is kept." : undefined}><span className="receipt-icon">{undone ? <Undo2 size={13} aria-hidden="true" /> : <Check size={14} strokeWidth={2.2} aria-hidden="true" />}</span><strong>{undone ? "Undone" : "Done"}</strong></span>
          {metrics}
          <span className="receipt-actions">
            {snapshotActions}
            {reviewAction}
          </span>
        </div>
        {routeFacts.length ? (
          <div className="receipt-route-facts" aria-label="Route details">
            {routeFacts.map((fact) => <span key={fact}>{fact}</span>)}
          </div>
        ) : null}
        {fileCount ? (() => {
          const files = filesOpen ? changed : changed.slice(0, 3);
          const more = changed.length - files.length;
          return (
            <section className="changes-card" aria-label="Changed files">
              <div className="changes-head">
                <FilePen size={13} aria-hidden="true" />
                <span className="changes-title">Changed {fileCount} file{fileCount === 1 ? "" : "s"}</span>
              </div>
              <ul className="change-rows">
                {files.map((path) => {
                  const parts = path.split(/[\\/]/).filter(Boolean);
                  const name = parts.pop() ?? path;
                  return (
                    <li key={path}>
                      <button type="button" className="change-row" title={`${path} — open diff`} onClick={() => openDiff(path)}>
                        <FilePen size={12} aria-hidden="true" />
                        <span className="change-name">{name}</span>
                        {parts.length ? <span className="change-dir">{parts.join("/")}</span> : null}
                        <ChevronRight size={12} className="change-arrow" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              {changed.length > 3 ? (
                <button type="button" className="changes-more" aria-expanded={filesOpen} onClick={() => setFilesOpen(!filesOpen)}>
                  {filesOpen ? "Show fewer files" : `Show ${more} more file${more === 1 ? "" : "s"}`}
                </button>
              ) : null}
            </section>
          );
        })() : null}
        {snapshotNote}
      </section>
    );
  }
  const label = run.status === "cancelled" ? "Stopped" : run.status === "failed" ? "Run failed" : "Interrupted";
  const detail = run.status === "interrupted" && recoveryNotice ? recoveryNotice
    : run.status === "interrupted" ? `${agentName} disconnected mid-run. Completed steps are kept.`
    : run.status === "cancelled" ? "You stopped this run. Completed steps are kept."
    : threadError || "Review the last step, then retry or continue.";
  return (
    <section className={`receipt ${run.status}`} aria-label={label}>
      <span className="receipt-icon">{run.status === "failed" ? <CircleAlert size={13} aria-hidden="true" /> : <CircleSlash size={12} aria-hidden="true" />}</span>
      <span className="receipt-text"><strong>{label}</strong> <span className="muted">{detail}</span></span>
      {metrics}
      <span className="receipt-actions">
        {recoveryDismissed ? null : (
          <>
            <button className="ghost-btn small" onClick={() => void continueThread()}><Play size={11} />Continue</button>
            {run.status === "interrupted" ? <button className="ghost-btn small" onClick={() => stopRecovery()}>Leave stopped</button> : null}
          </>
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
 * One live status at a time: an in-progress thought only joins the list once
 * it's done. Host reminder child sessions with nothing but the generic
 * placeholder are bookkeeping, not work.
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

/** A delegated child's card drills into its read-only transcript. */
function SubagentControls({ step }: { step: AgentStep }) {
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const openChild = useAppStore((s) => s.openChild);
  const item = step.item;
  if (!sessionId || !item.childSessionId) return null;
  return (
    <div className="agent-controls">
      <div className="agent-buttons" role="toolbar" aria-label="Subagent controls">
        <button type="button" className="agent-btn" onClick={() => void openChild(sessionId, item.itemId)} title="Read the child transcript without attaching"><FileText size={12} />Transcript</button>
      </div>
    </div>
  );
}

/**
 * A workflow or subagent as its own card, one row per agent, updating live. Agents can keep
 * running after the turn that launched them ends, so they never hide inside a step group.
 */
function AgentsCardView({ step }: { step: AgentStep }) {
  const workflow = step.kind === "workflow";
  const counts = workflow ? agentCounts(step.item) : null;
  const state: AgentState = step.status === "running" ? "running" : step.status === "failed" ? "failed" : step.status === "cancelled" ? "cancelled" : "completed";
  const [open, setOpen] = useState(true);
  // Only a click animates the card body; a remount in the virtual list does not.
  const [toggled, setToggled] = useState(false);
  const outcome = useMemo(() => workflow && state !== "running" ? parseWorkflowMessage(step.item.message) : null, [workflow, state, step.item.message]);
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
            </li>
          ))}
          {workflow && !rows.length ? <li className="agent-message">{state === "running" ? "Starting agents…" : "No agents ran."}</li> : null}
          {outcome?.text ? <li className="agent-message"><Markdown>{outcome.text}</Markdown></li> : null}
          {outcome?.evidence.length ? <li className="agent-message"><strong>Evidence</strong><ul>{outcome.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul></li> : null}
          {outcome?.unresolved.length ? <li className="agent-message"><strong>Unresolved</strong><ul>{outcome.unresolved.map((entry, index) => <li key={index}>{entry}</li>)}</ul></li> : null}
          {outcome?.failure ? <li className="agent-message failed">{outcome.failure}</li> : null}
        </ol>
      {!workflow ? <SubagentControls step={step} /> : null}
      </>}</Collapse>
    </section>
  );
}

const AgentsCard = memo(AgentsCardView);

function RunViewView({ run, header, inline, isLast, onHeightChange, tokenSpeed }: { run: AgentRun; header?: ReactNode; inline?: { after: string; node: ReactNode }; isLast: boolean; onHeightChange?: (id: string, height: number) => void; tokenSpeed?: TokenSpeed }) {
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
  // The user's message (and the goal or plan under it), then the agent's work,
  // its answer, and anything that came after the answer.
  const blocks: ReactNode[] = [];
  const entries: TraceEntry[] = [];
  const after: ReactNode[] = [];
  const traceSteps: AgentStep[] = [];
  const holds: string[] = [];
  let answer: ReactNode = null;
  let buffer: AgentStep[] = [];
  let placed = false;
  const answerId = settledAnswerId(run.steps);
  const push = (node: ReactNode, loose = false) => { if (answer) after.push(node); else entries.push({ node, loose }); };
  const flush = () => {
    if (!buffer.length) return;
    push(<ActivityGroup key={`g-${buffer[0].id}`} steps={buffer} live={live && buffer.some((step) => step.status === "running")} />);
    traceSteps.push(...buffer);
    buffer = [];
  };
  // A plan is shown where the agent made it, splitting the activity around it.
  const place = (step: AgentStep) => {
    if (!inline || step.id !== inline.after) return;
    flush();
    const node = <div key="run-inline" className="run-inline">{inline.node}</div>;
    if (step.kind === "user") blocks.push(node); else push(node, true);
  };
  for (const step of run.steps) {
    if (hiddenStep(step)) { place(step); continue; }
    if (step.kind === "compaction") {
      flush();
      push(<ContextDivider key={step.id} step={step} />);
      place(step);
      continue;
    }
    if (ACTIVITY_KINDS.has(step.kind)) { buffer.push(step); place(step); continue; }
    flush();
    if (step.kind === "user") {
      blocks.push(<UserMessage key={step.id} step={step} />);
      if (header && !placed) { blocks.push(<div key="run-header" className="run-header">{header}</div>); placed = true; }
    }
    else if (step.kind === "workflow" || step.kind === "subagent") push(<AgentsCard key={step.id} step={step} />, true);
    else if (step.kind === "error") push(<div key={step.id} className="system-note" role="alert"><CircleAlert size={13} aria-hidden="true" /><span>{step.detail || "Something went wrong."}</span></div>, true);
    else if (step.detail && step.id === answerId) answer = <AgentMessage key={step.id} step={step} final={!live} canRetry={isLast} tokenSpeed={live && isLast ? tokenSpeed : undefined} />;
    else if (step.detail) { push(<AgentNote key={step.id} step={step} />); holds.push(step.id); }
    place(step);
  }
  // While the run is live, the work since the last message belongs to the live status line
  // (it opens to show it), so it isn't repeated above that line.
  if (live && isLast) buffer = [];
  flush();
  if (header && !placed) blocks.unshift(<div key="run-header" className="run-header">{header}</div>);
  // One line is already its own summary; a fold over it would only add a click.
  const foldable = !live && answer != null && entries.filter((entry) => !entry.loose).length > 1;
  return (
    <section ref={rootRef} className={`run ${run.status}`} data-run={run.id}>
      {blocks}
      {entries.length || answer || after.length ? (
        <div className="agent-turn">
          <Trace entries={entries} steps={traceSteps} holds={holds} foldable={foldable} run={run} isLast={isLast} />
          {answer}
          {after}
        </div>
      ) : null}
      <Completion run={run} isLast={isLast} />
    </section>
  );
}

const RunView = memo(RunViewView);

/** The single live status line opens to show what the agent is doing right now. */
export function WorkingIndicator({ label, paused, peak, meta, live, agentName = AGENT_LABELS.harness, closing = false }: { label: string; paused?: boolean; peak?: boolean; meta?: string; live?: AgentStep[]; agentId?: AgentId; agentName?: string; closing?: boolean }) {
  const thinkingOrb = useAppStore((state) => state.thinkingOrb ?? "auto");
  const [open, setOpen] = useState(false);
  const thought = live?.find((step) => step.kind === "reasoning" && step.status === "running");
  // A compaction is a seam in the trace above, never a step in the live list.
  const actions = live?.filter((step) => step !== thought && step.kind !== "compaction") ?? [];
  return (
    <div className={`working-wrap${closing ? " closing" : ""}`} aria-live="polite">
      <button type="button" className={`working ${peak ? "peak" : ""}`} aria-expanded={live ? open : undefined} disabled={!live} onClick={() => setOpen(!open)}>
        <Orb state={paused ? "breathing" : thinkingOrb !== "auto" ? thinkingOrb : peak ? "solving" : "working"} size={20} speed={peak && !paused ? 1.9 : 1} paused={paused} aria-label={agentName} />
        <span className="working-label" title={label}>{label}</span>
        {meta ? <span className="working-meta">{meta}</span> : null}
        {live ? <ChevronRight size={12} className={`caret ${open ? "open" : ""}`} aria-hidden="true" /> : null}
      </button>
      <Collapse open={open && Boolean(live)}>{() => (
        // The wrapper announces the live status; the steps it opens onto must not be read as one update.
        <div className="working-detail" aria-live="off">
          {actions.length ? <ol className="steps">{actions.map((step) => <StepRow key={step.id} step={step} />)}</ol> : null}
          {thought?.detail ? (
            <div className="thought live">
              <p className="thought-head"><Brain size={12} aria-hidden="true" />Thinking</p>
              <Markdown>{thought.detail}</Markdown>
            </div>
          ) : null}
          {!thought?.detail && !actions.length ? <p className="working-empty">{thought ? "Reasoning privately. The model hasn't shared its thoughts yet." : "Waiting on the model."}</p> : null}
        </div>
      )}</Collapse>
    </div>
  );
}

export function AgentTimeline({ thread, scrollContainerRef, planFloating = false }: { thread: Thread; scrollContainerRef?: React.RefObject<HTMLDivElement | null>; planFloating?: boolean }) {
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

  const plan = thread.plan?.length && !planFloating ? (
    <PlanView items={thread.plan} live={thread.status === "running"} />
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

  const liveTokenSpeed = thread.status === "running" && !thread.pendingApproval && !thread.userInputs?.length && !thread.cancelRequested ? thread.tokenSpeed : undefined;
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
            tokenSpeed={index === runs.length - 1 ? liveTokenSpeed : undefined}
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
