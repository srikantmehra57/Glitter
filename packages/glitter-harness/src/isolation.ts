/**
 * Child-process isolation for the processes the Harness starts: shell
 * commands and stdio MCP servers (SEC-03 / SEC-04 / SEC-05).
 *
 * The agent process never forwards the inherited desktop environment
 * wholesale. A child starts in a confined cwd, a process group we can reap,
 * and — when the platform can enforce it — a write-scoped OS sandbox.
 */

import { DEFAULT_PROTECTED_PATHS, protectedSeatbeltRules } from "./harness/permission/protected.js";
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";

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
  "JAVA_HOME", "JDK_HOME", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT",
  "PYENV_ROOT", "PYENV_VERSION", "RBENV_ROOT", "RBENV_VERSION", "BUN_INSTALL", "NVM_DIR",
  "VOLTA_HOME", "ASDF_DATA_DIR", "MISE_DATA_DIR", "VIRTUAL_ENV", "CONDA_PREFIX",
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
 * Share package data, not whole toolchain homes: those also hold configuration,
 * credentials and binaries on PATH. Resolve only the home, never a cache
 * symlink: following ~/.npm into another folder must not grant that folder on
 * the next spawn. Parent directories may be created, but not replaced or moved.
 */
export function packageCacheRules(home = homedir()): string {
  let base = home;
  try { base = realpathSync(home); } catch { /* not created yet */ }
  const caches = [
    ".npm", ".cargo/registry", ".cargo/git", ".gradle/caches", ".gradle/daemon",
    ".gradle/native", ".gradle/notifications", ".gradle/wrapper", ".m2/repository",
    "go/pkg", ".bun/install/cache", ".yarn/berry/cache",
  ].map((path) => join(base, path));
  // Cargo silently falls back to an unlocked/read-only cache if these fail.
  // SQLite may use either a rollback journal or WAL sidecars.
  const files = [".package-cache", ".package-cache-mutate", ".global-cache", ".global-cache-journal", ".global-cache-shm", ".global-cache-wal"]
    .map((name) => `(literal ${seatbeltString(join(base, ".cargo", name))})`);
  const parents = new Set<string>();
  for (const cache of caches) {
    for (let parent = dirname(cache); parent !== base && parent !== dirname(parent); parent = dirname(parent)) parents.add(parent);
  }
  const create = [...parents].map((path) => `(require-all (literal ${seatbeltString(path)}) (vnode-type DIRECTORY))`).join(" ");
  return `(allow file-write* ${[...caches.map(seatbeltPath), ...files].join(" ")})\n(allow file-write-create ${create})\n`;
}

/**
 * What an "offline" command may still reach: this Mac only.
 *
 * - Loopback (`localhost:*`), so a dev server, a test database or a browser the
 *   command starts can talk to itself. Binding a local port is unaffected.
 * - Unix sockets only under the folders the sandbox may write (the workspace,
 *   temp, caches) and the GPG agent's folder. Local tools put their sockets
 *   there: a test database, the ssh agent under /private/tmp, gpg-agent.
 *
 * Every other socket is refused. `/var/run/mDNSResponder` is the one that
 * mattered: it answers any name lookup, so a command could send data out as a
 * hostname through the system resolver even though it had no route. With it
 * closed an external name fails at once, `localhost` and `/etc/hosts` names
 * still resolve (they never needed it), and this Mac's own `.local` name does
 * not. The Docker socket is refused for the same reason: a container has the
 * network. Loopback itself stays open on purpose; a local proxy or a published
 * container port the user runs is reachable from it.
 */
function networkOff(socketRoots: string[]): string {
  return `(deny network-outbound)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-outbound ${socketRoots.map(seatbeltPath).join(" ")})\n`;
}

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
    // Private keys. Their `.pub` halves, known_hosts and ssh config sit beside them and are not needed
    // without a network either. The agents (ssh-agent, gpg-agent) sign without the shell reading a key.
    ".ssh", ".gnupg/private-keys-v1.d", ".gnupg/secring.gpg",
  ].map((path) => join(home, path));
}

/** The Glitter identifier the app's data folder is named for; `cli/config.ts` holds the same constant. */
const APP_IDENTIFIER = "com.glitter.desktop";

/**
 * The saved threads of every workspace: the app's session logs, and the CLI's
 * when it runs without the app. A command in one workspace has no use for the
 * conversations of the others, and reading them would hand another project's
 * private history to this one's model. Worktrees live beside these, not in them.
 */
export function sessionLogRoots(env: NodeJS.ProcessEnv = process.env, home = homedir(), platform = process.platform): string[] {
  const data = platform === "darwin" ? join(home, "Library", "Application Support") : env.XDG_DATA_HOME || join(home, ".local", "share");
  return [...new Set([env.GLITTER_HARNESS_DIR || join(home, ".glitter", "harness"), join(data, APP_IDENTIFIER, "harness")])];
}

function seatbeltString(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function regexEscape(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/"]/g, "\\$&");
}

/**
 * The files that decide what git runs and where its settings come from, under
 * each writable workspace root. The app's own git (status refresh, commit,
 * push) reads them with the user's authority, and so does the user's terminal,
 * so a command in the sandbox must not be able to plant a hook, a filter
 * driver or a redirect there: `.git` itself (it cannot be replaced, renamed or
 * created, so `git init` at the root is the user's to run), its `config`,
 * `config.worktree` and `commondir`, its hooks, and the same redirects for each
 * linked worktree. Objects, refs and the index stay writable, so `git add` and
 * `git commit` still work. Seatbelt resolves paths the way APFS does, so a
 * case variant such as `.GIT/config` is the same file and is denied too.
 */
export function gitControlRules(roots: string[]): string {
  const rules: string[] = [];
  for (const root of canonicalRoots(roots)) {
    const git = join(root, ".git");
    rules.push(`(literal ${seatbeltString(git)})`);
    for (const name of ["config", "config.worktree", "commondir"]) rules.push(`(literal ${seatbeltString(join(git, name))})`);
    rules.push(`(subpath ${seatbeltString(join(git, "hooks"))})`);
    rules.push(`(regex #"^${regexEscape(join(git, "worktrees"))}/[^/]+/(config\\.worktree|commondir|gitdir)$")`);
  }
  return rules.length ? `(deny file-write* ${rules.join(" ")})\n` : "";
}

/**
 * Writes are allowed only under the extra roots (the workspace) and temp/cache
 * folders and package caches, except the workspace's protected paths (Settings → Permissions;
 * the defaults when none are given) and its git control files. Seatbelt
 * applies the last matching rule, so each deny comes after the allow it
 * narrows, and the git rules come last so nothing gives them back.
 */
export function buildSeatbeltProfile(extraRoots: string[] = [], denyReadRoots: string[] = [], network = true, protectedPaths: readonly string[] = DEFAULT_PROTECTED_PATHS): string {
  const socketRoots = canonicalRoots([...writeRoots(extraRoots), join(homedir(), ".gnupg")]);
  const networkRule = network ? "" : networkOff(socketRoots);
  const readDeny = canonicalRoots(denyReadRoots.filter(safeDenyRoot)).map(seatbeltPath).join(" ");
  const readRule = readDeny ? `(deny file-read-data ${readDeny})\n` : "";
  const writes = canonicalRoots(writeRoots(extraRoots)).map(seatbeltPath).join(" ");
  return `(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write-data (regex #"^/dev/"))\n(allow file-write* ${writes})\n${packageCacheRules()}${protectedSeatbeltRules(canonicalRoots(extraRoots), protectedPaths)}${gitControlRules(extraRoots)}${readRule}${networkRule}`;
}

export type WrappedCommand = { command: string; args: string[]; sandboxed: boolean };

/** Prefix a command with seatbelt when this Mac can enforce it. */
export function wrapSandboxedCommand(
  bin: string,
  args: string[],
  options: { extraRoots?: string[]; denyReadRoots?: string[]; backend?: SandboxBackend; network?: boolean; protectedPaths?: readonly string[] } = {},
): WrappedCommand {
  const backend = options.backend ?? sandboxBackend();
  if (backend === "seatbelt") {
    return {
      command: "/usr/bin/sandbox-exec",
      // Every sandboxed child, the shell and a stdio MCP server alike, is kept out of the saved threads.
      args: ["-p", buildSeatbeltProfile(options.extraRoots ?? [], [...sessionLogRoots(), ...(options.denyReadRoots ?? [])], options.network !== false, options.protectedPaths), bin, ...args],
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
  options: { workspace?: string; sandbox?: boolean; env?: NodeJS.ProcessEnv; extraEnv?: NodeJS.ProcessEnv; denyReadRoots?: string[]; cwd?: string; network?: boolean; protectedPaths?: readonly string[] } = {},
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
      protectedPaths: options.protectedPaths,
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
  } catch (error) {
    if (wrapped.sandboxed) throw new Error("Could not start the sandbox; the command was not run.", { cause: error });
    throw error;
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

/**
 * Every process below `pid`, by parent links. One that started its own session
 * (`setsid`, a detached spawn) is outside the process group, so a group signal
 * misses it, but it keeps its parent until that parent exits: this has to run
 * while the tree is still alive.
 */
export function descendantsOf(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid="], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) { resolve([]); return; }
      const children = new Map<number, number[]>();
      for (const line of stdout.split("\n")) {
        const [child, parent] = line.trim().split(/\s+/).map(Number);
        if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
        children.set(parent, [...(children.get(parent) ?? []), child]);
      }
      const found: number[] = [];
      const queue = [pid];
      for (let next = queue.shift(); next !== undefined && found.length < 4096; next = queue.shift()) {
        for (const child of children.get(next) ?? []) {
          if (child === process.pid || found.includes(child)) continue;
          found.push(child);
          queue.push(child);
        }
      }
      resolve(found);
    });
  });
}

/**
 * Close stdin, SIGTERM the process group, then SIGKILL after a grace period.
 * Descendants that left the group are signalled too, so the command's own
 * processes do not outlive it holding its output.
 */
export function terminateTree(child: ChildProcess, graceMs = TREE_GRACE_MS): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const pid = child.pid;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result = { code: child.exitCode, signal: child.signalCode };
    const family = pid ? descendantsOf(pid) : Promise.resolve<number[]>([]);
    const signalFamily = (signal: NodeJS.Signals) => void family.then((list) => {
      for (const member of list) { try { process.kill(member, signal); } catch { /* gone */ } }
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signalFamily("SIGKILL");
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
    // The family is read before anything is signalled: once the leader dies its
    // children are reparented and the links that find them are gone.
    if (pid) void family.then(() => signalGroup(pid, "SIGTERM")).then((signalled) => {
      signalFamily("SIGTERM");
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
