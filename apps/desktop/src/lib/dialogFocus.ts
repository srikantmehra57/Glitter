import { useEffect, type RefObject } from "react";
import { EXIT_MS, motionReduced } from "./presence";

/**
 * Show and hide a native modal dialog, returning focus to whatever opened it.
 *
 * The webview implementations Tauri runs on are not consistent about restoring
 * focus after `close()`, and a keyboard user who opens Settings from the sidebar
 * gear and closes it must not be dropped onto `<body>` — from there Tab starts
 * over at the top of the page. The element focused before opening is therefore
 * remembered and re-focused explicitly.
 *
 * Closing is immediate for focus, inertness and the `close` event. Only the
 * pixels linger: the closed dialog carries `data-closing` for one exit, which
 * the stylesheet uses to keep it drawn while it fades. The caller keeps the
 * dialog mounted for that long (see `usePresence`).
 */
/**
 * Elements focused before each dialog opened, oldest first. Closing restores
 * the topmost entry that is still valid: connected and not inside a closed
 * dialog. Entries are peeked, not popped — a close only evicts entries that
 * are no longer valid, so a restore that runs early (before a chained dialog
 * mounts) cannot consume the entries a later close will need. A single
 * remembered opener is not enough regardless: when dialogs chain (palette →
 * Settings), the inner dialog's opener lives inside the dialog that closed
 * under it, and the real restore target sits one level deeper.
 */
const focusTrail: HTMLElement[] = [];

/** Record the element focused right before a dialog opens. */
export function rememberDialogFocus() {
  const opener = document.activeElement;
  if (opener instanceof HTMLElement && opener !== document.body && !opener.closest("dialog:not([open])")) focusTrail.push(opener);
  if (focusTrail.length > 16) focusTrail.splice(0, focusTrail.length - 16);
}

/**
 * Gap between blur() and focus() in a re-attach. It must be a real task, not
 * a frame: the webview only re-attaches text input when the refocus runs a
 * macrotask after the blur, so a same-frame blur+focus — and even a
 * blur/focus pair split by requestAnimationFrame — leaves the dead state.
 */
const REATTACH_MS = 60;
/** Re-attach passes after a close, covering top-layer teardown that outlives
 * the close event (the dialog stays mounted for its exit, then unmounts). */
const REATTACH_AT = [EXIT_MS + 120, EXIT_MS + 420];
/** Delay between the close event and the deferred restore pass — long enough
 * for top-layer teardown to settle focus first. */
const RESTORE_MS = 40;
/** How long the focus watchdog stays armed after a restore. The webview's own
 * close-restore can fire deep into the dialog's exit lifetime and beyond. */
const WATCH_MS = 2000;

/**
 * Depth of blur-to-focus re-attach transitions currently in flight. While one
 * is pending, focus legitimately sits on <body> for the re-attach gap, so the
 * watchdog must not mistake that transit for a stolen focus.
 */
let detachDepth = 0;

/**
 * Focus `target`, first detaching on a later task when the browser already
 * considers it active. Top-layer teardown can leave an element half-focused —
 * activeElement set, keydowns landing, input events never firing — and only a
 * blur followed by a genuinely later focus() rebuilds the input attachment.
 */
function refocus(target: HTMLElement) {
  if (document.activeElement !== target) {
    target.focus();
    return;
  }
  detachDepth++;
  target.blur();
  window.setTimeout(() => {
    detachDepth--;
    if (target.isConnected && !modalOpen()) target.focus();
  }, REATTACH_MS);
}

/**
 * Deferred focus restore shared by every dialog close path. Runs shortly
 * after the close event, past top-layer teardown, and does nothing while
 * another modal is open so a deferred command's dialog keeps its focus. The
 * restored element is the trail's topmost valid entry.
 *
 * Two defences cover teardown that outlives the close dispatch. Re-attach
 * passes re-run through the exit lifetime and beyond, each only acting while
 * our target is still the active element. And a focus watchdog re-claims the
 * target whenever focus settles somewhere it can never legitimately stay —
 * <body>, a detached element, or inside a closed dialog — which is where the
 * webview's own restore aims when the closed dialog's opener lived inside a
 * dialog that closed under it. Both are invisible once focus genuinely
 * settled on a live element elsewhere.
 */
export function restoreDialogFocus() {
  window.setTimeout(() => {
    if (modalOpen()) return;
    while (focusTrail.length) {
      const target = focusTrail[focusTrail.length - 1];
      if (!target.isConnected || target.closest("dialog:not([open])")) { focusTrail.pop(); continue; }
      // A real `input` event proves the attachment is healthy — once one has
      // landed the re-attach passes have nothing to fix, and skipping them
      // keeps their blur/focus blackout from eating a fast typist's keys.
      // And a keydown that produces no input within the re-attach gap proves
      // it dead: repair on that keystroke instead of waiting for a timed
      // pass, so a teardown that lands late still loses at most one char.
      let inputSeen = false;
      let keySeen = 0;
      const noteInput = () => { inputSeen = true; };
      const noteKey = () => {
        const stamp = ++keySeen;
        window.setTimeout(() => {
          if (keySeen !== stamp || inputSeen || document.activeElement !== target || !target.isConnected || modalOpen()) return;
          refocus(target);
        }, REATTACH_MS + 30);
      };
      target.addEventListener("input", noteInput);
      target.addEventListener("keydown", noteKey);
      const reattach = () => {
        if (inputSeen || document.activeElement !== target || !target.isConnected || modalOpen()) return;
        refocus(target);
      };
      refocus(target);
      for (const delay of REATTACH_AT) window.setTimeout(reattach, delay);
      window.setTimeout(() => {
        target.removeEventListener("input", noteInput);
        target.removeEventListener("keydown", noteKey);
      }, REATTACH_AT[REATTACH_AT.length - 1] + REATTACH_MS + 40);
      const watch = () => {
        if (detachDepth > 0) return;
        window.setTimeout(() => {
          if (detachDepth > 0 || modalOpen()) return;
          const el = document.activeElement;
          if (!(el instanceof HTMLElement) || el === target) return;
          if (el === document.body || !el.isConnected || el.closest("dialog:not([open])")) {
            refocus(target);
            window.setTimeout(reattach, REATTACH_MS + 80);
          }
        }, 0);
      };
      document.addEventListener("focusin", watch);
      document.addEventListener("focusout", watch);
      window.setTimeout(() => {
        document.removeEventListener("focusin", watch);
        document.removeEventListener("focusout", watch);
      }, WATCH_MS);
      return;
    }
  }, RESTORE_MS);
}

/**
 * Run `fn` once the pending close's focus restore has settled — later than the
 * deferred pass plus the re-attach gap. Commands that move focus themselves
 * (focus a field, open a picker) must wait for this or the restore steals the
 * focus they just claimed.
 */
export function afterDialogRestore(fn: () => void) {
  window.setTimeout(fn, RESTORE_MS + REATTACH_MS + 40);
}

/**
 * True while any modal surface holds the page — a native top-layer dialog or
 * an overlay the app renders itself with `aria-modal` (the image viewer).
 * Shortcut and mutation guards must consult this, not `dialog[open]` alone,
 * or chords keep mutating state behind a non-native modal.
 */
export function modalOpen() {
  return Boolean(document.querySelector('dialog[open], [aria-modal="true"]'));
}

export function useModalDialog(open: boolean, ref: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (open) {
      node.removeAttribute("data-closing");
      if (node.open) return;
      rememberDialogFocus();
      node.showModal();
      // Reading `open` back guards against a webview that refused to show it.
      if (!node.open) return;
      const restore = () => {
        node.removeEventListener("close", restore);
        restoreDialogFocus();
      };
      node.addEventListener("close", restore);
      return () => node.removeEventListener("close", restore);
    }
    return closeDialog(node);
  }, [open, ref]);
}

/**
 * Close a dialog the app itself dismissed and leave it drawn for one exit.
 * Returns the cleanup for the caller's effect.
 */
export function closeDialog(node: HTMLDialogElement): (() => void) | undefined {
  if (!node.open) return undefined;
  // The app already knows about this close. Its `close` event must not reach the
  // dialog's own handler, which would dismiss a dialog reopened in the meantime.
  node.addEventListener("close", (event) => event.stopImmediatePropagation(), { capture: true, once: true });
  node.close();
  // The close-listener restore path never runs here — the caller's effect
  // cleanup detaches it before close() — so the restore has to be scheduled
  // from the close itself.
  restoreDialogFocus();
  if (motionReduced()) return undefined;
  node.setAttribute("data-closing", "");
  const timer = window.setTimeout(() => node.removeAttribute("data-closing"), EXIT_MS);
  return () => { window.clearTimeout(timer); node.removeAttribute("data-closing"); };
}
