import { useEffect, useRef, useState } from "react";
import { GitBranch, GitCommitHorizontal, Upload, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useModalDialog } from "../lib/dialogFocus";
import { describeError } from "../lib/errors";
import { useRetained } from "../lib/presence";
import { activeWorkspace, currentThread, useAppStore } from "../lib/store";

export type CommitOperation = "commit" | "commit-push" | "push";
export type CommitDialogRequest = { id: number; operation?: CommitOperation };

type DialogContext = { requestId: number; scopeKey: string; sessionId: string | null };
type PendingDraft = DialogContext & { operation: CommitOperation; includeUnstaged: boolean; baselineSeq: number };
type PendingOperation = DialogContext & { operation: CommitOperation; includeUnstaged: boolean; message: string };

const scopeKeyFor = (workspace: { id: string; grantId?: string | null } | undefined) => workspace ? `${workspace.id}\u0000${workspace.grantId ?? ""}` : "";

/** The app's one commit/push form, shared by Changes and Environment. */
export function CommitDialog({ request, onClose, onNotice }: {
  request: CommitDialogRequest | null;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const dialog = useRetained(request);
  const open = Boolean(request);
  const node = useRef<HTMLDialogElement>(null);
  const messageNode = useRef<HTMLTextAreaElement>(null);
  const continueNode = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<DialogContext | null>(null);
  const pendingDraft = useRef<PendingDraft | null>(null);
  const [message, setMessage] = useState("");
  const [operation, setOperation] = useState<CommitOperation>("commit");
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [busy, setBusy] = useState<"draft" | "commit" | "push" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = useAppStore(useShallow((state) => ({
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    threads: state.threads,
    git: state.git,
    commitDraft: state.commitDraft,
    commitDrafting: state.commitDrafting,
  })));
  const workspace = activeWorkspace(s);
  const scopeKey = scopeKeyFor(workspace);
  const files = s.git?.files ?? [];
  const stagedCount = files.filter((file) => file.status[0] !== " " && file.status[0] !== "?").length;
  const unstagedCount = files.filter((file) => file.status === "??" || (file.status[1] ?? " ") !== " ").length;
  const canCommit = stagedCount > 0 || (includeUnstaged && unstagedCount > 0);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);

  useModalDialog(open, node);

  const isCurrent = (context: DialogContext, requireThread = false) => {
    const state = useAppStore.getState();
    const liveWorkspace = activeWorkspace(state);
    const liveScope = scopeKeyFor(liveWorkspace);
    const held = contextRef.current;
    if (!held || held.requestId !== context.requestId || held.scopeKey !== context.scopeKey || liveScope !== context.scopeKey) return false;
    return !requireThread || currentThread(state)?.sessionId === context.sessionId;
  };

  const cancel = () => {
    // A native commit/push cannot be recalled. Keep the progress visible rather
    // than pretending Close cancelled it; a workspace switch still blocks any
    // subsequent push through isCurrent.
    if (busy === "commit" || busy === "push") return;
    pendingDraft.current = null;
    contextRef.current = null;
    onClose();
  };

  const execute = async (pending: PendingOperation) => {
    if (!isCurrent(pending)) return;
    const { operation: action, includeUnstaged: include, message: text } = pending;
    setError(null);
    setBusy(action === "push" ? "push" : "commit");
    let committed = false;
    try {
      if (action !== "push") {
        await useAppStore.getState().commitGit(text, include);
        committed = true;
        if (!isCurrent(pending)) return;
        setMessage("");
      }
      if (action !== "commit") {
        if (!isCurrent(pending)) return;
        setBusy("push");
        const pushed = await useAppStore.getState().pushBranch();
        if (!isCurrent(pending)) return;
        onNotice(`${committed ? "Committed and pushed" : "Pushed"} ${pushed.branch} to ${pushed.remote}.`);
      } else {
        const branch = useAppStore.getState().git?.branch;
        onNotice(`Committed${branch ? ` ${branch}` : ""}.`);
      }
      contextRef.current = null;
      onClose();
    } catch (cause) {
      if (!isCurrent(pending)) return;
      if (committed) {
        // Retry only the push. Calling Continue must never create the same
        // commit twice after the remote side failed.
        setOperation("push");
        setMessage("");
        setError(describeError("Committed, but could not push", cause));
      } else {
        const failure = action === "push" ? "Could not push" : include ? "Could not commit; included changes may now be staged" : "Could not commit the staged changes";
        setError(describeError(failure, cause));
      }
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!request) return;
    const state = useAppStore.getState();
    const workspace = activeWorkspace(state);
    contextRef.current = { requestId: request.id, scopeKey: scopeKeyFor(workspace), sessionId: currentThread(state)?.sessionId ?? null };
    pendingDraft.current = null;
    setMessage("");
    setIncludeUnstaged(true);
    setError(null);
    setBusy(null);
    setOperation(request.operation ?? (state.git?.files.length ? "commit" : "push"));
  }, [request?.id]);

  useEffect(() => {
    const context = contextRef.current;
    if (!request || !context || context.scopeKey === scopeKey) return;
    pendingDraft.current = null;
    contextRef.current = null;
    onClose();
  }, [request, scopeKey]);

  useEffect(() => {
    if (!request) return;
    const initial = request.operation ?? (files.length ? "commit" : "push");
    if (initial === "push") continueNode.current?.focus();
    else messageNode.current?.focus();
  }, [request?.id]);

  useEffect(() => {
    const pending = pendingDraft.current;
    if (!pending) return;
    const draft = s.commitDraft;
    if (draft && draft.sessionId === pending.sessionId && draft.seq > pending.baselineSeq) {
      pendingDraft.current = null;
      if (!isCurrent(pending, true)) { setBusy(null); return; }
      setMessage(draft.text);
      void execute({ ...pending, message: draft.text });
      return;
    }
    if (s.commitDrafting !== pending.sessionId) {
      pendingDraft.current = null;
      setBusy(null);
      if (isCurrent(pending, true)) {
        const failure = currentThread(useAppStore.getState())?.error;
        setError(failure || "The agent did not return a commit message. Write one or try again.");
      }
    }
  }, [s.commitDraft?.seq, s.commitDrafting]);

  if (!dialog) return null;

  const beginDraft = async () => {
    const context = contextRef.current;
    if (!context || busy) return;
    const pending: PendingDraft = { ...context, operation, includeUnstaged, baselineSeq: useAppStore.getState().commitDraft?.seq ?? 0 };
    pendingDraft.current = pending;
    setError(null);
    setBusy("draft");
    try {
      await useAppStore.getState().draftCommitMessage(includeUnstaged);
    } catch (cause) {
      if (pendingDraft.current !== pending) return;
      pendingDraft.current = null;
      setBusy(null);
      if (isCurrent(pending, true)) setError(describeError("Could not draft a message", cause));
    }
  };

  const repository = Boolean(workspace) && s.git?.repository !== false;
  const branch = s.git?.branch ?? "";
  const canContinue = !busy && repository && (operation === "push" ? Boolean(branch) : canCommit && (operation === "commit" || Boolean(branch)));
  const submit = () => {
    const context = contextRef.current;
    if (!context || !canContinue) return;
    const text = message.trim();
    if (operation !== "push" && !text) { void beginDraft(); return; }
    void execute({ ...context, operation, includeUnstaged, message: text });
  };
  const continueLabel = busy === "draft" ? "Generating…" : busy === "commit" ? "Committing…" : busy === "push" ? "Pushing…" : "Continue";
  const operations: Array<{ id: CommitOperation; label: string; available: boolean }> = [
    { id: "commit", label: "Commit", available: canCommit },
    { id: "commit-push", label: "Commit and push", available: canCommit && Boolean(branch) },
    { id: "push", label: "Push", available: Boolean(branch) },
  ];

  return <dialog ref={node} className="modal commit-dialog" aria-labelledby="commit-dialog-title" aria-hidden={!open} onCancel={(event) => { event.preventDefault(); cancel(); }} onClose={cancel} onClick={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <form className="commit-dialog-form" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      <header className="commit-dialog-head">
        <h2 id="commit-dialog-title">Commit or push</h2>
        <button type="button" className="icon-btn" aria-label="Close commit or push dialog" disabled={busy === "commit" || busy === "push"} onClick={cancel}><X size={16} /></button>
      </header>
      <div className="commit-dialog-meta">
        <GitBranch size={15} aria-hidden="true" />
        <span className="commit-dialog-branch" title={branch}>{branch || "No branch"}</span>
        <span className="grow" />
        <span className={`add${added ? "" : " zero"}`}>+{added}</span>
        <span className={`del${removed ? "" : " zero"}`}>−{removed}</span>
      </div>
      <textarea ref={messageNode} className="commit-dialog-message" aria-label="Commit message" placeholder="Commit message (leave blank to auto-generate)..." rows={5} maxLength={2000} value={message} disabled={operation === "push" || Boolean(busy)} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          if (canContinue) event.currentTarget.form?.requestSubmit();
        }
      }} />
      <label className="commit-dialog-include"><input type="checkbox" checked={includeUnstaged} disabled={operation === "push" || Boolean(busy)} onChange={(event) => setIncludeUnstaged(event.target.checked)} />Include unstaged changes</label>
      {busy === "draft" ? <p className="commit-dialog-status" role="status">Drafting a commit message in this thread…</p> : null}
      {operation !== "commit" && !busy ? <p className="commit-dialog-status">Uses your own git credentials. Never force-pushes.</p> : null}
      {error ? <p className="commit-dialog-error" role="alert">{error}</p> : null}
      <div className="commit-dialog-operations">
        {operations.map((option) => <div className={`commit-dialog-operation${operation === option.id ? " selected" : ""}`} key={option.id}>
          <label>
            <input type="radio" name={`commit-operation-${dialog.id}`} value={option.id} checked={operation === option.id} disabled={Boolean(busy) || !option.available} onChange={() => { setOperation(option.id); setError(null); }} />
            {option.id === "commit" ? <GitCommitHorizontal size={16} aria-hidden="true" /> : <Upload size={16} aria-hidden="true" />}
            <span>{option.label}</span>
          </label>
          {operation === option.id ? <button ref={continueNode} type="submit" className="secondary commit-dialog-continue" disabled={!canContinue}>{continueLabel}</button> : null}
        </div>)}
      </div>
    </form>
  </dialog>;
}
