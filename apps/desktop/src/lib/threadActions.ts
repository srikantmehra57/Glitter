import { APP_VERSION } from "./version";
import { openConfigFile, openPath, openUrl, supportPaths } from "./bridge";
import { describeError } from "./errors";
import { inWorktree, useAppStore } from "./store";
import { AGENT_LABELS, type Thread } from "./types";

export type ThreadActionTarget = Pick<Thread, "sessionId" | "title" | "workspacePath" | "agentId" | "worktree">;

/** The folder a thread actually uses: its worktree when it has one. */
export function threadRootPath(thread: Pick<ThreadActionTarget, "workspacePath" | "worktree">): string {
  return thread.worktree?.path ?? thread.workspacePath;
}

function actionThread(sessionId: string): ThreadActionTarget {
  const thread = useAppStore.getState().threads.find((item) => item.sessionId === sessionId);
  if (!thread) throw new Error("This thread is no longer available.");
  return thread;
}

async function perform(label: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    useAppStore.setState({ error: describeError(label, error) });
  }
}

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
  await navigator.clipboard.writeText(value);
}

export function openThreadFolder(sessionId: string): Promise<void> {
  return perform("Could not open the thread folder", async () => {
    const state = useAppStore.getState();
    const thread = actionThread(sessionId);
    const owner = state.workspaces.find((workspace) => workspace.path === thread.workspacePath);
    const scope = inWorktree(owner, thread.worktree);
    if (!scope) throw new Error("The thread's workspace is no longer available.");
    await openPath(scope.path, scope.grantId ?? "preview", "default");
  });
}

export function copyThreadPath(sessionId: string): Promise<void> {
  return perform("Could not copy the thread path", async () => copyText(threadRootPath(actionThread(sessionId))));
}

export function copySessionId(sessionId: string): Promise<void> {
  return perform("Could not copy the session ID", async () => copyText(sessionId));
}

export function copyThreadLogPath(sessionId: string): Promise<void> {
  return perform("Could not copy the task log path", async () => {
    const thread = actionThread(sessionId);
    if (thread.agentId !== "harness") throw new Error("This agent does not expose a canonical session log.");
    const paths = await supportPaths(sessionId, "harness");
    if (!paths.sessionLogPath) throw new Error("This thread has no saved session log yet.");
    await copyText(paths.sessionLogPath);
  });
}

export function copyAppLogPath(): Promise<void> {
  return perform("Could not copy the app log path", async () => {
    const paths = await supportPaths();
    await copyText(paths.appLogPath);
  });
}

export function openAppConfig(): Promise<void> {
  return perform("Could not open the config file", () => openConfigFile());
}

/** A pre-filled draft only; nothing is posted until the user submits it on GitHub. */
export function threadIssueUrl(thread: ThreadActionTarget): string {
  const params = new URLSearchParams({
    title: `Thread issue: ${thread.title.slice(0, 100)}`,
    body: [
      "## What happened?",
      "",
      "## What did you expect?",
      "",
      "## Thread",
      `Title: ${thread.title}`,
      `Session ID: ${thread.sessionId}`,
      `Agent: ${AGENT_LABELS[thread.agentId ?? "muse"]}`,
      "",
      `Glitter: ${APP_VERSION}`,
    ].join("\n"),
  });
  return `https://github.com/srikantmehra57/Glitter/issues/new?${params.toString()}`;
}

export function reportThreadIssue(sessionId: string): Promise<void> {
  return perform("Could not open the issue form", async () => {
    await openUrl(threadIssueUrl(actionThread(sessionId)));
  });
}
