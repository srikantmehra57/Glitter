import { statSync } from "node:fs";

/**
 * `<tool> --version` spawns the tool: tens of milliseconds when it is warm, and
 * several *seconds* the first time a large binary is paged in and
 * signature-checked. The desktop asks for detection at launch, on every rescan
 * and on every host status check, so the answer is kept per file identity.
 *
 * Two bounds keep it honest: the identity (inode, size, mtime, ctime) must be
 * unchanged, and the entry expires — a launcher script can start resolving to a
 * newer binary without itself changing, and a failed probe should be retried
 * soon rather than remembered as a fact.
 */
const SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;

type Entry = { print: string; value: string | null; expires: number };
const entries = new Map<string, Entry>();

function fingerprint(path: string): string | null {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch {
    return null;
  }
}

/** `undefined` means "unknown, probe it"; `null` means "probed, nothing usable". */
export function cachedProbe(path: string, now = performance.now()): string | null | undefined {
  const print = fingerprint(path);
  const hit = entries.get(path);
  if (!print || !hit || hit.print !== print || hit.expires <= now) return undefined;
  return hit.value;
}

export function rememberProbe(path: string, value: string | null, now = performance.now()) {
  const print = fingerprint(path);
  // A path that cannot be stat'ed has no identity to key on, so nothing is kept.
  if (!print) return;
  entries.set(path, { print, value, expires: now + (value === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS) });
}

/** Drop everything remembered (tests, and an explicit "look again"). */
export function forgetProbes() {
  entries.clear();
}

/** Drop one path: its binary was swapped out from under the cached print. */
export function forgetProbe(path: string) {
  entries.delete(path);
}
