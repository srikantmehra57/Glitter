import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type WheelEvent } from "react";
import { ArrowLeft, ArrowRight, Globe2, LoaderCircle, RotateCcw, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { bridge } from "../lib/bridge";
import { browserPoint, normalizeBrowserAddress } from "../lib/browser";
import { describeError } from "../lib/errors";
import { isTauri } from "../lib/format";
import { usePresence } from "../lib/presence";
import { activeWorkspace, useAppStore } from "../lib/store";

const SPECIAL_KEYS = new Set(["Enter", "Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", "Escape"]);

/** The same Chromium page the agent controls, rendered as pixels beside the thread. */
export function BrowserPane() {
  const open = useAppStore((state) => state.browserOpen);
  const workspace = useAppStore(activeWorkspace);
  const preview = useAppStore((state) => state.preview);
  const { state, frame, busy, error, openBrowser, controlBrowser, closeBrowser } = useAppStore(useShallow((store) => ({
    state: store.browserState,
    frame: store.browserFrame,
    busy: store.browserBusy,
    error: store.browserError,
    openBrowser: store.openBrowser,
    controlBrowser: store.controlBrowser,
    closeBrowser: store.closeBrowser,
  })));
  const pane = usePresence(open);
  const viewportRef = useRef<HTMLDivElement>(null);
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const root = workspace?.path ?? "";
  const grantId = workspace?.grantId ?? null;
  const ready = state?.status === "ready";
  const blocked = !isTauri() || preview
    ? "Browser control needs the desktop app with a real workspace."
    : !grantId ? "Open a workspace to use Browser." : null;

  useEffect(() => {
    if (!addressFocused) setAddress(state?.url && state.url !== "about:blank" ? state.url : "");
  }, [state?.url, addressFocused]);

  useEffect(() => {
    if (!open || blocked || !grantId || !root) return;
    let cancelled = false;
    const size = viewportRef.current?.getBoundingClientRect();
    const viewport = size && size.width > 0 && size.height > 0
      ? { width: Math.max(320, Math.floor(size.width)), height: Math.max(240, Math.floor(size.height)) }
      : undefined;
    void (async () => {
      await openBrowser(undefined, viewport);
      if (cancelled) return;
      await controlBrowser({ action: "setStreaming", stream: true });
    })();
    return () => {
      cancelled = true;
      // Cleanup uses the captured grant: a workspace switch must stop the old
      // root's stream, not accidentally subscribe the newly selected root.
      void bridge("browserControl", { action: "setStreaming", stream: false, grantId }).catch(() => {});
    };
  }, [open, blocked, grantId, root, openBrowser, controlBrowser]);

  useEffect(() => {
    if (!open || !ready || !viewportRef.current) return;
    const node = viewportRef.current;
    let timer = 0;
    const resize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const rect = node.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return;
        void controlBrowser({ action: "resize", width: Math.max(320, Math.floor(rect.width)), height: Math.max(240, Math.floor(rect.height)) });
      }, 160);
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    observer?.observe(node);
    resize();
    return () => { observer?.disconnect(); window.clearTimeout(timer); };
  }, [open, ready, root, controlBrowser]);

  if (!pane.mounted) return null;
  const go = (event: FormEvent) => {
    event.preventDefault();
    try {
      const url = normalizeBrowserAddress(address);
      setAddressError("");
      void openBrowser(url);
    } catch (cause) {
      setAddressError(describeError("Enter a valid address", cause));
    }
  };
  const point = (event: MouseEvent<HTMLDivElement> | WheelEvent<HTMLDivElement>) => state
    ? browserPoint(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), state.viewport)
    : null;
  const click = (event: MouseEvent<HTMLDivElement>) => {
    if (!ready) return;
    keyboardRef.current?.focus({ preventScroll: true });
    const at = point(event);
    if (at) void controlBrowser({ action: "click", x: at.x, y: at.y });
  };
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!ready) return;
    const at = point(event);
    if (!at) return;
    event.preventDefault();
    void controlBrowser({ action: "scroll", x: at.x, y: at.y, deltaX: Math.round(event.deltaX / at.scale), deltaY: Math.round(event.deltaY / at.scale) });
  };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!ready || event.metaKey || event.ctrlKey || event.altKey || event.key === "Tab" || !SPECIAL_KEYS.has(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    void controlBrowser({ action: "key", key: event.key });
  };

  return <aside className={`browser-pane${pane.closing ? " closing" : ""}`} aria-label="Browser" aria-hidden={pane.closing || undefined} inert={pane.closing}>
    <header className="terminal-head browser-head">
      <Globe2 size={14} aria-hidden="true" />
      <span className="terminal-title">Browser</span>
      <span className="terminal-folder" title={state?.url || root}>{state?.title || (root ? workspace?.name : "Shared browser")}</span>
      {busy ? <LoaderCircle size={13} className="spin" aria-label="Browser is working" /> : null}
      <button type="button" className="icon-btn small" aria-label="Close browser" data-tooltip-align="end" data-tooltip="Close browser" onClick={() => void closeBrowser()}><X size={14} /></button>
    </header>
    <div className="browser-nav">
      <button type="button" className="icon-btn small" aria-label="Go back" data-tooltip="Back" disabled={!ready || busy} onClick={() => void controlBrowser({ action: "back" })}><ArrowLeft size={14} /></button>
      <button type="button" className="icon-btn small" aria-label="Go forward" data-tooltip="Forward" disabled={!ready || busy} onClick={() => void controlBrowser({ action: "forward" })}><ArrowRight size={14} /></button>
      <button type="button" className="icon-btn small" aria-label="Reload page" data-tooltip="Reload" disabled={!ready || busy} onClick={() => void controlBrowser({ action: "reload" })}><RotateCcw size={13} /></button>
      <form className="browser-address" onSubmit={go}>
        <input
          aria-label="Browser address"
          value={address}
          placeholder="http://localhost:3000"
          spellCheck={false}
          disabled={Boolean(blocked) || busy}
          onFocus={() => setAddressFocused(true)}
          onBlur={() => setAddressFocused(false)}
          onChange={(event) => { setAddress(event.target.value); setAddressError(""); }}
        />
        <button type="submit" className="ghost-btn small" disabled={Boolean(blocked) || busy || !address.trim()}>Go</button>
      </form>
    </div>
    {blocked || addressError || error ? <div className="browser-notice" role="status">
      <span>{blocked ?? addressError ?? error}</span>
      {!blocked && error ? <button type="button" className="ghost-btn small" onClick={() => void openBrowser()}>Retry</button> : null}
    </div> : null}
    {blocked ? <div className="browser-empty"><Globe2 size={22} aria-hidden="true" /><p>{blocked}</p></div> : (
      <div ref={viewportRef} className={`browser-viewport${ready ? " ready" : ""}`} onClick={click} onWheel={wheel}>
        {frame && ready ? <img src={`data:${frame.mediaType};base64,${frame.data}`} alt={state.title ? `Current browser page: ${state.title}` : "Current browser page"} draggable={false} /> : (
          <div className="browser-empty">
            {busy ? <LoaderCircle size={22} className="spin" aria-hidden="true" /> : <Globe2 size={22} aria-hidden="true" />}
            <strong>{state?.status === "closed" ? "Browser is closed" : busy ? "Starting Chromium…" : "Open a page in this workspace"}</strong>
            <p>Enter a local server or web address above. This fresh browser is separate from your normal browser profile.</p>
            {state?.status === "closed" ? <button type="button" className="secondary" onClick={() => void openBrowser()}>Open Browser</button> : null}
          </div>
        )}
        <textarea
          ref={keyboardRef}
          className="browser-keyboard"
          aria-label="Type into the shared browser"
          value=""
          disabled={!ready}
          onKeyDown={key}
          onChange={(event) => {
            const text = event.target.value;
            if (text) void controlBrowser({ action: "type", text });
          }}
        />
      </div>
    )}
    {!blocked ? <p className="browser-privacy">Click the page to type or scroll. Agent inspection shares page content and screenshots with the selected model provider.</p> : null}
  </aside>;
}
