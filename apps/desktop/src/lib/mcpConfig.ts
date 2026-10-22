import type { HarnessMcpConfigServer } from "./types";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Why a server name would be refused, or null when the bridge accepts it. */
export function mcpServerNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Give the server a name.";
  if (!NAME.test(trimmed)) return "Use letters, digits, dots, dashes or underscores, starting with a letter or digit (at most 64 characters).";
  return null;
}

/**
 * Split an argument line into tokens: whitespace separates, single and double
 * quotes group, and a backslash escapes the next character.
 */
export function parseMcpArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) { quote = null; continue; }
      if (char === "\\" && quote === '"' && index + 1 < text.length) { current += text[++index]; continue; }
      current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { args.push(current); current = ""; started = false; }
      continue;
    }
    if (char === "\\" && index + 1 < text.length) { current += text[++index]; started = true; continue; }
    current += char;
    started = true;
  }
  if (quote) throw new Error(`The arguments end inside ${quote === "'" ? "a single quote" : "a double quote"}.`);
  if (started) args.push(current);
  return args;
}

function separator(line: string): number {
  const equals = line.indexOf("=");
  const colon = line.indexOf(":");
  if (equals < 0) return colon;
  if (colon < 0) return equals;
  return Math.min(equals, colon);
}

/**
 * Read one `NAME=value` pair per line (a header may also use `Name: value`).
 * Blank lines and lines starting with `#` are skipped; repeated keys and
 * malformed names fail with the line number.
 */
export function parseMcpKeyValues(text: string, kind: "env" | "headers"): Record<string, string> {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  const pattern = kind === "env" ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[A-Za-z0-9-]+$/;
  const noun = kind === "env" ? "variable name" : "header name";
  const example = kind === "env" ? "NAME=value" : "Name=value or Name: value";
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const split = kind === "env" ? line.indexOf("=") : separator(line);
    if (split < 1) throw new Error(`Line ${index + 1}: use ${example}.`);
    const key = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (!pattern.test(key)) throw new Error(`Line ${index + 1}: “${key}” is not a valid ${noun}.`);
    if (!value) throw new Error(`Line ${index + 1}: give ${key} a value.`);
    if (seen.has(key)) throw new Error(`Line ${index + 1}: ${key} is listed twice.`);
    seen.add(key);
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** One line describing where a configured server points and what it carries. */
export function mcpServerSummary(server: HarnessMcpConfigServer): string {
  const parts = server.transport === "stdio"
    ? [server.command ?? "No command", `${server.args} argument${server.args === 1 ? "" : "s"}`]
    : [server.url ?? "No URL", `${server.headerKeys.length} header${server.headerKeys.length === 1 ? "" : "s"}`];
  if (server.transport === "stdio" && server.envKeys.length) parts.push(`${server.envKeys.length} env`);
  return parts.join(" · ");
}
