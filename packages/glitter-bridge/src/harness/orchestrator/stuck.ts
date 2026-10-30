/**
 * Deterministic stuck signals for a Builder stage. The host turns a signal into
 * one automatic Lead consult; it never decides whether the build is correct.
 * The state is per turn and reset on a new task; a signal is re-armed only
 * after its consult produced guidance and a new attempt recurs.
 */

export type StuckCode = "check-failed-twice" | "edit-back-and-forth" | "repeated-call" | "edit-failed-twice" | "no-progress" | "plan-checks-failing" | "step-limit";

export type StuckTuning = {
  /** Consecutive failures of the same command before a consult. */
  checkFailures: number;
  /** Distinct prior versions a file needs before a revert counts. */
  editHistory: number;
  /** Identical tool calls with the same arguments before a consult. */
  repeatedCalls: number;
  /** Failed edit calls with the same arguments before a consult. */
  editFailures: number;
  /** Tool steps without touching a new path, after edits, before a consult. */
  noNewTargetSteps: number;
  /** Steps remaining when a no-passing-check build is worth a consult. */
  stepLimitStepsLeft: number;
};

export const DEFAULT_STUCK_TUNING: StuckTuning = { checkFailures: 2, editHistory: 2, repeatedCalls: 3, editFailures: 2, noNewTargetSteps: 6, stepLimitStepsLeft: 4 };

export type StuckSignal = { code: StuckCode; detail: string };

export type StuckObservation = {
  path?: string;
  oldText?: string;
  newText?: string;
  command?: string;
  exitCode?: number;
  /** The call that produced this observation, for repeat and failed-edit signals. */
  tool?: string;
  inputKey?: string;
  failed?: boolean;
  /** A short, already-bounded failure line for the consult evidence. */
  detail?: string;
};

export type StuckState = {
  checkFailures: Map<string, number>;
  /** Digests of the distinct contents this turn wrote to each file, oldest first. */
  contents: Map<string, string[]>;
  /** Identical call signatures and their counts this turn. */
  toolCalls: Map<string, number>;
  /** Identical failed edit signatures and their counts this turn. */
  editFailures: Map<string, number>;
  /** Paths any tool touched this turn, for the no-progress signal. */
  seenPaths: Set<string>;
  /** Paths edited this turn; used in the consult evidence. */
  editedPaths: Set<string>;
  lastNewPathStep: number;
  edits: number;
  passedCheck: boolean;
  /** Commands that passed since the latest edit. */
  passedChecks: Set<string>;
  /** The last few failure lines, bounded for the consult. */
  recentFailures: string[];
  fired: Set<StuckCode>;
};

const EDIT_TOOLS = /^(edit_file|write_file|apply_patch)$/;

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
  return {
    checkFailures: new Map(),
    contents: new Map(),
    toolCalls: new Map(),
    editFailures: new Map(),
    seenPaths: new Set(),
    editedPaths: new Set(),
    lastNewPathStep: 0,
    edits: 0,
    passedCheck: false,
    passedChecks: new Set(),
    recentFailures: [],
    fired: new Set(),
  };
}

function rememberFailure(state: StuckState, line: string) {
  state.recentFailures.push(line.slice(0, 300));
  if (state.recentFailures.length > 3) state.recentFailures.shift();
}

function rememberPath(state: StuckState, path: string) {
  state.editedPaths.add(path);
  if (state.editedPaths.size > 20) {
    const oldest = state.editedPaths.values().next().value;
    if (oldest) state.editedPaths.delete(oldest);
  }
}

/** Fold one tool result into the state and return a new signal, if any. */
export function observeStuck(state: StuckState, observation: StuckObservation, tuning: StuckTuning = DEFAULT_STUCK_TUNING, step = 0): StuckSignal | undefined {
  let toolSignal: StuckSignal | undefined;
  const signature = observation.tool && observation.inputKey ? `${observation.tool}\u0000${observation.inputKey}` : undefined;
  if (signature) {
    const count = (state.toolCalls.get(signature) ?? 0) + 1;
    state.toolCalls.set(signature, count);
    if (count >= tuning.repeatedCalls && !state.fired.has("repeated-call")) {
      toolSignal = { code: "repeated-call", detail: `${observation.tool} was called with identical arguments ${count} times.` };
    }
  }
  if (observation.path) {
    if (!state.seenPaths.has(observation.path)) state.lastNewPathStep = step;
    state.seenPaths.add(observation.path);
  }
  if (observation.failed && observation.path && observation.tool && EDIT_TOOLS.test(observation.tool)) {
    const key = signature ?? `${observation.tool}\u0000${observation.path}`;
    const count = (state.editFailures.get(key) ?? 0) + 1;
    state.editFailures.set(key, count);
    rememberFailure(state, observation.detail?.trim() || `${observation.tool} failed on ${observation.path}.`);
    if (count >= tuning.editFailures && !state.fired.has("edit-failed-twice")) {
      state.fired.add("edit-failed-twice");
      return { code: "edit-failed-twice", detail: `${observation.tool} failed ${count} times on ${observation.path}.` };
    }
  }
  if (observation.path && (observation.oldText !== undefined || observation.newText !== undefined)) {
    state.edits += 1;
    rememberPath(state, observation.path);
    // A check that passed before the latest edit does not prove the edited state.
    state.passedCheck = false;
    state.passedChecks.clear();
    const written = contentKey(observation.newText ?? "");
    const history = state.contents.get(observation.path) ?? [];
    if (history.length >= tuning.editHistory && history.slice(0, -1).includes(written) && !state.fired.has("edit-back-and-forth")) {
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
      state.passedChecks.add(observation.command.trim());
    } else {
      const count = (state.checkFailures.get(observation.command) ?? 0) + 1;
      state.checkFailures.set(observation.command, count);
      state.passedCheck = false;
      state.passedChecks.delete(observation.command.trim());
      rememberFailure(state, observation.detail?.trim() || `\`${observation.command}\` failed.`);
      if (count >= tuning.checkFailures && state.edits > 0 && !state.fired.has("check-failed-twice")) {
        state.fired.add("check-failed-twice");
        return { code: "check-failed-twice", detail: `\`${observation.command}\` failed ${count} times after edits.` };
      }
    }
  }
  if (toolSignal && !state.fired.has("repeated-call")) {
    state.fired.add("repeated-call");
    return toolSignal;
  }
  if (step - state.lastNewPathStep >= tuning.noNewTargetSteps && state.edits > 0 && !state.fired.has("no-progress")) {
    state.fired.add("no-progress");
    return { code: "no-progress", detail: `No new file was touched for ${tuning.noNewTargetSteps} steps after ${state.edits} edit${state.edits === 1 ? "" : "s"}.` };
  }
  return undefined;
}

/** Near the step limit, an edited build with no passing check is worth a consult. */
export function stepLimitSignal(state: StuckState, stepsLeft: number, threshold = DEFAULT_STUCK_TUNING.stepLimitStepsLeft): StuckSignal | undefined {
  if (stepsLeft > threshold || state.edits === 0 || state.passedCheck || state.fired.has("step-limit")) return undefined;
  state.fired.add("step-limit");
  return { code: "step-limit", detail: `The turn has ${stepsLeft} step${stepsLeft === 1 ? "" : "s"} left, with edits made and no passing check.` };
}

/** Near the limit, the Lead's plan checks are still not passing. */
export function planChecksSignal(state: StuckState, checks: readonly string[], stepsLeft: number, tuning: StuckTuning = DEFAULT_STUCK_TUNING): StuckSignal | undefined {
  if (stepsLeft > tuning.stepLimitStepsLeft || !checks.length || state.fired.has("plan-checks-failing")) return undefined;
  if (!state.edits && !state.checkFailures.size) return undefined;
  const pending = [...new Set(checks.map((check) => check.trim()))].filter((check) => !state.passedChecks.has(check));
  if (!pending.length) return undefined;
  state.fired.add("plan-checks-failing");
  return { code: "plan-checks-failing", detail: `The plan's checks are not passing near the step limit: ${pending.slice(0, 3).join("; ")}` };
}

/** A successful automatic consult re-arms its signal so one new attempt can ask again. */
export function rearmStuck(state: StuckState, code: StuckCode) {
  state.fired.delete(code);
}
