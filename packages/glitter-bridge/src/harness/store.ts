import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  | { type: "toolStarted"; id: string }
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
  | { type: "builderEnd"; planId: string };

const SESSION_ID = /^h-[a-z0-9-]{8,64}$/;

export function harnessDir(): string {
  return process.env.GLITTER_HARNESS_DIR || join(homedir(), ".glitter", "harness");
}

export class SessionStore {
  private index: Map<string, SessionMeta> | null = null;
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

  private async load(): Promise<Map<string, SessionMeta>> {
    if (this.index) return this.index;
    const index = new Map<string, SessionMeta>();
    try {
      const raw = JSON.parse(await readFile(this.indexFile, "utf8")) as SessionMeta[];
      for (const meta of Array.isArray(raw) ? raw : []) if (meta && SESSION_ID.test(meta.sessionId)) index.set(meta.sessionId, meta);
    } catch { /* first run, or an unreadable index: start empty */ }
    this.index = index;
    return index;
  }

  private async saveIndex() {
    const index = await this.load();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.indexFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...index.values()]), { mode: 0o600 });
    await rename(temporary, this.indexFile);
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
      (await this.load()).set(meta.sessionId, meta);
      await mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
      await writeFile(this.file(meta.sessionId), "", { mode: 0o600, flag: "a" });
      await this.saveIndex();
    });
  }

  update(sessionId: string, patch: Partial<Omit<SessionMeta, "sessionId" | "workspaceRoot" | "createdAt">>): Promise<void> {
    return this.serial(async () => {
      const index = await this.load();
      const meta = index.get(sessionId);
      if (!meta) return;
      index.set(sessionId, { ...meta, ...patch, updatedAt: new Date().toISOString() });
      await this.saveIndex();
    });
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
      await appendFile(this.file(sessionId), durable.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
    });
  }

  private steerMessage(steer: PendingSteer): ChatMessage {
    const content: ContentPart[] = [];
    if (steer.text.trim()) content.push({ type: "text", text: steer.text });
    for (const image of steer.images ?? []) content.push({ type: "image", mediaType: image.mediaType, data: image.base64Data });
    return { role: "user", content };
  }

  /** Messages for the model and items for the transcript. A torn last line (a crash mid-write) is skipped. */
  async read(sessionId: string): Promise<{ messages: ChatMessage[]; items: Array<Record<string, unknown>>; steering?: PendingSteer[]; question?: PendingQuestion; delegation?: DelegationPolicy; routes?: Array<{ turnId: string; route: RouteRecord }>; leadMessages?: ChatMessage[]; builder?: BuilderSessionRecord }> {
    const path = this.file(sessionId);
    if (!existsSync(path)) return { messages: [], items: [] };
    let question: PendingQuestion | undefined;
    let delegation: DelegationPolicy | undefined;
    const messages: ChatMessage[] = [];
    const leadMessages: ChatMessage[] = [];
    let builder: BuilderSessionRecord | undefined;
    const items = new Map<string, Record<string, unknown>>();
    const steering = new Map<string, PendingSteer>();
    const routes: Array<{ turnId: string; route: RouteRecord }> = [];
    const started = new Set<string>();
    for (const line of (await readFile(path, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      let record: Record_;
      try { record = JSON.parse(line) as Record_; } catch { continue; }
      if (record.type === "message") messages.push(record.message);
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
      else if (record.type === "toolStarted" && typeof record.id === "string") started.add(record.id);
      else if (record.type === "question" && record.question) question = record.question;
      else if (record.type === "questionSettled" && record.userInputId === question?.userInputId) question = undefined;
      else if (record.type === "delegation" && record.delegation) delegation = record.delegation;
      else if (record.type === "route" && typeof record.turnId === "string" && record.route) routes.push({ turnId: record.turnId, route: record.route });
    }
    // A crash mid-tool leaves the assistant message without a result. The marker says the call had started.
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) if (started.has(call.id)) call.started = true;
    }
    return { messages, items: [...items.values()], ...(steering.size ? { steering: [...steering.values()] } : {}), ...(question ? { question } : {}), ...(delegation ? { delegation } : {}), ...(routes.length ? { routes } : {}), ...(leadMessages.length ? { leadMessages } : {}), ...(builder ? { builder } : {}) };
  }

  remove(sessionId: string): Promise<void> {
    return this.serial(async () => {
      (await this.load()).delete(sessionId);
      await rm(this.file(sessionId), { force: true });
      await this.saveIndex();
    });
  }
}
