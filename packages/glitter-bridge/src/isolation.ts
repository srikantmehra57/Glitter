/**
 * Child-process isolation for Muse and ACP agents (SEC-03 / SEC-04 / SEC-05).
 *
 * The bridge never forwards the inherited desktop environment wholesale.
 * ACP agents start in a confined cwd, a process group we can reap, and — when
 * the platform can enforce it — a write-scoped OS sandbox. If that sandbox
 * cannot be applied, callers must collect an informed opt-in before spawn.
 * Muse's MSP host manages its own shell sandbox and approvals instead.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

export const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const CANCEL_WAIT_MS = 2_000;
export const TREE_GRACE_MS = 1_500;
export const HOST_QUEUE_LIMIT = 16;
export const CREATE_CACHE_TTL_MS = 60_000;

/** Environment keys every child may inherit. Secrets and cloud creds stay out. */
export const BASE_ENV_KEYS = new Set([
  "PATH", "HOME", "USER", "LOGNAME",
  "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE", "TERM", "COLORTERM", "TZ",
  "SHELL",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
  "EDITOR", "VISUAL",
  "HOMEBREW_PREFIX", "HOMEBREW_CELLAR",
  "NODE_NO_WARNINGS",
]);

const PROVIDER_ENV: Record<string, (key: string) => boolean> = {
  muse: (key) => key === "META_API_KEY" || key.startsWith("MUSE_"),
  opencode: (key) => /^(OPENCODE_|ANTHROPIC_|OPENAI_|OPENROUTER_)/.test(key),
  grok: (key) => key === "XAI_API_KEY" || key.startsWith("GROK_"),
  gemini: (key) => key === "GEMINI_API_KEY" || key === "GOOGLE_API_KEY" || key === "GOOGLE_GENAI_API_KEY" || key.startsWith("GEMINI_"),
  qwen: (key) => key === "DASHSCOPE_API_KEY" || key === "QWEN_API_KEY" || key.startsWith("QWEN_") || key.startsWith("DASHSCOPE_"),
  goose: (key) => key.startsWith("GOOSE_"),
  cline: (key) => key.startsWith("CLINE_"),
};

export type IsolationReport = {
  env: "minimal";
  osSandbox: "enforced" | "unavailable" | "cli-managed";
  platform: NodeJS.Platform;
  cwd: string;
  consentRequired: boolean;
};

export function providerAllows(agentId: string | undefined, key: string): boolean {
  if (!agentId) return false;
  return PROVIDER_ENV[agentId]?.(key) === true;
}

/** Drop inherited secrets; keep PATH/HOME and the selected provider's keys. */
export function filterChildEnv(base: NodeJS.ProcessEnv, agentId?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null || value === "") continue;
    if (key === "NODE_OPTIONS") continue;
    if (BASE_ENV_KEYS.has(key) || providerAllows(agentId, key)) env[key] = value;
  }
  return env;
}

export type SandboxBackend = "seatbelt" | "none";
export type SandboxKind = "agent" | "muse";

let cachedBackend: SandboxBackend | undefined;

/** Which write-confinement wrapper this host can actually apply. */
export function sandboxBackend(): SandboxBackend {
  if (cachedBackend) return cachedBackend;
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) cachedBackend = "seatbelt";
  else cachedBackend = "none";
  return cachedBackend;
}

export function osSandboxAvailable(): boolean {
  return sandboxBackend() !== "none";
}

function seatbeltPath(path: string): string {
  return `(subpath "${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}")`;
}

/** Seatbelt matches the canonical path. /var on macOS is a symlink to /private/var. */
function canonicalRoots(paths: string[]): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    out.add(path);
    try { out.add(realpathSync(path)); } catch { /* not created yet */ }
  }
  return [...out];
}

function existingDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/**
 * A suggestion sandbox may hide one project folder. It must not hide `/`,
 * the home directory, or temp: those are where the process itself reads its
 * binary, config, and runtime files. A folder *inside* temp (a test
 * workspace) is still deniable.
 */
function safeDenyRoot(path: string): boolean {
  if (!path || path === "/" || path === "\\") return false;
  const normalized = path.endsWith(sep) ? path.slice(0, -1) : path;
  const banned = [homedir(), tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp", "/private/var/tmp"];
  return !banned.some((root) => {
    if (!root) return false;
    const base = root.endsWith(sep) ? root.slice(0, -1) : root;
    return normalized === base || base.startsWith(`${normalized}${sep}`);
  });
}

/** Config directories the process may still read after a workspace deny. Never a parent of the denied folder — a later allow of a parent would uncover it. */
function readableConfigExceptions(agentId: string, denied: string[]): string[] {
  return agentConfigDirs(agentId).filter((dir) => !denied.some((root) => {
    const base = root.endsWith(sep) ? root.slice(0, -1) : root;
    const config = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
    return config === base || config.startsWith(`${base}${sep}`) || base.startsWith(`${config}${sep}`);
  }));
}

/** Per-agent config directories. Parents such as `~/.config` stay off this list. */
function agentConfigDirs(agentId: string): string[] {
  const home = homedir();
  const scoped = (name: string, dot?: string) => [
    ...(dot ? [join(home, dot)] : []),
    join(home, ".config", name),
    join(home, ".local", "share", name),
    join(home, ".local", "state", name),
    join(home, "Library", "Application Support", name),
  ];
  if (agentId === "grok") return scoped("grok", ".grok");
  if (agentId === "opencode") return scoped("opencode", ".opencode");
  if (agentId === "gemini") return scoped("gemini", ".gemini");
  if (agentId === "qwen") return scoped("qwen", ".qwen");
  if (agentId === "goose") return scoped("goose");
  if (agentId === "cline") return scoped("cline", ".cline");
  if (agentId === "muse") return [join(home, ".muse"), join(home, ".config", "muse"), join(home, "Library", "Application Support", "muse")];
  return [];
}

function agentWriteRoots(agentId: string, extra: string[]): string[] {
  const home = homedir();
  const tmp = tmpdir();
  return [
    ...extra, tmp, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp",
    join(home, ".cache"), join(home, "Library", "Caches"),
    ...agentConfigDirs(agentId),
  ];
}

/**
 * Create allow-listed config directories before the sandbox is applied.
 *
 * The profile grants the agent directory and not its parent, so a folder that
 * does not exist yet cannot be created from inside seatbelt.
 */
export function ensureDirectories(paths: string[]): void {
  for (const dir of paths) {
    if (!dir || existingDir(dir)) continue;
    try { mkdirSync(dir, { recursive: true }); }
    catch { /* a root that cannot be prepared is omitted by the sandbox */ }
  }
}

/**
 * Muse `serve` writes whichever workspace the user opened, so its seatbelt
 * denies system locations instead of an allow-list of one folder. ACP agents
 * stay write-scoped to the workspace plus their config roots.
 */
export function buildSeatbeltProfile(kind: SandboxKind, agentId = "", extraRoots: string[] = [], denyReadRoots: string[] = []): string {
  const deniedReads = canonicalRoots(denyReadRoots.filter(safeDenyRoot));
  const readDeny = deniedReads.map(seatbeltPath).join(" ");
  // Last matching rule wins. Re-allowing config *after* the deny keeps the
  // agent's own files readable without uncovering the project: the allow is
  // only for paths that neither contain nor sit inside the denied folder.
  const readKeep = deniedReads.length
    ? canonicalRoots(readableConfigExceptions(agentId, deniedReads)).map(seatbeltPath).join(" ")
    : "";
  const readRule = readDeny
    ? `(deny file-read-data ${readDeny})\n${readKeep ? `(allow file-read-data ${readKeep})\n` : ""}`
    : "";
  if (kind === "muse") {
    const denied = ["/System", "/usr", "/bin", "/sbin", "/Library", "/etc", "/private/etc", "/boot"]
      .map(seatbeltPath).join(" ");
    const reallowed = canonicalRoots(["/usr/local", "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp", "/private/var/tmp", tmpdir(), ...extraRoots])
      .map(seatbeltPath).join(" ");
    return `(version 1)\n(allow default)\n(deny file-write* ${denied})\n(allow file-write* ${reallowed})\n(allow file-write-data (regex #"^/dev/"))\n${readRule}`;
  }
  const writes = canonicalRoots(agentWriteRoots(agentId, extraRoots)).map(seatbeltPath).join(" ");
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write-data (regex #"^/dev/"))\n(allow file-write* ${writes})\n${readRule}`;
}

export type WrappedCommand = { command: string; args: string[]; sandboxed: boolean };

/** Prefix a command with seatbelt when this Mac can enforce it. */
export function wrapSandboxedCommand(
  bin: string,
  args: string[],
  options: { kind?: SandboxKind; agentId?: string; extraRoots?: string[]; denyReadRoots?: string[]; backend?: SandboxBackend } = {},
): WrappedCommand {
  const kind = options.kind ?? "agent";
  const backend = options.backend ?? sandboxBackend();
  const extra = options.extraRoots ?? [];
  const agentId = options.agentId ?? "";
  const denyReadRoots = (options.denyReadRoots ?? []).filter(safeDenyRoot);
  if (kind === "agent" && agentId && backend === "seatbelt") {
    ensureDirectories(agentConfigDirs(agentId));
  }
  if (backend === "seatbelt") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", buildSeatbeltProfile(kind, agentId, extra, denyReadRoots), bin, ...args],
      sandboxed: true,
    };
  }
  return { command: bin, args, sandboxed: false };
}

export function confinedCwd(workspace?: string): string {
  if (workspace) {
    try {
      if (statSync(workspace).isDirectory()) return workspace;
    } catch {
      // Fall through to a throwaway directory rather than $HOME.
    }
  }
  return tmpdir();
}

export function describeIsolation(cwd: string, sandboxed: boolean): IsolationReport {
  const osSandbox = sandboxed ? "enforced" : "unavailable";
  return {
    env: "minimal",
    osSandbox,
    platform: process.platform,
    cwd,
    consentRequired: osSandbox !== "enforced",
  };
}

export type IsolatedSpawn = {
  child: ChildProcessWithoutNullStreams;
  isolation: IsolationReport;
};

export function spawnIsolated(
  bin: string,
  args: string[],
  options: { agentId?: string; workspace?: string; sandbox?: boolean; env?: NodeJS.ProcessEnv; extraEnv?: NodeJS.ProcessEnv; denyReadRoots?: string[]; cwd?: string } = {},
): IsolatedSpawn {
  const cwd = options.cwd ?? confinedCwd(options.workspace);
  // `extraEnv` is configuration the user wrote for this child (an MCP server's
  // own credentials), not the inherited environment. It is merged explicitly
  // after the scrub; NODE_OPTIONS stays out either way.
  const extra: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (key !== "NODE_OPTIONS" && typeof value === "string" && value !== "") extra[key] = value;
  }
  const env = { ...filterChildEnv(options.env ?? process.env, options.agentId), ...extra, NODE_NO_WARNINGS: "1" };
  const knownAgent = Boolean(options.agentId && ["muse", "opencode", "grok", "gemini", "qwen", "goose", "cline", "harness"].includes(options.agentId));
  // Known agents are sandboxed even without a workspace: a session-less start
  // (model listing before any thread is open) still confines writes to the
  // agent's config and temp roots, never the whole user account.
  const wantSandbox = options.sandbox !== false && knownAgent;
  const wrapped = wantSandbox
    ? wrapSandboxedCommand(bin, args, {
      kind: "agent",
      agentId: options.agentId,
      extraRoots: options.workspace ? [options.workspace] : [],
      denyReadRoots: options.denyReadRoots,
    })
    : { command: bin, args, sandboxed: false };
  const spawnOpts: SpawnOptions = {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  };
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(wrapped.command, wrapped.args, spawnOpts) as ChildProcessWithoutNullStreams;
  } catch {
    child = spawn(bin, args, spawnOpts) as ChildProcessWithoutNullStreams;
    wrapped.sandboxed = false;
  }
  return { child, isolation: describeIsolation(cwd, wrapped.sandboxed) };
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function signalGroup(pid: number, signal: NodeJS.Signals): Promise<boolean> {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Close stdin, SIGTERM the process group, then SIGKILL after a grace period. */
export function terminateTree(child: ChildProcess, graceMs = TREE_GRACE_MS): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const pid = child.pid;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result = { code: child.exitCode, signal: child.signalCode };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const arm = () => {
      if (settled || timer) return;
      timer = setTimeout(() => {
        const escalate = pid ? signalGroup(pid, "SIGKILL") : Promise.resolve().then(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
        void escalate.finally(finish);
      }, graceMs);
    };
    child.once("exit", (code, signal) => {
      result = { code, signal };
      // Leader exit is not tree exit: a descendant can still hold the group.
      if (!pid || !groupExists(pid)) finish();
      else arm();
    });
    try { child.stdin?.end(); } catch { /* closed */ }
    if (pid) void signalGroup(pid, "SIGTERM").then((signalled) => {
      if (settled) return;
      if (!signalled && !groupExists(pid)) finish();
      else arm();
    });
    else {
      try { child.kill("SIGTERM"); } catch { /* gone */ }
      arm();
    }
  });
}

/** Wall-clock expiry for the renderer's countdown and card copy. */
export function approvalExpiry(from = Date.now(), ttl = APPROVAL_TTL_MS): number {
  return from + ttl;
}

/** Monotonic expiry for enforcement; a wall-clock jump must not move it. */
export function approvalExpiryMono(from = performance.now(), ttl = APPROVAL_TTL_MS): number {
  return from + ttl;
}

export function approvalAlive(expiresAtMono: number, now = performance.now()): boolean {
  return now <= expiresAtMono;
}
