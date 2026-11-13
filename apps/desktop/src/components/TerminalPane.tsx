import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { RotateCcw, X } from "lucide-react";
import { shortcutText } from "../lib/commands";
import { onTerminalEvent, terminalClose, terminalOpen, terminalResize, terminalWrite, type TerminalEvent } from "../lib/bridge";
import { describeError } from "../lib/errors";
import { isTauri } from "../lib/format";
import { motionReduced, usePresence } from "../lib/presence";
import { activeWorkspace, useAppStore } from "../lib/store";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const readTheme = () => ({ background: css("--surface") || undefined, foreground: css("--ink") || undefined, cursor: css("--ink") || undefined, selectionBackground: css("--active") || undefined });

/**
 * The integrated terminal: the user's own shell in the folder the open thread
 * works in. One shell per pane. It ends when the pane closes or the folder in
 * view changes, and a new one starts in the new folder.
 */
export function TerminalPane() {
  const open = useAppStore((state) => state.terminalOpen);
  const setOpen = useAppStore((state) => state.setTerminalOpen);
  const preview = useAppStore((state) => state.preview);
  const disableTerminal = useAppStore((state) => state.disableTerminal);
  const theme = useAppStore((state) => state.theme);
  const accentColor = useAppStore((state) => state.accentColor);
  const reduceMotion = useAppStore((state) => state.reduceMotion);
  useAppStore((state) => state.shortcutOverrides);
  const grantId = useAppStore((state) => activeWorkspace(state)?.grantId ?? null);
  const folder = useAppStore((state) => activeWorkspace(state)?.path ?? "");
  // The side panel slides in and out like the Changes dock; the shell still
  // dies the moment `open` drops rather than living through the exit animation.
  const pane = usePresence(open);
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [exited, setExited] = useState(false);
  const [sessionSeq, setSessionSeq] = useState(0);
  const blocked = disableTerminal ? "The Terminal pane is disabled in Settings → Permissions."
    : !isTauri() || preview ? "The terminal needs the desktop app with a real workspace."
    : !grantId ? "Open a workspace to use the terminal." : null;

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readTheme();
  }, [theme, accentColor]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.cursorBlink = !motionReduced();
  }, [reduceMotion]);

  useEffect(() => {
    if (!open || blocked || !grantId || !host.current) return;
    const node = host.current;
    let disposed = false;
    let id: string | null = null;
    const earlyEvents: TerminalEvent[] = [];
    let cleanup = () => {};
    setExited(false);
    setStatus("Starting your shell…");
    // The renderer is loaded only when a terminal is first opened, so it stays out of the main bundle.
    void (async () => {
      // Created before the awaits that can fail: the catch must be able to
      // release both or a rejected spawn leaks the listener and the instance.
      let term: Terminal | null = null;
      let off: (() => void) | null = null;
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
        if (disposed) return;
        term = new Terminal({
          cursorBlink: !motionReduced(),
          fontFamily: css("--font-mono") || "ui-monospace, Menlo, monospace",
          fontSize: 12,
          scrollback: 5000,
          // xterm renders to canvas; this keeps a text mirror in the live region
          // it maintains, so terminal output reaches screen readers at all.
          screenReaderMode: true,
          theme: readTheme(),
        });
        termRef.current = term;
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(node);
        fit.fit();
        const applyEvent = (event: TerminalEvent) => {
          if (event.kind === "output") term?.write(event.data);
          else {
            setExited(true);
            setStatus(`Shell exited${event.code != null ? ` with code ${event.code}` : ""}.`);
            id = null;
          }
        };
        off = onTerminalEvent((event) => {
          if (!id) {
            if (earlyEvents.length < 256) earlyEvents.push(event);
            return;
          }
          if (event.id !== id) return;
          applyEvent(event);
        });
        const started = await terminalOpen(grantId, term.cols, term.rows);
        if (disposed) { void terminalClose(started); off?.(); termRef.current = null; term.dispose(); return; }
        id = started;
        setStatus(null);
        for (const buffered of earlyEvents.splice(0)) {
          if (buffered.id === started) applyEvent(buffered);
        }
        const input = term.onData((data) => { if (id) void terminalWrite(id, data).catch(() => {}); });
        const resized = term.onResize(({ cols, rows }) => { if (id) void terminalResize(id, cols, rows).catch(() => {}); });
        const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { try { fit.fit(); } catch { /* the pane is mid-layout */ } });
        observer?.observe(node);
        term.focus();
        cleanup = () => { observer?.disconnect(); input.dispose(); resized.dispose(); off?.(); termRef.current = null; term?.dispose(); if (id) void terminalClose(id).catch(() => {}); };
        if (disposed) cleanup();
      } catch (error) {
        // Whatever got as far as existing — the event subscription, the xterm
        // instance, a spawned PTY — is released here too, or a failed spawn
        // leaks it.
        off?.();
        if (termRef.current === term) termRef.current = null;
        term?.dispose();
        if (id) { const sid = id; id = null; void terminalClose(sid).catch(() => {}); }
        if (!disposed) { setExited(true); setStatus(describeError("Could not start the terminal", error)); }
      }
    })();
    return () => { disposed = true; cleanup(); };
  }, [open, blocked, grantId, sessionSeq]);

  if (!pane.mounted) return null;
  return <aside className={`terminal-pane${pane.closing ? " closing" : ""}`} aria-label="Terminal" aria-hidden={pane.closing || undefined} inert={pane.closing}>
    <header className="terminal-head">
      <span className="terminal-title">Terminal</span>
      <span className="terminal-folder" title={folder}>{folder}</span>
      {exited && !blocked ? <button type="button" className="ghost-btn small" onClick={() => setSessionSeq((seq) => seq + 1)}><RotateCcw size={12} aria-hidden="true" />Restart</button> : null}
      <button type="button" className="icon-btn small" aria-label="Close terminal" data-tooltip-align="end" data-tooltip={`Close terminal  ${shortcutText("terminal")}`} onClick={() => setOpen(false)}><X size={14} /></button>
    </header>
    {blocked || status ? <p className="terminal-note" role="status">{blocked ?? status}</p> : null}
    {blocked ? null : <div ref={host} className="terminal-host" />}
  </aside>;
}
