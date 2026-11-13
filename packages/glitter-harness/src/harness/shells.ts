import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
};

export type ShellRead = { id: string; command: string; output: string; running: boolean; exitCode?: number; missed: number };

const shells = new Map<string, BackgroundShell>();
let counter = 0;

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
  child.on("close", (code) => { shell.exitCode = code ?? 1; });
  child.on("error", () => { shell.exitCode ??= 127; });
  shells.set(shell.id, shell);
  return shell;
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
