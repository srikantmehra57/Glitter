export const MAX_HANDOFF_CHARS = 250_000;
const MAX_LIST_ITEMS = 200;
const MAX_TEXT_CHARS = 100_000;

export type ContextPack = {
  kind: "context-pack";
  version: 1;
  excerpts: Array<{ path: string; startLine: number; endLine: number; symbol?: string; text: string }>;
  notes: string[];
};

export type OrchestratorPlan = {
  kind: "orchestrator-plan";
  version: 1;
  goal: string;
  acceptanceCriteria: string[];
  fileTargets: Array<{ path: string; symbols: string[]; intent: string }>;
  steps: Array<{ intent: string; files: string[] }>;
  constraints: string[];
  checks: string[];
  risks: string[];
  askLeadIf: string[];
};

export type BuildReport = {
  kind: "build-report";
  version: 1;
  summary: string;
  diffStat: string;
  diff: string;
  checks: Array<{ command: string; status: "passed" | "failed" | "skipped"; detail?: string }>;
  deviations: string[];
  openQuestions: string[];
};

export type ReviewNotes = {
  kind: "review-notes";
  version: 1;
  outcome: "pass" | "changes-required";
  fixes: string[];
};

export type OrchestratorHandoff = ContextPack | OrchestratorPlan | BuildReport | ReviewNotes;
export type HandoffValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function header(value: Record_, kind: string, allowed: readonly string[], errors: string[]): boolean {
  if (value.kind !== kind) errors.push(`kind must be ${kind}.`);
  if (value.version !== 1) errors.push("version must be 1.");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`Unknown field: ${key}.`);
  return value.kind === kind && value.version === 1;
}

function text(value: unknown, field: string, errors: string[], options: { empty?: boolean; max?: number; preserve?: boolean } = {}): string {
  if (typeof value !== "string") {
    errors.push(`${field} must be a string.`);
    return "";
  }
  const result = options.preserve ? value : value.trim();
  if (!options.empty && !result) errors.push(`${field} must not be empty.`);
  const max = options.max ?? MAX_TEXT_CHARS;
  if (value.length > max) errors.push(`${field} exceeds ${max} characters.`);
  return result;
}

function texts(value: unknown, field: string, errors: string[], minimum = 0): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array.`);
    return [];
  }
  if (value.length < minimum) errors.push(`${field} needs at least ${minimum} entr${minimum === 1 ? "y" : "ies"}.`);
  if (value.length > MAX_LIST_ITEMS) errors.push(`${field} exceeds ${MAX_LIST_ITEMS} entries.`);
  return value.slice(0, MAX_LIST_ITEMS).map((entry, index) => text(entry, `${field}[${index}]`, errors));
}

function objectArray(value: unknown, field: string, errors: string[], minimum = 0): Record_[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array.`);
    return [];
  }
  if (value.length < minimum) errors.push(`${field} needs at least ${minimum} entr${minimum === 1 ? "y" : "ies"}.`);
  if (value.length > MAX_LIST_ITEMS) errors.push(`${field} exceeds ${MAX_LIST_ITEMS} entries.`);
  return value.slice(0, MAX_LIST_ITEMS).map((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`${field}[${index}] must be an object.`);
      return {};
    }
    return entry;
  });
}

function exactFields(value: Record_, field: string, allowed: readonly string[], errors: string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`Unknown field: ${field}.${key}.`);
}

function parsed(raw: string): HandoffValidation<unknown> {
  if (raw.length > MAX_HANDOFF_CHARS) return { ok: false, errors: [`Handoff exceeds ${MAX_HANDOFF_CHARS} characters.`] };
  try { return { ok: true, value: JSON.parse(raw) as unknown }; }
  catch { return { ok: false, errors: ["Handoff must be one JSON object without fences or surrounding prose."] }; }
}

function finish<T>(value: T, errors: string[]): HandoffValidation<T> {
  // Direct object validation gets the same aggregate bound as JSON parsing;
  // per-field limits alone would allow hundreds of large excerpts to add up.
  if (!errors.length && JSON.stringify(value).length > MAX_HANDOFF_CHARS) errors.push(`Handoff exceeds ${MAX_HANDOFF_CHARS} characters.`);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

export function validateContextPack(input: unknown): HandoffValidation<ContextPack> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Context pack must be an object."] };
  header(input, "context-pack", ["kind", "version", "excerpts", "notes"], errors);
  const excerpts = objectArray(input.excerpts, "excerpts", errors).map((excerpt, index) => {
    const field = `excerpts[${index}]`;
    exactFields(excerpt, field, ["path", "startLine", "endLine", "symbol", "text"], errors);
    const startLine = excerpt.startLine;
    const endLine = excerpt.endLine;
    if (!Number.isInteger(startLine) || (startLine as number) < 1) errors.push(`${field}.startLine must be a positive integer.`);
    if (!Number.isInteger(endLine) || (endLine as number) < (startLine as number)) errors.push(`${field}.endLine must be at least startLine.`);
    return {
      path: text(excerpt.path, `${field}.path`, errors, { max: 4_096 }),
      startLine: typeof startLine === "number" ? startLine : 0,
      endLine: typeof endLine === "number" ? endLine : 0,
      ...(excerpt.symbol !== undefined ? { symbol: text(excerpt.symbol, `${field}.symbol`, errors, { max: 1_000 }) } : {}),
      text: text(excerpt.text, `${field}.text`, errors, { empty: true, max: 50_000, preserve: true }),
    };
  });
  return finish({ kind: "context-pack", version: 1, excerpts, notes: texts(input.notes, "notes", errors) }, errors);
}

export function validatePlan(input: unknown): HandoffValidation<OrchestratorPlan> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Plan must be an object."] };
  header(input, "orchestrator-plan", ["kind", "version", "goal", "acceptanceCriteria", "fileTargets", "steps", "constraints", "checks", "risks", "askLeadIf"], errors);
  const fileTargets = objectArray(input.fileTargets, "fileTargets", errors, 1).map((target, index) => {
    const field = `fileTargets[${index}]`;
    exactFields(target, field, ["path", "symbols", "intent"], errors);
    return {
      path: text(target.path, `${field}.path`, errors, { max: 4_096 }),
      symbols: texts(target.symbols, `${field}.symbols`, errors),
      intent: text(target.intent, `${field}.intent`, errors),
    };
  });
  const knownPaths = new Set(fileTargets.map((target) => target.path));
  const steps = objectArray(input.steps, "steps", errors, 1).map((step, index) => {
    const field = `steps[${index}]`;
    exactFields(step, field, ["intent", "files"], errors);
    const files = texts(step.files, `${field}.files`, errors);
    for (const path of files) if (!knownPaths.has(path)) errors.push(`${field}.files names ${path}, which is not a file target.`);
    return { intent: text(step.intent, `${field}.intent`, errors), files };
  });
  return finish({
    kind: "orchestrator-plan",
    version: 1,
    goal: text(input.goal, "goal", errors),
    acceptanceCriteria: texts(input.acceptanceCriteria, "acceptanceCriteria", errors, 1),
    fileTargets,
    steps,
    constraints: texts(input.constraints, "constraints", errors),
    checks: texts(input.checks, "checks", errors),
    risks: texts(input.risks, "risks", errors),
    askLeadIf: texts(input.askLeadIf, "askLeadIf", errors),
  }, errors);
}

export function validateBuildReport(input: unknown): HandoffValidation<BuildReport> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Build report must be an object."] };
  header(input, "build-report", ["kind", "version", "summary", "diffStat", "diff", "checks", "deviations", "openQuestions"], errors);
  const checks = objectArray(input.checks, "checks", errors).map((check, index) => {
    const field = `checks[${index}]`;
    exactFields(check, field, ["command", "status", "detail"], errors);
    if (check.status !== "passed" && check.status !== "failed" && check.status !== "skipped") errors.push(`${field}.status is invalid.`);
    const status: BuildReport["checks"][number]["status"] = check.status === "passed" || check.status === "failed" || check.status === "skipped" ? check.status : "failed";
    return {
      command: text(check.command, `${field}.command`, errors),
      status,
      ...(check.detail !== undefined ? { detail: text(check.detail, `${field}.detail`, errors, { empty: true }) } : {}),
    };
  });
  return finish({
    kind: "build-report",
    version: 1,
    summary: text(input.summary, "summary", errors),
    diffStat: text(input.diffStat, "diffStat", errors, { empty: true, preserve: true }),
    diff: text(input.diff, "diff", errors, { empty: true, max: 200_000, preserve: true }),
    checks,
    deviations: texts(input.deviations, "deviations", errors),
    openQuestions: texts(input.openQuestions, "openQuestions", errors),
  }, errors);
}

export function validateReviewNotes(input: unknown): HandoffValidation<ReviewNotes> {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["Review notes must be an object."] };
  header(input, "review-notes", ["kind", "version", "outcome", "fixes"], errors);
  if (input.outcome !== "pass" && input.outcome !== "changes-required") errors.push("outcome is invalid.");
  const outcome = input.outcome === "pass" ? "pass" : "changes-required";
  const fixes = texts(input.fixes, "fixes", errors, outcome === "changes-required" ? 1 : 0);
  if (outcome === "pass" && fixes.length) errors.push("A passing review cannot require fixes.");
  return finish({ kind: "review-notes", version: 1, outcome, fixes }, errors);
}

export function validateHandoff(input: unknown): HandoffValidation<OrchestratorHandoff> {
  if (!isRecord(input) || typeof input.kind !== "string") return { ok: false, errors: ["Handoff must be an object with a kind."] };
  if (input.kind === "context-pack") return validateContextPack(input);
  if (input.kind === "orchestrator-plan") return validatePlan(input);
  if (input.kind === "build-report") return validateBuildReport(input);
  if (input.kind === "review-notes") return validateReviewNotes(input);
  return { ok: false, errors: [`Unknown handoff kind: ${input.kind}.`] };
}

export function parseHandoff(raw: string): HandoffValidation<OrchestratorHandoff> {
  const json = parsed(raw);
  return json.ok ? validateHandoff(json.value) : json;
}

export function parsePlan(raw: string): HandoffValidation<OrchestratorPlan> {
  const json = parsed(raw);
  return json.ok ? validatePlan(json.value) : json;
}

export function parseContextPack(raw: string): HandoffValidation<ContextPack> {
  const json = parsed(raw);
  return json.ok ? validateContextPack(json.value) : json;
}

export function parseReviewNotes(raw: string): HandoffValidation<ReviewNotes> {
  const json = parsed(raw);
  return json.ok ? validateReviewNotes(json.value) : json;
}
