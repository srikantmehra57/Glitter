/**
 * Child-process isolation for the processes the Harness starts: shell
 * commands and stdio MCP servers (SEC-03 / SEC-04 / SEC-05).
 *
 * The agent process never forwards the inherited desktop environment
 * wholesale. A child starts in a confined cwd, a process group we can reap,
 * and — when the platform can enforce it — a write-scoped OS sandbox.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
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

export type IsolationReport = {
  env: "minimal";
  osSandbox: "enforced" | "unavailable" | "cli-managed";
  platform: NodeJS.Platform;
  cwd: string;
  consentRequired: boolean;
};

/** Drop inherited secrets; keep PATH/HOME and the other base keys. */
export function filterChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value == null || value === "") continue;
    if (key === "NODE_OPTIONS") continue;
    if (BASE_ENV_KEYS.has(key)) env[key] = value;
  }
  return env;
}

export type SandboxBackend = "seatbelt" | "none";

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

/**
 * A read deny may hide one folder. It must not hide `/`, the home directory,
 * or temp: those are where the process itself reads its binary, config, and
 * runtime files. A folder *inside* temp (a test workspace) is still deniable.
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

function writeRoots(extra: string[]): string[] {
  const home = homedir();
  const tmp = tmpdir();
  return [
    ...extra, tmp, "/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp",
    join(home, ".cache"), join(home, "Library", "Caches"),
  ];
}

/**
 * Outbound network stays on this Mac: loopback (local dev servers, test
 * databases) and Unix sockets (name lookup) only. Binding a local port is
 * unaffected, so a dev server still starts.
 */
const NETWORK_OFF = `(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-outbound (remote unix-socket))\n`;

/**
 * Cloud and registry tokens that offline work never reads. A command without
 * the network cannot read them either, so injected text cannot print a token
 * into the model's context. SSH and GPG keys, `.npmrc`, Docker and kube config
 * stay readable: signed commits, installs from a local cache and local
 * clusters read them without going online.
 */
export function credentialRoots(home = homedir()): string[] {
  return [
    ".aws", ".azure", ".config/gcloud", ".config/gh", ".config/hub", ".netrc", ".git-credentials", ".pypirc",
    ".gem/credentials", ".cargo/credentials", ".cargo/credentials.toml", ".terraform.d", "Library/Keychains",
  ].map((path) => join(home, path));
}

/** Writes are allowed only under the extra roots (the workspace) and temp/cache folders. */
export function buildSeatbeltProfile(extraRoots: string[] = [], denyReadRoots: string[] = [], network = true): string {
  const networkRule = network ? "" : NETWORK_OFF;
  const readDeny = canonicalRoots(denyReadRoots.filter(safeDenyRoot)).map(seatbeltPath).join(" ");
  const readRule = readDeny ? `(deny file-read-data ${readDeny})\n` : "";
  const writes = canonicalRoots(writeRoots(extraRoots)).map(seatbeltPath).join(" ");
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write-data (regex #"^/dev/"))\n(allow file-write* ${writes})\n${readRule}${networkRule}`;
}

export type WrappedCommand = { command: string; args: string[]; sandboxed: boolean };

/** Prefix a command with seatbelt when this Mac can enforce it. */
export function wrapSandboxedCommand(
  bin: string,
  args: string[],
  options: { extraRoots?: string[]; denyReadRoots?: string[]; backend?: SandboxBackend; network?: boolean } = {},
): WrappedCommand {
  const backend = options.backend ?? sandboxBackend();
  if (backend === "seatbelt") {
    return {
      command: "/usr/bin/sandbox-exec",
      args: ["-p", buildSeatbeltProfile(options.extraRoots ?? [], options.denyReadRoots ?? [], options.network !== false), bin, ...args],
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
  options: { workspace?: string; sandbox?: boolean; env?: NodeJS.ProcessEnv; extraEnv?: NodeJS.ProcessEnv; denyReadRoots?: string[]; cwd?: string; network?: boolean } = {},
): IsolatedSpawn {
  const cwd = options.cwd ?? confinedCwd(options.workspace);
  // `extraEnv` is configuration the user wrote for this child (an MCP server's
  // own credentials), not the inherited environment. It is merged explicitly
  // after the scrub; NODE_OPTIONS stays out either way.
  const extra: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) {
    if (key !== "NODE_OPTIONS" && typeof value === "string" && value !== "") extra[key] = value;
  }
  const env = { ...filterChildEnv(options.env ?? process.env), ...extra, NODE_NO_WARNINGS: "1" };
  // Sandboxed even without a workspace: writes are then confined to temp and
  // cache roots, never the whole user account.
  const wrapped = options.sandbox !== false
    ? wrapSandboxedCommand(bin, args, {
      extraRoots: options.workspace ? [options.workspace] : [],
      denyReadRoots: options.denyReadRoots,
      network: options.network,
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
