import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

/** True for a path that cannot escape the fixture root. */
export function safeRelative(path) {
  if (typeof path !== "string" || !path.trim() || isAbsolute(path)) return false;
  const normalized = normalize(path);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith(`..${sep}`);
}

export async function setupTask(root, task) {
  for (const [path, content] of Object.entries(task.setup ?? {})) {
    if (!safeRelative(path)) throw new Error(`Unsafe setup path in ${task.id}: ${path}`);
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

function commandDetail(result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const tail = output.length > 600 ? `…${output.slice(-600)}` : output;
  return `exit ${result.status ?? "unknown"}${result.error ? ` (${result.error.message})` : ""}${tail ? `: ${tail}` : ""}`;
}

async function fileCheck(root, check) {
  let text;
  try {
    text = await readFile(join(root, check.path), "utf8");
  } catch {
    return { kind: "file", ok: false, detail: `${check.path} is missing` };
  }
  if (check.equals !== undefined && text !== check.equals) return { kind: "file", ok: false, detail: `${check.path} does not equal the expected text` };
  if (check.contains !== undefined && !text.includes(check.contains)) return { kind: "file", ok: false, detail: `${check.path} does not contain ${JSON.stringify(check.contains)}` };
  if (check.notContains !== undefined && text.includes(check.notContains)) return { kind: "file", ok: false, detail: `${check.path} still contains ${JSON.stringify(check.notContains)}` };
  return { kind: "file", ok: true, detail: check.path };
}

async function pathCheck(root, check) {
  try {
    await stat(join(root, check.path));
    return { kind: "path", ok: true, detail: check.path };
  } catch {
    return { kind: "path", ok: false, detail: `${check.path} is missing` };
  }
}

/** Run every check in the fixture. Commands run with the fixture as their cwd. */
export async function runChecks(root, task, options = {}) {
  const timeoutMs = options.commandTimeoutMs ?? 60_000;
  const results = [];
  for (const check of task.checks ?? []) {
    if (check.kind === "file") {
      results.push(await fileCheck(root, check));
    } else if (check.kind === "path") {
      results.push(await pathCheck(root, check));
    } else if (check.kind === "command") {
      const [program, ...args] = check.command;
      const env = { ...process.env, ...(check.env ?? {}) };
      // A command check may run from inside this repo's own node:test run; the
      // child runner must not inherit the parent's test context.
      delete env.NODE_TEST_CONTEXT;
      const result = (options.commandRunner ?? spawnSync)(program, args, { cwd: root, encoding: "utf8", timeout: check.timeoutMs ?? timeoutMs, maxBuffer: 1_000_000, env });
      const expected = check.expectExit ?? 0;
      results.push({ kind: "command", ok: !result.error && result.status === expected, detail: `${check.command.join(" ")}: ${commandDetail(result)}` });
    }
  }
  return results;
}

export function checksSummary(results) {
  const passed = results.filter((result) => result.ok).length;
  return `${passed}/${results.length}`;
}
