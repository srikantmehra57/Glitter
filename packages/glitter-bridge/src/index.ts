import { diagnostics, diagnosticEvent } from "./redaction.js";
import { LineFrames, encodeFrame } from "./framing.js";
import { queueDelta, writeFrame } from "./output.js";
import { MuseHost } from "./host.js";
import { LoginFlow } from "./login.js";
import { AcpAgentHost } from "./acp.js";
import { HARNESS_ID, HarnessHost } from "./harness/host.js";
import type { McpScope, McpServerInput } from "./harness/mcp.js";
import type { ProviderCredentials } from "./harness/providers.js";
import { agentSpec, checkAgentBin, detectAgents, resolveAgentBin } from "./agents.js";
import { checkCliUpdate, updateCli } from "./cli-update.js";
import type { ApprovalMode, BridgeRequest, ReasoningEffort, UserInputResponse } from "./protocol.js";
import { CREATE_CACHE_TTL_MS, HOST_QUEUE_LIMIT } from "./isolation.js";

diagnostics.remember(process.env);
const host = new MuseHost();
/**
 * Dedicated suggestion host: quiet (emits nothing) and always started with
 * `--no-session-log`, so predicted-starter sessions can never appear as
 * threads — live or after relaunch. Spawned lazily on the first `suggest`
 * call and stopped after a few idle minutes.
 */
const suggestHost = new MuseHost(true);
let suggestIdle: NodeJS.Timeout | null = null;
let suggestBusy = 0;
const SUGGEST_IDLE_MS = 4 * 60 * 1000;
/** Host start cap plus one turn. Callers may pass a shorter `timeoutMs`. */
const SUGGEST_BUDGET_MS = 75_000;
const SUGGEST_START_CAP_MS = 45_000;
/**
 * One quiet process, so only one start may run. A second overlapping `start`
 * would stop the child the first call is still initializing.
 */
let suggestLock: Promise<void> = Promise.resolve();
type SuggestIdentity = {
  museBin: string | null;
  museApiKey: string | null;
  museAuthMode: string | null;
  contributorMode: "on" | "off" | undefined;
  /** Workspace the sandbox was told not to read. Fixed until the next spawn. */
  denyReadRoot: string;
};
let suggestIdentity: SuggestIdentity | null = null;
function armSuggestIdle() {
  if (suggestIdle) clearTimeout(suggestIdle);
  suggestIdle = setTimeout(() => {
    if (suggestBusy > 0) { armSuggestIdle(); return; }
    suggestIdentity = null;
    void suggestHost.stop().catch(() => {});
  }, SUGGEST_IDLE_MS);
  suggestIdle.unref?.();
}
function withSuggestLock<T>(work: () => Promise<T>): Promise<T> {
  const run = suggestLock.then(work, work);
  suggestLock = run.then(() => undefined, () => undefined);
  return run;
}
function suggestIdentityFrom(params: Record<string, unknown>, denyReadRoot: string): SuggestIdentity {
  return {
    museBin: text(params.museBin),
    museApiKey: typeof params.museApiKey === "string" ? params.museApiKey : null,
    museAuthMode: text(params.museAuthMode),
    contributorMode: params.contributorMode === "on" || params.contributorMode === "off" ? params.contributorMode : undefined,
    denyReadRoot,
  };
}
/** Omitted fields keep the running host. A provided field that differs restarts it. */
function sameSuggestIdentity(running: SuggestIdentity, next: SuggestIdentity): boolean {
  if (running.denyReadRoot !== next.denyReadRoot) return false;
  if (next.contributorMode !== undefined && next.contributorMode !== running.contributorMode) return false;
  if (next.museBin && next.museBin !== running.museBin) return false;
  if (next.museApiKey !== null && next.museApiKey !== running.museApiKey) return false;
  if (next.museAuthMode && next.museAuthMode !== running.museAuthMode) return false;
  return true;
}
function mergeSuggestIdentity(running: SuggestIdentity | null, next: SuggestIdentity): SuggestIdentity {
  if (!running) return next;
  return {
    museBin: next.museBin ?? running.museBin,
    museApiKey: next.museApiKey !== null ? next.museApiKey : running.museApiKey,
    museAuthMode: next.museAuthMode ?? running.museAuthMode,
    contributorMode: next.contributorMode ?? running.contributorMode,
    denyReadRoot: next.denyReadRoot,
  };
}
const loginFlow = new LoginFlow((event, payload) => emit(event, payload));
/** The built-in agent runs in this process; one host serves every workspace. */
const harness = new HarnessHost((event, payload) => emit(event, payload));
const acpHosts = new Map<string, AcpAgentHost>();
/** sessionId → host key, so session-scoped calls reach the host that owns them. */
const owners = new Map<string, string>();
const MAX_OWNER_BINDINGS = 4096;

function write(value: unknown) {
  try {
    writeFrame(encodeFrame(value));
  } catch {
    const id = (value as { id?: string })?.id;
    if (id) {
      writeFrame(encodeFrame({ id, ok: false, error: "Response exceeds the protocol byte limit. Request a smaller page." }));
    } else {
      writeFrame(encodeFrame({ type: "event", event: "bridgeExit", payload: { error: "Agent output exceeds the protocol byte limit. Reconnect to continue." } }));
      shutdown();
    }
  }
}

function emit(event: string, payload: unknown) {
  // Streamed text is merged per display frame before it is written (see output.ts).
  if (event === "delta" && queueDelta(payload)) return;
  write({ type: "event", event, payload: diagnosticEvent(event, payload) });
}

/**
 * A sandbox profile is fixed at spawn, so each workspace gets its own host
 * process instead of reusing one scoped to a different folder. The key is
 * `agentId::workspaceRoot`. Sessionless calls (model listing before any
 * thread is open) share the bare per-agent host, which the sandbox confines
 * to the agent's config and temp roots.
 */
function acpHostKey(agentId: string, params: Record<string, unknown>): string {
  // `agentOf` returns whatever `owners` holds for the session, and that map
  // stores host *keys*, not agent ids. Re-deriving from one would append the
  // workspace a second time, miss the live host, and spawn a duplicate agent
  // child for a session that already has one.
  if (agentId.includes("::")) return agentId;
  const workspaceRoot = typeof params.workspaceRoot === "string" ? params.workspaceRoot : "";
  return workspaceRoot ? `${agentId}::${workspaceRoot}` : agentId;
}

function acp(key: string, providedBin?: string | null) {
  const supplied = providedBin ? checkAgentBin(providedBin) : null;
  let agent = acpHosts.get(key);
  if (agent && supplied && agent.bin !== supplied && !agent.running) {
    acpHosts.delete(key);
    agent = undefined;
  }
  if (!agent) {
    const agentId = key.split("::")[0];
    const spec = agentSpec(agentId);
    if (spec.protocol !== "acp") throw new Error(`${spec.name} is not an ACP agent.`);
    // The native side resolves, validates, and identity-checks the binary and
    // injects its canonical path; only direct (non-Tauri) invocations fall
    // back to self-resolution here. A supplied path is still canonicalized and
    // refused from temp before anything is spawned with it.
    const bin = supplied || resolveAgentBin(spec);
    if (!bin) throw new Error(`${spec.name} is not installed. Install it, then choose Rescan.`);
    agent = new AcpAgentHost(spec, bin, emit);
    acpHosts.set(key, agent);
  }
  return agent;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A skill invocation from the renderer: a selector string, and arguments when they are a string. */
function skillParam(value: unknown): { selector: string; arguments?: string } | undefined {
  const skill = value as { selector?: unknown; arguments?: unknown } | undefined;
  return skill && typeof skill.selector === "string" ? { selector: skill.selector, ...(typeof skill.arguments === "string" ? { arguments: skill.arguments } : {}) } : undefined;
}

/** The file an MCP server is written to: the workspace or the home folder. */
function mcpScope(value: unknown): McpScope {
  if (value !== "workspace" && value !== "home") throw new Error("A server scope must be workspace or home.");
  return value;
}

/** A server definition from the renderer, reduced to the shapes the config writer accepts. */
function mcpServerInput(value: unknown): McpServerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A server definition is required.");
  const raw = value as Record<string, unknown>;
  if (raw.transport !== "stdio" && raw.transport !== "http") throw new Error("A server transport must be stdio or http.");
  const list = (candidate: unknown, label: string): string[] => {
    if (candidate == null) return [];
    if (!Array.isArray(candidate) || candidate.some((item) => typeof item !== "string")) throw new Error(`${label} must be a list of strings.`);
    return candidate as string[];
  };
  const map = (candidate: unknown, label: string): Record<string, string> => {
    if (candidate == null) return {};
    if (typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`${label} must be an object of strings.`);
    const entries = Object.entries(candidate);
    if (entries.some(([, item]) => typeof item !== "string")) throw new Error(`${label} must be an object of strings.`);
    return Object.fromEntries(entries) as Record<string, string>;
  };
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    transport: raw.transport,
    ...(typeof raw.command === "string" ? { command: raw.command } : {}),
    args: list(raw.args, "args"),
    env: map(raw.env, "env"),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    headers: map(raw.headers, "headers"),
    ...(typeof raw.timeoutMs === "number" ? { timeoutMs: raw.timeoutMs } : {}),
  };
}

/**
 * Serialize a dispatch failure without flattening its structure: the
 * message stays human-readable, while an SDK `MspError` kind (found on the
 * error or its cause chain, which the host mappers preserve) and its
 * retryability ride along so the renderer can branch recovery on them.
 */
function failureOf(error: unknown): { error: string; code?: string; retryable?: boolean } {
  const message = diagnostics.text(error instanceof Error ? error.message : String(error));
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const record = current as Record<string, unknown>;
    if (typeof record.kind === "string" && record.kind) {
      return {
        error: message,
        code: diagnostics.text(record.kind),
        ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
      };
    }
    if (typeof record.code === "string" && record.code) {
      return { error: message, code: diagnostics.text(record.code) };
    }
    current = current instanceof Error ? current.cause : record.cause;
  }
  return { error: message };
}

const queues = new Map<string, { tail: Promise<unknown>; pending: number }>();
const createCache = new Map<string, { expires: number; result: unknown }>();

function queueKey(method: string, params: Record<string, unknown>) {
  // An update downloads a release: it must not wedge lifecycle verbs behind it.
  if (method === "updateCli") return "muse:cli-update";
  // Suggestions never hold the session queue. Muse has one quiet host, so its
  // suggestions share one key: a second workspace must not restart that host
  // while a turn is still running. ACP suggestion hosts are per workspace.
  if (method === "suggest") {
    const agent = agentOf(params);
    if (agent === "muse") return "muse:suggest";
    const root = typeof params.workspaceRoot === "string" ? params.workspaceRoot : "";
    return `${agent}:suggest:${root}`;
  }
  const agent = agentOf(params);
  if (["ping", "detect", "status", "startHost", "stopHost", "startLogin", "cancelLogin", "usage", "mcpServers", "checkCliUpdate"].includes(method)) {
    return `${agent}:lifecycle`;
  }
  const session = typeof params.sessionId === "string" ? params.sessionId : "";
  return session ? `${agent}:${session}` : `${agent}:lifecycle`;
}

/**
 * A verb that never answers must not hold its queue slot forever. `enqueue`
 * serializes per agent (and per session), so a single wedged request becomes
 * head-of-line: it blocks every later call on that key until the queue limit
 * starts rejecting — including `cancelTurn`, which is how the user asks for the
 * thing that is stuck to stop.
 *
 * The wait is bounded, not the work: the request is already on the wire, so the
 * promise is abandoned rather than cancelled and the verb may still land. The
 * wording is the renderer's unknown-result contract — a send whose
 * acknowledgement never arrived must stay retryable, not roll back as a
 * definitive failure.
 */
const WORK_CEILING_MS = 100_000;

/**
 * Test seam: `GLITTER_WORK_CEILING_MS` may only *tighten* the ceiling, never
 * loosen it, so an override can shorten the wait a test has to sit through
 * without ever weakening the guard in a real session.
 */
function workCeiling(): number {
  const raw = process.env.GLITTER_WORK_CEILING_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, WORK_CEILING_MS) : WORK_CEILING_MS;
}

/**
 * Verbs whose duration is legitimately unbounded, so a wall-clock ceiling would
 * cut working turns short. Their own budgets govern them instead.
 *
 * - `updateCli` downloads a release; the launcher's budget is minutes.
 * - `startLogin` waits on the user's browser to authorize a device code.
 *
 * `sendTurn` is deliberately NOT here: it awaits the submit acknowledgement,
 * not the turn itself. `sendUserTurn` returns a `Turn` handle and the item,
 * delta and completion streams are wired fire-and-forget, so its wait is a
 * round trip that should be bounded like any other.
 */
const UNBOUNDED_WORK = new Set(["updateCli", "startLogin"]);

async function enqueue<T>(key: string, method: string, deadlineAt: number | undefined, work: () => Promise<T>): Promise<T> {
  const slot = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  if (slot.pending >= HOST_QUEUE_LIMIT) {
    throw new Error("Too many requests are already in flight for this agent. Wait and retry.");
  }
  slot.pending += 1;
  const run = slot.tail.then(async () => {
    if (deadlineAt != null && performance.now() >= deadlineAt) throw new Error("Request deadline expired.");
    return UNBOUNDED_WORK.has(method) ? work() : bounded(work);
  }) as Promise<T>;
  slot.tail = run.then(() => undefined, () => undefined);
  queues.set(key, slot);
  try {
    return await run;
  } finally {
    slot.pending -= 1;
    // An idle queue slot holds no ordering state; dropping it keeps the map
    // bounded over a long-lived bridge.
    if (slot.pending === 0) queues.delete(key);
  }
}

/**
 * Race `work` against the ceiling. `Promise.race` subscribes to the loser too,
 * so the abandoned request's eventual rejection is never unhandled, and the
 * timer is cleared so it cannot outlive the call.
 */
async function bounded<T>(work: () => Promise<T>): Promise<T> {
  const ceiling = workCeiling();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The request timed out. Its result is unknown; check before retrying.")), ceiling);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function replayCreate(method: string, agentId: string, params: Record<string, unknown>): unknown | undefined {
  const id = typeof params.clientRequestId === "string" ? params.clientRequestId.trim() : "";
  if (!id) return undefined;
  const key = `${method}:${agentId}:${id}`;
  const hit = createCache.get(key);
  if (!hit) return undefined;
  if (hit.expires < performance.now()) {
    createCache.delete(key);
    return undefined;
  }
  return hit.result;
}

function rememberCreate(method: string, agentId: string, params: Record<string, unknown>, result: unknown) {
  const id = typeof params.clientRequestId === "string" ? params.clientRequestId.trim() : "";
  if (!id) return;
  if (createCache.size >= 64) {
    const now = performance.now();
    for (const [key, entry] of createCache) {
      if (entry.expires < now) createCache.delete(key);
    }
    if (createCache.size >= 64) createCache.delete(createCache.keys().next().value!);
  }
  createCache.set(`${method}:${agentId}:${id}`, { expires: performance.now() + CREATE_CACHE_TTL_MS, result });
}

function agentOf(params: Record<string, unknown>) {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
  const explicit = typeof params.agentId === "string" && params.agentId ? params.agentId : undefined;
  return (sessionId && owners.get(sessionId)) || explicit || "muse";
}

function rememberOwner(sessionId: string, agentId: string) {
  if (!sessionId) return;
  if (owners.has(sessionId)) owners.delete(sessionId);
  owners.set(sessionId, agentId);
  while (owners.size > MAX_OWNER_BINDINGS) {
    const oldest = owners.keys().next();
    if (oldest.done) break;
    owners.delete(oldest.value);
  }
}

function claim<T extends { sessionId?: string; sessions?: Array<{ sessionId: string }> }>(agentId: string, result: T): T {
  if (result.sessionId) rememberOwner(result.sessionId, agentId);
  for (const session of result.sessions ?? []) rememberOwner(session.sessionId, agentId);
  return result;
}

/**
 * Drop a session's ownership entry. `closeSession` is the one verb that ends a
 * session's life in this bridge, and `owners` is the map that grows with every
 * session ever listed or started, so the entry has to go with the host's state.
 */
function release(sessionId: string) {
  if (sessionId) owners.delete(sessionId);
}

/**
 * Provider keys the native shell injected for a harness request. Each is
 * registered with the redactor first, so no error or log line can echo one.
 */
function providerCredentials(params: Record<string, unknown>): ProviderCredentials | undefined {
  const raw = params.providerKeys;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const credentials: ProviderCredentials = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { key?: unknown; baseUrl?: unknown };
    const key = typeof entry.key === "string" ? entry.key : undefined;
    if (key) diagnostics.remember({ [`${id}ApiKey`]: key });
    credentials[id] = { ...(key ? { key } : {}), ...(typeof entry.baseUrl === "string" && entry.baseUrl ? { baseUrl: entry.baseUrl } : {}) };
  }
  return credentials;
}

/** Ids of the providers with saved keys, injected natively (never the keys) for detection. */
function harnessProviders(params: Record<string, unknown>): string[] {
  return Array.isArray(params.harnessProviders) ? params.harnessProviders.filter((id): id is string => typeof id === "string") : [];
}

async function dispatch(method: string, params: Record<string, unknown>) {
  if (typeof params.museApiKey === "string") diagnostics.remember({ museApiKey: params.museApiKey });
  const agentId = agentOf(params);
  if (agentId === HARNESS_ID) {
    harness.setCredentials(providerCredentials(params));
    return dispatchHarness(method, params);
  }
  if (agentId !== "muse") {
    // Suggestion hosts are not the user's session host. Reusing that process
    // would keep the workspace as a write root for the suggestion turn.
    const workspaceRoot = typeof params.workspaceRoot === "string" ? params.workspaceRoot : "";
    const hostKey = method === "suggest"
      ? `${agentId.split("::")[0]}::suggest::${workspaceRoot}`
      : acpHostKey(agentId, params);
    return dispatchAcp(acp(hostKey, text(params.agentBin)), hostKey, method, params);
  }
  switch (method) {
    case "ping":
      return { pong: true };
    case "detect": {
      // Agents first: their probes run concurrently and warm the Muse version
      // cache, so the Muse detection below answers without spawning it again.
      const agents = await detectAgents(text(params.museBin), text(params.museApiKey), text(params.museAuthMode), harnessProviders(params));
      return { ...(await host.detect(text(params.museBin), text(params.museApiKey), text(params.museAuthMode))), agents };
    }
    case "status":
      return host.status(text(params.museBin), text(params.museApiKey), text(params.museAuthMode));
    case "startLogin":
      return loginFlow.start(text(params.museBin));
    case "cancelLogin":
      return loginFlow.cancel();
    case "checkCliUpdate":
      return checkCliUpdate({ museBin: text(params.museBin) });
    case "updateCli":
      return updateCli({ museBin: text(params.museBin) });
    case "usage":
      return host.readUsage();
    case "startHost":
      return host.start(text(params.museBin), text(params.museApiKey), text(params.museAuthMode), params.trustWorkspace === true, {
        noSessionLog: params.noSessionLog === true,
        disableWrite: params.disableWrite === true,
        disableShell: params.disableShell === true,
        sandboxNetwork: typeof params.sandboxNetwork === "string" ? params.sandboxNetwork : undefined,
        contributorMode: params.contributorMode === "on" || params.contributorMode === "off" ? params.contributorMode : undefined,
      });
    case "stopHost":
      return host.stop();
    case "listSessions":
      return claim("muse", await host.listSessions({
        workspaceRoot: typeof params.workspaceRoot === "string" ? params.workspaceRoot : undefined,
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined,
        updatedAfter: typeof params.updatedAfter === "string" ? params.updatedAfter : undefined,
      }) as { sessions?: Array<{ sessionId: string }> });
    case "renameSession":
      return host.renameSession({
        sessionId: String(params.sessionId ?? ""),
        name: String(params.name ?? ""),
      });
    case "listModels":
      return host.listModels(typeof params.sessionId === "string" ? params.sessionId : undefined);
    case "startSession": {
      const replayed = replayCreate("startSession", "muse", params);
      if (replayed) return replayed;
      const started = claim("muse", await host.startSession({
        workspaceRoot: String(params.workspaceRoot ?? ""),
        approvalMode: params.approvalMode as ApprovalMode | undefined,
        modelId: typeof params.modelId === "string" ? params.modelId : undefined,
        providerId: typeof params.providerId === "string" ? params.providerId : undefined,
      }));
      rememberCreate("startSession", "muse", params, started);
      return started;
    }
    case "resumeSession": {
      const replayed = replayCreate("resumeSession", "muse", params);
      if (replayed) return replayed;
      const resumed = claim("muse", await host.resumeSession({
        sessionId: String(params.sessionId ?? ""),
        cursor: typeof params.cursor === "string" ? params.cursor : null,
      }));
      rememberCreate("resumeSession", "muse", params, resumed);
      return resumed;
    }
    case "forkSession": {
      const replayed = replayCreate("forkSession", "muse", params);
      if (replayed) return replayed;
      const forked = claim("muse", await host.forkSession({
        sessionId: String(params.sessionId ?? ""),
        lastTurnId: typeof params.lastTurnId === "string" ? params.lastTurnId : undefined,
      }));
      rememberCreate("forkSession", "muse", params, forked);
      return forked;
    }
    case "compactSession":
      return host.compactSession({ sessionId: String(params.sessionId ?? "") });
    case "closeSession": {
      const sessionId = String(params.sessionId ?? "");
      const closed = await host.closeSession({ sessionId });
      release(sessionId);
      return closed;
    }
    case "readSession":
      return host.readSession({
        sessionId: String(params.sessionId ?? ""),
        excludeItems: typeof params.excludeItems === "boolean" ? params.excludeItems : undefined,
      });
    case "pageHistory":
      return host.pageOlderHistory({
        sessionId: String(params.sessionId ?? ""),
        cursor: typeof params.cursor === "string" && params.cursor ? params.cursor : undefined,
      });
    case "listSkills":
      return host.listSkills({ sessionId: String(params.sessionId ?? "") });
    case "mcpServers":
      return host.mcpServers();
    case "userShell":
      return host.userShell({ sessionId: String(params.sessionId ?? ""), commandText: String(params.commandText ?? "") });
    case "sendTurn": {
      const ifBusy = params.ifBusy;
      if (ifBusy !== undefined && ifBusy !== "queue" && ifBusy !== "steer" && ifBusy !== "replace") {
        throw new Error("Busy disposition must be queue, steer, or replace.");
      }
      return host.sendTurn({
        sessionId: String(params.sessionId ?? ""),
        text: String(params.text ?? ""),
        reasoningEffort: params.reasoningEffort as ReasoningEffort | undefined,
        images: Array.isArray(params.images) ? params.images : undefined,
        clientTurnId: typeof params.clientTurnId === "string" ? params.clientTurnId : undefined,
        ifBusy: ifBusy as "queue" | "steer" | "replace" | undefined,
        skill: skillParam(params.skill),
      });
    }
    case "steerTurn":
      return host.steerTurn({
        sessionId: String(params.sessionId ?? ""),
        text: String(params.text ?? ""),
        reasoningEffort: params.reasoningEffort as ReasoningEffort | undefined,
        images: Array.isArray(params.images) ? params.images : undefined,
      });
    case "unqueueTurn":
      return host.unqueueTurn({
        sessionId: String(params.sessionId ?? ""),
        turnId: String(params.turnId ?? ""),
      });
    case "cancelTurn":
      return host.cancelTurn({
        sessionId: String(params.sessionId ?? ""),
        turnId: typeof params.turnId === "string" ? params.turnId : undefined,
      });
    case "respondUserInput":
      if (!params.response || typeof params.response !== "object") throw new Error("Question response is required.");
      return host.respondUserInput({
        sessionId: String(params.sessionId ?? ""),
        userInputId: String(params.userInputId ?? ""),
        response: params.response as UserInputResponse,
      });
    case "decideApproval": {
      const approvalId = String(params.approvalId ?? "");
      const owner = [...acpHosts.values()].find((agent) => agent.ownsApproval(approvalId));
      if (owner) return owner.decideApproval({ approvalId, choiceId: String(params.choiceId ?? "") });
      return host.decideApproval({ approvalId, choiceId: String(params.choiceId ?? "") });
    }
    case "setApprovalMode":
      return host.setApprovalMode({
        sessionId: String(params.sessionId ?? ""),
        mode: params.mode as ApprovalMode,
      });
    case "setModel":
      return host.setModel({
        sessionId: String(params.sessionId ?? ""),
        modelId: String(params.modelId ?? ""),
        providerId: typeof params.providerId === "string" ? params.providerId : undefined,
      });
    case "setReasoningEffort":
      return host.setReasoningEffort({
        sessionId: String(params.sessionId ?? ""),
        reasoningEffort: String(params.reasoningEffort ?? params.effort ?? ""),
      });
    case "subagentControl":
      return host.subagentControl({
        sessionId: String(params.sessionId ?? ""),
        subagentId: String(params.subagentId ?? ""),
        action: String(params.action ?? ""),
        body: typeof params.body === "string" ? params.body : undefined,
        reason: typeof params.reason === "string" ? params.reason : undefined,
      });
    case "taskControl":
      return host.taskControl({
        sessionId: String(params.sessionId ?? ""),
        action: String(params.action ?? ""),
        taskId: typeof params.taskId === "string" ? params.taskId : undefined,
      });
    case "workflowControl":
      return host.workflowControl({
        sessionId: String(params.sessionId ?? ""),
        workflowRunId: String(params.workflowRunId ?? ""),
        action: String(params.action ?? ""),
        childId: typeof params.childId === "string" ? params.childId : undefined,
        attempt: typeof params.attempt === "number" ? params.attempt : undefined,
      });
    case "goalControl":
      return host.goalControl({
        sessionId: String(params.sessionId ?? ""),
        action: String(params.action ?? ""),
        objective: typeof params.objective === "string" ? params.objective : undefined,
      });
    case "readOutput":
      return host.readOutput({
        sessionId: String(params.sessionId ?? ""),
        itemId: String(params.itemId ?? ""),
        outputRef: String(params.outputRef ?? ""),
        offsetBytes: typeof params.offsetBytes === "number" ? params.offsetBytes : undefined,
        lengthBytes: typeof params.lengthBytes === "number" ? params.lengthBytes : undefined,
      });
    case "suggest": {
      const workspaceRoot = String(params.workspaceRoot ?? "");
      if (!workspaceRoot.trim()) throw new Error("A workspace root is required for suggestions.");
      const budget = typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : SUGGEST_BUDGET_MS;
      const startedAt = performance.now();
      const next = suggestIdentityFrom(params, workspaceRoot);
      const remaining = await withSuggestLock(async () => {
        const reuse = suggestHost.running && suggestIdentity !== null && sameSuggestIdentity(suggestIdentity, next);
        if (!reuse) {
          const merged = suggestHost.running ? mergeSuggestIdentity(suggestIdentity, next) : next;
          if (suggestHost.running) {
            await suggestHost.stop();
            suggestIdentity = null;
          }
          const left = budget - (performance.now() - startedAt);
          if (left <= 0) throw new Error("The suggestion request timed out.");
          await suggestHost.start(merged.museBin, merged.museApiKey, merged.museAuthMode, false, {
            noSessionLog: true,
            disableWrite: true,
            disableShell: true,
            contributorMode: merged.contributorMode,
            denyReadRoots: [merged.denyReadRoot],
            initializeTimeoutMs: Math.min(SUGGEST_START_CAP_MS, left),
          });
          suggestIdentity = merged;
        }
        return budget - (performance.now() - startedAt);
      });
      if (remaining <= 0) throw new Error("The suggestion request timed out.");
      // The idle clock runs from completion: an in-flight suggestion is never
      // killed by its own keep-alive timer.
      suggestBusy += 1;
      try {
        return await suggestHost.suggest({
          workspaceRoot,
          prompt: String(params.prompt ?? ""),
          modelId: typeof params.modelId === "string" && params.modelId.trim() ? params.modelId.trim() : undefined,
          providerId: typeof params.providerId === "string" && params.providerId.trim() ? params.providerId.trim() : undefined,
          timeoutMs: remaining,
        });
      } finally {
        suggestBusy -= 1;
        armSuggestIdle();
      }
    }
    case "setSessionOption":
      throw new Error("Muse sessions use setModel/setApprovalMode.");
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function dispatchAcp(agent: AcpAgentHost, hostKey: string, method: string, params: Record<string, unknown>) {
  const agentId = hostKey.split("::")[0];
  const sessionId = String(params.sessionId ?? "");
  switch (method) {
    case "startHost":
      await agent.start(typeof params.workspaceRoot === "string" ? { workspaceRoot: params.workspaceRoot } : undefined);
      return { started: true, agentId, isolation: agent.isolation() };
    case "stopHost": {
      // One agent may run one host per workspace; stop them all.
      const targets = [...acpHosts].filter(([key]) => key === agentId || key.startsWith(`${agentId}::`));
      for (const [key] of targets) acpHosts.delete(key);
      await Promise.all(targets.map(([, host]) => host.stop()));
      return { stopped: true };
    }
    case "listSessions":
      return claim(hostKey, await agent.listSessions(typeof params.workspaceRoot === "string" ? params.workspaceRoot : undefined));
    case "listModels":
      return agent.listModels(sessionId || undefined, params.refresh === true, typeof params.modelId === "string" ? params.modelId : undefined);
    case "startSession": {
      const replayed = replayCreate("startSession", agentId, params);
      if (replayed) return replayed;
      const started = claim(hostKey, await agent.startSession({
        workspaceRoot: String(params.workspaceRoot ?? ""),
        modelId: typeof params.modelId === "string" ? params.modelId : undefined,
        effort: typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
        mode: typeof params.mode === "string" ? params.mode : undefined,
      }));
      rememberCreate("startSession", agentId, params, started);
      return started;
    }
    case "resumeSession": {
      const replayed = replayCreate("resumeSession", agentId, params);
      if (replayed) return replayed;
      const resumed = claim(hostKey, await agent.resumeSession({ sessionId, workspaceRoot: String(params.workspaceRoot ?? "") }));
      rememberCreate("resumeSession", agentId, params, resumed);
      return resumed;
    }
    case "sendTurn":
      return agent.sendTurn({
        sessionId,
        text: String(params.text ?? ""),
        reasoningEffort: typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
        images: Array.isArray(params.images) ? params.images : undefined,
      });
    case "cancelTurn":
      return agent.cancelTurn({ sessionId });
    case "steerTurn":
    case "unqueueTurn":
      throw new Error(`${agent.spec.name} does not support queued turns.`);
    case "forkSession":
    case "compactSession":
    case "readSession":
    case "pageHistory":
    case "listSkills":
    case "mcpServers":
    case "userShell":
    case "readOutput":
    case "setReasoningEffort":
    case "subagentControl":
    case "taskControl":
    case "workflowControl":
    case "goalControl":
    case "readChildSession":
      throw new Error(`${agent.spec.name} does not support this session operation.`);
    case "decideApproval":
      return agent.decideApproval({ approvalId: String(params.approvalId ?? ""), choiceId: String(params.choiceId ?? "") });
    case "setModel":
      return agent.setModel({ sessionId, modelId: String(params.modelId ?? "") });
    case "setSessionOption": {
      const option = String(params.option ?? "");
      const value = String(params.value ?? "");
      if (option === "effort") return agent.setEffort(sessionId, value);
      if (option === "mode") return agent.setMode(sessionId, value);
      return agent.setOption(sessionId, option, value);
    }
    case "suggest": {
      // The root becomes the read-deny of the suggestion sandbox. An empty one
      // would silently run the turn unconfined, so it is refused like Muse's.
      const workspaceRoot = String(params.workspaceRoot ?? "");
      if (!workspaceRoot.trim()) throw new Error("A workspace root is required for suggestions.");
      return agent.suggest({
        workspaceRoot,
        prompt: String(params.prompt ?? ""),
        modelId: typeof params.modelId === "string" && params.modelId.trim() ? params.modelId.trim() : undefined,
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      });
    }
    case "closeSession": {
      const closed = await agent.closeSession({ sessionId });
      release(sessionId);
      return closed;
    }
    case "setApprovalMode":
      throw new Error(`${agent.spec.name} controls permissions in its own configuration; Muse Desktop cannot change them for this agent.`);
    default:
      throw new Error(`${agent.spec.name} does not support ${method}.`);
  }
}

async function dispatchHarness(method: string, params: Record<string, unknown>) {
  const sessionId = String(params.sessionId ?? "");
  const workspaceRoot = typeof params.workspaceRoot === "string" ? params.workspaceRoot : "";
  switch (method) {
    case "startHost":
      await harness.start();
      return { started: true, agentId: HARNESS_ID, isolation: harness.isolation() };
    case "stopHost":
      await harness.stop();
      return { stopped: true };
    case "listSessions":
      return claim(HARNESS_ID, await harness.listSessions(workspaceRoot || undefined));
    case "listModels":
      return harness.listModels(sessionId || undefined, params.refresh === true);
    case "startSession": {
      const replayed = replayCreate("startSession", HARNESS_ID, params);
      if (replayed) return replayed;
      const started = claim(HARNESS_ID, await harness.startSession({
        workspaceRoot,
        modelId: typeof params.modelId === "string" ? params.modelId : undefined,
        effort: typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
        mode: typeof params.mode === "string" ? params.mode : undefined,
        approvalMode: typeof params.approvalMode === "string" ? params.approvalMode : undefined,
      }));
      rememberCreate("startSession", HARNESS_ID, params, started);
      return started;
    }
    case "resumeSession": {
      const replayed = replayCreate("resumeSession", HARNESS_ID, params);
      if (replayed) return replayed;
      const resumed = claim(HARNESS_ID, await harness.resumeSession({ sessionId, workspaceRoot, approvalMode: typeof params.approvalMode === "string" ? params.approvalMode : undefined }));
      rememberCreate("resumeSession", HARNESS_ID, params, resumed);
      return resumed;
    }
    case "sendTurn": {
      const ifBusy = params.ifBusy;
      if (ifBusy !== undefined && ifBusy !== "queue" && ifBusy !== "steer" && ifBusy !== "replace") {
        throw new Error("Busy disposition must be queue, steer, or replace.");
      }
      return harness.sendTurn({
        sessionId,
        text: String(params.text ?? ""),
        reasoningEffort: typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
        images: Array.isArray(params.images) ? params.images : undefined,
        ifBusy: ifBusy as "queue" | "steer" | "replace" | undefined,
        skill: skillParam(params.skill),
      });
    }
    case "steerTurn":
      return harness.steerTurn({
        sessionId,
        text: String(params.text ?? ""),
        reasoningEffort: typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
        images: Array.isArray(params.images) ? params.images : undefined,
        skill: skillParam(params.skill),
      });
    case "unqueueTurn":
      return harness.unqueueTurn({ sessionId, turnId: String(params.turnId ?? "") });
    case "listSkills":
      return harness.listSkills({ sessionId });
    case "harnessMcp":
      return harness.mcpStatus({ sessionId, refresh: params.refresh === true });
    case "harnessMcpConfig":
      return harness.mcpConfig({ sessionId });
    case "harnessMcpAddServer":
      return harness.addMcpServer({ sessionId, scope: mcpScope(params.scope), server: mcpServerInput(params.server) });
    case "harnessMcpRemoveServer":
      return harness.removeMcpServer({ sessionId, scope: mcpScope(params.scope), name: String(params.name ?? "") });
    case "respondUserInput":
      if (!params.response || typeof params.response !== "object") throw new Error("Question response is required.");
      return harness.respondUserInput({ sessionId, userInputId: String(params.userInputId ?? ""), response: params.response as UserInputResponse });
    case "cancelTurn":
      return harness.cancelTurn({ sessionId });
    case "decideApproval":
      return harness.decideApproval({ approvalId: String(params.approvalId ?? ""), choiceId: String(params.choiceId ?? "") });
    case "setModel":
      return harness.setModel({ sessionId, modelId: String(params.modelId ?? "") });
    case "setSessionOption":
      return harness.setOption(sessionId, String(params.option ?? ""), String(params.value ?? ""));
    case "setApprovalMode":
      return harness.setApprovalMode(sessionId, String(params.mode ?? ""));
    case "suggest": {
      if (!workspaceRoot.trim()) throw new Error("A workspace root is required for suggestions.");
      return harness.suggest({
        workspaceRoot,
        prompt: String(params.prompt ?? ""),
        modelId: typeof params.modelId === "string" && params.modelId.trim() ? params.modelId.trim() : undefined,
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
      });
    }
    case "testModel":
      return harness.testModel({ modelId: String(params.modelId ?? "") });
    case "closeSession": {
      const closed = await harness.closeSession({ sessionId });
      release(sessionId);
      return closed;
    }
    case "readChildSession":
      return harness.readChildSession({
        sessionId,
        childSessionId: String(params.childSessionId ?? ""),
        excludeItems: typeof params.excludeItems === "boolean" ? params.excludeItems : undefined,
      });
    default:
      throw new Error(`${harness.spec.name} does not support ${method}.`);
  }
}

const frames = new LineFrames();
let shuttingDown = false;
process.stdin.on("data", (chunk: Buffer) => {
  if (shuttingDown) return;
  try {
    frames.push(chunk, (raw) => {
      const line = raw.trim();
      if (!line) return;
      let request: BridgeRequest;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
          || typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 128
          || typeof parsed.method !== "string" || !parsed.method || parsed.method.length > 128
          || (parsed.params !== undefined && (!parsed.params || typeof parsed.params !== "object" || Array.isArray(parsed.params)))) {
          throw new Error("Invalid request");
        }
        request = parsed;
      } catch {
        // Parse errors may contain credentials from the input; never echo them.
        write({ id: null, ok: false, error: "Invalid JSON request." });
        return;
      }
      // The native shell sends a relative budget so the deadline is measured
      // on this process's monotonic clock, not the wall clock shared with it.
      const deadlineInMs = typeof request.deadlineInMs === "number" && Number.isFinite(request.deadlineInMs) ? Math.max(0, request.deadlineInMs) : undefined;
      const deadlineAt = deadlineInMs == null ? undefined : performance.now() + deadlineInMs;
      const params = request.params ?? {};
      void enqueue(queueKey(request.method, params), request.method, deadlineAt, () => dispatch(request.method, params))
        .then((result) => write({ id: request.id, ok: true, result }))
        .catch((error: unknown) => write({ id: request.id, ok: false, ...failureOf(error) }));
    });
  } catch {
    write({ type: "event", event: "bridgeExit", payload: { error: "Bridge protocol frame exceeded the byte limit. Reconnect to continue." } });
    shutdown();
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdin.pause();
  const timer = setTimeout(() => process.exit(0), 2000);
  timer.unref();
  void Promise.allSettled([host.stop(), suggestHost.stop(), harness.stop(), ...[...acpHosts.values()].map((agent) => agent.stop())]).finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}

/**
 * Last-resort crash sink: an uncaught frame reaches the host as a redacted
 * `bridgeExit` event instead of Node's raw stderr dump — which matters when
 * the bridge runs without the native stderr tap (dev, smoke scripts).
 * Node's default already crashes on unhandled rejections; this keeps that
 * semantics while routing the report through the diagnostic redactor.
 */
function crash(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  try {
    emit("bridgeExit", { error: `Bridge crashed: ${message}` });
    shutdown();
  } catch {
    // stdout or stdin is already gone; nothing safe left to do but exit.
    process.exit(1);
  }
}

process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);
