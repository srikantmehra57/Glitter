import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { groupAgentRuns } from "../lib/agent";
import { findMatches, textRanges } from "../lib/find";
import { useAppStore } from "../lib/store";
import type { Thread } from "../lib/types";

type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };
/** The CSS Custom Highlight API, where the webview has it. Without it the current message is still outlined. */
function highlights(): { registry: HighlightRegistry; make: (ranges: Range[]) => unknown } | null {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
  const Maker = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  return registry && Maker ? { registry, make: (ranges) => new Maker(...ranges) } : null;
}

function clearPaint(root: HTMLElement | null) {
  const api = highlights();
  api?.registry.delete("thread-find");
  api?.registry.delete("thread-find-current");
  root?.querySelectorAll(".find-current").forEach((node) => node.classList.remove("find-current"));
}

const byData = (root: HTMLElement, name: "item" | "run" | "virtualRun", value: string) =>
  Array.from(root.querySelectorAll<HTMLElement>(`[data-${name === "virtualRun" ? "virtual-run" : name}]`)).find((node) => node.dataset[name] === value);

/** Find within the open thread: ⌘F opens it, Enter and ⌘G step forward, ⇧ steps back, Esc closes. */
export function FindBar({ thread, scroller, closing = false }: { thread: Thread; scroller: React.RefObject<HTMLDivElement | null>; closing?: boolean }) {
  const setFindOpen = useAppStore((state) => state.setFindOpen);
  const focusRequest = useAppStore((state) => state.findFocus);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const runs = useMemo(() => (query.trim() ? groupAgentRuns(thread.items) : []), [thread.items, query]);
  const matches = useMemo(() => findMatches(runs, query), [runs, query]);
  const at = matches.length ? Math.min(index, matches.length - 1) : 0;
  const current = matches[at];
  const step = (delta: number) => { if (matches.length) setIndex((at + delta + matches.length) % matches.length); };
  const stepRef = useRef(step);
  stepRef.current = step;

  // The find bar obeys the dialog-focus rule: the element that had focus when it
  // opened is remembered and re-takes focus when the bar leaves, so a keyboard
  // user is never dropped onto <body>.
  const bar = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const restored = useRef(false);
  const restoreFocus = () => {
    if (restored.current) return;
    const active = document.activeElement;
    const stranded = active === document.body || !active?.isConnected || (active instanceof Node && (bar.current?.contains(active) ?? false));
    if (!stranded) return;
    restored.current = true;
    if (invoker.current?.isConnected && invoker.current !== document.body) invoker.current.focus();
  };
  // Focus moves at close-start, not when the exit animation ends; under reduced
  // motion there is no closing phase, so the unmount is the backstop.
  useEffect(() => { if (closing) restoreFocus(); }, [closing]);
  useEffect(() => () => restoreFocus(), []);

  useEffect(() => {
    // findFocus bumps on every setFindOpen call — closing included; only a bar
    // that is not leaving may take focus back.
    if (closing) return;
    const prior = document.activeElement;
    input.current?.focus();
    input.current?.select();
    if (prior instanceof HTMLElement && prior !== input.current && !(bar.current?.contains(prior) ?? false)) invoker.current = prior;
    restored.current = false;
  }, [focusRequest, closing]);
  useEffect(() => () => clearPaint(scroller.current), [scroller]);
  // Runs outside the timeline's virtual window mount as placeholders, so the
  // model-space count and the painted marks can disagree. Rebuild the match
  // layer from whatever is mounted once the scroll settles and report the
  // matches still off screen — then the label and the marks tell one story.
  const [offscreen, setOffscreen] = useState(0);
  useEffect(() => {
    const root = scroller.current;
    if (!root || !matches.length) { setOffscreen(0); return; }
    let frame = 0;
    let settle = 0;
    const measure = () => {
      const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-item]"));
      const api = highlights();
      if (api) api.registry.set("thread-find", api.make(nodes.flatMap((node) => textRanges(node, query))));
      const mounted = new Set(nodes.map((node) => node.dataset.item));
      setOffscreen(matches.reduce((count, match) => count + (mounted.has(match.itemId) ? 0 : 1), 0));
    };
    // Mounted DOM lags the scroll event by a commit; measure on the next frame
    // so the count and the marks reflect what actually rendered.
    const onScroll = () => {
      if (frame || settle) return;
      frame = window.requestAnimationFrame(() => { frame = 0; settle = window.requestAnimationFrame(() => { settle = 0; measure(); }); });
    };
    measure();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { root.removeEventListener("scroll", onScroll); window.cancelAnimationFrame(frame); window.cancelAnimationFrame(settle); };
  }, [matches, query, scroller]);
  // ⌘G works wherever focus is while the bar is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyG") { event.preventDefault(); stepRef.current(event.shiftKey ? -1 : 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Bring the current match on screen. A run scrolled far away is only a
  // placeholder, so scroll to that first and look for the message again once
  // the timeline has rendered it.
  useEffect(() => {
    const root = scroller.current;
    clearPaint(root);
    if (!root || !current) return;
    let frame = 0;
    let tries = 0;
    const reveal = () => {
      const message = byData(root, "item", current.itemId);
      if (!message) {
        (byData(root, "virtualRun", current.runId) ?? byData(root, "run", current.runId))?.scrollIntoView({ block: "center" });
        if (tries++ < 30) frame = requestAnimationFrame(reveal);
        return;
      }
      message.classList.add("find-current");
      const api = highlights();
      const mine = textRanges(message, query);
      let occurrence = 0;
      for (let i = 0; i < at; i += 1) {
        if (matches[i]?.itemId === current.itemId) occurrence += 1;
      }
      const targetRange = mine[Math.min(occurrence, Math.max(0, mine.length - 1))];
      if (api) {
        const messageNodes = Array.from(root.querySelectorAll<HTMLElement>("[data-item]"));
        api.registry.set("thread-find", api.make(messageNodes.flatMap((node) => textRanges(node, query))));
        if (targetRange) api.registry.set("thread-find-current", api.make([targetRange]));
      }
      const box = (typeof targetRange?.getBoundingClientRect === "function" ? targetRange : message).getBoundingClientRect();
      const view = root.getBoundingClientRect();
      if (box.top < view.top + 48 || box.bottom > view.bottom - 24) root.scrollTop += box.top - view.top - view.height / 3;
    };
    reveal();
    return () => cancelAnimationFrame(frame);
  }, [at, current?.itemId, current?.runId, matches, query, scroller]);

  return <div ref={bar} className={`find-bar${closing ? " closing" : ""}`} role="search">
    <input
      ref={input}
      aria-label="Find in thread"
      placeholder="Find in thread"
      value={query}
      spellCheck={false}
      onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setFindOpen(false); }
      }}
    />
    <span className="find-count" role="status" aria-live="polite" title={offscreen ? "Off-screen matches highlight as you scroll or step to them" : undefined}>{query.trim() ? matches.length ? `${at + 1} of ${matches.length}${offscreen ? ` · ${offscreen} off-screen` : ""}` : "No matches" : ""}</span>
    <button type="button" className="icon-btn small" aria-label="Previous match" data-tooltip="Previous match  ⇧Enter" disabled={!matches.length} onClick={() => step(-1)}><ChevronUp size={14} /></button>
    <button type="button" className="icon-btn small" aria-label="Next match" data-tooltip="Next match  Enter" disabled={!matches.length} onClick={() => step(1)}><ChevronDown size={14} /></button>
    <button type="button" className="icon-btn small" aria-label="Close find" data-tooltip-align="end" data-tooltip="Close  Esc" onClick={() => setFindOpen(false)}><X size={14} /></button>
  </div>;
}
