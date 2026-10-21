import { useEffect, useId, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { currentThread, useAppStore } from "../lib/store";
import { describeApprovalScope, formatArgs, humanizeToolName, shortcutLabel, summarizeArgs } from "../lib/format";
import { approvalPreview } from "../lib/approvalPreview";
import { usePresence, useRetained } from "../lib/presence";
import { EditPreview } from "./EditPreview";

const EXPIRY_NOTICE_MS = 5 * 60 * 1000;
export function ApprovalCard() {
  // The pending approval and the flags that gate it — not the thread, which is
  // replaced on every streamed token and would re-render this card each time.
  const { approval, approvalPending, cancelRequested, more } = useAppStore(useShallow((s) => {
    const thread = currentThread(s);
    return { approval: thread?.pendingApproval, approvalPending: thread?.approvalPending, cancelRequested: thread?.cancelRequested, more: thread?.queuedApprovals?.length ?? 0 };
  }));
  const decide = useAppStore((s) => s.decide);
  const [feedback, setFeedback] = useState<{ approvalId: string; text: string } | null>(null);
  // The card stays mounted for one exit after the request resolves (the shared
  // `closing` convention); `shown` keeps drawing the last request during it.
  const { mounted, closing } = usePresence(Boolean(approval));
  const shown = useRetained(approval);
  const explaining = feedback?.approvalId === shown?.approvalId && feedback != null;
  const expiresAt = shown?.expiresAt;
  const [now, setNow] = useState(() => Date.now());
  const card = useRef<HTMLElement>(null);
  const titleId = useId();
  const descId = useId();
  useEffect(() => {
    if (!expiresAt || expiresAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= expiresAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  // Waiting state contract: the card takes focus when a request arrives and
  // hands it back to whatever had it when the request leaves. A user who
  // already moved focus into the card (or away from it) is left alone.
  const approvalId = approval?.approvalId ?? null;
  useEffect(() => {
    const node = card.current;
    if (!approvalId || !node) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const inside = prior != null && node.contains(prior);
    const opener = inside ? null : prior;
    if (!inside) node.focus({ preventScroll: true });
    return () => {
      // Restore only when focus died with the card — still inside it, detached
      // with it, or stranded on <body>. A deliberate move away is left alone.
      const active = document.activeElement;
      const stranded = active === document.body || !active?.isConnected || (active instanceof HTMLElement && node.contains(active));
      if (stranded && opener?.isConnected) opener.focus();
    };
  }, [approvalId]);
  if (!mounted || !shown) return null;
  const toolLabel = humanizeToolName(shown.toolName);
  const summary = summarizeArgs(shown.toolName, shown.rawArgs);
  const details = shown.rawArgs && shown.rawArgs !== summary ? formatArgs(shown.rawArgs) : "";
  const preview = approvalPreview(shown.toolName, shown.rawArgs);
  const allow = shown.availableChoices.filter((choice) => !choice.decision.startsWith("denied"));
  const deny = shown.availableChoices.filter((choice) => choice.decision.startsWith("denied"));
  const feedbackChoice = deny.find((choice) => choice.acceptsFeedback) ?? deny[0];
  const subject = shown.subject && typeof shown.subject.kind === "string"
    ? [String(shown.subject.kind), typeof shown.subject.path === "string" ? shown.subject.path : typeof shown.subject.workspaceRoot === "string" ? shown.subject.workspaceRoot : ""].filter(Boolean).join(" · ")
    : "";
  const remaining = expiresAt != null ? expiresAt - now : null;
  const expired = remaining != null && remaining <= 0;
  const showCountdown = remaining != null && !expired && remaining < EXPIRY_NOTICE_MS;
  const countdown = remaining != null ? `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}` : "";
  const disabled = approvalPending || cancelRequested || expired || closing;
  const scopeNote = describeApprovalScope(allow[0]?.scope ?? "");
  return (
    <section
      ref={card}
      className={`approval${closing ? " closing" : ""}`}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={summary ? descId : undefined}
      aria-keyshortcuts="Enter Escape"
      tabIndex={closing ? -1 : 0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          // Esc inside an in-card field is the field's own business; it must
          // never bubble to the window handler that reads it as "stop the turn".
          const target = event.target as HTMLElement;
          if (event.key === "Escape" && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) event.stopPropagation();
          return;
        }
        // Only with focus on the card itself: a focused button or the feedback
        // field keeps Enter and Esc for its own use.
        if (disabled) return;
        const choice = event.key === "Enter" ? allow[0] : event.key === "Escape" ? deny[0] : undefined;
        if (!choice) return;
        event.preventDefault();
        void decide(shown.approvalId, choice.choiceId);
      }}
    >
      <header className="approval-head">
        <span className="approval-icon"><ShieldAlert size={14} aria-hidden="true" /></span>
        <div>
          <h3 id={titleId}>Allow {toolLabel}?</h3>
          {subject ? <p className="muted">{subject}</p> : null}
          {more ? <p className="muted">+{more} more waiting</p> : null}
        </div>
      </header>
      {preview ? <EditPreview preview={preview} /> : null}
      {summary ? <pre className="cmd" id={descId}>{summary}</pre> : null}
      {details ? <details className="approval-args"><summary>Full arguments</summary><pre className="cmd">{details}</pre></details> : null}
      {expired ? <p className="muted approval-expiry" role="status">This approval expired. Stop or re-run the turn.</p> : null}
      <div className="choices">
        {deny.map((choice, index) => (
          <button key={choice.choiceId} disabled={disabled} title={describeApprovalScope(choice.scope) || undefined} className="secondary" onClick={() => void decide(shown.approvalId, choice.choiceId)}>{choice.label}{index === 0 ? <kbd>{shortcutLabel("⌫")}</kbd> : null}</button>
        ))}
        {feedbackChoice && !explaining ? <button type="button" className="secondary" disabled={disabled} onClick={() => setFeedback({ approvalId: shown.approvalId, text: "" })}>Deny and explain…</button> : null}
        <span className="grow" />
        {allow.map((choice, index) => (
          <button key={choice.choiceId} disabled={disabled} title={describeApprovalScope(choice.scope) || undefined} className={index === 0 ? "primary accent" : "secondary"} onClick={() => void decide(shown.approvalId, choice.choiceId)}>{choice.label}{index === 0 ? <kbd>{shortcutLabel("Y")}</kbd> : index === 1 ? <kbd>{shortcutLabel("⇧Y")}</kbd> : null}</button>
        ))}
      </div>
      {explaining && feedbackChoice ? <form className="approval-feedback" onSubmit={(event) => {
        event.preventDefault();
        if (!disabled && feedback.text.trim()) void decide(shown.approvalId, feedbackChoice.choiceId, feedback.text);
      }}>
        <label htmlFor="denial-feedback">Explain what the agent should do instead</label>
        <textarea id="denial-feedback" autoFocus rows={2} maxLength={8000} value={feedback.text} disabled={disabled} onChange={(event) => setFeedback({ approvalId: shown.approvalId, text: event.target.value })} />
        <p className="muted">Denies this request, then sends your feedback to the running turn or queues it until the agent can accept it.</p>
        <div className="choices">
          <button type="button" className="secondary" disabled={disabled} onClick={() => setFeedback(null)}>Cancel explanation</button>
          <button type="submit" className="primary" disabled={disabled || !feedback.text.trim()}>Deny and send feedback</button>
        </div>
      </form> : null}
      {scopeNote ? <p className="muted approval-scope">{scopeNote}</p> : null}
      {showCountdown ? <p className="muted approval-expiry">Expires in {countdown}</p> : null}
    </section>
  );
}
