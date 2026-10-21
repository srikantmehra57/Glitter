import { useEffect, useState } from "react";
import { TIER_COPY } from "../lib/effort";
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

/**
 * Reasoning effort, apart from the model. The chip names the level; a click
 * opens a menu of the model's levels, each with what it trades, and the
 * model's own default tagged. The left and right arrows on the closed chip
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
        value={selected}
        placeholder="Effort"
        disabled={disabled}
        options={tiers.map((tier) => ({
          value: tier,
          label: TIER_COPY[tier].label,
          description: TIER_COPY[tier].blurb,
          tag: tier === fallback ? "Default" : undefined,
        }))}
        onChange={(tier) => commit(tier as ReasoningEffort)}
      />
    </div>
  );
}
