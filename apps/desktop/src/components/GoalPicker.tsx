import { useEffect, useState } from "react";
import { Target } from "lucide-react";
import { haptic } from "../lib/haptics";
import { ORCHESTRATOR_GOAL_COPY, ORCHESTRATOR_GOAL_SHORT, ORCHESTRATOR_SHAPE_LABELS } from "../lib/orchestrator";
import { ORCHESTRATOR_GOALS, ORCHESTRATOR_SHAPES, type OrchestratorGoal, type OrchestratorShape } from "../lib/types";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

export type OrchestratorOverride = OrchestratorShape | "auto";

const OVERRIDE_COPY: Record<OrchestratorShape, string> = {
  "direct-small": "A quick edit without the Lead.",
  "direct-builder": "The Builder works without a Lead plan.",
  "lead-guided": "The Lead plans, then the Builder executes.",
  "lead-only": "The Lead plans and does the work itself.",
};

type Props = {
  goal: OrchestratorGoal;
  /** The shape requested for the next message, or Auto to let the policy decide. */
  override: OrchestratorOverride;
  disabled: boolean;
  /** True while a pick is still being written to the session: the pick stays drawn meanwhile. */
  applying?: boolean;
  onGoal: (goal: OrchestratorGoal) => void;
  onOverride: (override: OrchestratorOverride) => void;
};

/**
 * The Orchestrator's goal, in the effort control's footprint. One menu holds
 * both the goal and the next message's shape; the chip names the goal, and the
 * queued shape when one is waiting.
 */
export function GoalPicker({ goal, override, disabled, applying, onGoal, onOverride }: Props) {
  // The last pick stays drawn while its write is in flight, then follows the session.
  const [choice, setChoice] = useState({ goal, override });
  useEffect(() => {
    if (!applying) setChoice({ goal, override });
  }, [goal, override, applying]);
  const shown = choice;

  const commit = (next: { goal?: OrchestratorGoal; override?: OrchestratorOverride }) => {
    if (disabled) return;
    setChoice({ ...shown, ...next });
    haptic("level");
    if (next.goal) onGoal(next.goal);
    if (next.override) onOverride(next.override);
  };

  const options: SelectMenuOption[] = [
    ...ORCHESTRATOR_GOALS.map((value) => ({
      value: `goal:${value}`,
      label: ORCHESTRATOR_GOAL_COPY[value].label,
      description: ORCHESTRATOR_GOAL_COPY[value].summary,
      triggerLabel: ORCHESTRATOR_GOAL_SHORT[value],
      heading: "Goal",
    })),
    {
      value: "override:auto",
      label: "Auto",
      description: "The Orchestrator chooses the shape from the message.",
      tag: "Default",
      triggerLabel: ORCHESTRATOR_GOAL_SHORT[shown.goal],
      heading: "This message",
    },
    ...ORCHESTRATOR_SHAPES.map((value) => ({
      value: `override:${value}`,
      label: ORCHESTRATOR_SHAPE_LABELS[value],
      description: OVERRIDE_COPY[value],
      triggerLabel: `${ORCHESTRATOR_GOAL_SHORT[shown.goal]} · ${ORCHESTRATOR_SHAPE_LABELS[value]} next`,
      heading: "This message",
    })),
  ];
  const value = shown.override === "auto" ? `goal:${shown.goal}` : `override:${shown.override}`;
  const next = shown.override === "auto" ? "Auto" : `${ORCHESTRATOR_SHAPE_LABELS[shown.override]} for the next message`;

  return (
    <div className="effort-select goal-select" data-tooltip-side="top" data-tooltip="Orchestrator goal · floors still apply">
      <SelectMenu
        id="orchestrator-goal-chip"
        ariaLabel={`Orchestrator goal, ${ORCHESTRATOR_GOAL_COPY[shown.goal].label}; ${next}`}
        className="effort-menu goal-menu"
        icon={<Target size={14} aria-hidden="true" />}
        value={value}
        placeholder="Goal"
        disabled={disabled}
        options={options}
        onChange={(next) => {
          // A goal and the next message's shape are independent: changing the
          // goal keeps a shape already queued for the next message.
          if (next.startsWith("goal:")) commit({ goal: next.slice("goal:".length) as OrchestratorGoal });
          else commit({ override: next.slice("override:".length) as OrchestratorOverride });
        }}
      />
    </div>
  );
}
