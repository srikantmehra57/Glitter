import { diagnostics, DiagnosticLines, diagnosticEvent } from "./redaction.js";
import { LineFrames, encodeFrame } from "./framing.js";
import { execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSpec } from "./agents.js";
import type { ApprovalMode } from "./protocol.js";
import { assessCommand } from "./harness/permission/danger.js";
import {
  approvalAlive,
  approvalExpiry,
  approvalExpiryMono,
  APPROVAL_TTL_MS,
  CANCEL_WAIT_MS,
  confinedCwd,
  filterChildEnv,
  spawnIsolated,
  terminateTree,
  type IsolationReport,
} from "./isolation.js";

/**
 * Drives any ACP (Agent Client Protocol) agent over stdio and translates its
 * `session/update` stream into the bridge events the desktop app already renders
 * for Muse: `item`, `delta`, `sessionFacts`, `approval`, `turnCompleted`, `turnError`.
 */

type Emit = (event: string, payload: unknown) => void;
type Json = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type AcpConfigOption = { id: string; name?: string; category?: string; type?: string; currentValue?: string; options?: Array<{ value: string; name?: string; description?: string }> };

const TOOL_NAMES: Record<string, string> = { read: "read_file", edit: "edit_file", delete: "edit_file", move: "edit_file", search: "grep", execute: "bash", fetch: "web_fetch" };
const TIERS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
/**
 * Silence before the thread says the agent has gone quiet. Agents often think
 * or work for half a minute without a word, so this is set well past that; a
 * running tool or an open approval is never silence.
 */
const STALL_MS = 45_000;
/**
 * Silence long enough to call an OpenCode turn dead. Reasoning models can think
 * for minutes without streaming a token, so this is a backstop for a provider
 * that never answers, not a timeout on slow work; a real provider error in
 * OpenCode's log fails the turn at once (see `watch`).
 */
const STALL_FAIL_MS = 300_000;

class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) { super(message); }
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** One ACP child process with line-delimited JSON-RPC in both directions. */
class AcpConnection {
  private frames = new LineFrames();
  private protocolError: Error | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private stderrTail = "";
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  onNotification: (method: string, params: Json) => void = () => {};
  onRequest: (method: string, params: Json) => Promise<unknown> = async (method) => { throw new RpcError(`Method not found: ${method}`, -32601); };

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    diagnostics.remember(process.env);
    const stderr = new DiagnosticLines((line) => { this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4000); });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    this.exited = new Promise((resolve) => child.on("exit", (code, signal) => {
      stderr.end();
      const error = new Error(this.lastError() || `Agent exited${code != null ? ` (${code})` : ""}`);
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      resolve({ code, signal });
    }));
    child.on("error", () => {});
  }

  lastError() {
    return this.stderrTail.split("\n").map((line) => line.trim()).filter(Boolean).slice(-2).join(" ").slice(0, 400);
  }

  private write(message: Json) {
    if (this.protocolError) throw this.protocolError;
    if (!this.child.stdin.writable) throw new Error("Agent is not running.");
    this.child.stdin.write(encodeFrame({ jsonrpc: "2.0", ...message }));
  }

  private read(chunk: Buffer) {
    if (this.protocolError) return;
    try {
      this.frames.push(chunk, (raw) => {
        const line = raw.trim();
        if (!line.startsWith("{")) return;
        let message: Json;
        try { message = JSON.parse(line) as Json; } catch { return; }
        const id = message.id as number | string | undefined;
        const method = str(message.method);
        if (method && id != null) {
          // Replies race `kill()`: a parked approval settled by `stop()` answers
          // into a dying stdin, so both arms swallow write failures instead of
          // surfacing unhandled rejections.
          this.onRequest(method, asRecord(message.params)).then(
            (result) => { try { this.write({ id, result: result ?? null }); } catch { /* stopping */ } },
            (error: unknown) => { try { this.write({ id, error: { code: error instanceof RpcError && error.code ? error.code : -32603, message: error instanceof Error ? error.message : String(error) } }); } catch { /* stopping */ } },
          );
        } else if (method) {
          this.onNotification(method, asRecord(message.params));
        } else if (typeof id === "number" && this.pending.has(id)) {
          const waiter = this.pending.get(id)!;
          this.pending.delete(id);
          if (message.error) {
            const error = asRecord(message.error);
            const data = asRecord(error.data);
            waiter.reject(new RpcError(diagnostics.text(str(data.message) ?? str(error.message) ?? "Agent request failed"), typeof error.code === "number" ? error.code : undefined, error.data));
          } else waiter.resolve(message.result);
        }
      });
    } catch {
      this.protocolError = new Error("Agent protocol frame exceeded the byte limit. Reconnect to continue.");
      for (const waiter of this.pending.values()) waiter.reject(this.protocolError);
      this.pending.clear();
      this.child.stdout.destroy();
      this.kill();
    }
  }

  request<T = Json>(method: string, params: Json, timeoutMs?: number): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs) : null;
      this.pending.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value as T); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); },
      });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); if (timer) clearTimeout(timer); reject(error as Error); }
    });
  }

  notify(method: string, params: Json) {
    this.write({ method, params });
  }

  kill() {
    return terminateTree(this.child);
  }
}

type Stream = { kind: "agentMessage" | "reasoning" | "userMessage"; itemId: string; text: string };
type Tool = { item: Json; hidden: boolean };
type SessionState = {
  cwd: string;
  turnId: string;
  counter: number;
  stream: Stream | null;
  tools: Map<string, Tool>;
  config: AcpConfigOption[];
  prompting: boolean;
  lastActivity: number;
  watchdog?: NodeJS.Timeout;
  failTimer?: NodeJS.Timeout;
  logCursor?: { file: string; offset: number };
  /** Set when the provider cannot complete this turn (rate limit, disabled model). */
  fatal?: string;
  /** The quiet-agent notice is showing; the next update clears it. */
  stalled?: boolean;
  /**
   * Predictive-suggestion sessions report nothing to the renderer; their
   * agent text accumulates here and is returned by `suggest`.
   */
  muted?: boolean;
  collected?: string;
  /**
   * The app's permission mode for this session. The agent still chooses which
   * calls it reports; the app answers each report with the same rules it uses
   * for the built-in harness.
   */
  approvalMode?: ApprovalMode;
};

const ACP_APPROVAL_MODES: readonly ApprovalMode[] = ["promptUnmatched", "onRequest", "guarded", "denyUnmatched", "allowAll"];
/** ACP tool kinds that only look: Read only lets these through and declines the rest. */
const READ_KINDS = new Set(["read", "search", "think", "fetch"]);
/** Workspace writes. Ask lets these run; a command still asks. */
const WRITE_KINDS = new Set(["edit", "delete", "move"]);

/** How the app answers one ACP permission request. `ask` shows the card. */
export function acpPermissionDecision(mode: string, toolCall: { kind?: unknown; rawInput?: unknown }): "allow" | "deny" | "ask" {
  const known: ApprovalMode = ACP_APPROVAL_MODES.find((item) => item === mode) ?? "promptUnmatched";
  const kind = str(toolCall.kind) ?? "other";
  const raw = asRecord(toolCall.rawInput);
  const command = str(raw.command) ?? str(raw.cmd);
  const risks = command ? assessCommand(command) : [];
  if (risks.some((risk) => risk.level === "block")) return "deny";
  if (known === "allowAll") return "allow";
  if (known === "denyUnmatched") return READ_KINDS.has(kind) ? "ask" : "deny";
  if (risks.some((risk) => risk.level === "ask")) return "ask";
  if (known === "guarded") return "allow";
  if (known === "onRequest") {
    if (command) return "ask";
    if (READ_KINDS.has(kind) || WRITE_KINDS.has(kind)) return "allow";
    return "ask";
  }
  return "ask";
}

/** The option an automatic answer picks: once, never "always", so no rule outlives the thread's mode. */
function automaticChoice(options: Json[], allow: boolean): string | null {
  const kinds = allow ? ["allow_once"] : ["reject_once"];
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind && typeof option.optionId === "string");
    if (match) return String(match.optionId);
  }
  return null;
}

export type AcpModel = {
  modelId: string;
  displayLabel?: string;
  providerId?: string;
  description?: string | null;
  contextLimit?: number | null;
  cost?: { input?: string; output?: string; currency?: string | null } | null;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  effortSource?: "host" | "vocabulary";
  isDefault?: boolean;
  isActive?: boolean;
  unavailable?: boolean;
  /**
   * Cline's current free promotion. A `-free` or `:free` id is not enough:
   * those names stay in the catalog after the promotion ends.
   */
  free?: boolean;
};

const CLINE_FREE_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const CLINE_FREE_TTL_MS = 10 * 60 * 1000;
const STALE_FREE_LABEL = /\s*\(free\)/gi;

export type ClineFreeModel = { id: string; name?: string; description?: string };

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** The `free` lane of Cline's model picker. Null when the list cannot be read. */
export async function fetchClineFreeIds(fetchImpl: FetchLike = fetch): Promise<ClineFreeModel[] | null> {
  try {
    const response = await fetchImpl(CLINE_FREE_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const body = await response.json() as { free?: unknown };
    const rows = Array.isArray(body?.free) ? body.free : [];
    const models = rows.flatMap((row): ClineFreeModel[] => {
      if (!row || typeof row !== "object") return [];
      const id = (row as { id?: unknown }).id;
      if (typeof id !== "string" || !id) return [];
      const name = (row as { name?: unknown }).name;
      const description = (row as { description?: unknown }).description;
      return [{ id, ...(typeof name === "string" && name ? { name } : {}), ...(typeof description === "string" && description ? { description } : {}) }];
    });
    return models.length ? models : null;
  } catch {
    return null;
  }
}

/** Same model when the catalog omits a provider prefix, or the other way around. */
export function clineModelMatches(catalogId: string, freeId: string): boolean {
  const catalog = catalogId.trim().toLowerCase();
  const free = freeId.trim().toLowerCase();
  if (!catalog || !free) return false;
  if (catalog === free) return true;
  const catalogSlug = catalog.slice(catalog.lastIndexOf("/") + 1);
  const freeSlug = free.slice(free.lastIndexOf("/") + 1);
  if (catalogSlug !== freeSlug) return false;
  const catalogProvider = catalog.includes("/") ? catalog.slice(0, catalog.lastIndexOf("/")) : "";
  const freeProvider = free.includes("/") ? free.slice(0, free.lastIndexOf("/")) : "";
  return !catalogProvider || !freeProvider || catalogProvider === freeProvider;
}

function clineFreeLabel(model: ClineFreeModel): string {
  const name = model.name?.trim();
  if (name && !name.includes("/") && name.toLowerCase() !== model.id.toLowerCase()) return name;
  const slug = model.id.slice(model.id.lastIndexOf("/") + 1).replace(/[:-]free$/i, "");
  return slug.replace(/-/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Keep the Free mark for models Cline still promotes, and take it off the rest.
 * A retired promotion often keeps "(free)" in its catalog name. A promotion the
 * catalog has not caught up with is added, so the Free section is not empty.
 */
export function applyClineFree<T extends { modelId: string; displayLabel?: string; providerId?: string; description?: string | null; free?: boolean }>(models: T[], freeModels: readonly ClineFreeModel[]): T[] {
  const claimed = new Set<string>();
  const annotated = models.map((model) => {
    const hit = freeModels.find((free) => clineModelMatches(model.modelId, free.id));
    if (hit) {
      claimed.add(hit.id);
      return { ...model, free: true };
    }
    const next: T = { ...model, free: false };
    if (next.description === "Free") next.description = null;
    if (next.displayLabel) {
      const label = next.displayLabel.replace(STALE_FREE_LABEL, "").replace(/[ \t]{2,}/g, " ").trim();
      next.displayLabel = label || undefined;
    }
    return next;
  });
  const missing = freeModels.filter((free) => !claimed.has(free.id)).map((free) => {
    const slash = free.id.indexOf("/");
    return {
      modelId: free.id,
      displayLabel: clineFreeLabel(free),
      providerId: slash > 0 ? free.id.slice(0, slash) : "cline",
      description: free.description || "Free",
      free: true,
    } as T;
  });
  return [...missing, ...annotated];
}

/** OpenCode Zen promo models (`mimo-v2.5-free`, `*:free`) that often reject with "Model access is disabled". */
export function zenFreeModel(modelId: string) {
  return /(?:^|[/:])[^/]*-free$/i.test(modelId);
}

function modelBare(modelId: string) {
  return modelId.includes("/") ? modelId.slice(modelId.indexOf("/") + 1) : modelId;
}

/**
 * The option that lists the models. Cline offers a provider picker under the
 * `model` category beside the model list itself, so the option named `model`
 * wins and the category is only the fallback for agents that name it
 * differently.
 */
export function modelOption(config: AcpConfigOption[]): AcpConfigOption | undefined {
  return config.find((item) => item.id === "model") ?? config.find((item) => item.category === "model");
}

function modelOk(modelId: string, blocked: Set<string>) {
  const bare = modelBare(modelId);
  return !zenFreeModel(modelId) && !blocked.has(modelId) && !blocked.has(bare);
}

/** Replace a gated/blocked OpenCode model with Big Pickle or the first usable catalog row. */
export function fallbackOpencodeModel(catalog: Array<{ modelId: string }>, current?: string | null, blocked: Iterable<string> = []) {
  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked);
  if (current && modelOk(current, blockedSet)) return undefined;
  return catalog.find((model) => /\/big-pickle$/i.test(model.modelId) && modelOk(model.modelId, blockedSet))?.modelId
    ?? catalog.find((model) => modelOk(model.modelId, blockedSet))?.modelId;
}

export function modelIdsFromError(message: string) {
  const match = message.match(/^([a-z0-9._/:+-]+)\s*:/i);
  if (!match) return [];
  const id = match[1];
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  return [...new Set([id, bare, `opencode/${bare}`])];
}

/** Provider errors that will not recover if OpenCode keeps retrying. */
export function fatalProviderError(message: string) {
  return /model access is disabled|rate limit|quota(?: exceeded)?|insufficient (?:account )?funds|insufficient (?:credit|quota)|payment required|unauthori[sz]ed|forbidden|\b403\b|\b401\b/i.test(message);
}

/**
 * Cline's `--thinking` levels. Its ACP server takes no reasoning option per
 * session; it reads this flag once, when the process starts.
 */
const CLINE_THINKING = ["none", "low", "medium", "high", "xhigh"];
const CLINE_DEFAULT_THINKING = "medium";

/** Normalizes agent effort ids (`xhigh`, `x-high`, `default`, …) onto the app's tier vocabulary. */
function tierOf(value: string): string | null {
  const id = value.toLowerCase().replace(/[^a-z]/g, "");
  if (id === "extrahigh") return "xhigh";
  return TIERS.includes(id) ? id : null;
}

export class AcpAgentHost {
  private conn: AcpConnection | null = null;
  private starting: Promise<void> | null = null;
  private init: Json = {};
  private sessions = new Map<string, SessionState>();
  private approvals = new Map<string, { sessionId: string; turnId?: string; choices: Set<string>; expiresAt: number; expiresAtMono: number; resolve: (optionId: string | null) => void }>();
  private catalog: AcpModel[] | null = null;
  private catalogLoading: Promise<AcpModel[]> | null = null;
  /** Modes the agent offers a new session (OpenCode: build, plan), from the catalog probe. */
  private catalogModes: { modes: Array<{ value: string; name?: string; description?: string }>; defaultMode?: string } | null = null;
  /**
   * The catalog probe's session, kept open while the agent runs. A thread that
   * has not started yet has no session to ask, and OpenCode's effort levels
   * differ per model, so a model picked in a draft is described here.
   */
  private probe: { sessionId: string; config: AcpConfigOption[] } | null = null;
  private efforts = new Map<string, { reasoningEfforts: string[]; defaultReasoningEffort?: string }>();
  /** Cline's promoted free models, so a stale `-free` id is not offered as free. */
  private clineFree: { at: number; models: ClineFreeModel[] } | null = null;
  private describing: Promise<unknown> = Promise.resolve();
  /** Cline only: the level the process was launched with, and the level the next turn wants. */
  private thinking = { launched: CLINE_DEFAULT_THINKING, wanted: CLINE_DEFAULT_THINKING };
  /** The workspace the process was started for, so a relaunch keeps the same sandbox. */
  private workspaceRoot?: string;
  private blocked = new Set<string>();
  private turnSeq = 0;
  private isolationReport: IsolationReport | null = null;

  private readonly emit: Emit;
  constructor(readonly spec: AgentSpec, readonly bin: string, emit: Emit) {
    this.emit = (event, payload) => emit(event, diagnosticEvent(event, payload));
  }

  /**
   * Release a session the app no longer needs, clearing its watchdog so a
   * deleted thread cannot keep polling an agent it no longer talks to. Mirrors
   * `MuseHost.closeSession`.
   */
  async closeSession(options: { sessionId: string }) {
    const session = this.sessions.get(options.sessionId);
    if (session?.watchdog) clearInterval(session.watchdog);
    if (session?.failTimer) clearTimeout(session.failTimer);
    this.sessions.delete(options.sessionId);
    return { closed: true };
  }

  isolation() {
    return this.isolationReport;
  }

  get running() { return Boolean(this.conn); }
  owns(sessionId: string) { return this.sessions.has(sessionId); }

  async start(options?: { workspaceRoot?: string; suggest?: { denyReadRoot: string }; initializeTimeoutMs?: number }) {
    if (this.conn) return;
    this.starting ??= (async () => {
      // A suggestion host does not receive the workspace as a write root, and
      // its cwd is a temp directory. The profile denies reading the project.
      const suggest = options?.suggest;
      const thinking = this.spec.id === "cline" ? ["--thinking", this.thinking.wanted] : [];
      if (!suggest) this.workspaceRoot = options?.workspaceRoot;
      const spawned = spawnIsolated(this.bin, [...(this.spec.acpArgs ?? []), ...thinking], suggest
        ? { agentId: this.spec.id, denyReadRoots: [suggest.denyReadRoot], cwd: confinedCwd() }
        : { agentId: this.spec.id, workspace: options?.workspaceRoot });
      this.isolationReport = spawned.isolation;
      this.thinking.launched = this.thinking.wanted;
      const child = spawned.child;
      const conn = new AcpConnection(child);
      conn.onNotification = (method, params) => this.onNotification(method, params);
      conn.onRequest = (method, params) => this.onRequest(method, params);
      void conn.exited.then(() => {
        if (this.conn !== conn) return;
        this.conn = null;
        // The agent is gone: settle parked approvals as cancelled so a later
        // decide cannot route to a dead stdin and the map does not linger.
        for (const approval of this.approvals.values()) approval.resolve(null);
        this.approvals.clear();
        for (const [sessionId, session] of this.sessions) {
          if (session.watchdog) clearInterval(session.watchdog);
          if (session.prompting) this.emit("turnCompleted", { sessionId, turnId: session.turnId, outcome: { kind: "failed", params: { terminal: "failed", error: { message: `${this.spec.name} stopped unexpectedly. ${conn.lastError()}`.trim() } } } });
        }
        this.sessions.clear();
        this.emit("agentExit", { agentId: this.spec.id, error: conn.lastError() || null });
      });
      try {
        this.init = await conn.request<Json>("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "glitter", title: "Glitter", version: "0.1.0" },
        }, options?.initializeTimeoutMs ?? 30000);
        this.catalog = null;
        this.catalogModes = null;
        this.probe = null;
        this.efforts.clear();
      } catch (error) {
        await conn.kill();
        throw new Error(`${this.spec.name} did not start its ACP server: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.conn = conn;
    })().finally(() => { this.starting = null; });
    await this.starting;
  }

  async stop() {
    for (const approval of this.approvals.values()) approval.resolve(null);
    this.approvals.clear();
    for (const session of this.sessions.values()) {
      if (session.watchdog) clearInterval(session.watchdog);
      if (session.failTimer) clearTimeout(session.failTimer);
    }
    this.sessions.clear();
    this.catalog = null;
    this.catalogLoading = null;
    this.catalogModes = null;
    this.probe = null;
    this.efforts.clear();
    const conn = this.conn;
    this.conn = null;
    this.isolationReport = null;
    if (conn) await conn.kill();
  }

  private requireConn() {
    if (!this.conn) throw new Error(`${this.spec.name} is not running.`);
    return this.conn;
  }

  private capability(path: string[]) {
    let node: unknown = asRecord(this.init.agentCapabilities);
    for (const key of path) node = asRecord(node)[key];
    return node === true || (node != null && typeof node === "object");
  }

  /** Friendlier text for auth and model-access failures. */
  private explain(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RpcError ? error.code : undefined;
    if (code === -32000 || /auth|sign.?in|log.?in|unauthori[sz]ed|401/i.test(message)) return `${this.spec.name} needs a sign-in. ${this.spec.signIn}`;
    if (/insufficient (?:account )?funds|insufficient (?:credit|quota)/i.test(message)) {
      return `${message.replace(/\.+$/, "")}. OpenCode Zen has no credits. Add funds in OpenCode, or pick a model from a provider you have a key for.`;
    }
    if (/model access is disabled|rate limit/i.test(message)) {
      this.blockFrom(message);
      return `${message.replace(/\.+$/, "")}. OpenCode Zen free models aren't available on this account. Pick a model from a provider you have a key for, or add Zen credits.`;
    }
    return message;
  }

  private blockFrom(message: string) {
    for (const id of modelIdsFromError(message)) this.blocked.add(id);
  }

  private markUnavailable(models: AcpModel[]): AcpModel[] {
    if (!this.blocked.size) return models;
    return models.map((model) => {
      const bare = model.modelId.includes("/") ? model.modelId.slice(model.modelId.indexOf("/") + 1) : model.modelId;
      if (!this.blocked.has(model.modelId) && !this.blocked.has(bare)) return model;
      return { ...model, unavailable: true, description: model.description && model.description !== "Free" ? model.description : "Unavailable on this account" };
    });
  }

  // ─── Models ───────────────────────────────────────────────────────────────

  async listModels(sessionId?: string, refresh = false, modelId?: string): Promise<{ models: AcpModel[]; source: string; modes?: Array<{ value: string; name?: string; description?: string }>; defaultMode?: string }> {
    await this.start();
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    const fromSession = session ? this.modelsFromConfig(session.config) : [];
    // OpenCode's session option is the few models its inference endpoint names.
    // The Zen catalog is wider, so a thread must not replace it with that short list.
    const catalog = fromSession.length && this.spec.id !== "grok" && this.spec.id !== "opencode" && !refresh
      ? this.catalog ?? [] : await this.loadCatalog(refresh);
    if (!fromSession.length) {
      // A draft: no session yet. The probe tells it the agent's modes and,
      // for the model it has picked, that model's effort levels.
      const described = modelId ? await this.describeModel(catalog, modelId) : null;
      const models = described ? catalog.map((model) => model.modelId === modelId ? { ...model, ...described } : model) : catalog;
      return { models: await this.present(models), source: "catalog", ...(this.catalogModes?.modes.length ? this.catalogModes : {}) };
    }
    // A rescan must return the probe catalog for every agent. The open session
    // only contributes which row is active; keeping its old option list is how
    // a composer refresh used to stay stale for everyone but Grok.
    if (refresh && catalog.length) {
      const selected = new Map(fromSession.map((model) => [model.modelId, model]));
      return { models: await this.present(catalog.map((model) => {
        const current = selected.get(model.modelId);
        return { ...model, ...current, isActive: current?.isActive === true };
      })), source: "session" };
    }
    // OpenCode keeps the Zen catalog and only borrows the session row's active flag.
    if (this.spec.id === "opencode" && catalog.length) {
      const selected = new Map(fromSession.map((model) => [model.modelId, model]));
      return { models: await this.present(catalog.map((model) => {
        const current = selected.get(model.modelId);
        return current ? { ...model, ...current, isActive: current.isActive === true, ...(current.reasoningEfforts?.length ? {} : model.reasoningEfforts?.length ? { reasoningEfforts: model.reasoningEfforts, effortSource: model.effortSource } : {}) } : { ...model, isActive: false };
      })), source: "catalog", ...(this.catalogModes?.modes.length ? this.catalogModes : {}) };
    }
    // Session options are authoritative for availability; the catalog adds metadata.
    const byId = new Map(catalog.map((model) => [model.modelId, model]));
    // Grok's session names the models that existed when it started, while its
    // catalog is re-read on every listing. Start from the catalog so a model
    // released since (grok-4.7 in an older thread) still reaches the picker, and
    // keep any row only the session names.
    if (this.spec.id === "grok" && catalog.length) {
      const selected = new Map(fromSession.map((model) => [model.modelId, model]));
      const merged = catalog.map((model) => {
        const current = selected.get(model.modelId);
        return current ? { ...model, ...current, isActive: current.isActive === true } : { ...model, isActive: false };
      });
      for (const model of fromSession) if (!byId.has(model.modelId)) merged.push({ ...model, isActive: model.isActive === true });
      return { models: await this.present(merged), source: "catalog" };
    }
    return { models: await this.present(fromSession.map((model) => ({ ...byId.get(model.modelId), ...model, ...(byId.get(model.modelId)?.reasoningEfforts && !model.reasoningEfforts ? { reasoningEfforts: byId.get(model.modelId)!.reasoningEfforts } : {}) }))), source: "session" };
  }

  /** Cline's Free section is the live promotion list, not every id that says free. */
  private async present(models: AcpModel[]): Promise<AcpModel[]> {
    const marked = this.markUnavailable(models);
    if (this.spec.id !== "cline") return marked;
    const ids = await this.clineFreeIds();
    const listed = ids ? applyClineFree(marked, ids) : marked;
    // Every Cline model takes `--thinking`; Cline drops the level for a model that cannot reason.
    return listed.map((model) => model.reasoningEfforts?.length ? model : { ...model, reasoningEfforts: CLINE_THINKING, defaultReasoningEffort: CLINE_DEFAULT_THINKING, effortSource: "host" as const });
  }

  private async clineFreeIds(): Promise<ClineFreeModel[] | null> {
    if (this.clineFree && Date.now() - this.clineFree.at < CLINE_FREE_TTL_MS) return this.clineFree.models;
    const models = await fetchClineFreeIds();
    if (!models) return this.clineFree?.models ?? null;
    this.clineFree = { at: Date.now(), models };
    return models;
  }

  private modelsFromConfig(config: AcpConfigOption[]): AcpModel[] {
    const option = modelOption(config);
    const effort = config.find((item) => item.category === "thought_level");
    const efforts = effort?.options?.map((item) => tierOf(item.value)).filter((tier): tier is string => Boolean(tier));
    return (option?.options ?? []).filter((item) => typeof item.value === "string" && item.value.length > 0).map((item) => {
      const [provider, ...rest] = item.value.split("/");
      const active = item.value === option?.currentValue;
      return {
        modelId: item.value,
        displayLabel: item.name?.includes("/") ? item.name.split("/").slice(1).join("/") : item.name,
        providerId: rest.length ? provider : this.spec.id,
        ...(item.description ? { description: item.description } : {}),
        isActive: active,
        ...(active && efforts?.length ? { reasoningEfforts: TIERS.filter((tier) => efforts.includes(tier)), defaultReasoningEffort: tierOf(effort?.currentValue ?? "") ?? undefined, effortSource: "host" as const } : {}),
      };
    });
  }

  private modelsFromState(value: unknown): AcpModel[] {
    const meta = asRecord(value);
    if (Array.isArray(meta.availableModels)) {
      return (meta.availableModels as Json[]).filter((row) => str(row.modelId)).map((row) => {
        const info = asRecord(row._meta);
        const efforts = Array.isArray(info.reasoningEfforts) ? (info.reasoningEfforts as Json[]) : [];
        const tiers = efforts.map((entry) => tierOf(String(entry.value ?? entry.id ?? ""))).filter((tier): tier is string => Boolean(tier));
        const fallback = efforts.find((entry) => entry.default === true);
        return {
          modelId: String(row.modelId),
          displayLabel: str(row.name),
          providerId: this.spec.id,
          description: str(row.description) ?? null,
          contextLimit: typeof info.totalContextTokens === "number" ? info.totalContextTokens : null,
          isDefault: row.modelId === meta.currentModelId,
          ...(tiers.length ? { reasoningEfforts: TIERS.filter((tier) => tiers.includes(tier)), defaultReasoningEffort: tierOf(String(fallback?.value ?? info.reasoningEffort ?? "")) ?? undefined, effortSource: "host" as const } : {}),
        };
      });
    }
    return [];
  }

  private async loadCatalog(refresh = false): Promise<AcpModel[]> {
    // An empty list is a failed read, not an answer: it is never served from cache.
    if (this.catalog?.length && !refresh) return this.catalog;
    if (this.catalogLoading) return this.catalogLoading;
    const conn = this.requireConn();
    const initialized = this.modelsFromState(asRecord(this.init._meta).modelState);
    if (initialized.length && !refresh && this.spec.id !== "opencode") return this.catalog = initialized;
    if (initialized.length && !refresh && this.spec.id === "opencode") return this.catalog = mergeOpencodeModels(initialized, await liveOpencodeCatalog());
    // OpenCode v2 exposes models through ACP session config; its `models`
    // command is interactive and no longer accepts v1's `--verbose` flag.
    // Query the confined temporary directory, without a prompt or a UI thread.
    const zen = this.spec.id === "opencode" ? liveOpencodeCatalog() : Promise.resolve([]);
    const run = (async () => {
      let probeId: string | undefined;
      try {
        const result = await conn.request<Json>("session/new", { cwd: confinedCwd(), mcpServers: [] }, 30000);
        probeId = str(result.sessionId);
        const probeConfig = this.configFrom(result);
        const config = this.modelsFromConfig(probeConfig);
        const detailed = this.modelsFromState(result.models ?? asRecord(result._meta).modelState);
        const byId = new Map(detailed.map((model) => [model.modelId, model]));
        const probed = config.length ? config.map((model) => ({ ...byId.get(model.modelId), ...model })) : detailed;
        const models = mergeOpencodeModels(probed, await zen);
        if (this.conn === conn) {
          this.catalog = models;
          const mode = probeConfig.find((item) => item.category === "mode");
          this.catalogModes = { modes: (mode?.options ?? []).filter((item) => item.value).map((item) => ({ value: item.value, ...(item.name ? { name: item.name } : {}), ...(item.description ? { description: item.description } : {}) })), defaultMode: mode?.currentValue };
          // Kept open for describing draft models (see `describeModel`).
          if (refresh) this.efforts.clear();
          if (probeId) {
            const previous = this.probe;
            this.probe = { sessionId: probeId, config: probeConfig };
            if (previous && previous.sessionId !== probeId) void this.closeProbe(conn, previous.sessionId);
            probeId = undefined;
          }
        }
        return models;
      } catch (error) {
        // Keep the old CLI fallback only for agents without session discovery.
        // Authentication and transport failures must remain visible to the user.
        if (!(error instanceof RpcError && error.code === -32601)) {
          void zen.catch(() => {});
          throw new Error(this.explain(error));
        }
        const models = initialized.length ? initialized : this.spec.id === "opencode" ? mergeOpencodeModels(await opencodeCatalog(this.bin), await zen) : [];
        if (this.conn === conn) this.catalog = models;
        return models;
      } finally {
        if (probeId && !this.sessions.has(probeId) && this.capability(["sessionCapabilities", "close"])) {
          await conn.request("session/close", { sessionId: probeId }, 5000).catch(() => {});
        }
      }
    })();
    this.catalogLoading = run;
    try { return await run; }
    finally { if (this.catalogLoading === run) this.catalogLoading = null; }
  }

  private async closeProbe(conn: AcpConnection, sessionId: string) {
    if (this.capability(["sessionCapabilities", "close"])) await conn.request("session/close", { sessionId }, 5000).catch(() => {});
  }

  /**
   * Effort levels for a model chosen before its thread has a session. Grok
   * lists them per model in the catalog already; OpenCode reports them only
   * for the selected model, so the parked probe session switches to it and
   * reads them back. Remembered per model; requests run one at a time so two
   * picks cannot interleave their switches on the one probe session.
   */
  private async describeModel(catalog: AcpModel[], modelId: string): Promise<{ reasoningEfforts: string[]; defaultReasoningEffort?: string } | null> {
    const listed = catalog.find((model) => model.modelId === modelId);
    if (!listed) return null;
    if (listed.reasoningEfforts?.length) return null;
    const known = this.efforts.get(modelId);
    if (known) return known;
    const run = this.describing.then(async () => {
      const conn = this.conn;
      const probe = this.probe;
      if (!conn || !probe) return null;
      const model = modelOption(probe.config);
      if (!model) return null;
      const result = await conn.request<Json>("session/set_config_option", { sessionId: probe.sessionId, configId: model.id, value: modelId }, 15000);
      if (Array.isArray(result?.configOptions)) probe.config = result.configOptions as AcpConfigOption[];
      const effort = probe.config.find((item) => item.category === "thought_level");
      const tiers = (effort?.options ?? []).map((item) => tierOf(item.value)).filter((tier): tier is string => Boolean(tier));
      const described = { reasoningEfforts: TIERS.filter((tier) => tiers.includes(tier)), ...(tierOf(effort?.currentValue ?? "") ? { defaultReasoningEffort: tierOf(effort?.currentValue ?? "")! } : {}) };
      this.efforts.set(modelId, described);
      return described;
    });
    this.describing = run.catch(() => {});
    // A failed description leaves the row as it was; the session reports
    // efforts once the thread starts.
    return run.catch(() => null);
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  async listSessions(cwd?: string) {
    await this.start({ workspaceRoot: cwd });
    if (!this.capability(["sessionCapabilities", "list"])) return { sessions: [] };
    const result = await this.requireConn().request<Json>("session/list", cwd ? { cwd } : {}, 20000);
    const rows = Array.isArray(result.sessions) ? result.sessions as Json[] : [];
    return {
      sessions: rows
        .filter((row) => !cwd || !row.cwd || row.cwd === cwd)
        .map((row) => ({ sessionId: String(row.sessionId), name: str(row.title) ?? null, workspaceRoot: str(row.cwd) ?? cwd ?? null, updatedAt: str(row.updatedAt) ?? (typeof row.lastChangeUnixMs === "number" ? new Date(row.lastChangeUnixMs).toISOString() : undefined), status: "idle" })),
    };
  }

  private track(sessionId: string, cwd: string, config: AcpConfigOption[]) {
    const session: SessionState = { cwd, turnId: "history", counter: 0, stream: null, tools: new Map(), config, prompting: false, lastActivity: performance.now() };
    this.sessions.set(sessionId, session);
    return session;
  }

  private configFrom(result: Json): AcpConfigOption[] {
    if (Array.isArray(result.configOptions)) return result.configOptions as AcpConfigOption[];
    // Older ACP agents report `models`/`modes` instead of config options.
    const config: AcpConfigOption[] = [];
    const models = asRecord(result.models);
    if (Array.isArray(models.availableModels)) config.push({ id: "model", category: "model", currentValue: str(models.currentModelId), options: (models.availableModels as Json[]).map((row) => ({ value: String(row.modelId), name: str(row.name) })) });
    const modes = asRecord(result.modes);
    if (Array.isArray(modes.availableModes)) config.push({ id: "mode", category: "mode", currentValue: str(modes.currentModeId), options: (modes.availableModes as Json[]).map((row) => ({ value: String(row.id), name: str(row.name), description: str(row.description) })) });
    return config;
  }

  private sessionConfig(sessionId: string) {
    const session = this.sessions.get(sessionId);
    const pick = (category: string) => session?.config.find((item) => item.category === category);
    return {
      modelId: modelOption(session?.config ?? [])?.currentValue,
      effort: this.spec.id === "cline" ? this.thinking.wanted : tierOf(pick("thought_level")?.currentValue ?? "") ?? undefined,
      mode: pick("mode")?.currentValue,
      modes: pick("mode")?.options ?? [],
    };
  }

  /** The app's permission mode for one session; see `SessionState.approvalMode`. */
  setApprovalMode(sessionId: string, mode: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown ${this.spec.name} session: ${sessionId}`);
    const next = ACP_APPROVAL_MODES.find((item) => item === mode) ?? "onRequest";
    session.approvalMode = next;
    return { status: "accepted" as const, effectiveMode: { mode: next } };
  }

  async startSession(options: { workspaceRoot: string; modelId?: string; effort?: string; mode?: string; approvalMode?: string }) {
    // A new Cline session starts in a process already at its level: an empty session cannot be reloaded later.
    if (this.spec.id === "cline" && options.effort && CLINE_THINKING.includes(options.effort)) this.thinking.wanted = options.effort;
    await this.start({ workspaceRoot: options.workspaceRoot });
    await this.relaunchForThinking();
    let result: Json;
    try {
      result = await this.requireConn().request<Json>("session/new", { cwd: options.workspaceRoot, mcpServers: [] }, 60000);
    } catch (error) {
      throw new Error(this.explain(error));
    }
    const sessionId = String(result.sessionId);
    this.track(sessionId, options.workspaceRoot, this.configFrom(result));
    const current = this.sessionConfig(sessionId).modelId;
    const fallback = this.spec.id === "opencode" ? fallbackOpencodeModel(await this.loadCatalog(), options.modelId ?? current, this.blocked) : undefined;
    const target = fallback ?? options.modelId;
    if (target && target !== current) {
      try { await this.setModel({ sessionId, modelId: target }); }
      catch (error) {
        this.emit("agentNotice", { sessionId, level: "warning", message: `Couldn't switch to ${target}: ${this.explain(error)} Using ${this.sessionConfig(sessionId).modelId ?? "the agent default"}.` });
      }
    }
    if (options.effort) await this.setEffort(sessionId, options.effort).catch(() => {});
    // The mode the draft showed (OpenCode: build or plan) carries into the thread.
    if (options.mode && options.mode !== this.sessionConfig(sessionId).mode) await this.setMode(sessionId, options.mode).catch(() => {});
    if (options.approvalMode) this.setApprovalMode(sessionId, options.approvalMode);
    const config = this.sessionConfig(sessionId);
    return { sessionId, opening: { result: { session: { sessionId, workspaceRoot: options.workspaceRoot, modelId: config.modelId ?? null, providerId: config.modelId?.includes("/") ? config.modelId.split("/")[0] : this.spec.id } } }, agentConfig: config };
  }

  async resumeSession(options: { sessionId: string; workspaceRoot: string }) {
    await this.start({ workspaceRoot: options.workspaceRoot });
    if (this.sessions.has(options.sessionId)) return { sessionId: options.sessionId, alreadyOpen: true, agentConfig: this.sessionConfig(options.sessionId) };
    const session = this.track(options.sessionId, options.workspaceRoot, []);
    let result: Json;
    try {
      if (this.capability(["loadSession"])) {
        result = await this.requireConn().request<Json>("session/load", { sessionId: options.sessionId, cwd: options.workspaceRoot, mcpServers: [] }, 120000);
      } else if (this.capability(["sessionCapabilities", "resume"])) {
        result = await this.requireConn().request<Json>("session/resume", { sessionId: options.sessionId, cwd: options.workspaceRoot, mcpServers: [] }, 60000);
      } else throw new Error(`${this.spec.name} can't reopen past sessions.`);
    } catch (error) {
      this.sessions.delete(options.sessionId);
      throw new Error(this.explain(error));
    }
    this.closeStream(options.sessionId, session);
    session.config = this.configFrom(asRecord(result));
    session.turnId = "idle";
    const config = this.sessionConfig(options.sessionId);
    return { sessionId: options.sessionId, alreadyOpen: false, opening: { result: { session: { sessionId: options.sessionId, workspaceRoot: options.workspaceRoot, modelId: config.modelId ?? null } } }, agentConfig: config };
  }

  async setOption(sessionId: string, configId: string, value: string) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("Session is not open.");
    const result = await this.requireConn().request<Json>("session/set_config_option", { sessionId, configId, value }, 30000);
    if (Array.isArray(result?.configOptions)) session.config = result.configOptions as AcpConfigOption[];
    else session.config = session.config.map((item) => item.id === configId ? { ...item, currentValue: value } : item);
    // A muted (suggestion) session belongs to no renderer thread: even its
    // config moves stay off the event stream.
    if (!session.muted) this.emit("agentConfig", { sessionId, config: this.sessionConfig(sessionId) });
    return { status: "accepted", agentConfig: this.sessionConfig(sessionId) };
  }

  async setModel(options: { sessionId: string; modelId: string }) {
    const session = this.sessions.get(options.sessionId);
    const option = modelOption(session?.config ?? []);
    if (option) return this.setOption(options.sessionId, option.id, options.modelId);
    await this.requireConn().request("session/set_model", { sessionId: options.sessionId, modelId: options.modelId }, 30000);
    return { status: "accepted" };
  }

  async setEffort(sessionId: string, effort: string) {
    if (this.spec.id === "cline") return this.wantThinking(sessionId, effort);
    const option = this.sessions.get(sessionId)?.config.find((item) => item.category === "thought_level");
    if (!option) return { status: "unsupported" };
    const match = option.options?.find((item) => tierOf(item.value) === effort);
    if (!match || match.value === option.currentValue) return { status: "accepted" };
    return this.setOption(sessionId, option.id, match.value);
  }

  /** The level applies from the next turn, which relaunches Cline at it (see `relaunchForThinking`). */
  private wantThinking(sessionId: string, effort: string) {
    if (!this.sessions.has(sessionId)) throw new Error("Session is not open.");
    if (!CLINE_THINKING.includes(effort)) return { status: "unsupported" };
    const changed = effort !== this.thinking.wanted;
    this.thinking.wanted = effort;
    if (changed && !this.sessions.get(sessionId)?.muted) this.emit("agentConfig", { sessionId, config: this.sessionConfig(sessionId) });
    return { status: "accepted", agentConfig: this.sessionConfig(sessionId) };
  }

  /**
   * Cline reads its reasoning level only from `--thinking` at launch. A new
   * level relaunches the process while no turn is running, and the open
   * sessions are reloaded into it with their model and mode. A turn already
   * running elsewhere keeps the old level; the relaunch waits for idle.
   */
  private async relaunchForThinking() {
    if (this.spec.id !== "cline" || !this.conn || this.thinking.wanted === this.thinking.launched) return;
    if ([...this.sessions.values()].some((session) => session.prompting)) return;
    const open = [...this.sessions.entries()].filter(([, session]) => !session.muted).map(([sessionId, session]) => ({ sessionId, cwd: session.cwd, config: this.sessionConfig(sessionId) }));
    const { catalog, catalogModes, workspaceRoot } = this;
    await this.stop();
    await this.start({ workspaceRoot });
    // The catalog does not depend on the level; keep it instead of probing again.
    this.catalog = catalog;
    this.catalogModes = catalogModes;
    for (const { sessionId, cwd, config } of open) {
      try {
        await this.reload(sessionId, cwd);
        const now = this.sessionConfig(sessionId);
        if (config.modelId && config.modelId !== now.modelId) await this.setModel({ sessionId, modelId: config.modelId });
        if (config.mode && config.mode !== now.mode) await this.setMode(sessionId, config.mode);
      } catch (error) {
        this.emit("agentNotice", { sessionId, level: "warning", message: `${this.spec.name} restarted to change its reasoning level and could not reopen this thread: ${this.explain(error)}` });
      }
    }
  }

  /** Reopens a session in a relaunched process. Its history is already in the thread, so the replay is muted. */
  private async reload(sessionId: string, cwd: string) {
    const session = this.track(sessionId, cwd, []);
    session.muted = true;
    try {
      const result = await this.requireConn().request<Json>("session/load", { sessionId, cwd, mcpServers: [] }, 120000);
      session.config = this.configFrom(asRecord(result));
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    } finally {
      session.muted = false;
      session.collected = undefined;
      session.turnId = "idle";
    }
  }

  async setMode(sessionId: string, mode: string) {
    const option = this.sessions.get(sessionId)?.config.find((item) => item.category === "mode");
    if (option) return this.setOption(sessionId, option.id, mode);
    await this.requireConn().request("session/set_mode", { sessionId, modeId: mode }, 30000);
    return { status: "accepted" };
  }

  // ─── Turns ────────────────────────────────────────────────────────────────

  async sendTurn(options: { sessionId: string; text: string; reasoningEffort?: string; images?: Array<{ mediaType: string; base64Data: string }> }) {
    if (this.spec.id === "cline" && this.sessions.has(options.sessionId)) {
      if (options.reasoningEffort) this.wantThinking(options.sessionId, options.reasoningEffort);
      await this.relaunchForThinking();
    }
    const session = this.sessions.get(options.sessionId);
    if (!session) throw new Error("Session is not open. Reopen the thread.");
    if (session.prompting) throw new Error(`${this.spec.name} is still working on the previous message.`);
    if (this.spec.id === "opencode") {
      const current = this.sessionConfig(options.sessionId).modelId;
      const fallback = fallbackOpencodeModel(await this.loadCatalog(), current, this.blocked);
      if (fallback && fallback !== current) {
        this.emit("agentNotice", { sessionId: options.sessionId, level: "info", message: `${current ?? "This Free model"} isn't usable on this OpenCode account. Switching to ${fallback}.` });
        try { await this.setModel({ sessionId: options.sessionId, modelId: fallback }); }
        catch { /* send on the current model */ }
      }
    }
    if (options.reasoningEffort) await this.setEffort(options.sessionId, options.reasoningEffort).catch(() => {});
    const turnId = `turn-${Date.now().toString(36)}-${++this.turnSeq}`;
    this.closeStream(options.sessionId, session);
    session.turnId = turnId;
    session.prompting = true;
    session.lastActivity = performance.now();
    this.emit("item", { sessionId: options.sessionId, item: { itemId: `${turnId}:user`, kind: "userMessage", status: "completed", text: options.text, turnId } });
    const prompt: Json[] = [];
    if (options.text.trim()) prompt.push({ type: "text", text: options.text });
    const images = asRecord(asRecord(this.init.agentCapabilities).promptCapabilities).image === true;
    for (const image of options.images ?? []) if (images) prompt.push({ type: "image", mimeType: image.mediaType, data: image.base64Data });
    this.watch(options.sessionId, session);
    this.requireConn().request<Json>("session/prompt", { sessionId: options.sessionId, prompt })
      .then((result) => {
        if (session.fatal) {
          this.completeTurn(options.sessionId, { kind: "failed", params: { terminal: "failed", error: { message: session.fatal } } });
          return;
        }
        const stop = str(result?.stopReason) ?? "end_turn";
        if (stop === "cancelled") this.completeTurn(options.sessionId, { kind: "completed", params: { terminal: "cancelled" } });
        else if (stop === "refusal") this.completeTurn(options.sessionId, { kind: "failed", params: { terminal: "failed", error: { message: `${this.spec.name} declined this request.` } } });
        else this.completeTurn(options.sessionId, { kind: "completed", params: { terminal: "completed", reason: stop } });
      })
      .catch((error) => this.completeTurn(options.sessionId, { kind: "failed", params: { terminal: "failed", error: { message: session.fatal ?? this.explain(error) } } }));
    return { turnId };
  }

  /**
   * One off-transcript prompt for predictive suggestions: a muted session on
   * this agent's existing connection, closed when the turn ends. The reply
   * text accumulates in `session.collected` (see `onNotification`) instead of
   * streaming to the renderer.
   */
  async suggest(options: { workspaceRoot: string; prompt: string; modelId?: string; timeoutMs?: number }) {
    const budget = options.timeoutMs ?? 75_000;
    const startedAt = performance.now();
    const remaining = () => budget - (performance.now() - startedAt);
    if (remaining() <= 0) throw new Error("The suggestion request timed out.");
    await this.start({
      suggest: { denyReadRoot: options.workspaceRoot },
      initializeTimeoutMs: Math.min(30_000, Math.max(1, remaining())),
    });
    const conn = this.requireConn();
    let sessionId = "";
    let prompted = false;
    try {
      const openBudget = remaining();
      if (openBudget <= 0) throw new Error("The suggestion request timed out.");
      // The session cwd is a temp directory, not the project. The sandbox
      // denies reading the project; putting the process inside it would make
      // the start itself fail that deny.
      const result = await conn.request<Json>("session/new", { cwd: confinedCwd(), mcpServers: [] }, Math.min(60_000, openBudget));
      sessionId = String(result.sessionId);
      const session = this.track(sessionId, options.workspaceRoot, this.configFrom(result));
      session.muted = true;
      session.collected = "";
      session.prompting = true;
      // A failed model switch must not silently bill the agent's default.
      if (options.modelId) await this.setModel({ sessionId, modelId: options.modelId });
      const turnBudget = remaining();
      if (turnBudget <= 0) throw new Error("The suggestion request timed out.");
      prompted = true;
      await conn.request<Json>("session/prompt", { sessionId, prompt: [{ type: "text", text: options.prompt }] }, turnBudget);
      return { text: session.collected ?? "" };
    } catch (error) {
      if (prompted && sessionId) {
        try { conn.notify("session/cancel", { sessionId }); } catch { /* agent already gone */ }
      }
      throw error;
    } finally {
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) session.prompting = false;
        this.sessions.delete(sessionId);
        if (this.capability(["sessionCapabilities", "close"])) await conn.request("session/close", { sessionId }, 5000).catch(() => {});
      }
    }
  }

  private completeTurn(sessionId: string, outcome: Json) {
    const session = this.sessions.get(sessionId);
    if (!session?.prompting) return;
    if (session.watchdog) clearInterval(session.watchdog);
    if (session.failTimer) clearTimeout(session.failTimer);
    session.watchdog = undefined;
    session.failTimer = undefined;
    session.prompting = false;
    this.closeStream(sessionId, session);
    for (const tool of session.tools.values()) {
      if (tool.item.status === "inProgress") this.emitTool(sessionId, tool, { status: outcome.kind === "completed" ? "completed" : "cancelled" });
    }
    this.emit("agentNotice", { sessionId, message: null });
    this.emit("turnCompleted", { sessionId, turnId: session.turnId, outcome });
  }

  /** Cancel a hanging prompt and fail the turn when the provider will not recover. */
  private failTurn(sessionId: string, message: string) {
    const session = this.sessions.get(sessionId);
    if (!session?.prompting || session.fatal) return;
    session.fatal = message;
    try { this.requireConn().notify("session/cancel", { sessionId }); } catch { /* agent already gone */ }
    if (session.failTimer) clearTimeout(session.failTimer);
    session.failTimer = setTimeout(() => {
      session.failTimer = undefined;
      if (this.sessions.get(sessionId)?.fatal === message) {
        this.completeTurn(sessionId, { kind: "failed", params: { terminal: "failed", error: { message } } });
      }
    }, 1500);
    session.failTimer.unref?.();
  }

  async cancelTurn(options: { sessionId: string }) {
    for (const [id, approval] of this.approvals) {
      if (approval.sessionId !== options.sessionId) continue;
      approval.resolve(null);
      this.approvals.delete(id);
    }
    const session = this.sessions.get(options.sessionId);
    try { this.requireConn().notify("session/cancel", { sessionId: options.sessionId }); }
    catch { return { status: "requested" as const }; }
    const deadline = performance.now() + CANCEL_WAIT_MS;
    while (session?.prompting && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!session?.prompting) return { status: "terminal" as const };
    await this.stop();
    return { status: "terminal" as const, escalated: true };
  }

  decideApproval(options: { approvalId: string; choiceId: string }) {
    const approval = this.approvals.get(options.approvalId);
    if (!approval) throw new Error("No pending approval with that id.");
    if (!approvalAlive(approval.expiresAtMono)) {
      this.approvals.delete(options.approvalId);
      approval.resolve(null);
      this.emit("approvalAudit", { approvalId: options.approvalId, sessionId: approval.sessionId, turnId: approval.turnId ?? null, choiceId: options.choiceId, outcome: "expired" });
      throw new Error("This approval expired. Re-run the turn to request it again.");
    }
    if (!approval.choices.has(options.choiceId)) throw new Error("That approval choice is not available.");
    this.approvals.delete(options.approvalId);
    approval.resolve(options.choiceId);
    this.emit("approvalAudit", { approvalId: options.approvalId, sessionId: approval.sessionId, turnId: approval.turnId ?? null, choiceId: options.choiceId, outcome: "decided" });
    return { decided: true };
  }

  ownsApproval(approvalId: string) { return this.approvals.has(approvalId); }

  /** Surfaces silent retries: no update for a while, plus opencode's own error log. */
  private watch(sessionId: string, session: SessionState) {
    if (session.watchdog) clearInterval(session.watchdog);
    session.fatal = undefined;
    let noticed = false;
    let last = "";
    // The log reads are async now, so the cursor is established off the interval
    // and each tick awaits its own read. Two overlapping reads of the same log
    // are harmless (the cursor only moves forward), so a slow one does not need
    // a guard of its own.
    if (this.spec.id === "opencode") void openLogCursor().then((cursor) => { session.logCursor = cursor; });
    session.stalled = false;
    session.watchdog = setInterval(() => {
      if (session.fatal || !session.prompting) return;
      // A tool that is still running, or a question waiting on the user, is work, not silence.
      const busy = [...session.tools.values()].some((tool) => tool.item.status === "inProgress") || [...this.approvals.values()].some((approval) => approval.sessionId === sessionId);
      if (busy) session.lastActivity = performance.now();
      void (async () => {
        const logged = session.logCursor ? await readOpencodeErrors(session.logCursor, sessionId) : null;
        if (logged) {
          noticed = true;
          if (logged === last) return;
          last = logged;
          const detail = this.explain(new Error(logged));
          if (fatalProviderError(logged)) {
            this.emit("agentNotice", { sessionId, level: "warning", message: detail });
            this.failTurn(sessionId, detail);
            return;
          }
          this.emit("agentNotice", { sessionId, level: "warning", message: `${detail} ${this.spec.name} is retrying automatically; Stop to cancel.` });
        }
      })();
      const idle = performance.now() - session.lastActivity;
      if (!noticed && !session.stalled && idle > STALL_MS) {
        session.stalled = true;
        this.emit("agentNotice", { sessionId, level: "info", message: `No word from ${this.spec.name} for ${Math.round(idle / 1000)}s. The model may still be thinking, or the provider is slow.` });
      }
      if (this.spec.id === "opencode" && idle > STALL_FAIL_MS) {
        this.failTurn(sessionId, "OpenCode stopped responding for five minutes. The provider may be down or rate-limiting; try again, or pick another model.");
      }
    }, 2000);
  }
  // ─── Agent → client ───────────────────────────────────────────────────────

  private async onRequest(method: string, params: Json): Promise<unknown> {
    if (method === "session/request_permission") {
      const sessionId = String(params.sessionId ?? "");
      const session = this.sessions.get(sessionId);
      // A muted suggestion turn asks for no tools; deny instead of surfacing a card.
      if (session?.muted) return { outcome: { outcome: "cancelled" } };
      const toolCall = asRecord(params.toolCall);
      const options = Array.isArray(params.options) ? params.options as Json[] : [];
      const choices = new Set(options.map((option) => String(option.optionId ?? "")).filter(Boolean));
      const approvalId = randomUUID();
      // The thread's mode may answer for the user. Every automatic answer is audited like a click.
      const mode = session?.approvalMode ?? "promptUnmatched";
      const decision = acpPermissionDecision(mode, toolCall);
      const automatic = decision === "ask" ? null : automaticChoice(options, decision === "allow");
      if (automatic) {
        this.emit("approvalAudit", { approvalId, sessionId, turnId: session?.turnId ?? null, choiceId: automatic, outcome: decision === "allow" ? "auto-approved" : "auto-denied" });
        return { outcome: { outcome: "selected", optionId: automatic } };
      }
      // A refusal with no decline option on offer: cancel rather than ask or allow.
      if (decision === "deny") return { outcome: { outcome: "cancelled" } };
      const expiresAt = approvalExpiry();
      const expiresAtMono = approvalExpiryMono();
      const choice = await new Promise<string | null>((resolve) => {
        this.approvals.set(approvalId, { sessionId, turnId: session?.turnId, choices, expiresAt, expiresAtMono, resolve });
        // An unanswered request would park the agent's permission round trip
        // forever; at the deadline the bridge answers "cancelled", audits the
        // expiry, and the renderer clears the card.
        const expiry = setTimeout(() => {
          const approval = this.approvals.get(approvalId);
          if (!approval || approval.resolve !== resolve) return;
          this.approvals.delete(approvalId);
          this.emit("approvalResolved", { approvalId, sessionId });
          this.emit("approvalAudit", { approvalId, sessionId, turnId: approval.turnId ?? null, choiceId: null, outcome: "expired" });
          resolve(null);
        }, APPROVAL_TTL_MS);
        expiry.unref?.();
        this.emit("approval", {
          approvalId,
          sessionId,
          turnId: session?.turnId ?? "",
          toolName: str(toolCall.title) ?? str(toolCall.kind) ?? "Tool",
          rawArgs: JSON.stringify(toolCall.rawInput ?? {}),
          subject: { kind: str(toolCall.kind) ?? "tool" },
          expiresAt,
          availableChoices: options.map((option) => {
            const kind = String(option.kind ?? "");
            return { choiceId: String(option.optionId), label: str(option.name) ?? kind, decision: kind.startsWith("allow") ? "approved" : "denied", scope: kind.endsWith("always") ? "session" : "once" };
          }),
        });
      });
      return choice ? { outcome: { outcome: "selected", optionId: choice } } : { outcome: { outcome: "cancelled" } };
    }
    throw new RpcError(`Method not found: ${method}`, -32601);
  }

  private onNotification(method: string, params: Json) {
    if (method !== "session/update") return;
    const sessionId = String(params.sessionId ?? "");
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.lastActivity = performance.now();
    if (session.stalled) {
      // It spoke again: the quiet notice no longer applies.
      session.stalled = false;
      this.emit("agentNotice", { sessionId, message: null });
    }
    const update = asRecord(params.update);
    const kind = String(update.sessionUpdate ?? "");
    // Muted (suggestion) sessions: keep only the reply text, emit nothing.
    if (session.muted) {
      if (kind === "agent_message_chunk") {
        const content = asRecord(update.content);
        if (content.type === "text") session.collected = (session.collected ?? "") + String(content.text ?? "");
      }
      return;
    }
    switch (kind) {
      case "user_message_chunk": return this.chunk(sessionId, session, "userMessage", update);
      case "agent_message_chunk": return this.chunk(sessionId, session, "agentMessage", update);
      case "agent_thought_chunk": return this.chunk(sessionId, session, "reasoning", update);
      case "tool_call":
      case "tool_call_update": return this.tool(sessionId, session, update);
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries as Json[] : [];
        const plan = entries.map((entry, index) => ({ id: `plan-${index}`, text: String(entry.content ?? ""), status: entry.status === "in_progress" ? "inProgress" : entry.status === "completed" ? "completed" : "pending" }));
        this.emit("sessionFacts", { sessionId, plan });
        return;
      }
      case "session_info_update":
        if (str(update.title)) this.emit("sessionTitle", { sessionId, title: update.title });
        return;
      case "usage_update": {
        const used = typeof update.used === "number" ? update.used : undefined;
        const size = typeof update.size === "number" ? update.size : undefined;
        if (used != null && size) this.emit("sessionFacts", { sessionId, context: { usedTokens: used, windowTokens: size } });
        return;
      }
      case "config_option_update":
        if (Array.isArray(update.configOptions)) {
          session.config = update.configOptions as AcpConfigOption[];
          this.emit("agentConfig", { sessionId, config: this.sessionConfig(sessionId) });
        }
        return;
      case "current_mode_update":
        session.config = session.config.map((item) => item.category === "mode" ? { ...item, currentValue: str(update.currentModeId) ?? item.currentValue } : item);
        this.emit("agentConfig", { sessionId, config: this.sessionConfig(sessionId) });
        return;
      default:
        return;
    }
  }

  private chunk(sessionId: string, session: SessionState, kind: Stream["kind"], update: Json) {
    const content = asRecord(update.content);
    const text = content.type === "text" ? String(content.text ?? "") : "";
    if (!text) return;
    if (kind === "userMessage" && !session.prompting && session.stream?.kind !== "userMessage") {
      // Replayed history: every user message opens a new run.
      session.turnId = `history-${++session.counter}`;
    }
    if (session.stream?.kind !== kind) {
      this.closeStream(sessionId, session);
      const itemId = `${sessionId}:${session.turnId}:${kind}:${++session.counter}`;
      session.stream = { kind, itemId, text };
      this.emit("item", { sessionId, item: { itemId, kind, status: session.prompting ? "inProgress" : "completed", text, turnId: session.turnId } });
      return;
    }
    session.stream.text += text;
    this.emit("delta", { sessionId, itemId: session.stream.itemId, field: "text", delta: text });
  }

  private closeStream(sessionId: string, session: SessionState) {
    const stream = session.stream;
    if (!stream) return;
    session.stream = null;
    this.emit("item", { sessionId, item: { itemId: stream.itemId, kind: stream.kind, status: "completed", text: stream.text, turnId: session.turnId } });
  }

  private tool(sessionId: string, session: SessionState, update: Json) {
    this.closeStream(sessionId, session);
    const id = String(update.toolCallId ?? "");
    const existing = session.tools.get(id);
    const merged: Json = { ...(existing?.item.raw as Json ?? {}), ...Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)) };
    const input = asRecord(merged.rawInput);
    const kind = String(merged.kind ?? "other").toLowerCase();
    // Plan bookkeeping tools are shown through the plan card instead.
    const hidden = kind === "think" && (Array.isArray(input.todos) || /plan|todo/i.test(String(merged.title ?? "")));
    const locations = Array.isArray(merged.locations) ? merged.locations as Json[] : [];
    const path = str(locations[0]?.path) ?? str(input.path) ?? str(input.filePath) ?? str(input.file_path) ?? str(input.target_file);
    const command = str(input.command) ?? str(input.cmd);
    const output = toolOutput(merged);
    const raw = asRecord(merged.rawOutput);
    const exit = typeof raw.exit_code === "number" ? raw.exit_code : typeof raw.exitCode === "number" ? raw.exitCode : typeof asRecord(raw.metadata).exit === "number" ? asRecord(raw.metadata).exit as number : undefined;
    const status = merged.status === "completed" ? "completed" : merged.status === "failed" ? "failed" : "inProgress";
    const tool = TOOL_NAMES[kind] ?? (str(merged.title)?.split(/[\s`]/)[0] || "tool");
    const item: Json = {
      raw: merged,
      itemId: id,
      kind: "toolCall",
      status,
      tool,
      turnId: session.turnId,
      args: JSON.stringify({ ...input, ...(path ? { path } : {}), ...(command ? { command } : {}), title: merged.title }),
      ...(command ? { commandText: command } : {}),
      ...(output ? { visibleOutput: output } : {}),
      ...(exit != null ? { exitCode: exit } : {}),
      ...(status === "failed" ? { failureReason: output || "Tool failed" } : {}),
    };
    const entry = { item, hidden };
    session.tools.set(id, entry);
    if (!hidden) this.emitTool(sessionId, entry);
  }

  private emitTool(sessionId: string, tool: Tool, patch: Json = {}) {
    Object.assign(tool.item, patch);
    if (tool.hidden) return;
    const { raw: _raw, ...item } = tool.item;
    this.emit("item", { sessionId, item });
  }
}

function toolOutput(merged: Json) {
  const content = Array.isArray(merged.content) ? merged.content as Json[] : [];
  const parts = content.map((entry) => {
    if (entry.type === "diff") return `--- ${String(entry.path ?? "")}\n${String(entry.newText ?? "")}`.slice(0, 4000);
    const inner = asRecord(entry.content);
    return inner.type === "text" ? String(inner.text ?? "") : "";
  }).filter(Boolean);
  if (parts.length) return parts.join("\n").slice(0, 20000);
  const raw = asRecord(merged.rawOutput);
  const text = str(raw.output_for_prompt) ?? str(raw.output) ?? str(raw.stdout);
  return text?.slice(0, 20000);
}

// ─── opencode helpers ───────────────────────────────────────────────────────

const OPENCODE_LOG_DIR = join(homedir(), ".local", "share", "opencode", "log");

/** Newest opencode log. Async because it runs on the event loop. */
async function newestLog(): Promise<string | null> {
  try {
    const names = await readdir(OPENCODE_LOG_DIR);
    const files = names.filter((name) => name.endsWith(".log")).map((name) => join(OPENCODE_LOG_DIR, name));
    const mtimes = await Promise.all(files.map(async (file) => [file, await stat(file).then((entry) => entry.mtimeMs, () => 0)] as const));
    return mtimes.sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  } catch {
    return null;
  }
}

async function openLogCursor() {
  const file = await newestLog();
  if (!file) return undefined;
  try { return { file, offset: (await stat(file)).size }; } catch { return undefined; }
}

/** Reads new lines of opencode's log and returns the latest provider error for this session. */
async function readOpencodeErrors(cursor: { file: string; offset: number }, sessionId: string): Promise<string | null> {
  let size: number;
  try { size = (await stat(cursor.file)).size; } catch { return null; }
  if (size < cursor.offset) cursor.offset = 0;
  if (size === cursor.offset) return null;
  const length = Math.min(size - cursor.offset, 512 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = openSync(cursor.file, "r");
  try { readSync(fd, buffer, 0, length, cursor.offset); } finally { closeSync(fd); }
  cursor.offset += length;
  let found: string | null = null;
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line.includes(`session.id=${sessionId}`) || !line.includes("level=ERROR") || line.includes("agent=title")) continue;
    const error = line.match(/error\.error="([^"]+)"/)?.[1] ?? line.match(/message="([^"]+)"/)?.[1];
    const model = line.match(/modelID=(\S+)/)?.[1];
    if (error) found = `${model ? `${model}: ` : ""}${error.replace(/^AI_APICallError:\s*/, "")}`;
  }
  return found;
}

const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENCODE_CONFIG_URL = "https://opencode.ai/console/api/v2/config";
const OPENCODE_CATALOG_TTL_MS = 10 * 60 * 1000;
let opencodeCatalogCache: { at: number; models: AcpModel[] } | null = null;

/**
 * Models.dev's OpenCode provider, minus models the signed-in workspace has
 * turned off. OpenCode's own `models` command and its ACP session option only
 * name the handful its inference endpoint currently returns.
 */
export function opencodeModelsFromCatalog(body: unknown, disabled: ReadonlySet<string> = new Set()): AcpModel[] {
  const root = asRecord(body);
  const provider = asRecord(root.opencode).models ? asRecord(root.opencode) : asRecord(asRecord(root.providers).opencode);
  const models = asRecord(provider.models);
  const rows: AcpModel[] = [];
  for (const [id, raw] of Object.entries(models)) {
    if (!id || disabled.has(id)) continue;
    const row = asRecord(raw);
    const cost = asRecord(row.cost);
    const limit = asRecord(row.limit);
    const input = typeof cost.input === "number" && Number.isFinite(cost.input) && cost.input >= 0 ? cost.input : undefined;
    const output = typeof cost.output === "number" && Number.isFinite(cost.output) && cost.output >= 0 ? cost.output : undefined;
    const free = /-free$|:free$/i.test(id) || (input === 0 && output === 0);
    const efforts = reasoningTiers(row.reasoning_options);
    rows.push({
      modelId: `opencode/${id}`,
      displayLabel: str(row.name) ?? id,
      providerId: "opencode",
      description: free ? "Free" : null,
      contextLimit: typeof limit.context === "number" ? limit.context : null,
      cost: input != null || output != null ? { ...(input != null ? { input: String(input) } : {}), ...(output != null ? { output: String(output) } : {}), currency: "USD" } : null,
      ...(efforts.length ? { reasoningEfforts: efforts, effortSource: "host" as const } : { reasoningEfforts: [] }),
    });
  }
  return rows;
}

/** Workspace denylist from `GET /console/api/v2/config`. Ids are the bare model id, without `opencode/`. */
export function disabledOpencodeModelIds(body: unknown): Set<string> {
  const models = asRecord(asRecord(asRecord(asRecord(body).providers).opencode).models);
  const disabled = new Set<string>();
  for (const [id, meta] of Object.entries(models)) if (asRecord(meta).disabled === true) disabled.add(id);
  return disabled;
}

/** The session's rows win where they know more (the active model, its efforts). Catalog rows fill in the rest. */
export function mergeOpencodeModels(session: AcpModel[], catalog: AcpModel[]): AcpModel[] {
  if (!catalog.length) return session;
  const byId = new Map(session.map((model) => [model.modelId, model]));
  const seen = new Set<string>();
  const merged = catalog.map((model) => {
    seen.add(model.modelId);
    const current = byId.get(model.modelId);
    if (!current) return model;
    return {
      ...model,
      ...current,
      displayLabel: current.displayLabel || model.displayLabel,
      description: current.description ?? model.description,
      contextLimit: current.contextLimit ?? model.contextLimit,
      cost: current.cost ?? model.cost,
      reasoningEfforts: current.reasoningEfforts?.length ? current.reasoningEfforts : model.reasoningEfforts,
      effortSource: current.reasoningEfforts?.length ? current.effortSource ?? model.effortSource : model.effortSource,
      defaultReasoningEffort: current.defaultReasoningEffort ?? model.defaultReasoningEffort,
    };
  });
  for (const model of session) if (!seen.has(model.modelId)) merged.push(model);
  return merged;
}

function reasoningTiers(raw: unknown): string[] {
  const options = Array.isArray(raw) ? raw : [];
  const values = options.flatMap((option) => {
    const row = asRecord(option);
    return row.type === "effort" && Array.isArray(row.values) ? row.values : [];
  });
  const tiers = values.map((value) => tierOf(String(value))).filter((tier): tier is string => Boolean(tier));
  return TIERS.filter((tier) => tiers.includes(tier));
}

/** The node test runner keeps the agent's own fixture list; a live app reads the Zen catalog. */
function liveOpencodeCatalog(): Promise<AcpModel[]> {
  if (process.env.NODE_TEST_CONTEXT) return Promise.resolve([]);
  return opencodeZenCatalog();
}

async function opencodeZenCatalog(): Promise<AcpModel[]> {
  if (opencodeCatalogCache && Date.now() - opencodeCatalogCache.at < OPENCODE_CATALOG_TTL_MS) return opencodeCatalogCache.models;
  const headers = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; Glitter)" };
  try {
    const response = await fetch(MODELS_DEV_URL, { headers, signal: AbortSignal.timeout(20000) });
    if (!response.ok) return opencodeCatalogCache?.models ?? [];
    const disabled = await disabledOpencodeIds(headers);
    const models = opencodeModelsFromCatalog(await response.json(), disabled);
    if (models.length) opencodeCatalogCache = { at: Date.now(), models };
    return models;
  } catch {
    return opencodeCatalogCache?.models ?? [];
  }
}

async function disabledOpencodeIds(headers: Record<string, string>): Promise<Set<string>> {
  let key = "";
  try {
    const auth = JSON.parse(await readFile(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8")) as unknown;
    key = str(asRecord(asRecord(auth).opencode).key) ?? "";
  } catch {
    return new Set();
  }
  if (!key) return new Set();
  try {
    const response = await fetch(OPENCODE_CONFIG_URL, { headers: { ...headers, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return new Set();
    return disabledOpencodeModelIds(await response.json());
  } catch {
    return new Set();
  }
}

/**
 * `opencode models --verbose`: the v1 catalog. v2's command is interactive and
 * no longer accepts the flag, so this is only the fallback when the agent has
 * no session discovery. The live list is `opencodeZenCatalog`.
 */
async function opencodeCatalog(bin: string): Promise<AcpModel[]> {
  let text = "";
  try {
    text = await new Promise<string>((resolve, reject) => {
      execFile(bin, ["models", "--verbose"], {
        encoding: "utf8",
        timeout: 20000,
        cwd: confinedCwd(),
        env: filterChildEnv(process.env, "opencode"),
        maxBuffer: 64 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        const collected = `${stdout ?? ""}${stderr ?? ""}`;
        if (error && !collected) {
          reject(error);
          return;
        }
        resolve(collected);
      });
    });
  } catch {
    return [];
  }
  const models: AcpModel[] = [];
  for (const block of text.split(/\n(?=[a-z0-9._-]+\/\S+\n\{)/i)) {
    const brace = block.indexOf("{");
    if (brace < 0) continue;
    let row: Json;
    try { row = JSON.parse(block.slice(brace)) as Json; } catch { continue; }
    const provider = String(row.providerID ?? "");
    const cost = asRecord(row.cost);
    const limit = asRecord(row.limit);
    const variants = Object.keys(asRecord(row.variants)).map(tierOf).filter((tier): tier is string => Boolean(tier));
    const input = typeof cost.input === "number" && Number.isFinite(cost.input) && cost.input >= 0 ? cost.input : undefined;
    const output = typeof cost.output === "number" && Number.isFinite(cost.output) && cost.output >= 0 ? cost.output : undefined;
    const free = /-free$|:free$/.test(String(row.id)) || (input === 0 && output === 0);
    models.push({
      modelId: `${provider}/${String(row.id)}`,
      displayLabel: str(row.name),
      providerId: provider,
      description: free ? "Free" : null,
      contextLimit: typeof limit.context === "number" ? limit.context : null,
      cost: input != null || output != null ? { ...(input != null ? { input: String(input) } : {}), ...(output != null ? { output: String(output) } : {}), currency: "USD" } : null,
      ...(variants.length ? { reasoningEfforts: TIERS.filter((tier) => variants.includes(tier)), effortSource: "host" as const } : { reasoningEfforts: [] }),
    });
  }
  return models;
}
