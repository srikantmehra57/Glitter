import { reviewPrompt } from "./composerText";
import { isMacPlatform, threadStatusLines } from "./format";
import { bindingFor, chordLabel, type ShortcutId } from "./shortcuts";
import { currentThread, useAppStore } from "./store";
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

/**
 * Run a built-in slash command by name. Slash, the palette and shortcuts all
 * come through here. Returns prompt text for the composer when the command
 * drafts one instead of acting.
 */
export function runBuiltinCommand(name: string): string | undefined {
  const state = useAppStore.getState();
  const thread = currentThread(state);
  switch (name) {
    case "new": void state.newThread(); break;
    case "compact": void state.compactThread(); break;
    case "rename": if (thread) state.requestTitleEdit(); break;
    case "model": case "effort": case "permissions": openPicker(name); break;
    case "status":
      if (thread) void state.confirm({ title: thread.title, body: threadStatusLines(thread, AGENT_LABELS.harness).join("\n"), confirmLabel: "Done", info: true });
      break;
    case "mcp": case "skills": state.setSettingsOpen(true, "Extensions"); break;
    case "review": return reviewPrompt(state.reviewScope, state.reviewBase);
  }
  return undefined;
}
