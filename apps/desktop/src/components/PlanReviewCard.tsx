import { useId, useRef, useState } from "react";
import { ListChecks } from "lucide-react";
import { useAppStore } from "../lib/store";
import type { UserInputRequest, UserInputResponse } from "../lib/types";
import { Markdown } from "./Markdown";
import { keepFieldEscape, useWaitingFocus } from "./UserInputCard";

/** The plan review's named answers; the host decides by label, never by position. */
const APPROVE = "Approve";
const KEEP_PLANNING = "Keep planning";
const FEEDBACK_LIMIT = 4000;

/**
 * A plan the agent presented from Plan mode. Approve turns Plan mode off and
 * the agent carries the plan out; feedback goes to the agent as your message
 * and it revises the plan; Keep planning closes the review and waits for you.
 */
export function PlanReviewCard({ request, disabled, closing = false, agentName = "Harness" }: { request: UserInputRequest; disabled: boolean; closing?: boolean; agentName?: string }) {
  const respond = useAppStore((state) => state.respondUserInput);
  const [feedback, setFeedback] = useState("");
  const card = useRef<HTMLElement>(null);
  const titleId = useId();
  const planId = useId();
  const feedbackId = useId();
  useWaitingFocus(card, request.userInputId, closing);
  const plan = request.intent?.kind === "planReview" ? request.intent.plan : "";
  const question = request.questions[0]?.id ?? "q1";
  const send = (response: UserInputResponse) => void respond(request.sessionId, request.userInputId, response);
  const locked = disabled || closing;
  return (
    <section ref={card} className={`approval user-input plan-review${closing ? " closing" : ""}`} role="alertdialog" aria-labelledby={titleId} aria-describedby={planId} tabIndex={-1} onKeyDown={keepFieldEscape}>
      <header className="approval-head">
        <span className="approval-icon"><ListChecks size={14} aria-hidden="true" /></span>
        <div>
          <h3 id={titleId}>Review the plan</h3>
          <p className="muted">{agentName} edits nothing until you approve it.</p>
        </div>
      </header>
      <div className="plan-review-body" id={planId} role="region" aria-label="Proposed plan" tabIndex={0}><Markdown>{plan}</Markdown></div>
      <div className="approval-feedback">
        <label htmlFor={feedbackId}>What should change?</label>
        <textarea id={feedbackId} rows={2} maxLength={FEEDBACK_LIMIT} value={feedback} disabled={locked} placeholder="Optional. Your notes go to the agent, and Plan mode stays on." onChange={(event) => setFeedback(event.target.value)} />
      </div>
      <div className="choices">
        <button type="button" className="text-btn" disabled={locked} title="Close the review and stay in Plan mode" onClick={() => send({ action: "answer", answers: [{ questionId: question, selectedLabel: KEEP_PLANNING }] })}>Keep planning</button>
        <span className="grow" />
        <button type="button" className="secondary" disabled={locked || !feedback.trim()} onClick={() => send({ action: "clarify", text: feedback.trim() })}>Send feedback</button>
        <button type="button" className="primary accent" disabled={locked} onClick={() => send({ action: "answer", answers: [{ questionId: question, selectedLabel: APPROVE }] })}>Approve and build</button>
      </div>
    </section>
  );
}
