import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { useAppStore } from "../lib/store";
import type { UserInputAnswer, UserInputRequest, UserInputResponse } from "../lib/types";

type AnswerDraft = { text?: string; labels?: string[]; freeText?: boolean };

/**
 * Waiting state contract: a question card takes focus when it appears and hands
 * it back to whatever had it when the request leaves. Focus that already lives
 * inside the card, or moved away on purpose, is left alone.
 */
export function useWaitingFocus(card: RefObject<HTMLElement | null>, requestId: string, closing: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const giveBack = (node: HTMLElement | null) => {
    const active = document.activeElement;
    const stranded = active === document.body || !active?.isConnected || (node && active instanceof HTMLElement && node.contains(active));
    if (stranded && opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  };
  useEffect(() => {
    const node = card.current;
    if (!node) return;
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!(prior && node.contains(prior))) {
      opener.current = prior;
      node.focus({ preventScroll: true });
    }
    return () => giveBack(node);
    // Each card mounts once per request id (the parent keys them); the exit is
    // driven by the `closing` flag below.
  }, [requestId]);
  useEffect(() => { if (closing) giveBack(card.current); }, [closing]);
}

/** Esc inside a field belongs to the field: it must not bubble to the window handler that reads it as "stop the turn". */
export function keepFieldEscape(event: KeyboardEvent<HTMLElement>) {
  if (event.key === "Escape" && event.target !== event.currentTarget) {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) event.stopPropagation();
  }
}

export function UserInputCard({ request, disabled, closing = false, agentName = "Muse" }: { request: UserInputRequest; disabled: boolean; closing?: boolean; agentName?: string }) {
  const respond = useAppStore((state) => state.respondUserInput);
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [clarifying, setClarifying] = useState(false);
  const [clarification, setClarification] = useState("");
  const [error, setError] = useState("");
  const card = useRef<HTMLElement>(null);
  const titleId = useId();
  const edit = (id: string, patch: AnswerDraft) => setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const send = (response: UserInputResponse) => {
    setError("");
    void respond(request.sessionId, request.userInputId, response);
  };
  useWaitingFocus(card, request.userInputId, closing);
  const submit = () => {
    const answers: UserInputAnswer[] = [];
    for (const question of request.questions) {
      const draft = drafts[question.id] ?? {};
      if (draft.freeText || !question.options.length) {
        if (!draft.text?.trim()) { setError(`Enter an answer for ${question.header || question.question}.`); return; }
        answers.push({ questionId: question.id, freeText: draft.text.trim() });
      } else {
        const labels = draft.labels ?? [];
        const multiple = question.selection.mode === "multiple";
        const min = multiple ? question.selection.minSelections ?? 1 : 1;
        const max = multiple ? question.selection.maxSelections ?? question.options.length : 1;
        if (labels.length < min || labels.length > max) {
          setError(`Choose ${min === max ? min : `${min}–${max}`} option(s) for ${question.header || question.question}.`);
          return;
        }
        answers.push(multiple ? { questionId: question.id, selectedLabels: labels } : { questionId: question.id, selectedLabel: labels[0] });
      }
    }
    send({ action: "answer", answers });
  };
  return <section ref={card} className={`approval user-input${closing ? " closing" : ""}`} role="alertdialog" aria-labelledby={titleId} tabIndex={-1}
    onKeyDown={keepFieldEscape}>
    <h3 id={titleId}>{agentName} needs your input</h3>
    <fieldset disabled={disabled || closing} className="settings-fields">
      {clarifying ? <label className="field">Explain what {agentName} should consider instead
        <textarea rows={3} maxLength={500} value={clarification} onChange={(event) => setClarification(event.target.value)} />
      </label> : request.questions.map((question) => {
        const draft = drafts[question.id] ?? {};
        const freeText = draft.freeText || !question.options.length;
        const multiple = question.selection.mode === "multiple";
        return <fieldset className="question" key={question.id}>
          <legend>{question.header ? `${question.header}: ` : ""}{question.question}</legend>
          {!freeText && question.options.map((option) => <label className="question-option" key={option.label}>
            <input type={multiple ? "checkbox" : "radio"} name={`${request.userInputId}:${question.id}`}
              checked={draft.labels?.includes(option.label) ?? false}
              onChange={(event) => edit(question.id, { labels: multiple ? event.target.checked ? [...(draft.labels ?? []), option.label] : (draft.labels ?? []).filter((label) => label !== option.label) : [option.label] })} />
            <span>{option.label}{option.description && <small>{option.description}</small>}{option.preview && <pre>{option.preview.content}</pre>}</span>
          </label>)}
          {freeText && <textarea aria-label={`Answer: ${question.question}`} rows={3} maxLength={500} value={draft.text ?? ""} onChange={(event) => edit(question.id, { text: event.target.value })} />}
          {question.options.length > 0 && <button type="button" className="text-btn" onClick={() => edit(question.id, { freeText: !freeText })}>{freeText ? "Choose from options" : "Write another answer"}</button>}
        </fieldset>;
      })}
      {error && <p role="alert">{error}</p>}
      <div className="choices">
        <button type="button" className="primary" disabled={clarifying && !clarification.trim()} onClick={() => clarifying ? send({ action: "clarify", text: clarification.trim() }) : submit()}>{clarifying ? "Send explanation" : "Send answers"}</button>
        <button type="button" className="chip" onClick={() => { setClarifying(!clarifying); setError(""); }}>{clarifying ? "Back to questions" : "Let me explain"}</button>
        <button type="button" className="text-btn" onClick={() => send({ action: "cancel" })}>Decline to answer</button>
      </div>
    </fieldset>
  </section>;
}
