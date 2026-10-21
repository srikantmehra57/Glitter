import { exportSession } from "./bridge";
import { reviewPrompt } from "./composerText";
import { describeError } from "./errors";
import { isMacPlatform, threadStatusLines } from "./format";
import { bindingFor, chordLabel, type ShortcutId } from "./shortcuts";
import { currentThread, currentWorkspace, useAppStore } from "./store";
import { AGENT_LABELS } from "./types";

/** The current key label for a remappable shortcut, as it should appear in a tooltip or menu. */
export function shortcutText(id: ShortcutId): string {
  return chordLabel(bindingFor(id, useAppStore.getState().shortcutOverrides), isMacPlatform());
}

export type PickerKind = "model" | "effort" | "permissions";

const PICKER_TRIGGERS: Record<PickerKind, string> = {
  model: ".composer-foot #model-picker",
  effort: ".composer-foot #effort-meter",
  permissions: "#approval",
};

/**
 * Open one of the composer's pickers as if its trigger were clicked. The
 * pickers own their open state, so the trigger is the one way in; a locked or
 * absent picker stays closed. Returns whether it opened.
 */
export function openPicker(kind: PickerKind): boolean {
  const trigger = document.querySelector<HTMLElement>(PICKER_TRIGGERS[kind]);
  if (!trigger || (trigger instanceof HTMLButtonElement && trigger.disabled) || trigger.getAttribute("aria-disabled") === "true") return false;
  trigger.focus();
  if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
  return true;
}

/** Export a Muse thread through the native save dialog and report where it went. */
export async function exportThread(thread: { sessionId: string; title: string }, redacted: boolean, format: "json" | "markdown" = "json"): Promise<void> {
  const store = useAppStore.getState();
  // The app's own dialog, not a native alert: it matches the UI and does not freeze the window.
  try {
    const path = await exportSession({ sessionId: thread.sessionId, title: thread.title, museBin: store.museBin, redacted, markdown: format === "markdown" });
    if (path) await store.confirm({ title: "Session exported", body: path, confirmLabel: "Done", info: true });
  } catch (error) {
    await store.confirm({ title: "Could not export this Muse thread", body: describeError("Could not export this thread", error), confirmLabel: "OK", info: true });
  }
}

/**
 * Run a built-in slash command by name. Slash, the palette and shortcuts all
 * come through here. Returns prompt text for the composer when the command
 * drafts one instead of acting.
 */
export function runBuiltinCommand(name: string): string | undefined {
  const state = useAppStore.getState();
  const thread = currentThread(state);
  const workspace = currentWorkspace(state);
  switch (name) {
    case "new": void state.newThread(); break;
    case "compact": void state.compactThread(); break;
    case "fork": void state.forkThread(); break;
    case "rename": if (thread) state.requestTitleEdit(); break;
    case "model": case "effort": case "permissions": openPicker(name); break;
    case "init": if (workspace) void state.openInitDialog(workspace.id); break;
    case "status":
      if (thread) void state.confirm({ title: thread.title, body: threadStatusLines(thread, state.agents.find((agent) => agent.id === (thread.agentId ?? "muse"))?.name ?? AGENT_LABELS[thread.agentId ?? "muse"]).join("\n"), confirmLabel: "Done", info: true });
      break;
    case "mcp": case "skills": state.setSettingsOpen(true, "Extensions"); break;
    case "export": if (thread && !thread.agentId) void exportThread(thread, true); break;
    case "review": return reviewPrompt(state.reviewScope, state.reviewBase);
  }
  return undefined;
}
