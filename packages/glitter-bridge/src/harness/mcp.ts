import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LineFrames } from "../framing.js";
import { mcpConfigFingerprints, readMcpConfigBytes } from "./mcp-config.js";
import { spawnIsolated, terminateTree } from "../isolation.js";
import { diagnostics } from "../redaction.js";
import type { Extension, TurnContext } from "./registry.js";
import type { Subject } from "./permission/grants.js";
import type { ToolDefinition, ToolProduced } from "./tools.js";

/**
 * MCP for the harness. Servers are user configuration, never renderer input:
 * `.glitter/mcp.json` in the workspace, then in the home folder, with the
 * nearest file winning a duplicate name. A stdio server runs under the same OS
 * sandbox and scrubbed environment as the shell; a streamable-HTTP server is
 * reached with the headers the user configured.
 *
 * Sync is two-phase. The whole next generation is connected and listed first;
 * any failure closes the partial generation and retires the previous one for
 * future turns. The registry therefore sees either a complete set of tools or none.
 */

const CONFIG_PATH = [".glitter", "mcp.json"];
const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const MAX_CALL_TIMEOUT_MS = 600_000;
const MAX_MAP_ENTRIES = 64;
const MAX_MAP_KEY = 128;
const MAX_MAP_VALUE = 4_096;
const MAX_TOOLS_PER_SERVER = 200;
const MAX_TOOL_PAGES = 20;
const MAX_TOOL_DESCRIPTION = 2_000;
const MAX_PROMPT_NAMES = 12;
const MAX_SEARCH_RESULTS = 8;
const OUTPUT_CHARS = 24 * 1024;
/** Reject hostile input before a frame or response can accumulate without bound. */
const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = "2025-06-18";
const FALLBACK_PROTOCOL_VERSION = "2024-11-05";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY = /^[A-Za-z0-9-]+$/;

export type McpTransport = "stdio" | "http";

export type McpServerConfig = Readonly<{
  name: string;
  transport: McpTransport;
  command?: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  url?: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
}>;

export type McpTool = Readonly<{ name: string; description: string; inputSchema: Record<string, unknown> }>;

export type McpServerInfo = Readonly<{ name: string; transport: McpTransport; tools: number; skipped?: boolean; reason?: string }>;
export type McpStatus = Readonly<{ servers: McpServerInfo[]; error: string | null }>;

/** Which `.glitter/mcp.json` a server is written to. The workspace file wins a duplicate name. */
export type McpScope = "workspace" | "home";

/** A server the app may add. Values in `env` and `headers` are written once and never read back. */
export type McpServerInput = Readonly<{
  name: string;
  transport: McpTransport;
  command?: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  url?: string;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}>;

/** A configured server for the management list: no env or header values, only their names. */
export type McpConfigRow = Readonly<{
  name: string;
  source: McpScope;
  transport: McpTransport;
  command?: string;
  url?: string;
  args: number;
  envKeys: readonly string[];
  headerKeys: readonly string[];
  error?: string;
}>;

export type McpConfig = Readonly<{ servers: McpConfigRow[]; error: string | null }>;

type Json = Record<string, unknown>;
type JsonRpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };

const isRecord = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A result cut on a line boundary, so a huge tool result never floods the context. */
function bounded(text: string, max = OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  return `${text.slice(0, cut > 0 ? cut : max)}\n… [cut at ${max} characters]`;
}

function stringMap(value: unknown, label: string, keyPattern: RegExp): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error(`${label} must be an object of strings.`);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_MAP_ENTRIES) throw new Error(`${label} has more than ${MAX_MAP_ENTRIES} entries.`);
    if (!keyPattern.test(key) || key.length > MAX_MAP_KEY) throw new Error(`${label} has an invalid key: ${key}.`);
    if (typeof entry !== "string") throw new Error(`${label}.${key} must be a string.`);
    if (entry.length > MAX_MAP_VALUE) throw new Error(`${label}.${key} is longer than ${MAX_MAP_VALUE} characters.`);
    if (/[\r\n]/.test(entry)) throw new Error(`${label}.${key} must be one line.`);
    if (entry) out[key] = entry;
  }
  return out;
}

function transportOf(raw: Json): McpTransport {
  const declared = str(raw.transport || raw.type).toLowerCase();
  return declared === "http" || declared === "streamablehttp" || declared === "streamable-http" || (!declared && str(raw.url || raw.endpoint)) ? "http" : "stdio";
}

function parseServer(file: string, name: string, raw: unknown): McpServerConfig {
  if (!NAME.test(name)) throw new Error(`${file}: "${name}" is not a valid server name.`);
  if (!isRecord(raw)) throw new Error(`${file}: server "${name}" must be an object.`);
  const transport = transportOf(raw);
  const args = raw.args == null ? [] : raw.args;
  if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string")) throw new Error(`${file}: ${name}.args must be an array of at most 64 strings.`);
  const timeout = typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs) ? Math.floor(raw.timeoutMs) : DEFAULT_CALL_TIMEOUT_MS;
  if (timeout < 1_000 || timeout > MAX_CALL_TIMEOUT_MS) throw new Error(`${file}: ${name}.timeoutMs must be between 1000 and ${MAX_CALL_TIMEOUT_MS}.`);
  const env = stringMap(raw.env, `${name}.env`, ENV_KEY);
  if (Object.hasOwn(env, "NODE_OPTIONS")) throw new Error(`${file}: ${name}.env cannot set NODE_OPTIONS.`);
  const headers = stringMap(raw.headers, `${name}.headers`, HEADER_KEY);
  if (transport === "stdio") {
    const command = str(raw.command).trim();
    if (!command) throw new Error(`${file}: stdio server "${name}" needs a command.`);
    if (command.length > 4_096) throw new Error(`${file}: ${name}.command is too long.`);
    return Object.freeze({ name, transport, command, args: Object.freeze(args as string[]), env: Object.freeze(env), headers: Object.freeze(headers), timeoutMs: timeout });
  }
  const url = str(raw.url || raw.endpoint);
  if (url.length > 4_096) throw new Error(`${file}: ${name}.url is too long.`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`${file}: server "${name}" needs a valid url.`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${file}: ${name}.url must be http or https.`);
  return Object.freeze({ name, transport, args: Object.freeze(args as string[]), env: Object.freeze(env), url: parsed.toString(), headers: Object.freeze(headers), timeoutMs: timeout });
}

/**
 * Every configured server, workspace file first. A missing file is normal; a
 * malformed one is an error the sync reports instead of guessing.
 */
export async function readMcpServers(workspaceRoot: string, homeDir: string, includeWorkspace = true): Promise<{ servers: McpServerConfig[]; sources: Record<string, McpScope> }> {
  const found = new Map<string, McpServerConfig>();
  const sources: Record<string, McpScope> = {};
  for (const root of includeWorkspace ? [workspaceRoot, homeDir] : [homeDir]) {
    const file = join(root, ...CONFIG_PATH);
    let text: string;
    try { text = (await readMcpConfigBytes(root)).toString("utf8"); } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    if (!text) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new Error(`${file} is not valid JSON.`); }
    if (!isRecord(parsed)) throw new Error(`${file} must contain an object.`);
    const block = parsed.mcpServers ?? parsed;
    if (!isRecord(block)) throw new Error(`${file}: mcpServers must be an object.`);
    for (const [name, raw] of Object.entries(block)) {
      // The workspace file was read first, so its server wins a duplicate name.
      if (found.has(name)) continue;
      found.set(name, parseServer(file, name, raw));
      sources[name] = root === workspaceRoot && includeWorkspace ? "workspace" : "home";
    }
  }
  return { servers: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)), sources };
}

function configFile(root: string): string {
  return join(root, ...CONFIG_PATH);
}

/** A URL for display only: no userinfo, query or fragment, where a token may sit. */
function displayUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function rowFor(source: McpScope, config: McpServerConfig): McpConfigRow {
  const url = config.url ? displayUrl(config.url) : undefined;
  return {
    name: config.name,
    source,
    transport: config.transport,
    ...(config.command ? { command: config.command } : {}),
    ...(url ? { url } : {}),
    args: config.args.length,
    envKeys: Object.keys(config.env).sort(),
    headerKeys: Object.keys(config.headers).sort(),
  };
}

/** A row for a server the parser refused, so it can still be seen and removed. */
function lenientRow(source: McpScope, name: string, raw: unknown): McpConfigRow {
  const record = isRecord(raw) ? raw : {};
  const command = str(record.command).trim();
  const url = displayUrl(str(record.url || record.endpoint));
  const args = Array.isArray(record.args) ? record.args.filter((arg) => typeof arg === "string").length : 0;
  const envKeys = isRecord(record.env) ? Object.keys(record.env).filter((key) => ENV_KEY.test(key)).sort() : [];
  const headerKeys = isRecord(record.headers) ? Object.keys(record.headers).filter((key) => HEADER_KEY.test(key)).sort() : [];
  return {
    name,
    source,
    transport: transportOf(record),
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    args,
    envKeys,
    headerKeys,
  };
}

const sortRows = (rows: Iterable<McpConfigRow>) => [...rows].sort((a, b) => a.name.localeCompare(b.name));

/**
 * The effective servers as rows for the app, with per-server errors instead of
 * one failure for the whole file. Values are never included, only key names.
 * A malformed workspace file stops the walk, as it does for a sync.
 */
export async function readMcpConfig(workspaceRoot: string, homeDir: string, includeWorkspace = true): Promise<McpConfig> {
  const rows = new Map<string, McpConfigRow>();
  for (const [source, root] of includeWorkspace ? [["workspace", workspaceRoot], ["home", homeDir]] as const : [["home", homeDir]] as const) {
    const file = configFile(root);
    let document: Json | null;
    try {
      document = await readDocument(file);
    } catch (error) {
      return { servers: sortRows(rows.values()), error: messageOf(error) };
    }
    if (!document) continue;
    let block: Json;
    try {
      block = configBlock(document, file);
    } catch (error) {
      return { servers: sortRows(rows.values()), error: messageOf(error) };
    }
    for (const [name, raw] of Object.entries(block)) {
      if (rows.has(name)) continue;
      try {
        rows.set(name, rowFor(source, parseServer(file, name, raw)));
      } catch (error) {
        rows.set(name, { ...lenientRow(source, name, raw), error: messageOf(error) });
      }
    }
  }
  return { servers: sortRows(rows.values()), error: null };
}

async function readDocument(file: string): Promise<Json | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON.`);
  }
  if (!isRecord(parsed)) throw new Error(`${file} must contain an object.`);
  return parsed;
}

function configBlock(document: Json, file: string): Json {
  if (document.mcpServers == null) return document;
  if (!isRecord(document.mcpServers)) throw new Error(`${file}: mcpServers must be an object.`);
  return document.mcpServers;
}

async function editableDocument(file: string): Promise<{ document: Json; block: Json }> {
  const document = await readDocument(file) ?? { mcpServers: {} };
  return { document, block: configBlock(document, file) };
}

async function writeDocument(file: string, document: Json): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.mcp-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function configuredNames(file: string): Promise<Set<string>> {
  const document = await readDocument(file);
  return new Set(document ? Object.keys(configBlock(document, file)) : []);
}

/**
 * Add a server to one config file. The definition is parsed with the same rules
 * the sync uses before anything is written; the file is replaced atomically and
 * only its owner can read it, since env and header values may hold secrets.
 */
export async function addMcpServer(workspaceRoot: string, homeDir: string, scope: McpScope, input: McpServerInput): Promise<void> {
  const file = configFile(scope === "workspace" ? workspaceRoot : homeDir);
  if (!NAME.test(input.name)) throw new Error(`"${input.name}" is not a valid server name.`);
  if (input.transport !== "stdio" && input.transport !== "http") throw new Error("A server transport must be stdio or http.");
  if (scope === "home" && (await configuredNames(configFile(workspaceRoot))).has(input.name)) {
    throw new Error(`The workspace already defines a server named "${input.name}"; the workspace file wins, so a home server would be hidden.`);
  }
  const args = [...(input.args ?? [])];
  const env = { ...(input.env ?? {}) };
  const headers = { ...(input.headers ?? {}) };
  const raw: Json = input.transport === "stdio"
    ? {
        transport: "stdio",
        command: input.command ?? "",
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(input.timeoutMs != null ? { timeoutMs: input.timeoutMs } : {}),
      }
    : {
        transport: "http",
        url: input.url ?? "",
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(input.timeoutMs != null ? { timeoutMs: input.timeoutMs } : {}),
      };
  parseServer(file, input.name, raw);
  const { document, block } = await editableDocument(file);
  if (Object.hasOwn(block, input.name)) throw new Error(`${file} already defines a server named "${input.name}". Choose another name or remove it first.`);
  block[input.name] = raw;
  await writeDocument(file, document);
}

/** Remove a server from the file that defines it. */
export async function removeMcpServer(workspaceRoot: string, homeDir: string, scope: McpScope, name: string): Promise<void> {
  if (!name || name.length > 256) throw new Error("A server name is required.");
  const file = configFile(scope === "workspace" ? workspaceRoot : homeDir);
  const document = await readDocument(file);
  if (!document) throw new Error(`No MCP server named "${name}" is configured in ${scope === "workspace" ? "this workspace" : "your home folder"}.`);
  const block = configBlock(document, file);
  if (!Object.hasOwn(block, name)) throw new Error(`${file} has no server named "${name}".`);
  delete block[name];
  await writeDocument(file, document);
}

/** The model-facing name: `mcp__server__tool`, with a hash when normalization changed it. */
export function mcpToolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`;
  const normalized = `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32)}__${tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}`;
  if (normalized === raw && normalized.length <= 64) return normalized;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 12);
  return `${normalized.slice(0, 64 - hash.length - 2)}__${hash}`;
}

/** The MCP result as text for the model, with non-text blocks described rather than dropped. */
function toolText(result: unknown): { text: string; isError: boolean } {
  const record = isRecord(result) ? result : {};
  const parts: string[] = [];
  for (const part of Array.isArray(record.content) ? record.content : []) {
    if (!isRecord(part)) continue;
    if (typeof part.text === "string") parts.push(part.text);
    else if (typeof part.type === "string") parts.push(`[${part.type}${typeof part.mimeType === "string" ? ` ${part.mimeType}` : ""}${typeof part.uri === "string" ? ` ${part.uri}` : ""}]`);
  }
  if (!parts.length && isRecord(record.structuredContent)) parts.push(JSON.stringify(record.structuredContent, null, 2));
  return { text: bounded(parts.join("\n") || "(no output)"), isError: record.isError === true };
}

function messageTooLarge(name: string, kind: "frame" | "response"): Error {
  return new Error(`The ${name} MCP server sent a ${kind} that exceeds the ${MAX_MCP_MESSAGE_BYTES}-byte limit.`);
}

/** Read a non-streaming response with a hard byte ceiling, including error bodies. */
async function readBoundedResponse(response: Response, name: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_MCP_MESSAGE_BYTES) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw messageTooLarge(name, "response");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_MCP_MESSAGE_BYTES) throw messageTooLarge(name, "response");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, received).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

type Exchange = { listTools(signal?: AbortSignal): Promise<McpTool[]>; callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>; close(): Promise<void> };

class StdioExchange implements Exchange {
  private nextId = 1;
  private readonly frames = new LineFrames(MAX_MCP_MESSAGE_BYTES);
  private readonly pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly stderr: string[] = [];
  private termination?: ReturnType<typeof terminateTree>;
  private closed = false;

  private constructor(private readonly config: McpServerConfig, private readonly child: ReturnType<typeof spawnIsolated>["child"]) {
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      try {
        this.frames.push(chunk, (line) => this.receive(line));
      } catch {
        this.fail(messageTooLarge(config.name, "frame").message);
        this.child.stdout.destroy();
        this.termination = terminateTree(this.child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.stderr.join("").length < 2_000) this.stderr.push(chunk.toString("utf8").slice(0, 500));
    });
    child.on("exit", (code) => this.fail(`The ${config.name} MCP server exited${code == null ? "" : ` with code ${code}`}.${this.stderr.length ? ` ${this.stderr.join("").trim()}` : ""}`));
    child.on("error", (error) => this.fail(`The ${config.name} MCP server could not start: ${error.message}`));
  }

  static async start(config: McpServerConfig, workspaceRoot: string): Promise<StdioExchange> {
    const { child } = spawnIsolated(config.command ?? "", [...config.args], { agentId: "harness", workspace: workspaceRoot, cwd: workspaceRoot, extraEnv: config.env });
    const exchange = new StdioExchange(config, child);
    try {
      await exchange.initialize();
      return exchange;
    } catch (error) {
      await exchange.close();
      throw error;
    }
  }

  private send(message: JsonRpc) {
    if (this.closed || !this.child.stdin.writable) throw new Error(`The ${this.config.name} MCP server is closed.`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(raw: string) {
    const line = raw.trim();
    if (!line) return;
    let message: JsonRpc;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      message = parsed as JsonRpc;
    } catch { return; }
    // A server request (roots, sampling) is outside what we offer. Answer it
    // so the server does not wait forever; notifications need no answer.
    if (message.method && message.id != null) {
      try { this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "This client does not support server requests." } }); } catch { /* closing */ }
      return;
    }
    if (message.id == null) return;
    const waiter = this.pending.get(Number(message.id));
    if (!waiter) return;
    this.pending.delete(Number(message.id));
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(`${this.config.name}: ${message.error.message ?? "the MCP server returned an error"}`));
    else waiter.resolve(message.result);
  }

  private fail(message: string) {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
    }
    this.pending.clear();
  }

  private request(method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(new Error("The turn was stopped."));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${this.config.name} did not answer ${method} in ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      timer.unref?.();
      const abort = () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(new Error("The turn was stopped."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        resolve: (result) => { signal?.removeEventListener("abort", abort); resolve(result); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
        timer,
      });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async initialize() {
    const params = (version: string) => ({ protocolVersion: version, capabilities: {}, clientInfo: { name: "Glitter Harness", version: "0.1.0" } });
    try {
      await this.request("initialize", params(PROTOCOL_VERSION), CONNECT_TIMEOUT_MS);
    } catch (error) {
      if (!/protocol|version/i.test(messageOf(error))) throw error;
      await this.request("initialize", params(FALLBACK_PROTOCOL_VERSION), CONNECT_TIMEOUT_MS);
    }
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES && tools.length < MAX_TOOLS_PER_SERVER; page += 1) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS, signal) as Json;
      for (const row of Array.isArray(result?.tools) ? result.tools : []) {
        if (tools.length >= MAX_TOOLS_PER_SERVER) break;
        const tool = parseTool(row, this.config.name);
        if (tool) tools.push(tool);
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const result = await this.request("tools/call", { name, arguments: input }, this.config.timeoutMs, signal);
    return toolText(result);
  }

  async close() {
    if (!this.termination && !this.closed) {
      this.fail(`The ${this.config.name} MCP server was closed.`);
      try { this.child.stdin.end(); } catch { /* closed */ }
      this.termination = terminateTree(this.child);
    }
    await this.termination;
  }
}

class HttpExchange implements Exchange {
  private sessionId?: string;
  private protocol = PROTOCOL_VERSION;
  private nextId = 1;
  private closed = false;

  private constructor(private readonly config: McpServerConfig) {}

  static async start(config: McpServerConfig): Promise<HttpExchange> {
    const exchange = new HttpExchange(config);
    try {
      await exchange.initialize();
      return exchange;
    } catch (error) {
      await exchange.close();
      throw error;
    }
  }

  private headers(): Record<string, string> {
    return {
      ...this.config.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      "mcp-protocol-version": this.protocol,
    };
  }

  private async post(body: JsonRpc, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(this.config.url ?? "", { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: combined });
    } catch (error) {
      if (signal?.aborted) throw new Error("The turn was stopped.");
      if (timeout.aborted) throw new Error(`${this.config.name} did not answer in ${Math.round(timeoutMs / 1000)}s.`);
      throw new Error(`Could not reach ${this.config.name}: ${messageOf(error)}`);
    }
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? ` Add an Authorization header to ${this.config.name}.headers if the server needs one.` : "";
      const detail = bounded(await readBoundedResponse(response, this.config.name), 500).trim();
      throw new Error(`${this.config.name} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}${hint}`);
    }
    return response;
  }

  private async initialize() {
    const params = (version: string) => ({ protocolVersion: version, capabilities: {}, clientInfo: { name: "Glitter Harness", version: "0.1.0" } });
    let result: Json;
    try {
      result = await this.rpc("initialize", params(PROTOCOL_VERSION), CONNECT_TIMEOUT_MS) as Json;
    } catch (error) {
      if (!/protocol|version/i.test(messageOf(error))) throw error;
      result = await this.rpc("initialize", params(FALLBACK_PROTOCOL_VERSION), CONNECT_TIMEOUT_MS) as Json;
    }
    this.protocol = typeof result?.protocolVersion === "string" ? result.protocolVersion : FALLBACK_PROTOCOL_VERSION;
    await this.notify("notifications/initialized");
  }

  private async rpc(method: string, params: Json, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) throw new Error(`The ${this.config.name} MCP server is closed.`);
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
    try {
      const session = response.headers.get("mcp-session-id");
      if (session) this.sessionId = session;
      const type = response.headers.get("content-type") ?? "";
      let message: JsonRpc | undefined;
      if (type.includes("text/event-stream")) message = await this.readEvent(response, id);
      else {
        const text = await readBoundedResponse(response, this.config.name);
        let body: unknown = null;
        try { body = JSON.parse(text); } catch { /* answered with no JSON message */ }
        const rows = Array.isArray(body) ? body : [body];
        message = rows.find((row): row is JsonRpc => isRecord(row) && Number(row.id) === id);
      }
      if (!message) throw new Error(`${this.config.name} closed the response before answering ${method}.`);
      if (message.error) throw new Error(`${this.config.name}: ${message.error.message ?? "the MCP server returned an error"}`);
      return message.result;
    } catch (error) {
      if (signal?.aborted) throw new Error("The turn was stopped.");
      throw error;
    }
  }

  private async readEvent(response: Response, id: number): Promise<JsonRpc | undefined> {
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let received = 0;
    try {
      const declared = Number(response.headers.get("content-length"));
      if (declared > MAX_MCP_MESSAGE_BYTES) throw messageTooLarge(this.config.name, "response");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_MCP_MESSAGE_BYTES) throw messageTooLarge(this.config.name, "response");
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const parsed: unknown = JSON.parse(data);
            if (!isRecord(parsed)) continue;
            const message = parsed as JsonRpc;
            if (Number(message.id) === id) return message;
          } catch { /* not a JSON frame */ }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return undefined;
  }

  private async notify(method: string, params?: Json) {
    try { await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, CONNECT_TIMEOUT_MS); } catch { /* initialized is advisory */ }
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES && tools.length < MAX_TOOLS_PER_SERVER; page += 1) {
      const result = await this.rpc("tools/list", cursor ? { cursor } : {}, CONNECT_TIMEOUT_MS, signal) as Json;
      for (const row of Array.isArray(result?.tools) ? result.tools : []) {
        if (tools.length >= MAX_TOOLS_PER_SERVER) break;
        const tool = parseTool(row, this.config.name);
        if (tool) tools.push(tool);
      }
      cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
    const result = await this.rpc("tools/call", { name, arguments: input }, this.config.timeoutMs, signal);
    return toolText(result);
  }

  async close() {
    this.closed = true;
  }
}

function parseTool(row: unknown, server: string): McpTool | undefined {
  if (!isRecord(row)) return undefined;
  const name = str(row.name).trim();
  if (!name || name.length > 128) return undefined;
  const description = str(row.description).trim().replace(/\s+/g, " ").slice(0, MAX_TOOL_DESCRIPTION);
  const inputSchema = isRecord(row.inputSchema) ? row.inputSchema : { type: "object", properties: {} };
  return Object.freeze({ name, description, inputSchema });
}

type McpConnection = Readonly<{ config: McpServerConfig; exchange: Exchange; tools: McpTool[] }>;

type Generation = {
  fingerprint: string;
  servers: McpConnection[];
  skipped: Array<{ name: string; transport: McpTransport; tools: 0; skipped: true; reason: string }>;
  /** Model-facing name to the server's own tool. */
  byName: Map<string, { server: string; tool: McpTool; definition: ToolDefinition }>;
  definitions: ToolDefinition[];
  refs: number;
  retired: boolean;
};

function generationTools(servers: McpConnection[]): Generation["byName"] {
  const byName = new Map<string, { server: string; tool: McpTool; definition: ToolDefinition }>();
  for (const { config, exchange, tools } of servers) {
    for (const tool of tools) {
      const name = mcpToolName(config.name, tool.name);
      if (byName.has(name)) throw new Error(`MCP tool name ${name} is produced twice; the generation was not swapped in.`);
      const definition: ToolDefinition = {
        schema: {
          name,
          description: `${tool.description || tool.name} (MCP server ${config.name}.)`.slice(0, MAX_TOOL_DESCRIPTION + 100),
          parameters: tool.inputSchema,
        },
        kind: "mcp",
        // Listed by tool_search instead of in every request; the prompt names
        // only the servers and a few tools.
        deferred: true,
        // MCP tools are external and unauditable: every call needs approval
        // unless a thread grant names this tool or server.
        subject: (): Subject => ({ kind: "mcp", server: config.name, tool: tool.name }),
        run: async (_root, input, signal): Promise<ToolProduced> => {
          const result = await exchange.callTool(tool.name, input, signal);
          return { value: { kind: "mcp", server: config.name, tool: tool.name, text: result.text, ...(result.isError ? { isError: true } : {}) } };
        },
      };
      byName.set(name, { server: config.name, tool, definition });
    }
  }
  return byName;
}

function searchTool(generation: Generation): ToolDefinition {
  return {
    schema: {
      name: "tool_search",
      description: "Find MCP tools by what they do and load their argument schemas. Pass a query, a server name, or both. The matching tools become callable on your next step.",
      parameters: { type: "object", properties: { query: { type: "string", description: "What you need to do, or words from a tool's name or description." }, server: { type: "string", description: "Only search this MCP server." } } },
    },
    kind: "read",
    concurrencySafe: true,
    run: (_root, input) => {
      const query = str(input.query).trim().toLowerCase();
      const server = str(input.server).trim();
      const words = query.split(/\s+/).filter(Boolean);
      const all = [...generation.byName.entries()].map(([name, row]) => ({ name, ...row }));
      const matches = all.filter((row) => (!server || row.server === server) && words.every((word) => `${row.name} ${row.tool.name} ${row.tool.description} ${row.server}`.toLowerCase().includes(word)));
      const picked = matches.slice(0, MAX_SEARCH_RESULTS);
      const lines = picked.map((row) => {
        const schema = bounded(JSON.stringify(row.tool.inputSchema), 4_000);
        return `${row.name} — ${row.tool.description || row.tool.name} (MCP server ${row.server})\nArguments: ${schema}`;
      });
      const more = matches.length > picked.length ? `\n… ${matches.length - picked.length} more match; narrow the query.` : "";
      return {
        value: { kind: "read", path: "MCP tools", lines: `${lines.join("\n\n") || "No MCP tools match that query."}${more}`, offset: 1 },
        activate: picked.map((row) => row.name),
      };
    },
  };
}

function generationPrompt(generation: Generation): string | undefined {
  if (!generation.servers.length) return undefined;
  const rows = generation.servers.map(({ config, tools }) => {
    const names = tools.slice(0, MAX_PROMPT_NAMES).map((tool) => tool.name);
    return `- ${config.name} (${tools.length} tool${tools.length === 1 ? "" : "s"}): ${names.join(", ")}${tools.length > names.length ? ", …" : ""}`;
  });
  return [
    "MCP servers are connected. Their tools are not loaded into this request: call tool_search with what you need (or a server name) to load a tool's arguments, then call the mcp__server__tool it names. This is the complete list of connected servers for this turn; it replaces any earlier MCP list.",
    rows.join("\n"),
  ].join("\n\n");
}

/**
 * The extension that turns a workspace's current MCP generation into tools,
 * a deferred-search tool and a prompt section. A turn acquires the generation
 * when its snapshot is taken; a swapped generation is closed once the turns
 * still using it finish.
 */
export function mcpExtension(manager: McpManager): Extension {
  const perTurn = new WeakMap<TurnContext, Generation | null>();
  return {
    id: "mcp",
    tools: [(context) => {
      // A delegated child's profile keeps the built-ins only; it must not hold
      // a generation open or advertise tools it cannot call.
      if (context.delegationDepth > 0 || context.mode === "plan") return undefined;
      const generation = manager.acquire(context);
      if (!generation) return undefined;
      perTurn.set(context, generation);
      // Revoking the last server leaves an empty generation: no tools at all,
      // rather than a search tool that can never find anything.
      if (!generation.definitions.length) return undefined;
      return [...generation.definitions, searchTool(generation)];
    }],
    prompt: [{ placement: "stable", text: (context) => {
      if (context.delegationDepth > 0 || context.mode === "plan") return undefined;
      const generation = perTurn.get(context) ?? manager.acquire(context);
      return generation ? generationPrompt(generation) : undefined;
    } }],
    hooks: {
      turnFinished: ({ context }) => { manager.release(context); },
    },
  };
}

type SyncNotice = { sessionId?: string; level: "warning" | "info"; message: string };
type Emit = (event: string, payload: unknown) => void;

export type McpAuthorization = {
  workspaceTrusted: boolean;
  configurationDigest?: string;
  homeConfigurationDigest?: string;
};

export class McpManager {
  private readonly generations = new Map<string, Generation>();
  private readonly syncing = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  private readonly acquired = new WeakMap<TurnContext, Generation | null>();
  /** Swapped-out generations still held by a running turn; `close()` reaps them too. */
  private readonly retired = new Set<Generation>();

  constructor(private readonly homeDir: string, private readonly emit: Emit) {}

  /** The generation a turn is using, acquired once per turn context. */
  acquire(context: TurnContext): Generation | null {
    if (this.acquired.has(context)) return this.acquired.get(context) ?? null;
    const generation = this.generations.get(context.sessionId) ?? null;
    if (generation) generation.refs += 1;
    this.acquired.set(context, generation);
    return generation;
  }

  release(context: TurnContext) {
    if (!this.acquired.has(context)) return;
    const generation = this.acquired.get(context);
    this.acquired.delete(context);
    if (!generation) return;
    generation.refs = Math.max(0, generation.refs - 1);
    if (generation.retired && generation.refs === 0) void this.closeGeneration(generation);
  }

  status(sessionId: string): McpStatus {
    const generation = this.generations.get(sessionId);
    return {
      servers: generation ? [...generation.servers.map(({ config, tools }) => ({ name: config.name, transport: config.transport, tools: tools.length })), ...generation.skipped] : [],
      error: this.errors.get(sessionId) ?? null,
    };
  }

  /** Sync this session. Config or consent failure disables future-turn MCP rather than retaining an old grant. */
  async ensure(workspaceRoot: string, authorization: McpAuthorization, sessionId: string, force = false): Promise<void> {
    const running = this.syncing.get(sessionId);
    if (running) await running;
    const run = this.reconcile(workspaceRoot, authorization, sessionId, force).finally(() => {
      if (this.syncing.get(sessionId) === run) this.syncing.delete(sessionId);
    });
    this.syncing.set(sessionId, run);
    await run;
  }

  private retire(sessionId: string) {
    const previous = this.generations.get(sessionId);
    if (!previous) return;
    this.generations.delete(sessionId);
    previous.retired = true;
    this.retired.add(previous);
    if (previous.refs === 0) void this.closeGeneration(previous);
  }

  private async reconcile(workspaceRoot: string, authorization: McpAuthorization, sessionId: string, force = false) {
    let servers: McpServerConfig[];
    let skipped: Generation["skipped"] = [];
    let configFingerprint: string;
    try {
      const fingerprints = await mcpConfigFingerprints(workspaceRoot, this.homeDir);
      configFingerprint = fingerprints.configurationDigest;
      const read = await readMcpServers(workspaceRoot, this.homeDir, authorization.workspaceTrusted);
      const homeApproved = fingerprints.homeConfigurationDigest !== undefined && fingerprints.homeConfigurationDigest === authorization.homeConfigurationDigest;
      const workspaceApproved = authorization.workspaceTrusted && fingerprints.configurationDigest === authorization.configurationDigest;
      skipped = read.servers.filter((config) => read.sources[config.name] === "workspace" ? !workspaceApproved : !homeApproved).map((config) => ({ name: config.name, transport: config.transport, tools: 0 as const, skipped: true as const, reason: "Startup configuration has not been trusted and approved." }));
      const denied = new Set(skipped.map((config) => config.name));
      servers = read.servers.filter((config) => !denied.has(config.name));
      if (skipped.length) {
        this.notice({ sessionId, level: "info", message: `${skipped.map((config) => config.name).join(", ")}: MCP startup was skipped because its configuration has not been trusted and approved. Review it in Settings → Extensions.` }, true);
      }
    } catch (error) {
      this.retire(sessionId);
      this.report(sessionId, messageOf(error));
      return;
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ configFingerprint, workspaceTrusted: authorization.workspaceTrusted, configurationDigest: authorization.configurationDigest, homeConfigurationDigest: authorization.homeConfigurationDigest, servers, skipped })).digest("hex");
    const current = this.generations.get(sessionId);
    if (!force && current?.fingerprint === fingerprint) {
      this.errors.delete(sessionId);
      return;
    }
    // A changed config or authorization invalidates the old tools immediately.
    // A running turn can finish its snapshot, but a failed refresh cannot leave
    // that generation available to the next turn.
    this.retire(sessionId);
    const built: Exchange[] = [];
    for (const config of servers) diagnostics.rememberValues([...Object.values(config.env), ...Object.values(config.headers)]);
    const starts = servers.map(async (config): Promise<McpConnection> => {
      const exchange = config.transport === "stdio"
        ? await StdioExchange.start(config, workspaceRoot)
        : await HttpExchange.start(config);
      built.push(exchange);
      return { config, exchange, tools: await exchange.listTools() };
    });
    try {
      const connections = await Promise.all(starts);
      const byName = generationTools(connections);
      const generation: Generation = {
        fingerprint,
        servers: connections,
        skipped,
        byName,
        definitions: [...byName.values()].map((row) => row.definition),
        refs: 0,
        retired: false,
      };
      this.generations.set(sessionId, generation);
      this.errors.delete(sessionId);
      if (connections.length) this.notice({ sessionId, level: "info", message: `MCP is ready: ${generation.servers.length} server${generation.servers.length === 1 ? "" : "s"}, ${generation.definitions.length} tool${generation.definitions.length === 1 ? "" : "s"}.` }, false);
    } catch (error) {
      // A start that was still in flight when another failed has no generation
      // to belong to. Let every start settle, then close all that connected.
      await Promise.allSettled(starts);
      await Promise.allSettled(built.map((exchange) => exchange.close()));
      this.report(sessionId, messageOf(error));
    }
  }

  private report(sessionId: string, message: string) {
    const text = `${diagnostics.text(message)} No MCP tools are available.`;
    // Report a change, not the same failure once per turn.
    if (this.errors.get(sessionId) === text) return;
    this.errors.set(sessionId, text);
    this.notice({ sessionId, level: "warning", message: `MCP sync failed: ${text}` }, Boolean(sessionId));
  }

  private notice(notice: SyncNotice, warn: boolean) {
    if (!warn) return; // success is silent; the files are the source of truth
    this.emit("agentNotice", { ...(notice.sessionId ? { sessionId: notice.sessionId } : {}), level: notice.level, message: notice.message });
  }

  private async closeGeneration(generation: Generation) {
    await Promise.allSettled(generation.servers.map(({ exchange }) => exchange.close()));
    this.retired.delete(generation);
  }

  async closeSession(sessionId: string) {
    await this.syncing.get(sessionId);
    this.retire(sessionId);
    this.errors.delete(sessionId);
  }

  async close() {
    await Promise.allSettled([...this.generations.values(), ...this.retired].map((generation) => this.closeGeneration(generation)));
    this.generations.clear();
  }
}
