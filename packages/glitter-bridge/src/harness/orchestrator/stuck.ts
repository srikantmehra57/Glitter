/**
 * Deterministic stuck signals for a Builder stage. The host turns a signal into
 * one automatic Lead consult; it never decides whether the build is correct.
 */

export type StuckCode = "check-failed-twice" | "edit-back-and-forth" | "step-limit";

export type StuckSignal = { code: StuckCode; detail: string };

export type StuckObservation = {
  path?: string;
  oldText?: string;
  newText?: string;
  command?: string;
  exitCode?: number;
};

export type StuckState = {
  checkFailures: Map<string, number>;
  /** Digests of the distinct contents this turn wrote to each file, oldest first. */
  contents: Map<string, string[]>;
  edits: number;
  passedCheck: boolean;
  fired: Set<StuckCode>;
};

/** A bounded key for full-file content; the tracker never keeps the text itself. */
function contentKey(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}

export function createStuckState(): StuckState {
  return { checkFailures: new Map(), contents: new Map(), edits: 0, passedCheck: false, fired: new Set() };
}

/** Fold one tool result into the state and return a new signal, if any. */
export function observeStuck(state: StuckState, observation: StuckObservation): StuckSignal | undefined {
  if (observation.path && (observation.oldText !== undefined || observation.newText !== undefined)) {
    state.edits += 1;
    // A check that passed before the latest edit does not prove the edited state.
    state.passedCheck = false;
    const written = contentKey(observation.newText ?? "");
    const history = state.contents.get(observation.path) ?? [];
    if (history.slice(0, -1).includes(written) && !state.fired.has("edit-back-and-forth")) {
      state.fired.add("edit-back-and-forth");
      return { code: "edit-back-and-forth", detail: `${observation.path} was edited back to a version this turn already had.` };
    }
    if (!history.includes(written)) history.push(written);
    state.contents.set(observation.path, history);
  }
  if (observation.command && observation.exitCode !== undefined) {
    if (observation.exitCode === 0) {
      state.checkFailures.delete(observation.command);
      state.passedCheck = true;
    } else {
      const count = (state.checkFailures.get(observation.command) ?? 0) + 1;
      state.checkFailures.set(observation.command, count);
      state.passedCheck = false;
      if (count >= 2 && state.edits > 0 && !state.fired.has("check-failed-twice")) {
        state.fired.add("check-failed-twice");
        return { code: "check-failed-twice", detail: `\`${observation.command}\` failed ${count} times after edits.` };
      }
    }
  }
  return undefined;
}

/** Near the step limit, an edited build with no passing check is worth a consult. */
export function stepLimitSignal(state: StuckState, stepsLeft: number, threshold = 4): StuckSignal | undefined {
  if (stepsLeft > threshold || state.edits === 0 || state.passedCheck || state.fired.has("step-limit")) return undefined;
  state.fired.add("step-limit");
  return { code: "step-limit", detail: `The turn has ${stepsLeft} step${stepsLeft === 1 ? "" : "s"} left, with edits made and no passing check.` };
}
