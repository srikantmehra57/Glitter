import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Flame } from "lucide-react";
import { isPeak, TIER_COPY } from "../lib/effort";
import { effortRipple, haptic } from "../lib/haptics";
import { menuPosition } from "../lib/menuPosition";
import { EXIT_FAST_MS, usePresence } from "../lib/presence";
import type { ReasoningEffort } from "../lib/types";

type Props = {
  /** The session's saved effort; undefined means the model default. */
  value?: ReasoningEffort;
  tiers: ReasoningEffort[];
  fallback: ReasoningEffort;
  disabled: boolean;
  /** True while a pick is still being written to the session: the pick stays drawn meanwhile. */
  applying?: boolean;
  onChange: (tier: ReasoningEffort) => void;
};

/** Bar heights rise with the level, from a third of the row to all of it. */
const barHeight = (stop: number, count: number) => `${Math.round(30 + (70 * (stop + 1)) / count)}%`;

function Bars({ tiers, upTo, className }: { tiers: ReasoningEffort[]; upTo: number; className: string }) {
  return (
    <span className={className} aria-hidden="true">
      {tiers.map((tier, stop) => <i key={tier} data-on={stop <= upTo || undefined} style={{ height: barHeight(stop, tiers.length) }} />)}
    </span>
  );
}

/**
 * Reasoning effort, apart from the model. The chip shows the level as rising
 * bars and its name; a click opens a small panel with one large, labelled
 * column per level, where one more click picks a level and closes it. The
 * arrow keys on the chip step the level without opening anything.
 */
export function EffortMeter({ value, tiers, fallback, disabled, applying, onChange }: Props) {
  const current = value && tiers.includes(value) ? value : fallback;
  // The last pick stays drawn while its write is in flight, then follows the session.
  const [choice, setChoice] = useState(current);
  useEffect(() => { if (!applying) setChoice(current); }, [current, applying]);
  const selected = tiers.includes(choice) ? choice : current;
  const index = Math.max(0, tiers.indexOf(selected));
  const peak = isPeak(selected, tiers);
  const [open, setOpen] = useState(false);
  const pop = usePresence(open, EXIT_FAST_MS);
  const [hover, setHover] = useState<ReasoningEffort | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof menuPosition> | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const shown = hover ?? selected;

  const commit = (tier: ReasoningEffort, origin?: HTMLElement | null) => {
    if (disabled || tier === selected) return;
    const wasPeak = isPeak(selected, tiers);
    const willPeak = isPeak(tier, tiers);
    setChoice(tier);
    haptic("level");
    if (willPeak !== wasPeak) {
      const rect = (origin ?? trigger.current)?.getBoundingClientRect();
      if (rect) effortRipple({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, variant: willPeak ? "peak" : "calm" });
    }
    onChange(tier);
  };
  const close = () => { setOpen(false); setHover(null); trigger.current?.focus(); };

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current;
    const box = panel.current;
    const update = () => setPosition(menuPosition(anchor.getBoundingClientRect(), { width: box.offsetWidth, height: box.offsetHeight }, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }, false));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open]);
  // Once placed, focus lands on the current level, so the arrow keys move from there.
  useEffect(() => {
    if (open && position) panel.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  }, [open, position !== null]);

  return (
    <>
      <button
        ref={trigger}
        id="effort-meter"
        type="button"
        className={`effort-meter${peak ? " peak" : ""}`}
        aria-label={`Reasoning effort, ${TIER_COPY[selected].label}${selected === fallback ? ", model default" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={pop.mounted ? panelId : undefined}
        disabled={disabled}
        data-tooltip-side="top"
        data-tooltip={open ? undefined : "Reasoning effort · ←→ to adjust"}
        onClick={() => { if (open) close(); else { setPosition(null); setOpen(true); } }}
        onKeyDown={(event) => {
          // Quick steps without opening the panel.
          const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
          if (!step || open) return;
          const next = index + step;
          event.preventDefault();
          if (next >= 0 && next < tiers.length) commit(tiers[next]);
        }}
      >
        <Bars tiers={tiers} upTo={index} className="effort-meter-bars" />
        <span className="effort-meter-label">{peak ? <Flame size={11} aria-hidden="true" /> : null}{TIER_COPY[selected].short}</span>
      </button>
      {pop.mounted ? createPortal(
        <div
          ref={panel}
          id={panelId}
          className={`effort-panel${pop.closing ? " closing" : ""}${isPeak(shown, tiers) ? " peak" : ""}`}
          role="dialog"
          aria-label="Reasoning effort"
          style={position ?? { visibility: "hidden" }}
          onKeyDown={(event) => {
            if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); close(); }
          }}
        >
          <div
            className="effort-levels"
            role="radiogroup"
            aria-label="Reasoning effort"
            onMouseLeave={() => setHover(null)}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
              const at = tiers.indexOf((document.activeElement as HTMLElement | null)?.dataset.tier as ReasoningEffort);
              const next = event.key === "Home" ? 0 : event.key === "End" ? tiers.length - 1 : step && at >= 0 ? Math.max(0, Math.min(tiers.length - 1, at + step)) : -1;
              if (next < 0) return;
              event.preventDefault();
              event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
              setHover(tiers[next]);
            }}
          >
            {tiers.map((tier, stop) => {
              const hot = isPeak(tier, tiers);
              return (
                <button
                  key={tier}
                  type="button"
                  role="radio"
                  className={`effort-level${hot ? " hot" : ""}`}
                  data-tier={tier}
                  aria-checked={tier === selected}
                  aria-label={`${TIER_COPY[tier].label}${tier === fallback ? ", model default" : ""}`}
                  tabIndex={tier === selected ? 0 : -1}
                  data-lit={stop <= tiers.indexOf(shown) || undefined}
                  onMouseEnter={() => setHover(tier)}
                  onFocus={() => setHover(tier)}
                  onClick={(event) => { commit(tier, event.currentTarget); close(); }}
                >
                  <span className="effort-level-bar"><i style={{ height: barHeight(stop, tiers.length) }} /></span>
                  <span className="effort-level-name">{TIER_COPY[tier].short}</span>
                  {tier === fallback ? <span className="effort-level-default" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          <p className="effort-panel-note" aria-live="polite">
            <strong>{isPeak(shown, tiers) ? <Flame size={12} aria-hidden="true" /> : null}{TIER_COPY[shown].label}</strong>
            <span>{TIER_COPY[shown].blurb}{shown === fallback ? " · model default" : ""}</span>
          </p>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
