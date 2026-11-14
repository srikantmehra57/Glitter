import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { terminateTree } from "../isolation.js";

/**
 * Background shells: a command the agent starts and keeps running across
 * tool calls and turns, such as a dev server or a test watcher. Each belongs
 * to one session. Its output is kept in a bounded buffer the agent reads with
 * `bash_output`; a session's shells stop when the session closes or the
 * bridge stops, so nothing outlives the thread that started it.
 */

/** Per shell. Older output is dropped first and the reader is told how much. */
const BUFFER_MAX = 2 * 1024 * 1024;
/** A session cannot keep more than this many shells running. */
const PER_SESSION = 8;
/** An exited shell stays readable this long, then is forgotten so a long session does not collect them. */
const EXITED_TTL_MS = 15 * 60_000;
/** And no session keeps more than this many exited ones at once. */
const EXITED_KEEP = 8;

export type BackgroundShell = {
  id: string;
  sessionId: string;
  command: string;
  child: ChildProcessWithoutNullStreams;
  output: string;
  /** Characters dropped from the front of `output` so far. */
  dropped: number;
  /** Absolute offset (including dropped characters) the agent has read up to. */
  read: number;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
};

export type ShellRead = { id: string; command: string; output: string; running: boolean; exitCode?: number; missed: number };

const shells = new Map<string, BackgroundShell>();
let counter = 0;

/**
 * A process cannot be told to follow its parent into the grave, and a SIGKILL
 * of the agent skips every exit handler, so a dev server started by a shell
 * would run on with no thread to show it. A small watchdog holds the other end
 * of a pipe: when the agent's end closes for any reason, it kills the shells'
 * process groups. It is told each group as it starts and as it ends, so it never
 * signals a number that has been reused.
 */
const WATCHDOG = `
const groups = new Set();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at = buffer.indexOf("\\n"); at >= 0; at = buffer.indexOf("\\n")) {
    const [op, id] = buffer.slice(0, at).split(" ");
    buffer = buffer.slice(at + 1);
    const group = Number(id);
    if (!Number.isInteger(group) || group <= 1) continue;
    if (op === "add") groups.add(group); else groups.delete(group);
  }
});
process.stdin.on("end", () => {
  for (const group of groups) { try { process.kill(-group, "SIGKILL"); } catch {} }
  process.exit(0);
});
`;
let watchdog: ChildProcess | undefined;

function tell(op: "add" | "del", group: number | undefined): void {
  if (!group) return;
  try {
    if (!watchdog || watchdog.exitCode !== null || watchdog.killed) {
      watchdog = spawn(process.execPath, ["-e", WATCHDOG], { stdio: ["pipe", "ignore", "ignore"], detached: true });
      watchdog.on("error", () => { watchdog = undefined; });
      watchdog.stdin?.on("error", () => undefined);
      watchdog.unref();
      (watchdog.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    }
    watchdog.stdin?.write(`${op} ${group}\n`);
  } catch { /* the in-process exit handler below still covers an orderly exit */ }
}

// A crash skips the orderly stop. Each shell leads its own process group, so
// signal the groups synchronously on the way out rather than orphan a server.
process.once("exit", () => {
  for (const shell of shells.values()) {
    if (shell.exitCode !== undefined || !shell.child.pid) continue;
    try { process.kill(-shell.child.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

export function startShell(sessionId: string, command: string, spawn: () => ChildProcessWithoutNullStreams): BackgroundShell {
  const running = [...shells.values()].filter((shell) => shell.sessionId === sessionId && shell.exitCode === undefined);
  if (running.length >= PER_SESSION) throw new Error(`${PER_SESSION} background shells are already running in this thread. Stop one with kill_shell first.`);
  counter += 1;
  const child = spawn();
  child.stdin.end();
  const shell: BackgroundShell = { id: `bg-${counter}`, sessionId, command, child, output: "", dropped: 0, read: 0, startedAt: Date.now() };
  forgetExited(sessionId);
  tell("add", child.pid);
  const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
  const take = (decoder: StringDecoder) => (chunk: Buffer) => {
    shell.output += decoder.write(chunk);
    if (shell.output.length > BUFFER_MAX) {
      const cut = shell.output.length - BUFFER_MAX;
      shell.output = shell.output.slice(cut);
      shell.dropped += cut;
    }
  };
  child.stdout.on("data", take(decoders[0]));
  child.stderr.on("data", take(decoders[1]));
  const ended = () => {
    tell("del", child.pid);
    // The output stays readable for a while; then the shell is dropped from memory.
    const timer = setTimeout(() => { if (shells.get(shell.id) === shell) shells.delete(shell.id); }, EXITED_TTL_MS);
    timer.unref();
  };
  child.on("close", (code) => { if (shell.exitCode === undefined) ended(); shell.exitCode = code ?? 1; shell.endedAt = Date.now(); });
  child.on("error", () => { if (shell.exitCode === undefined) ended(); shell.exitCode ??= 127; shell.endedAt ??= Date.now(); });
  shells.set(shell.id, shell);
  return shell;
}

/** Drop a session's oldest exited shells beyond the number kept. */
function forgetExited(sessionId: string): void {
  const exited = [...shells.values()].filter((shell) => shell.sessionId === sessionId && shell.exitCode !== undefined).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (const shell of exited.slice(0, Math.max(0, exited.length - EXITED_KEEP + 1))) shells.delete(shell.id);
}

/** How many shells are held, exited or not. For tests and diagnostics. */
export function heldShells(): number {
  return shells.size;
}

function owned(id: string, sessionId: string): BackgroundShell {
  const shell = shells.get(id);
  if (!shell || shell.sessionId !== sessionId) throw new Error(`No background shell ${id} in this thread.`);
  return shell;
}

/** What the shell printed since the last read. `missed` counts output dropped before it could be read. */
export function readShell(id: string, sessionId: string): ShellRead {
  const shell = owned(id, sessionId);
  const start = Math.max(shell.read, shell.dropped);
  const missed = start - shell.read;
  const output = shell.output.slice(start - shell.dropped);
  shell.read = shell.dropped + shell.output.length;
  return { id, command: shell.command, output, running: shell.exitCode === undefined, ...(shell.exitCode !== undefined ? { exitCode: shell.exitCode } : {}), missed };
}

export async function killShell(id: string, sessionId: string): Promise<ShellRead> {
  const shell = owned(id, sessionId);
  if (shell.exitCode === undefined) await terminateTree(shell.child);
  const last = readShell(id, sessionId);
  shells.delete(id);
  return last;
}

export function listShells(sessionId: string): BackgroundShell[] {
  return [...shells.values()].filter((shell) => shell.sessionId === sessionId);
}

/** Stop every shell a session started. */
export async function stopSessionShells(sessionId: string): Promise<void> {
  await Promise.all(listShells(sessionId).map(async (shell) => {
    if (shell.exitCode === undefined) await terminateTree(shell.child).catch(() => undefined);
    shells.delete(shell.id);
  }));
}

export async function stopAllShells(): Promise<void> {
  await Promise.all([...shells.values()].map(async (shell) => {
    if (shell.exitCode === undefined) await terminateTree(shell.child).catch(() => undefined);
    shells.delete(shell.id);
  }));
}
