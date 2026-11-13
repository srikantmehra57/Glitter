import { closeSync, openSync, readSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Extension, TurnContext } from "./registry.js";
import type { ToolDefinition } from "./tools.js";

/**
 * Skills for the harness: a folder holding a `SKILL.md` whose frontmatter has
 * a `name` and a `description`. Progressive disclosure, as in the four
 * reviewed harnesses: a turn's system prompt carries only names and
 * descriptions, the `skill` tool loads a body when the model needs it, and the
 * same tool reads the other files in that skill's folder. The catalog is
 * rebuilt for every turn and replaces the previous one; it is never appended.
 *
 * Discovery is synchronous and bounded: it runs inside the turn snapshot, which
 * must not await, and it reads at most a small prefix of each `SKILL.md`.
 */

export type SkillScope = "project" | "user";
export type Skill = Readonly<{ name: string; description: string; scope: SkillScope; folder: string; label: string }>;

/** Nearest first: on a duplicate name the earlier root wins. */
const ROOTS: Array<{ path: string[]; scope: SkillScope }> = [
  { path: [".glitter", "skills"], scope: "project" },
  { path: [".agents", "skills"], scope: "project" },
  { path: [".glitter", "skills"], scope: "user" },
  { path: [".agents", "skills"], scope: "user" },
];

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SKILLS = 200;
const HEAD_BYTES = 16 * 1024;
const DESCRIPTION_CHARS = 1024;
const CATALOG_DESCRIPTION_CHARS = 400;
const CONTENT_CHARS = 100_000;
const ICON_BYTES = 256 * 1024;
/** Where a skill keeps its own logo when `agents/openai.yaml` names none. */
const ICON_FILES = ["assets/icon.png", "assets/logo.png", "assets/icon.svg", "assets/logo.svg", "icon.png", "logo.png"];

class SkillError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function realDirectory(path: string): string | null {
  try { return statSync(path).isDirectory() ? realpathSync(path) : null; } catch { return null; }
}

/** The first bytes of a file, enough for its frontmatter. */
function head(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

const unquote = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  return trimmed;
};

/**
 * The `key: value` pairs between the opening and closing `---`, and where the
 * body starts. Folded (`>`) and literal (`|`) block values are joined from
 * their indented lines. Anything else YAML allows is not needed here.
 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; bodyStart: number } | null {
  const source = text.replace(/^﻿/, "");
  const offset = text.length - source.length;
  const opening = /^---[ \t]*\r?\n/.exec(source);
  if (!opening) return null;
  const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(source.slice(opening[0].length));
  if (!closing) return null;
  const lines = source.slice(opening[0].length, opening[0].length + closing.index).split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(lines[index]);
    if (!match) continue;
    const [, key, raw] = match;
    const block = /^\s*([>|])[-+]?\s*$/.exec(raw);
    if (block) {
      const parts: string[] = [];
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || lines[index + 1].trim() === "")) parts.push(lines[(index += 1)].trim());
      fields[key] = (block[1] === ">" ? parts.join(" ").replace(/\s+/g, " ") : parts.join("\n")).trim();
    } else {
      fields[key] = unquote(raw);
    }
  }
  return { fields, bodyStart: offset + opening[0].length + closing.index + closing[0].length };
}

/** How a folder is named to the user and the model: workspace-relative, or under `~`. */
function labelFor(folder: string, workspace: string, home: string): string {
  if (inside(workspace, folder)) return relative(workspace, folder).split(sep).join("/");
  if (inside(home, folder)) return `~/${relative(home, folder).split(sep).join("/")}`;
  return folder;
}

/**
 * Every skill the workspace and the home folder provide, by name. A skill
 * without a description, with an invalid name, or whose folder or `SKILL.md`
 * resolves outside its root (a symlink out) is skipped.
 */
export function discoverSkills(workspaceRoot: string, homeDir: string): Skill[] {
  const workspace = realDirectory(workspaceRoot) ?? workspaceRoot;
  const home = realDirectory(homeDir) ?? homeDir;
  const found = new Map<string, Skill>();
  const seenRoots = new Set<string>();
  for (const root of ROOTS) {
    const base = realDirectory(join(root.scope === "project" ? workspace : home, ...root.path));
    // A workspace that is the home folder would list the same root twice.
    if (!base || seenRoots.has(base)) continue;
    seenRoots.add(base);
    let entries: string[];
    try { entries = readdirSync(base).sort((a, b) => a.localeCompare(b)); } catch { continue; }
    for (const entry of entries) {
      if (found.size >= MAX_SKILLS) break;
      if (entry.startsWith(".")) continue;
      const folder = realDirectory(join(base, entry));
      if (!folder || !inside(base, folder)) continue;
      let file: string;
      try { file = realpathSync(join(folder, "SKILL.md")); } catch { continue; }
      if (!inside(folder, file)) continue;
      let parsed: ReturnType<typeof parseFrontmatter>;
      try { parsed = parseFrontmatter(head(file)); } catch { continue; }
      const name = parsed?.fields.name?.trim() || entry;
      const description = parsed?.fields.description?.trim().replace(/\s+/g, " ") ?? "";
      if (!parsed || !NAME.test(name) || !description) continue;
      const key = name.toLowerCase();
      if (found.has(key)) continue;
      found.set(key, Object.freeze({ name, description: description.slice(0, DESCRIPTION_CHARS), scope: root.scope, folder, label: labelFor(folder, workspace, home) }));
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The `icon_large` and `icon_small` paths under `interface:` in a Codex `agents/openai.yaml`, large first. */
function interfaceIcons(text: string): string[] {
  const icons: Record<string, string> = {};
  let inInterface = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) { inInterface = /^interface:\s*$/.test(line); continue; }
    const match = inInterface ? /^\s+(icon_large|icon_small):(.*)$/.exec(line) : null;
    if (match) icons[match[1]] = unquote(match[2].replace(/\s+#.*$/, ""));
  }
  return [icons.icon_large, icons.icon_small].filter((path): path is string => Boolean(path));
}

/** A data URL for an image file inside the folder, sniffed from its bytes; null for anything else. */
function imageDataUrl(folder: string, path: string): string | null {
  let file: string;
  try { file = realpathSync(join(folder, path)); } catch { return null; }
  if (!inside(folder, file)) return null;
  try { if (!statSync(file).isFile() || statSync(file).size > ICON_BYTES) return null; } catch { return null; }
  let bytes: Buffer;
  try { bytes = readFileSync(file); } catch { return null; }
  let mime: string | null = null;
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) mime = "image/png";
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = "image/jpeg";
  else if (bytes.subarray(0, 4).toString("latin1") === "GIF8") mime = "image/gif";
  else if (bytes.length > 12 && bytes.subarray(8, 12).toString("latin1") === "WEBP") mime = "image/webp";
  else if (/\.svg$/i.test(file)) {
    const text = bytes.toString("utf8");
    // An image shows an SVG without the page's colour, so a `currentColor`
    // glyph would draw black; leave it to the generated tile.
    if (text.includes("<svg") && !/currentColor/i.test(text)) mime = "image/svg+xml";
  }
  return mime ? `data:${mime};base64,${bytes.toString("base64")}` : null;
}

/**
 * A skill's own logo, for its thumbnail: the `interface.icon_large` (else
 * `icon_small`) a Codex skill names in `agents/openai.yaml`, else a
 * conventional `assets/icon.png`. Only an image inside the skill's folder and
 * under 256 KB counts; null when there is none.
 */
export function skillIcon(folder: string): string | null {
  const root = realDirectory(folder);
  if (!root) return null;
  let named: string[] = [];
  try { named = interfaceIcons(head(join(root, "agents", "openai.yaml"))); } catch { /* no Codex metadata */ }
  for (const path of [...named, ...ICON_FILES]) {
    const url = imageDataUrl(root, path);
    if (url) return url;
  }
  return null;
}

/** The system-prompt section: names and descriptions only. */
export function catalogPrompt(skills: readonly Skill[]): string | undefined {
  if (!skills.length) return undefined;
  const rows = skills.map((skill) => `- ${skill.name}: ${skill.description.length > CATALOG_DESCRIPTION_CHARS ? `${skill.description.slice(0, CATALOG_DESCRIPTION_CHARS)}…` : skill.description}`);
  return [
    "Skills are instructions for particular kinds of task, kept as files. When a request matches a skill's description, load it with the skill tool before you start, then follow it. A loaded skill may name other files in its folder: read them with the same tool's file argument when you need them.",
    "This is the complete list of skills for this turn. It replaces any list of skills you saw earlier.",
    rows.join("\n"),
  ].join("\n\n");
}

const capped = (text: string) => (text.length > CONTENT_CHARS ? `${text.slice(0, CONTENT_CHARS)}\n… [cut at ${CONTENT_CHARS} characters]` : text);

/** One file from a skill's folder, which it must not leave. */
function readSkillFile(skill: Skill, file: string): { path: string; text: string } {
  const requested = file.trim();
  if (!requested) throw new SkillError("A file name is required.");
  let real: string;
  try { real = realpathSync(isAbsolute(requested) ? requested : join(skill.folder, requested)); } catch { throw new SkillError(`${requested} is not in the ${skill.name} skill.`); }
  if (!inside(skill.folder, real) || real === skill.folder) throw new SkillError(`${requested} is outside the ${skill.name} skill's folder.`);
  if (!statSync(real).isFile()) throw new SkillError(`${requested} is not a file.`);
  const buffer = readFileSync(real);
  if (buffer.subarray(0, 8000).includes(0)) throw new SkillError(`${requested} is a binary file.`);
  return { path: relative(skill.folder, real).split(sep).join("/"), text: buffer.toString("utf8") };
}

/** The skill's instructions: `SKILL.md` without its frontmatter. */
function skillBody(skill: Skill): string {
  const text = readFileSync(join(skill.folder, "SKILL.md"), "utf8");
  const parsed = parseFrontmatter(text);
  return (parsed ? text.slice(parsed.bodyStart) : text).trim();
}

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The one rendering of loaded skill content, for the tool's result and for a `/name` the user typed. */
export function renderSkill(skill: Skill, content: string, file?: string): string {
  const where = `name="${attribute(skill.name)}" folder="${attribute(skill.label)}"${file ? ` file="${attribute(file)}"` : ""}`;
  return `<skill_content ${where}>\n${capped(content)}\n</skill_content>`;
}

/** The `skill` tool for one turn, bound to that turn's catalog. */
function skillTool(skills: readonly Skill[]): ToolDefinition {
  const byName = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill]));
  const find = (input: Readonly<Record<string, unknown>>) => byName.get(String(input.name ?? "").trim().toLowerCase());
  return {
    schema: {
      name: "skill",
      description: "Load a skill's instructions by name, from the skills listed in the system prompt. Pass file to read another file from that skill's folder, such as a reference or script it mentions.",
      parameters: { type: "object", properties: { name: { type: "string", description: "The skill's name, exactly as listed." }, file: { type: "string", description: "A path inside the skill's folder. Leave it out to load the instructions." } }, required: ["name"] },
    },
    kind: "read",
    concurrencySafe: true,
    replay: "safe",
    validate: (_root, input) => (find(input) ? undefined : `There is no skill named ${String(input.name ?? "")}. Use a name from the list of skills.`),
    run: (_root, input) => {
      const skill = find(input);
      if (!skill) return { value: { kind: "error", message: `There is no skill named ${String(input.name ?? "")}.` } };
      const file = typeof input.file === "string" && input.file.trim() ? readSkillFile(skill, input.file) : undefined;
      const content = file ? file.text : skillBody(skill);
      return { value: { kind: "read", path: `${skill.label}/${file?.path ?? "SKILL.md"}`, lines: renderSkill(skill, content, file?.path), offset: 1 } };
    },
  };
}

/**
 * The extension that publishes a turn's catalog and its `skill` tool. Both read
 * one discovery per turn: the snapshot hands the same context object to each.
 */
export function skillsExtension(homeDir: string): Extension {
  const perTurn = new WeakMap<TurnContext, Skill[]>();
  const catalog = (context: TurnContext) => {
    let skills = perTurn.get(context);
    if (!skills) perTurn.set(context, (skills = discoverSkills(context.workspaceRoot, homeDir)));
    return skills;
  };
  return {
    id: "skills",
    tools: [(context) => {
      // A delegated child's profile has no skill tool, so it must not be told a
      // catalog it cannot load.
      if (context.delegationDepth > 0) return undefined;
      const skills = catalog(context);
      return skills.length ? skillTool(skills) : undefined;
    }],
    prompt: [{ placement: "stable", text: (context) => context.delegationDepth > 0 ? undefined : catalogPrompt(catalog(context)) }],
  };
}

/**
 * A `/name args` the user typed: the transcript shows what they typed, the
 * model gets the skill rendered as the tool would return it, then the request.
 */
export function expandInvocation(workspaceRoot: string, homeDir: string, invocation: { selector: string; arguments?: string }, text: string): { display: string; content: string } {
  const wanted = invocation.selector.replace(/^\//, "").trim().toLowerCase();
  const skill = discoverSkills(workspaceRoot, homeDir).find((candidate) => candidate.name.toLowerCase() === wanted);
  if (!skill) throw new SkillError(`/${invocation.selector.replace(/^\//, "")} is no longer available: the skill list changed. Pick the skill again.`, "skillNotFound");
  const args = (invocation.arguments ?? "").trim();
  const request = [args, text.trim()].filter(Boolean).join("\n\n");
  return {
    display: [`/${skill.name}${args ? ` ${args}` : ""}`, text.trim()].filter(Boolean).join("\n\n"),
    content: `The user invoked the ${skill.name} skill. Follow it for this request.\n\n${renderSkill(skill, skillBody(skill))}${request ? `\n\n${request}` : ""}`,
  };
}
