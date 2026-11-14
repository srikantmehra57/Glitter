import { diagnostics, diagnosticEvent } from "./redaction.js";
import { LineFrames, encodeFrame } from "./framing.js";
import { queueDelta, writeFrame } from "./output.js";
import { HARNESS_ID, HARNESS_NAME, HarnessHost } from "./harness/host.js";
import type { McpAuthorization, McpScope, McpServerInput } from "./harness/mcp.js";
import type { WorkspaceRestore } from "./harness/store.js";
import { nativeProviderCredentials } from "./harness/providers.js";
import type { BrowserControlInput, BrowserManager } from "./browser.js";
import type { BridgeRequest, UserInputResponse } from "./protocol.js";
import { CREATE_CACHE_TTL_MS, HOST_QUEUE_LIMIT } from "./isolation.js";
import { normalizeProtectedPaths } from "./harness/permission/protected.js";

/**
 * The app's agent process. The native shell spawns it once and speaks NDJSON
 * over stdio; every session runs on the in-process Harness. Nothing here
 * spawns another agent: the harness calls model providers directly with the
 * keys the native side injects into each request.
 */
diagnostics.remember(process.env);
/** Per-session MCP trust the native side injected with the request that opened the session. */
const harnessAuthorizations = new Map<string, McpAuthorization>();
let browser: BrowserManager | undefined;
let browserLoading: Promise<BrowserManager> | null = null;
const harness = new HarnessHost((event, payload) => emit(event, payload), undefined, undefined, undefined, (sessionId) => harnessAuthorizations.get(sessionId));
async function ensureBrowser(): Promise<BrowserManager> {
  if (!browserLoading) browserLoading = (async () => {
    const { BrowserManager, browserExtension } = await import("./browser.js");
    const manager = new BrowserManager((event, payload) => emit(event, payload));
    harness.registry.register(browserExtension(manager));
    browser = manager;
    return manager;
  })();
  return browserLoading;
}

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

/** A skill invocation from the renderer: a selector string, and arguments when they are a string. */
function skillParam(value: unknown): { selector: string; arguments?: string } | undefined {
  const skill = value as { selector?: unknown; arguments?: unknown } | undefined;
  return skill && typeof skill.selector === "string" ? { selector: skill.selector, ...(typeof skill.arguments === "string" ? { arguments: skill.arguments } : {}) } : undefined;
}

/** A model library entry from the renderer: trimmed to strings, numbers and booleans for the host to validate. */
function modelEntryParam(value: unknown) {
  const row = (value ?? {}) as Record<string, unknown>;
  const cost = row.cost && typeof row.cost === "object" ? row.cost as { input?: unknown; output?: unknown; currency?: unknown } : undefined;
  const efforts = Array.isArray(row.efforts) ? row.efforts.filter((item): item is string => typeof item === "string") : undefined;
  const effortSource = row.effortSource === "fetched" || row.effortSource === "user" ? row.effortSource as "fetched" | "user" : undefined;
  return {
    providerId: typeof row.providerId === "string" ? row.providerId : "",
    model: typeof row.model === "string" ? row.model : "",
    displayName: typeof row.displayName === "string" ? row.displayName : null,
    contextWindow: typeof row.contextWindow === "number" && Number.isFinite(row.contextWindow) ? Math.trunc(row.contextWindow) : null,
    ...(efforts ? { efforts } : {}),
    defaultEffort: typeof row.defaultEffort === "string" ? row.defaultEffort : undefined,
    images: typeof row.images === "boolean" ? row.images : null,
    documents: typeof row.documents === "boolean" ? row.documents : null,
    video: typeof row.video === "boolean" ? row.video : null,
    cost: cost ? {
      ...(typeof cost.input === "string" ? { input: cost.input } : {}),
      ...(typeof cost.output === "string" ? { output: cost.output } : {}),
      currency: typeof cost.currency === "string" ? cost.currency : null,
    } : null,
    ...(effortSource ? { effortSource } : {}),
  };
}

const ROUTE_SHAPES = ["direct-small", "direct-builder", "lead-guided", "lead-only"] as const;
/** Native-only context; the Rust SendTurn DTO refuses renderer-supplied facts. */
function workspaceRestoresParam(value: unknown): WorkspaceRestore[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new Error("Invalid workspace restore context.");
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object" || !("id" in row) || !("text" in row)
      || typeof row.id !== "string" || !row.id || row.id.length > 128
      || typeof row.text !== "string" || row.text.length > 16_384) throw new Error("Invalid workspace restore context.");
    return { id: row.id, text: row.text };
  });
}

/** One message's requested shape, for a routed Harness turn. */
function shapeParam(value: unknown): (typeof ROUTE_SHAPES)[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(ROUTE_SHAPES as readonly string[]).includes(value)) throw new Error("A forced shape must be direct-small, direct-builder, lead-guided or lead-only.");
  return value as (typeof ROUTE_SHAPES)[number];
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
 * Serialize a dispatch failure without flattening its structure: the message
 * stays human-readable, while an error kind or code (found on the error or its
 * cause chain) and its retryability ride along so the renderer can branch
 * recovery on them.
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

const LIFECYCLE = new Set(["ping", "detect", "startHost", "stopHost"]);

function queueKey(method: string, params: Record<string, unknown>) {
  if (["browserOpen", "browserControl", "browserClose"].includes(method)) return `browser:${String(params.workspaceRoot ?? "")}`;
  // Suggestions never hold a session queue: a suggestion may run while a turn does.
  if (method === "suggest") return `suggest:${typeof params.workspaceRoot === "string" ? params.workspaceRoot : ""}`;
  if (LIFECYCLE.has(method)) return "lifecycle";
  const session = typeof params.sessionId === "string" ? params.sessionId : "";
  return session ? `session:${session}` : "lifecycle";
}

/**
 * A verb that never answers must not hold its queue slot forever. `enqueue`
 * serializes per session, so a single wedged request becomes head-of-line: it
 * blocks every later call on that key until the queue limit starts rejecting —
 * including `cancelTurn`, which is how the user asks for the thing that is
 * stuck to stop.
 *
 * The wait is bounded, not the work: the promise is abandoned rather than
 * cancelled and the verb may still land. The wording is the renderer's
 * unknown-result contract — a send whose acknowledgement never arrived must
 * stay retryable, not roll back as a definitive failure. `sendTurn` awaits the
 * submit acknowledgement, not the turn, so it is bounded like any other verb.
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

async function enqueue<T>(key: string, deadlineAt: number | undefined, work: () => Promise<T>): Promise<T> {
  const slot = queues.get(key) ?? { tail: Promise.resolve(), pending: 0 };
  if (slot.pending >= HOST_QUEUE_LIMIT) {
    throw new Error("Too many requests are already in flight for this session. Wait and retry.");
  }
  slot.pending += 1;
  const run = slot.tail.then(async () => {
    if (deadlineAt != null && performance.now() >= deadlineAt) throw new Error("Request deadline expired.");
    return bounded(work);
  }) as Promise<T>;
  slot.tail = run.then(() => undefined, () => undefined);
  queues.set(key, slot);
  try {
    return await run;
  } finally {
    slot.pending -= 1;
    // An idle queue slot holds no ordering state; dropping it keeps the map
    // bounded over a long-lived process.
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

function replayCreate(method: string, params: Record<string, unknown>): unknown | undefined {
  const id = typeof params.clientRequestId === "string" ? params.clientRequestId.trim() : "";
  if (!id) return undefined;
  const key = `${method}:${id}`;
  const hit = createCache.get(key);
  if (!hit) return undefined;
  if (hit.expires < performance.now()) {
    createCache.delete(key);
    return undefined;
  }
  return hit.result;
}

function rememberCreate(method: string, params: Record<string, unknown>, result: unknown) {
  const id = typeof params.clientRequestId === "string" ? params.clientRequestId.trim() : "";
  if (!id) return;
  if (createCache.size >= 64) {
    const now = performance.now();
    for (const [key, entry] of createCache) {
      if (entry.expires < now) createCache.delete(key);
    }
    if (createCache.size >= 64) createCache.delete(createCache.keys().next().value!);
  }
  createCache.set(`${method}:${id}`, { expires: performance.now() + CREATE_CACHE_TTL_MS, result });
}

function sessionKey(params: Record<string, unknown>) { return typeof params.sessionId === "string" ? params.sessionId : ""; }

/** Ids of the providers with saved keys, injected natively (never the keys) for detection. */
function harnessProviders(params: Record<string, unknown>): string[] {
  return Array.isArray(params.harnessProviders) ? params.harnessProviders.filter((id): id is string => typeof id === "string") : [];
}

async function dispatchBrowser(method: string, params: Record<string, unknown>) {
  const manager = await ensureBrowser();
  const { parseBrowserControl } = await import("./browser.js");
  const workspaceRoot = typeof params.workspaceRoot === "string" ? params.workspaceRoot : "";
  if (!workspaceRoot.trim()) throw new Error("A workspace root is required for browser control.");
  if (method === "browserClose") return manager.control(workspaceRoot, { action: "close" });
  if (method === "browserOpen") {
    const input: BrowserControlInput = {
      action: "open",
      ...(typeof params.url === "string" ? { url: params.url } : {}),
      ...(typeof params.width === "number" ? { width: params.width } : {}),
      ...(typeof params.height === "number" ? { height: params.height } : {}),
    };
    return manager.control(workspaceRoot, input);
  }
  const raw = { ...params };
  delete raw.workspaceRoot;
  const parsed = parseBrowserControl(raw);
  if (!parsed.request) throw new Error(parsed.error ?? "Invalid browser input.");
  return manager.control(workspaceRoot, parsed.request);
}

async function dispatch(method: string, params: Record<string, unknown>) {
  if (["browserOpen", "browserControl", "browserClose"].includes(method)) return dispatchBrowser(method, params);
  if (method === "ping") return { pong: true };
  if (method === "detect") {
    // The agent ships with the app; it is ready once a provider is configured.
    const ready = harnessProviders(params).length > 0;
    return { agents: [{ id: HARNESS_ID, name: HARNESS_NAME, protocol: "native", found: true, path: null, version: null, verified: true, signIn: "Add an API key for a model provider in Settings → Models & providers.", authenticated: ready }] };
  }
  await ensureBrowser();
  harness.setCredentials(nativeProviderCredentials(params.providerKeys));
  if (params.harnessMcpTrust !== undefined && params.harnessMcpTrust !== null) {
    const authorization = params.harnessMcpTrust as McpAuthorization;
    const next = { workspaceTrusted: authorization.workspaceTrusted === true, ...(typeof authorization.configurationDigest === "string" ? { configurationDigest: authorization.configurationDigest } : {}), ...(typeof authorization.homeConfigurationDigest === "string" ? { homeConfigurationDigest: authorization.homeConfigurationDigest } : {}) };
    harnessAuthorizations.set(sessionKey(params), next);
  }
  return dispatchHarness(method, params);
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
      return harness.listSessions(workspaceRoot || undefined);
    case "listModels":
      return harness.listModels(sessionId || undefined, params.refresh === true);
    case "modelLibraryList":
      return harness.modelLibraryList();
    case "modelLibraryPut":
      return harness.modelLibraryPut(modelEntryParam(params.entry));
    case "modelLibraryRemove":
      return harness.modelLibraryRemove(String(params.modelId ?? ""));
    case "listProviderModels":
      return harness.listProviderModels(String(params.providerId ?? ""), params.refresh === true);
    case "startSession": {
      const replayed = replayCreate("startSession", params);
      if (replayed) return replayed;
      const started = await harness.startSession({
        workspaceRoot,
        modelId: typeof params.modelId === "string" ? params.modelId : undefined,
        effort: typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined,
        mode: typeof params.mode === "string" ? params.mode : undefined,
        approvalMode: typeof params.approvalMode === "string" ? params.approvalMode : undefined,
        orchestrator: params.orchestrator,
        mcpAuthorization: harnessAuthorizations.get(""),
      });
      harnessAuthorizations.delete("");
      rememberCreate("startSession", params, started);
      return started;
    }
    case "resumeSession": {
      const replayed = replayCreate("resumeSession", params);
      if (replayed) return replayed;
      const resumed = await harness.resumeSession({ sessionId, workspaceRoot, approvalMode: typeof params.approvalMode === "string" ? params.approvalMode : undefined });
      rememberCreate("resumeSession", params, resumed);
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
        forcedShape: shapeParam(params.forcedShape),
        workspaceRestores: workspaceRestoresParam(params.workspaceRestores),
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
    case "setOrchestrator":
      return harness.setOrchestrator({ sessionId, orchestrator: params.orchestrator });
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
    case "orchestratorProbe":
      return harness.orchestratorProbe({
        role: String(params.role ?? ""),
        providerId: String(params.providerId ?? ""),
        modelId: String(params.modelId ?? ""),
        refresh: params.refresh === true,
      });
    case "harnessRules":
      return harness.setPermissionRules(
        Array.isArray(params.rules) ? (params.rules as Array<{ effect?: unknown; rule?: unknown }>).filter((entry) => (entry.effect === "allow" || entry.effect === "deny") && typeof entry.rule === "string").map((entry) => ({ effect: entry.effect as "allow" | "deny", rule: entry.rule as string })) : [],
        Array.isArray(params.protectedPaths) ? normalizeProtectedPaths(params.protectedPaths) : undefined,
      );
    case "compactSession":
      return harness.compactSession({ sessionId });
    case "closeSession": {
      const closed = await harness.closeSession({ sessionId });
      if (sessionId) harnessAuthorizations.delete(sessionId);
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
      void enqueue(queueKey(request.method, params), deadlineAt, () => dispatch(request.method, params))
        .then((result) => write({ id: request.id, ok: true, result }))
        .catch((error: unknown) => write({ id: request.id, ok: false, ...failureOf(error) }));
    });
  } catch {
    write({ type: "event", event: "bridgeExit", payload: { error: "Protocol frame exceeded the byte limit. Reconnect to continue." } });
    shutdown();
  }
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdin.pause();
  const timer = setTimeout(() => process.exit(0), 2000);
  timer.unref();
  void Promise.allSettled([browser ? browser.closeAll() : Promise.resolve(), harness.stop()]).finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
}

/**
 * Last-resort crash sink: an uncaught frame reaches the app as a redacted
 * `bridgeExit` event instead of Node's raw stderr dump — which matters when
 * the process runs without the native stderr tap (dev, smoke scripts).
 * Node's default already crashes on unhandled rejections; this keeps that
 * semantics while routing the report through the diagnostic redactor.
 */
function crash(reason: unknown) {
  const message = reason instanceof Error ? reason.message : String(reason);
  try {
    emit("bridgeExit", { error: `Agent process crashed: ${message}` });
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
