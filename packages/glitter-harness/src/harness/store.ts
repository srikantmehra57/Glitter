import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PendingQuestion } from "./questions.js";
import type { ApprovalMode } from "./permission/policy.js";
import type { OrchestratorPlan } from "./orchestrator/handoffs.js";
import type { OrchestratorSettings, RouteRecord } from "./orchestrator/types.js";
import type { ChatMessage, ContentPart } from "./wire.js";

export type PendingSteer = { itemId: string; text: string; images?: Array<{ mediaType: string; base64Data: string }> };

/** A fresh Builder session for one plan; active until it finishes or a new task replaces it. */
export type BuilderSessionRecord = {
  planId: string;
  plan: OrchestratorPlan;
  messages: ChatMessage[];
};

/**
 * The harness owns its sessions, so it keeps them: one append-only JSONL file
 * per session (the model-facing messages and the transcript items the app
 * renders), plus a small index for listing. The native shell points
 * `GLITTER_HARNESS_DIR` at the app's data folder; files are written 0600.
 */

/** What a delegated child was created with. Stamped into its meta and its log; never widened. */
export type DelegationPolicy = {
  parentSessionId: string;
  /** 1 is a child of a top-level thread; the cap lives in delegation.ts. */
  depth: number;
  /** The tool profile the child was created with. */
  profile: string;
  /** The permission mode it inherited, fixed for its life. */
  approvalMode: ApprovalMode;
  /** A child of a Plan-mode thread stays in Plan mode. */
  planMode: boolean;
};

export type SessionMeta = {
  sessionId: string;
  workspaceRoot: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  modelId?: string;
  effort?: string;
  mode?: string;
  /** Present only on a thread started with Orchestrator. Role models override `modelId` and `effort`. */
  orchestrator?: OrchestratorSettings;
  /** The manual model and effort to restore when Orchestrator is switched off. */
  manual?: { modelId?: string; effort?: string };
  /** Present only on a delegated child. Hidden from the session list, shown in its parent's log. */
  delegation?: DelegationPolicy;
  /**
   * Tokens this session has used so far, as the providers reported them.
   * `promptTokens` is uncached input. Cache reads and writes are disjoint from it.
   */
  usage?: { promptTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
};

type Record_ =
  | { type: "message"; message: ChatMessage }
  | { type: "item"; item: Record<string, unknown> }
  | { type: "toolStarted"; id: string; replay?: "safe" }
  /** Written once, at child creation, so the policy survives even without the index. */
  | { type: "delegation"; delegation: DelegationPolicy }
  /** A turn ended asking the user; `questionSettled` closes it. */
  | { type: "question"; question: PendingQuestion }
  | { type: "questionSettled"; userInputId: string }
  /** Accepted steering is durable before its model-history boundary. */
  | { type: "steer"; steering: PendingSteer }
  | { type: "steerSettled"; itemIds: string[] }
  /** One routed turn's decision and the stages it ran. Durable for the thread's audit trail. */
  | { type: "route"; turnId: string; route: RouteRecord }
  /** The Lead's own session for the thread; reset when its model changes. */
  | { type: "leadMessage"; message: ChatMessage }
  | { type: "leadReset" }
  /** A fresh Builder session for one plan, kept across a user question. */
  | { type: "builderStart"; planId: string; plan: OrchestratorPlan }
  | { type: "builderMessage"; planId: string; message: ChatMessage }
  | { type: "builderEnd"; planId: string }
  /** The model history was compacted: from here on it starts over from these messages. The transcript items stay. */
  | { type: "compaction"; messages: ChatMessage[] }
  /**
   * Enough to reconcile an interruption. A later record for the same turn or
   * call replaces the earlier one. This is not a second transcript.
   */
  | { type: "checkpoint"; checkpoint: Checkpoint };

/** A turn has started, or a later record says how it ended. `open` is the only non-terminal state. */
export type TurnCheckpoint = { kind: "turn"; turnId: string; state: "open" | "completed" | "cancelled" | "failed" | "interrupted" };
/** An approval decision. `pending` means the call had not been decided when the record was written. */
export type ApprovalCheckpoint = { kind: "approval"; turnId: string; callId: string; state: "pending" | "allowed" | "rejected" | "cancelled" | "expired" };
export type Checkpoint = TurnCheckpoint | ApprovalCheckpoint;

const TURN_STATES = new Set<TurnCheckpoint["state"]>(["open", "completed", "cancelled", "failed", "interrupted"]);
const APPROVAL_STATES = new Set<ApprovalCheckpoint["state"]>(["pending", "allowed", "rejected", "cancelled", "expired"]);

const SESSION_ID = /^h-[a-z0-9-]{8,64}$/;

export function harnessDir(): string {
  return process.env.GLITTER_HARNESS_DIR || join(homedir(), ".glitter", "harness");
}

/** How long a writer waits for another process's index lock, and when a lock is treated as abandoned. */
const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 15_000;

/**
 * The index is shared: the app's agent process and the `glitter` CLI both
 * write it. Each process keeps a parsed copy, re-reads it whenever the file
 * changed on disk, and changes it only under a lock file after re-reading, so
 * neither process overwrites threads the other created.
 */
export class SessionStore {
  private index: Map<string, SessionMeta> | null = null;
  /** The index file's identity when this process last read or wrote it. */
  private indexStamp = "";
  /** True while this process holds the index lock. */
  private holdingLock = false;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly root = harnessDir()) {}

  private get sessionsDir() { return join(this.root, "sessions"); }
  private get indexFile() { return join(this.root, "index.json"); }
  private file(sessionId: string) {
    if (!SESSION_ID.test(sessionId)) throw new Error("Invalid session id.");
    return join(this.sessionsDir, `${sessionId}.jsonl`);
  }

  /** Writes run one at a time, in order, so a record never interleaves with another. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work, work);
    this.writes = run.catch(() => {});
    return run;
  }

  private get lockFile() { return `${this.indexFile}.lock`; }

  private async stampOf(): Promise<string> {
    try {
      const info = await stat(this.indexFile);
      return `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  /** The parsed index, re-read when another process has replaced the file since. */
  private async load(): Promise<Map<string, SessionMeta>> {
    if (this.index) {
      const stamp = await this.stampOf();
      if (stamp === this.indexStamp || stamp === "missing") return this.index;
    }
    const stamp = await this.stampOf();
    const index = new Map<string, SessionMeta>();
    let contents: string;
    try {
      contents = await readFile(this.indexFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot read the session index at ${this.indexFile}; the session logs have not been changed.`, { cause: error });
      let files: string[];
      try { files = await readdir(this.sessionsDir); }
      catch (directoryError) {
        if ((directoryError as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot inspect session logs at ${this.sessionsDir}; the session index has not been changed.`, { cause: directoryError });
        files = [];
      }
      // A writer in another process may be between the first log and the first index.
      if (files.some((file) => file.endsWith(".jsonl")) && (this.holdingLock || !existsSync(this.lockFile))) throw new Error(`The session index is missing at ${this.indexFile}, but session logs still exist at ${this.sessionsDir}. Restore the index before creating threads.`);
      this.index = index;
      this.indexStamp = "missing";
      return index;
    }
    try {
      const raw: unknown = JSON.parse(contents);
      if (!Array.isArray(raw)) throw new Error("Expected an array of sessions.");
      for (const meta of raw) {
        if (!meta || typeof meta !== "object" || typeof meta.sessionId !== "string" || !SESSION_ID.test(meta.sessionId)
          || typeof meta.workspaceRoot !== "string" || typeof meta.createdAt !== "string" || typeof meta.updatedAt !== "string"
          || !(meta.title === null || typeof meta.title === "string") || index.has(meta.sessionId)) throw new Error("Invalid or duplicate session metadata.");
        index.set(meta.sessionId, meta as SessionMeta);
      }
    } catch (error) {
      throw new Error(`The session index at ${this.indexFile} is corrupt or invalid. It and the session logs have not been changed. Restore the index before creating threads.`, { cause: error });
    }
    this.index = index;
    this.indexStamp = stamp;
    return index;
  }

  /** Hold the cross-process index lock for `work`. An abandoned lock is broken after `LOCK_STALE_MS`. */
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const started = Date.now();
    for (;;) {
      try {
        const handle = await open(this.lockFile, "wx", 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = await stat(this.lockFile).then((info) => Date.now() - info.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) {
          await rm(this.lockFile, { force: true });
          continue;
        }
        if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`Another Glitter process is holding the session index (${this.lockFile}). Try again.`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    }
    this.holdingLock = true;
    try {
      return await work();
    } finally {
      this.holdingLock = false;
      await rm(this.lockFile, { force: true });
    }
  }

  /** Re-read under the lock, apply one change, and write the result. */
  private changeIndex(change: (index: Map<string, SessionMeta>) => void | Promise<void>): Promise<void> {
    return this.locked(async () => {
      const index = await this.load();
      await change(index);
      const temporary = `${this.indexFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...index.values()]), { mode: 0o600 });
      await rename(temporary, this.indexFile);
      this.indexStamp = await this.stampOf();
    });
  }

  async list(workspaceRoot?: string): Promise<SessionMeta[]> {
    const index = await this.load();
    return [...index.values()]
      .filter((meta) => !workspaceRoot || meta.workspaceRoot === workspaceRoot)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async meta(sessionId: string): Promise<SessionMeta | undefined> {
    return (await this.load()).get(sessionId);
  }

  create(meta: SessionMeta): Promise<void> {
    return this.serial(async () => {
      // The log is created under the lock, after the index is read, so no
      // reader sees a log that its index does not name yet.
      await this.changeIndex(async (index) => {
        await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
        await writeFile(this.file(meta.sessionId), "", { mode: 0o600, flag: "a" });
        index.set(meta.sessionId, meta);
      });
    });
  }

  update(sessionId: string, patch: Partial<Omit<SessionMeta, "sessionId" | "workspaceRoot" | "createdAt">>): Promise<void> {
    return this.serial(async () => {
      if (!(await this.load()).has(sessionId)) return;
      await this.changeIndex((index) => {
        const meta = index.get(sessionId);
        if (meta) index.set(sessionId, { ...meta, ...patch, updatedAt: new Date().toISOString() });
      });
    });
  }

  /**
   * Append on a fresh line. A crash can leave a torn last line with no trailing
   * newline; appending straight into it would merge two records into one
   * unreadable line and lose both. Heal the boundary first.
   */
  private async appendLines(sessionId: string, payload: string): Promise<void> {
    const path = this.file(sessionId);
    let prefix = "";
    try {
      const handle = await open(path, "r");
      try {
        const { size } = await handle.stat();
        if (size > 0) {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = "\n";
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await appendFile(path, prefix + payload, { mode: 0o600 });
  }

  append(sessionId: string, records: Record_[]): Promise<void> {
    if (!records.length) return Promise.resolve();
    // Tool screenshots belong to the live context, not an ever-growing JSONL
    // log. A resumed turn gets an explicit omission note and can recapture.
    const durable = records.map((record): Record_ => {
      if (record.type !== "message" || record.message.role !== "tool" || !record.message.results.some((result) => result.images?.length)) return record;
      return {
        ...record,
        message: {
          ...record.message,
          results: record.message.results.map((result) => result.images?.length
            ? { ...result, output: `${result.output}\n[Tool image omitted from saved history. Capture a new image if it is needed.]`, images: undefined }
            : result),
        },
      };
    });
    return this.serial(async () => {
      await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
      await this.appendLines(sessionId, durable.map((record) => `${JSON.stringify(record)}\n`).join(""));
    });
  }

  /**
   * Settle a crash's unanswered tool calls once. Under the write lock, re-read
   * the tail: if a concurrent resume already recorded these results, skip. The
   * filler says exactly what happened — never started, a safe read, or an
   * unknown outcome — so the canonical history stays model-valid and truthful.
   */
  async appendInterruptedResults(sessionId: string, results: Array<{ id: string; name: string; output: string; isError?: boolean }>): Promise<boolean> {
    if (!results.length) return false;
    return this.serial(async () => {
      const { messages } = await this.read(sessionId);
      const last = messages.at(-1);
      const ids = new Set(results.map((result) => result.id));
      if (last?.role !== "assistant" || !last.toolCalls?.some((call) => ids.has(call.id))) return false;
      const message: ChatMessage = { role: "tool", results };
      await this.appendLines(sessionId, `${JSON.stringify({ type: "message", message })}\n`);
      return true;
    });
  }

  private steerMessage(steer: PendingSteer): ChatMessage {
    const content: ContentPart[] = [];
    if (steer.text.trim()) content.push({ type: "text", text: steer.text });
    for (const image of steer.images ?? []) content.push({ type: "image", mediaType: image.mediaType, data: image.base64Data });
    return { role: "user", content };
  }

  /** Messages for the model and items for the transcript. A torn last line (a crash mid-write) is skipped. */
  async read(sessionId: string): Promise<{ messages: ChatMessage[]; items: Array<Record<string, unknown>>; steering?: PendingSteer[]; question?: PendingQuestion; delegation?: DelegationPolicy; routes?: Array<{ turnId: string; route: RouteRecord }>; leadMessages?: ChatMessage[]; builder?: BuilderSessionRecord; checkpoint: { turn?: TurnCheckpoint; approvals: ApprovalCheckpoint[] } }> {
    const path = this.file(sessionId);
    if (!existsSync(path)) return { messages: [], items: [], checkpoint: { approvals: [] } };
    let question: PendingQuestion | undefined;
    let delegation: DelegationPolicy | undefined;
    const messages: ChatMessage[] = [];
    const leadMessages: ChatMessage[] = [];
    let builder: BuilderSessionRecord | undefined;
    const items = new Map<string, Record<string, unknown>>();
    const steering = new Map<string, PendingSteer>();
    const routes: Array<{ turnId: string; route: RouteRecord }> = [];
    const started = new Set<string>();
    const safeReplay = new Set<string>();
    let turn: TurnCheckpoint | undefined;
    const approvals = new Map<string, ApprovalCheckpoint>();
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      let record: Record_;
      try { record = JSON.parse(line) as Record_; } catch { continue; }
      if (record.type === "message") messages.push(record.message);
      else if (record.type === "compaction" && Array.isArray(record.messages)) messages.splice(0, messages.length, ...record.messages);
      else if (record.type === "leadMessage" && record.message) leadMessages.push(record.message);
      else if (record.type === "leadReset") leadMessages.length = 0;
      else if (record.type === "builderStart" && typeof record.planId === "string" && record.plan) builder = { planId: record.planId, plan: record.plan, messages: [] };
      else if (record.type === "builderMessage" && builder && record.planId === builder.planId && record.message) builder.messages.push(record.message);
      else if (record.type === "builderEnd" && builder?.planId === record.planId) builder = undefined;
      else if (record.type === "steer" && typeof record.steering?.itemId === "string" && typeof record.steering.text === "string") steering.set(record.steering.itemId, record.steering);
      else if (record.type === "steerSettled" && Array.isArray(record.itemIds)) {
        for (const itemId of record.itemIds) {
          const pending = steering.get(itemId);
          if (!pending) continue;
          messages.push(this.steerMessage(pending));
          steering.delete(itemId);
        }
      }
      else if (record.type === "item" && typeof record.item.itemId === "string") items.set(record.item.itemId, record.item);
      else if (record.type === "toolStarted" && typeof record.id === "string") {
        started.add(record.id);
        if (record.replay === "safe") safeReplay.add(record.id);
      }
      else if (record.type === "question" && record.question) question = record.question;
      else if (record.type === "questionSettled" && record.userInputId === question?.userInputId) question = undefined;
      else if (record.type === "delegation" && record.delegation) delegation = record.delegation;
      else if (record.type === "route" && typeof record.turnId === "string" && record.route) routes.push({ turnId: record.turnId, route: record.route });
      else if (record.type === "checkpoint") {
        const checkpoint = record.checkpoint;
        if (checkpoint?.kind === "turn" && typeof checkpoint.turnId === "string" && TURN_STATES.has(checkpoint.state)) turn = checkpoint;
        else if (checkpoint?.kind === "approval" && typeof checkpoint.turnId === "string" && typeof checkpoint.callId === "string" && APPROVAL_STATES.has(checkpoint.state)) approvals.set(checkpoint.callId, checkpoint);
      }
    }
    // A crash mid-tool leaves an assistant message without a result. The marker
    // says the call had started, in every history the thread keeps — the thread's
    // own, the Lead's and the Builder's — so none is told a started call never ran.
    // An approval that never reached toolStarted did not run. Its grant lived only in memory.
    const stamp = (history: ChatMessage[]) => {
      for (const message of history) {
        if (message.role !== "assistant") continue;
        for (const call of message.toolCalls ?? []) {
          if (started.has(call.id)) call.started = true;
          if (safeReplay.has(call.id)) call.replaySafe = true;
          const approval = approvals.get(call.id);
          if (approval && !started.has(call.id)) {
            call.approvalPending = true;
            call.approvalState = approval.state;
          }
        }
      }
    };
    stamp(messages);
    stamp(leadMessages);
    if (builder) stamp(builder.messages);
    return { messages, items: [...items.values()], checkpoint: { ...(turn ? { turn } : {}), approvals: [...approvals.values()] }, ...(steering.size ? { steering: [...steering.values()] } : {}), ...(question ? { question } : {}), ...(delegation ? { delegation } : {}), ...(routes.length ? { routes } : {}), ...(leadMessages.length ? { leadMessages } : {}), ...(builder ? { builder } : {}) };
  }

  remove(sessionId: string): Promise<void> {
    return this.serial(async () => {
      await this.changeIndex((index) => { index.delete(sessionId); });
      await rm(this.file(sessionId), { force: true });
    });
  }
}
