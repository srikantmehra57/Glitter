import { parseRouterAssessment } from "./assessment.js";
import { parsePlan } from "./handoffs.js";
import type {
  OrchestratorCapability,
  OrchestratorModel,
  OrchestratorRole,
  OrchestratorRoleCapabilities,
} from "./types.js";

export const PROBE_ROLES = ["router", "lead", "builder", "small"] as const;
export type ProbeRole = (typeof PROBE_ROLES)[number];
export type ProbeKind = "router-json" | "lead-plan" | "builder-tool-edit";

export function isProbeRole(value: unknown): value is ProbeRole {
  return PROBE_ROLES.some((role) => role === value);
}

export type ProbeToolCall = { name: string; arguments: Record<string, unknown> };
/** What the executor observed: the model's reply, its tool calls and the scratch files after them. */
export type ProbeResponse = {
  text: string;
  toolCalls: ProbeToolCall[];
  files?: Record<string, string>;
};

export type ProbeRequest = { role: ProbeRole; kind: ProbeKind; prompt: string };
export type ProbeTarget = OrchestratorModel & { role: ProbeRole };
export type ProbeResult = {
  role: ProbeRole;
  providerId: string;
  modelId: string;
  probeVersion: number;
  status: "passed" | "failed";
  detail: string;
  capabilities: OrchestratorCapability[];
  checkedAt: number;
};
export type ProbeStore = { version: 1; results: ProbeResult[] };

export type ProbeValidation = { ok: true; detail: string } | { ok: false; detail: string };
export type ProbeExecutor = (request: ProbeRequest) => ProbeResponse | Promise<ProbeResponse>;

export const PROBE_VERSION = 1;
export const PROBE_MAX_RESPONSE_CHARS = 32_000;
export const PROBE_FILE = "orchestrator-probe.txt";
export const PROBE_CONTENT = "orchestrator-probe-ok";
export const PROBE_DONE = "probe-ok";
const LEAD_PROBE_FILE = "README.md";
const MAX_PROBE_TOOL_CALLS = 8;
const CAPABILITY_ORDER: readonly OrchestratorCapability[] = ["tools", "vision", "long_context"];

/** The exact envelope the Router probe asks for; valid JSON alone is not enough. */
export const ROUTER_PROBE_ASSESSMENT = Object.freeze({
  taskKind: "minor_edit",
  difficulty: "trivial",
  designChoices: false,
  separable: true,
  causeKnown: true,
  risk: "low",
  confidence: "high",
  continuity: "new",
  requiredCapabilities: [],
  reasonCodes: ["probe"],
});

const PROMPTS: Record<ProbeKind, string> = {
  "router-json": `Return exactly one JSON object and no prose, fences or extra fields. Use exactly these values:\n${JSON.stringify(ROUTER_PROBE_ASSESSMENT)}`,
  "lead-plan": `Return exactly one JSON object and no prose or fences: an Orchestrator plan for adding one sentence to README.md. Use this shape and replace only the placeholders:\n${JSON.stringify({ kind: "orchestrator-plan", version: 1, goal: "<one sentence>", acceptanceCriteria: ["<one verifiable criterion>"], fileTargets: [{ path: LEAD_PROBE_FILE, symbols: [], intent: "<what changes>" }], steps: [{ intent: "<one ordered step>", files: [LEAD_PROBE_FILE] }], constraints: [], checks: [], risks: [], askLeadIf: [] })}`,
  "builder-tool-edit": `Work only inside the probe scratch directory. Use the write_file tool to create ./${PROBE_FILE} containing exactly: ${PROBE_CONTENT}\nThen use the read_file tool to read ./${PROBE_FILE} back. Do not use any other tool. Reply with exactly: ${PROBE_DONE}`,
};

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function probeRequest(role: ProbeRole): ProbeRequest {
  const kind: ProbeKind = role === "router" ? "router-json" : role === "lead" ? "lead-plan" : "builder-tool-edit";
  return { role, kind, prompt: PROMPTS[kind] };
}

function pathOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/^\.\//, "");
}

function builderValidation(response: ProbeResponse): ProbeValidation {
  const [write, read, ...extra] = response.toolCalls;
  if (response.toolCalls.length !== 2 || extra.length) return { ok: false, detail: "The Builder probe needs exactly one write_file call and one read_file call." };
  if (!write || write.name !== "write_file") return { ok: false, detail: "The first tool call must be write_file." };
  if (pathOf(write.arguments.path) !== PROBE_FILE) return { ok: false, detail: `write_file must target ${PROBE_FILE}.` };
  if (write.arguments.content !== PROBE_CONTENT) return { ok: false, detail: `write_file must contain exactly ${PROBE_CONTENT}.` };
  if (!read || read.name !== "read_file") return { ok: false, detail: "The second tool call must be read_file." };
  if (pathOf(read.arguments.path) !== PROBE_FILE) return { ok: false, detail: `read_file must target ${PROBE_FILE}.` };
  if (response.files?.[PROBE_FILE] !== PROBE_CONTENT) return { ok: false, detail: `The probe file must read back as ${PROBE_CONTENT}.` };
  if (response.text.trim() !== PROBE_DONE) return { ok: false, detail: `The final reply must be exactly ${PROBE_DONE}.` };
  return { ok: true, detail: "Builder tool use and edit verified." };
}

function routerValidation(response: ProbeResponse): ProbeValidation {
  const parsed = parseRouterAssessment(response.text);
  if (!parsed.ok) return { ok: false, detail: parsed.errors.join(" ") };
  if (JSON.stringify(parsed.value) !== JSON.stringify(ROUTER_PROBE_ASSESSMENT)) {
    return { ok: false, detail: "The Router probe must return the requested values without changes." };
  }
  return { ok: true, detail: "Strict router JSON verified." };
}

function leadValidation(response: ProbeResponse): ProbeValidation {
  const parsed = parsePlan(response.text);
  if (!parsed.ok) return { ok: false, detail: parsed.errors.join(" ") };
  if (!parsed.value.fileTargets.some((target) => pathOf(target.path) === LEAD_PROBE_FILE)) {
    return { ok: false, detail: `The Lead probe must target ${LEAD_PROBE_FILE}.` };
  }
  return { ok: true, detail: "Plan format verified." };
}

/** Validate a model's probe reply for its role. Unknown roles use the Builder check. */
export function validateProbeResponse(role: ProbeRole, response: unknown): ProbeValidation {
  if (!isRecord(response)) return { ok: false, detail: "Probe response must be an object." };
  if (typeof response.text !== "string") return { ok: false, detail: "Probe response text must be a string." };
  if (response.text.length > PROBE_MAX_RESPONSE_CHARS) return { ok: false, detail: `Probe response exceeds ${PROBE_MAX_RESPONSE_CHARS} characters.` };
  const rawCalls = response.toolCalls;
  if (!Array.isArray(rawCalls)) return { ok: false, detail: "Probe response toolCalls must be an array." };
  if (rawCalls.length > MAX_PROBE_TOOL_CALLS) return { ok: false, detail: `Probe response exceeds ${MAX_PROBE_TOOL_CALLS} tool calls.` };
  const toolCalls: ProbeToolCall[] = [];
  for (const [index, call] of rawCalls.entries()) {
    if (!isRecord(call) || typeof call.name !== "string" || !call.name.trim()) return { ok: false, detail: `toolCalls[${index}] must name a tool.` };
    if (!isRecord(call.arguments)) return { ok: false, detail: `toolCalls[${index}].arguments must be an object.` };
    toolCalls.push({ name: call.name, arguments: call.arguments });
  }
  if (response.files !== undefined && !isRecord(response.files)) return { ok: false, detail: "Probe response files must be an object." };
  const files: Record<string, string> = {};
  if (isRecord(response.files)) {
    for (const [path, content] of Object.entries(response.files)) {
      if (typeof content !== "string") return { ok: false, detail: "Probe response files must contain strings." };
      files[path] = content;
    }
  }
  const clean: ProbeResponse = { text: response.text, toolCalls, ...(isRecord(response.files) ? { files } : {}) };
  return role === "router" ? routerValidation(clean) : role === "lead" ? leadValidation(clean) : builderValidation(clean);
}

/**
 * Run one role probe through an injected executor. No provider call lives here:
 * the Harness supplies the executor, so the probe contract and its validation
 * stay deterministic and testable.
 */
export async function runProbe(input: {
  target: ProbeTarget;
  execute: ProbeExecutor;
  checkedAt: number;
}): Promise<ProbeResult> {
  const header = {
    role: input.target.role,
    providerId: input.target.providerId,
    modelId: input.target.modelId,
    probeVersion: PROBE_VERSION,
    checkedAt: input.checkedAt,
  };
  try {
    const validation = validateProbeResponse(input.target.role, await input.execute(probeRequest(input.target.role)));
    if (!validation.ok) return { ...header, status: "failed", detail: validation.detail, capabilities: [] };
    const role = input.target.role;
    return { ...header, status: "passed", detail: validation.detail, capabilities: role === "router" || role === "lead" ? [] : ["tools"] };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 500) : "Probe execution failed.";
    return { ...header, status: "failed", detail: detail || "Probe execution failed.", capabilities: [] };
  }
}

export function createProbeStore(): ProbeStore {
  return { version: 1, results: [] };
}

function sameTarget(result: ProbeResult, target: ProbeTarget): boolean {
  return result.role === target.role && result.providerId === target.providerId && result.modelId === target.modelId;
}

/** A record from an older probe version is stale, so the model is probed again. */
export function findProbe(store: ProbeStore, target: ProbeTarget): ProbeResult | undefined {
  return store.results.find((result) => sameTarget(result, target) && result.probeVersion === PROBE_VERSION);
}

export function probeNeeded(store: ProbeStore, target: ProbeTarget): boolean {
  return !findProbe(store, target);
}

/** A missing or failed probe is unsupported, never assumed. */
export function probePassed(store: ProbeStore, target: ProbeTarget): boolean {
  return findProbe(store, target)?.status === "passed";
}

/** Replace the record for this role and model; other models keep their results. */
export function recordProbe(store: ProbeStore, result: ProbeResult): ProbeStore {
  return {
    version: 1,
    results: [...store.results.filter((existing) => !sameTarget(existing, { role: result.role, providerId: result.providerId, modelId: result.modelId })), result],
  };
}

/**
 * Build the capability map the policy consumes. A role with no passing probe is
 * omitted entirely; catalog capabilities such as vision or a long context
 * window are added only for a role the model has already passed the probe for.
 * Small-task shares the Builder's check when both run the same model.
 */
export function roleCapabilitiesFromProbes(input: {
  roles: Record<OrchestratorRole, OrchestratorModel>;
  store: ProbeStore;
  catalog?: Partial<Record<OrchestratorRole, readonly OrchestratorCapability[]>>;
}): OrchestratorRoleCapabilities {
  const sameModel = (left: OrchestratorModel, right: OrchestratorModel) => left.providerId === right.providerId && left.modelId === right.modelId;
  const probeRole = (role: OrchestratorRole): OrchestratorRole =>
    role === "small" && sameModel(input.roles.small, input.roles.builder) ? "builder" : role;
  const capabilities = (role: OrchestratorRole): OrchestratorCapability[] => {
    const source = probeRole(role);
    const result = findProbe(input.store, { role: source, ...input.roles[role] });
    if (result?.status !== "passed") return [];
    const catalog = input.catalog?.[role] ?? input.catalog?.[source] ?? [];
    const supported = new Set<OrchestratorCapability>([...result.capabilities, ...catalog]);
    return CAPABILITY_ORDER.filter((capability) => supported.has(capability));
  };
  return { lead: capabilities("lead"), builder: capabilities("builder"), small: capabilities("small") };
}
