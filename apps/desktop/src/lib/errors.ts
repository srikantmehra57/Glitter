export type ErrorAction = "settings" | "retry" | "reconnect" | "dismiss";

export type ClassifiedError = {
  code: string;
  title: string;
  detail: string;
  action: ErrorAction;
  lost: string;
};

const CLOSED = /connection closed|agent stopped|agent process|bridge/i;
const TIMEOUT = /timed out/i;
const NETWORK = /network|offline|econnrefused|enotfound/i;

/**
 * Grant-loss wording crosses the IPC seam in more than one voice: the
 * renderer's own UNGRANTED_ERROR ("is not granted") and the native store's
 * "Unknown workspace grant" / "Workspace folder no longer exists". This one
 * pattern is the de-facto contract — matching prose at each call site is what
 * let the two halves drift. Both are fixed by re-opening the folder, which is
 * what the Open workspace CTA does.
 */
export const GRANT_WORDING = /is not granted|unknown workspace grant|folder no longer exists/i;

/** True for errors whose fix is re-opening the folder through Open workspace. */
export function isGrantError(text: string | null | undefined): boolean {
  return Boolean(text && GRANT_WORDING.test(text));
}

/** Harness failure codes the agent process preserves beside the message, mapped to recovery branches. */
const KIND_BRANCH: Record<string, Omit<ClassifiedError, "detail">> = {
  MISSING_CREDENTIAL: { code: "auth", title: "The provider needs an API key", action: "settings", lost: "The draft is kept. Nothing was sent." },
  INVALID_CREDENTIAL: { code: "auth", title: "The provider rejected the API key", action: "settings", lost: "The draft is kept. Replace the key in Settings → Models & providers." },
  RATE_LIMIT: { code: "busy", title: "The provider is rate limiting", action: "retry", lost: "Retry in a bit." },
  SERVER: { code: "busy", title: "The provider is busy", action: "retry", lost: "Retry in a bit." },
  CONTEXT_WINDOW_EXCEEDED: { code: "invalid", title: "Too much input for this model", action: "retry", lost: "Compact the thread, shorten the prompt or drop attachments, then retry." },
  skillNotFound: { code: "invalid", title: "Skill unavailable", action: "retry", lost: "The skill list changed and was refreshed. Pick the skill again." },
};

export function classifyError(error: unknown, fallback = "Something went wrong"): ClassifiedError {
  const detail = error instanceof Error ? error.message : String(error || fallback);
  const kind = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
  const branch = kind ? KIND_BRANCH[kind] : undefined;
  if (branch) return { ...branch, detail };
  if (GRANT_WORDING.test(detail)) {
    // The detail already carries the recovery wording on both sides of the seam.
    return { code: "grant", title: "This folder is not granted", detail, action: "retry", lost: "Nothing was lost." };
  }
  if (TIMEOUT.test(detail)) {
    return { code: "timeout", title: "The agent did not respond in time", detail, action: "retry", lost: "The request may still be running. Check the thread before retrying." };
  }
  if (CLOSED.test(detail) || NETWORK.test(detail)) {
    return { code: "host", title: "The agent disconnected", detail, action: "reconnect", lost: "Completed work is saved. Open the thread again to restore it." };
  }
  return { code: "unknown", title: fallback, detail, action: "retry", lost: "Check the thread before retrying." };
}

/** A call whose result is unknown: it timed out locally, so the work may still have landed. */
export function timeoutUnknown(error: unknown): boolean {
  if (error instanceof Error && (error as Error & { code?: string }).code === "timeout-unknown") return true;
  const detail = error instanceof Error ? error.message : String(error ?? "");
  return TIMEOUT.test(detail) && /result is unknown/i.test(detail);
}

/**
 * One sentence for the user about a failed action. Agent, git and native
 * exceptions arrive as `Error: fatal: pathspec …`; the exception prefix is
 * dropped and a recognized failure (auth, agent gone, timeout)
 * is replaced by its classification plus recovery guidance, which is what the
 * user can act on. Anything unrecognized keeps its own reason, because that is
 * often the only specific part — a locked keychain, a pathspec miss.
 */
export function describeError(action: string, cause: unknown): string {
  const classified = classifyError(cause, action);
  const detail = classified.detail.replace(/^error:\s*/i, "").trim();
  if (classified.code === "unknown") return detail ? `${action}: ${detail}` : `${action}.`;
  return [`${classified.title}.`, detail, classified.lost].filter(Boolean).join(" ");
}
