import { useEffect, useState } from "react";
import { TIER_COPY, TIER_ORDER } from "../lib/effort";
import { haptic } from "../lib/haptics";
import type { ReasoningEffort } from "../lib/types";
import { SelectMenu } from "./SelectMenu";

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

/** How far up the full scale (None to Max) a level sits, so a dial reads the same on every model. */
function heat(tier: ReasoningEffort) {
  return Math.min(1, TIER_ORDER.indexOf(tier) / TIER_ORDER.indexOf("max"));
}

const ARC = 2 * Math.PI * 6;
const SWEEP = 2 / 3;

/** A small dial: the arc fills and the needle swings with the level, warming toward Max. */
export function EffortGauge({ tier, size = 16 }: { tier: ReasoningEffort; size?: number }) {
  const level = heat(tier);
  return (
    <span className="effort-gauge" data-level={Math.round(level * 6)} data-peak={level >= 1 || undefined} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 16 16">
        <circle className="effort-gauge-track" cx="8" cy="9" r="6" strokeDasharray={`${ARC * SWEEP} ${ARC}`} />
        <circle className="effort-gauge-fill" cx="8" cy="9" r="6" strokeDasharray={`${Math.max(0.01, ARC * SWEEP * level)} ${ARC}`} />
        <line className="effort-gauge-needle" x1="8" y1="9" x2="8" y2="4.6" style={{ transform: `rotate(${-120 + 240 * level}deg)` }} />
        <circle className="effort-gauge-hub" cx="8" cy="9" r="1.4" />
      </svg>
    </span>
  );
}

/**
 * Reasoning effort, apart from the model. The chip names the level beside its
 * dial; a click opens a menu of the model's levels, each with its dial, and
 * the model's own default tagged. The left and right arrows on the closed chip
 * step the level without opening anything.
 */
export function EffortPicker({ value, tiers, fallback, disabled, applying, onChange }: Props) {
  const current = value && tiers.includes(value) ? value : fallback;
  // The last pick stays drawn while its write is in flight, then follows the session.
  const [choice, setChoice] = useState(current);
  useEffect(() => { if (!applying) setChoice(current); }, [current, applying]);
  const selected = tiers.includes(choice) ? choice : current;
  const index = Math.max(0, tiers.indexOf(selected));

  const commit = (tier: ReasoningEffort) => {
    if (disabled || tier === selected) return;
    setChoice(tier);
    haptic("level");
    onChange(tier);
  };

  return (
    <div
      className="effort-select"
      data-tooltip-side="top"
      data-tooltip="Reasoning effort · ←→ to adjust"
      onKeyDown={(event) => {
        // Quick steps on the closed chip; inside the menu the arrows move between rows.
        const trigger = event.target as HTMLElement;
        if (!trigger.matches(".select-trigger") || trigger.getAttribute("aria-expanded") === "true") return;
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = tiers[index + step];
        if (next) commit(next);
      }}
    >
      <SelectMenu
        id="effort-meter"
        ariaLabel={`Reasoning effort, ${TIER_COPY[selected].label}${selected === fallback ? ", model default" : ""}`}
        heading="Reasoning effort"
        className="effort-menu"
        icon={<EffortGauge tier={selected} size={15} />}
        value={selected}
        placeholder="Effort"
        disabled={disabled}
        options={tiers.map((tier) => ({
          value: tier,
          label: TIER_COPY[tier].label,
          icon: <EffortGauge tier={tier} size={20} />,
          tag: tier === fallback ? "Default" : undefined,
        }))}
        onChange={(tier) => commit(tier as ReasoningEffort)}
      />
    </div>
  );
}
