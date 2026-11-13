import { useRef } from "react";
import { useModalDialog } from "../lib/dialogFocus";
import { useRetained } from "../lib/presence";
import { LoaderCircle, ScanSearch, X } from "lucide-react";
import { useAppStore } from "../lib/store";
import type { TranscriptItem } from "../lib/types";

const CHILD_ITEMS = 40;
const SNIPPET = 280;

function snippet(item: TranscriptItem): string {
  const text = item.text ?? item.fallbackText ?? "";
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
}

function role(item: TranscriptItem): string {
  if (item.kind === "userMessage") return "You";
  if (item.kind === "agentMessage") return "Agent";
  if (item.kind === "toolCall") return item.tool ? `Tool · ${item.tool}` : "Tool";
  if (item.kind === "compaction") return "Compaction";
  return item.kind;
}

/**
 * Child drill-down: a delegated child's result plus its transcript, read
 * without attaching (`readChildSession`).
 */
export function SubagentModal() {
  const open = useAppStore((s) => s.childSession);
  // Drawn from the last child view while the dialog animates out.
  const viewing = useRetained(open);
  const close = useAppStore((s) => s.closeChild);
  const dialog = useRef<HTMLDialogElement>(null);

  useModalDialog(Boolean(open), dialog);

  const items = viewing?.items ?? [];
  const shown = items.slice(-CHILD_ITEMS);
  const result = viewing?.result ?? null;

  if (!viewing) return null;

  return <dialog ref={dialog} className="modal preview-dialog" aria-labelledby="child-title" aria-hidden={!open} onCancel={(event) => { event.preventDefault(); close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <header className="settings-header">
      <div>
        <h2 id="child-title">{viewing?.title ?? "Subagent"}</h2>
        <p>Read-only child thread — nothing here attaches it.</p>
      </div>
      <button type="button" className="icon-btn settings-close" aria-label="Close child view" onClick={close}><X size={16} /></button>
    </header>
    {!viewing ? null : viewing.loading ? (
      <p className="review-note"><LoaderCircle size={13} className="spin" aria-hidden="true" /> Reading child transcript…</p>
    ) : (
      <>
        {result ? (
          <section className="child-result" aria-label="Child result">
            <div className="monitor-heading"><span>Result</span></div>
            <p className="child-summary">{result.summary}</p>
            {result.text ? <pre className="child-text">{result.text}</pre> : null}
            {result.errorKind ? <p className="review-note" role="alert">Failed: {result.errorKind}</p> : null}
            {result.artifactRefs.length || result.evidenceRefs.length ? (
              <ul className="child-refs">
                {result.artifactRefs.map((ref) => <li key={`a:${ref}`}>Artifact · {ref}</li>)}
                {result.evidenceRefs.map((ref) => <li key={`e:${ref}`}>Evidence · {ref}</li>)}
              </ul>
            ) : null}
          </section>
        ) : <p className="review-note">No result yet — the child has not finished one.</p>}
        <div className="monitor-heading child-transcript-head"><span>Transcript</span></div>
        {viewing.error ? <p className="review-note" role="alert">{viewing.error}</p>
          : shown.length ? (
            <ol className="preview-items">
              {items.length > shown.length ? <li className="preview-gap" aria-hidden="true">⋯ {items.length - shown.length} earlier items</li> : null}
              {shown.map((item) => (
                <li key={item.itemId} className={`preview-item kind-${item.kind}`}>
                  <span className="preview-role">{role(item)}</span>
                  <span className="preview-text">{snippet(item) || "—"}</span>
                </li>
              ))}
            </ol>
          ) : <p className="review-note">No transcript items yet.</p>}
        <footer className="preview-foot">
          <span className="preview-note"><ScanSearch size={12} aria-hidden="true" />Point-in-time read — the child may still be writing.</span>
        </footer>
      </>
    )}
  </dialog>;
}
