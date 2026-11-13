import { lazy, Suspense, useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { LoaderCircle } from "lucide-react";
import { activeConfig, applyTheme, bindBridgeEvents, currentThread, useAppStore } from "./lib/store";
import { isTauri } from "./lib/format";
import { defaultTier, isPeak, modelFor, tiersFor } from "./lib/effort";
import { sidebarWidthFor, subscribeResize } from "./lib/reviewLayout";
import { CommandPalette } from "./components/CommandPalette";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ImageViewer } from "./components/ImageViewer";
import { Onboarding } from "./components/Onboarding";
import { Presence } from "./components/Presence";
import { SubagentModal } from "./components/SubagentModal";
import { TrustModal } from "./components/TrustModal";
import { Sidebar } from "./components/Sidebar";
import { ThreadView } from "./components/ThreadView";
import { openPicker } from "./lib/commands";
import { modalOpen } from "./lib/dialogFocus";
import { actionFor, chordOf, menuOwned, shortcutForMenu, type ShortcutId } from "./lib/shortcuts";
import "@fontsource-variable/inter";
import "@fontsource-variable/google-sans";
import "./styles.css";
import "./settings.css";

const SettingsModal = lazy(() => import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal })));

const focusThreadSearch = () => document.getElementById("thread-search")?.focus();

/** ⌘F finds within the open thread. With no transcript to search it falls back to the thread search. */
function findInThread() {
  const state = useAppStore.getState();
  if (currentThread(state)?.items.length) state.setFindOpen(true);
  else focusThreadSearch();
}

/**
 * Actions that may still run while a modal dialog is open: they only rescale the
 * view, which the open dialog visibly shares. Everything else — navigation,
 * archiving, pane toggles, pickers, opening another surface — stays inert behind
 * a modal, since its effect would be hidden from the user.
 */
const SAFE_BEHIND_MODAL: ReadonlySet<ShortcutId> = new Set(["zoom-in", "zoom-out", "zoom-reset"]);

/** Run a rebindable shortcut's action. The key handler and the native menu both end here. */
function runShortcut(id: ShortcutId) {
  const state = useAppStore.getState();
  // A modal makes the rest of the app inert. The guard lives here, not in the
  // keydown path, because native menu events reach this function directly.
  if (!SAFE_BEHIND_MODAL.has(id) && modalOpen()) return;
  switch (id) {
    case "palette": state.setPaletteOpen(true); break;
    case "settings": state.setSettingsOpen(true); break;
    case "shortcuts": state.setSettingsOpen(true, "Shortcuts"); break;
    case "open-workspace": void state.chooseProject(); break;
    case "toggle-sidebar": state.setSidebarCollapsed(!state.sidebarCollapsed); break;
    case "toggle-changes":
      if (!state.dockOpen && (state.inspectorTab === "activity" || state.inspectorTab === "environment" || state.inspectorTab === "files")) state.setInspectorTab("changes");
      state.setDockOpen(!state.dockOpen);
      break;
    case "terminal": state.setTerminalOpen(!state.terminalOpen); break;
    case "zoom-in": state.zoomBy(1); break;
    case "zoom-out": state.zoomBy(-1); break;
    case "zoom-reset": state.zoomBy(0); break;
    case "new-thread": void state.newThread(); break;
    case "find": findInThread(); break;
    case "search-threads": {
      // The field lives in the sidebar behind its search icon; opening it also expands a collapsed sidebar.
      state.setThreadSearchOpen(true);
      window.setTimeout(focusThreadSearch, 0);
      break;
    }
    case "next-thread": void state.selectAdjacentThread(1); break;
    case "previous-thread": void state.selectAdjacentThread(-1); break;
    case "attention": void state.selectNextAttentionThread(); break;
    case "archive": if (state.selectedSessionId) state.archiveThread(state.selectedSessionId); break;
    case "model": case "effort": case "permissions": openPicker(id); break;
  }
}

function useDesktopShortcuts() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        const state = useAppStore.getState();
        if (state.paletteOpen) { event.preventDefault(); state.setPaletteOpen(false); return; }
        // A menu inside Settings that already took this Escape closes alone.
        if (state.settingsOpen) { if (!event.defaultPrevented) { event.preventDefault(); state.setSettingsOpen(false); } return; }
        // Esc stops a running turn — the Stop button promises it. Only when nothing
        // else claimed the key (a menu, the composer's own handling) and no modal is
        // open, and only from the page itself, so it can never fire from a text field
        // where Esc means something else. An editable target is what decides that,
        // not DOM position: in-transcript fields (denial feedback, question answers)
        // sit inside .conversation and must not lose their draft to a stopped turn.
        if (event.defaultPrevented || modalOpen()) return;
        const target = event.target as HTMLElement | null;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable === true) return;
        if (target && target !== document.body && target.tagName !== "MAIN" && !target.closest(".conversation")) return;
        const thread = currentThread(state);
        if (thread?.status === "running" && !thread.cancelRequested) { event.preventDefault(); void state.stopTurn(); }
        return;
      }
      if (!meta) return;
      // Behind an open dialog the rest of the app is inert: thread navigation,
      // approvals and pane toggles must not run where their effect is hidden.
      // runShortcut repeats the same guard for native menu dispatches.
      const modal = modalOpen();
      // Ctrl+Tab on every platform, as in browsers and editors. ⌘Tab belongs to the OS.
      if (event.key === "Tab" && event.ctrlKey && !event.metaKey && !event.altKey) {
        if (!modal) { event.preventDefault(); void useAppStore.getState().selectAdjacentThread(event.shiftKey ? -1 : 1); }
        return;
      }
      if (/^[1-9]$/.test(event.key) && !event.shiftKey && !event.altKey) {
        if (!modal) { event.preventDefault(); void useAppStore.getState().selectThreadAt(Number(event.key) - 1); }
        return;
      }
      // Everything rebindable goes through the shortcut table. In the desktop
      // shell the native menu owns the chords of its own items and consumes the
      // key before the webview, so those run here in the browser preview only;
      // answering them twice would toggle a pane open and shut.
      const chord = chordOf(event);
      const action = chord ? actionFor(chord, useAppStore.getState().shortcutOverrides) : undefined;
      if (action) {
        if (isTauri() && menuOwned(action)) return;
        event.preventDefault();
        runShortcut(action);
        return;
      }
      // Approval decisions: mod+Y takes the first allow choice, mod+Shift+Y the
      // wider-scoped second, mod+Backspace the first deny. Never fires while
      // typing, while a decision is in flight, or past the host deadline.
      if (event.key.toLowerCase() === "y" || event.key === "Backspace") {
        const state = useAppStore.getState();
        const thread = state.threads.find((item) => item.sessionId === state.selectedSessionId);
        const approval = thread?.pendingApproval;
        const target = event.target as HTMLElement | null;
        const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable === true;
        if (!approval || thread?.approvalPending || editable || modal) return;
        if (approval.expiresAt != null && approval.expiresAt <= Date.now()) return;
        const allow = approval.availableChoices.filter((choice) => !choice.decision.startsWith("denied"));
        const deny = approval.availableChoices.filter((choice) => choice.decision.startsWith("denied"));
        // With a scope picker on the card, the wider shortcut approves the scope it shows.
        const picked = thread?.approvalScope?.approvalId === approval.approvalId ? allow.find((option) => option.choiceId === thread.approvalScope?.choiceId) : undefined;
        const choice = event.key === "Backspace" ? deny[0] : event.shiftKey ? picked ?? allow[1] : allow[0];
        if (!choice) return;
        event.preventDefault();
        void state.decide(approval.approvalId, choice.choiceId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** Native menu items arrive as `app-menu` events carrying the item id. */
function useAppMenu() {
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = listen<{ id: string }>("app-menu", (event) => {
      const action = shortcutForMenu(event.payload.id);
      if (action) runShortcut(action);
    });
    return () => { void unlisten.then((off) => off()); };
  }, []);
}

export default function App() {
  const hydrate = useAppStore((s) => s.hydrate);
  const ready = useAppStore((s) => s.ready);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  // A dragged sidebar width clamps against the live window; without one the stylesheet's default stands.
  const savedSidebarWidth = useAppStore((s) => s.sidebarWidth);
  const viewport = useSyncExternalStore(subscribeResize, () => window.innerWidth, () => 1280);
  const sidebarStyle = savedSidebarWidth == null ? undefined : { "--sidebar-width": `${sidebarWidthFor(viewport, false, savedSidebarWidth)}px` } as CSSProperties;
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const viewingChildAgent = useAppStore((s) => s.childSession);
  const trustDialog = useAppStore((s) => s.trustDialog);
  const confirmDialog = useAppStore((s) => s.confirmDialog);
  const enterPreview = useAppStore((s) => s.enterPreview);
  const showBootPreview = import.meta.env.DEV && new URLSearchParams(window.location.search).has("boot");
  const showUsagePreview = import.meta.env.DEV && new URLSearchParams(window.location.search).get("usage") === "preview";
  const peak = useAppStore((s) => {
    const config = activeConfig(s);
    const model = modelFor(s.models, config);
    const tiers = tiersFor(model);
    return isPeak(config.effort ?? defaultTier(model, tiers), tiers);
  });
  useDesktopShortcuts();
  useAppMenu();

  useEffect(() => {
    const unbind = bindBridgeEvents();
    void hydrate();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => {
      const state = useAppStore.getState();
      if (state.theme === "system") applyTheme(state);
    };
    // Reduced transparency takes the see-through sidebar back to a solid one.
    const transparency = window.matchMedia("(prefers-reduced-transparency: reduce)");
    const updateTransparency = () => applyTheme(useAppStore.getState());
    const online = () => useAppStore.getState().setOffline(!navigator.onLine);
    // Regaining focus may surface edits made while the app was away; a single
    // debounced read settles it instead of waiting for the next turn.
    const onFocus = () => {
      const state = useAppStore.getState();
      if (state.ready && !state.preview) state.scheduleGitRefresh();
    };
    media.addEventListener("change", updateTheme);
    transparency.addEventListener("change", updateTransparency);
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    window.addEventListener("focus", onFocus);
    return () => { unbind(); media.removeEventListener("change", updateTheme); transparency.removeEventListener("change", updateTransparency); window.removeEventListener("online", online); window.removeEventListener("offline", online); window.removeEventListener("focus", onFocus); };
  }, [hydrate]);

  useEffect(() => {
    if (ready && showUsagePreview && !useAppStore.getState().preview) enterPreview();
  }, [enterPreview, ready, showUsagePreview]);

  if (!ready || showBootPreview) {
    return (
      <div className="boot" role="status" aria-live="polite" aria-busy="true" aria-label="Starting Glitter">
        <div className="boot-aurora" aria-hidden="true" />
        <section className="boot-panel">
          <div className="boot-brand">
            <span className="boot-logo"><img src="/spark.svg" alt="" /></span>
            <span>Glitter</span>
          </div>
          <div className="boot-copy">
            <h1>Preparing your workspace</h1>
            <p>Restoring your workspaces and starting the agent.</p>
          </div>
          <div className="boot-progress" aria-hidden="true"><span /></div>
          <div className="boot-status">
            <LoaderCircle size={15} className="spin" aria-hidden="true" />
            <span>Starting local workspace</span>
          </div>
        </section>
        <p className="boot-privacy">Local-first · Your workspace stays on this device</p>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className={`app ${collapsed ? "sidebar-collapsed" : ""} ${peak ? "effort-peak" : ""}`} style={sidebarStyle}>
        <a className="visually-hidden skip-link" href="#main-content">Skip to main content</a>
        <Sidebar />
        <ThreadView />
        {/* Each dialog stays mounted for one exit after it closes, so it can animate out. */}
        <Presence open={settingsOpen}><Suspense fallback={null}><SettingsModal /></Suspense></Presence>
        <Presence open={Boolean(viewingChildAgent)}><SubagentModal /></Presence>
        <Presence open={Boolean(trustDialog)}><TrustModal /></Presence>
        <Presence open={Boolean(confirmDialog)}><ConfirmDialog /></Presence>
        <Onboarding />
        <Presence open={paletteOpen}><CommandPalette /></Presence>
        <ImageViewer />
      </div>
    </ErrorBoundary>
  );
}
