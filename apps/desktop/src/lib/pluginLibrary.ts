/**
 * Pure helpers for the plugin library: reading what the user typed as a GitHub
 * source, counting what a plugin installs, and merging the bundled store with
 * the plugins that added marketplaces list. The native side validates every
 * source again; this only decides what the UI can offer before asking it.
 */
import type { CatalogEntry, InstalledPlugin, MarketplacePlugin, MarketplaceSource, PluginAnalysis, PluginLibrary } from "./types";

/** Well-known repositories offered before the user has added any of their own. */
export type FeaturedSource = { spec: string; name: string; owner: string; summary: string; kind: "marketplace" | "plugin" };
export const FEATURED_SOURCES: FeaturedSource[] = [
  { spec: "anthropics/claude-plugins-official", name: "Claude plugin directory", owner: "Anthropic", summary: "Hundreds of plugins: developer tools, MCP integrations and workflows.", kind: "marketplace" },
  { spec: "anthropics/skills", name: "Agent Skills", owner: "Anthropic", summary: "Document, design and development skills, in four bundles.", kind: "marketplace" },
  { spec: "obra/superpowers", name: "Superpowers", owner: "Jesse Vincent", summary: "Planning, test-driven development and debugging workflows.", kind: "plugin" },
  { spec: "openai/skills", name: "Codex skills", owner: "OpenAI", summary: "Curated skills from the Codex catalog.", kind: "plugin" },
  { spec: "anthropics/claude-code", name: "Claude Code plugins", owner: "Anthropic", summary: "The example plugins that ship with Claude Code.", kind: "marketplace" },
];

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * `owner/repo` for anything that names a GitHub repository, or why it does
 * not. Accepts the same spellings as the native parser: `owner/repo`,
 * `owner/repo@ref`, `github.com/…`, https and ssh clone URLs and `tree/` links.
 */
export function readGithubSource(input: string): { repo: string | null; problem: string | null } {
  const text = input.trim();
  if (!text) return { repo: null, problem: null };
  if (/\s/.test(text)) return { repo: null, problem: "A repository link has no spaces." };
  let rest = text.split(/[#?]/)[0];
  rest = rest.replace(/^git@github\.com:/i, "").replace(/^github:/i, "");
  const scheme = /^([a-z]+):\/\//i.exec(rest);
  if (scheme) {
    if (!["https", "http", "ssh", "git"].includes(scheme[1].toLowerCase())) return { repo: null, problem: "Only github.com repositories can be added." };
    rest = rest.slice(scheme[0].length).replace(/^git@/i, "");
  }
  const host = /^(www\.)?github\.com\//i.exec(rest);
  if (host) rest = rest.slice(host[0].length);
  else if (scheme || /^[^/]*[.:]/.test(rest)) return { repo: null, problem: "Only github.com repositories can be added." };
  const [owner = "", rawRepo = ""] = rest.split(":")[0].split("@")[0].split("/");
  const repo = rawRepo.replace(/\.git$/, "");
  if (!owner || !repo) return { repo: null, problem: "Name the repository as owner/repo." };
  if (!OWNER.test(owner) || !REPO.test(repo)) return { repo: null, problem: `${owner}/${repo} is not a valid GitHub repository name.` };
  return { repo: `${owner}/${repo}`, problem: null };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** "6 skills · 1 command · 2 MCP servers", from what a plugin offers. */
export function componentSummary(parts: { skills: number; commands: number; servers: number }): string {
  const out: string[] = [];
  if (parts.skills) out.push(plural(parts.skills, "skill"));
  if (parts.commands) out.push(plural(parts.commands, "command"));
  if (parts.servers) out.push(plural(parts.servers, "MCP server"));
  return out.join(" · ") || "Nothing the built-in agent can run";
}

export function analysisSummary(plugin: PluginAnalysis): string {
  return componentSummary({ skills: plugin.skills.length, commands: plugin.commands.length, servers: plugin.servers.length });
}

export function installedSummary(plugin: InstalledPlugin): string {
  return componentSummary({ skills: plugin.skills.length, commands: plugin.commands.length, servers: plugin.servers.length });
}

/** What the built-in agent will not run from a plugin, as one sentence, or null. */
export function unsupportedSummary(plugin: { agents: string[]; hooks: boolean; lsp: boolean }): string | null {
  const parts: string[] = [];
  if (plugin.agents.length) parts.push(plural(plugin.agents.length, "agent"));
  if (plugin.hooks) parts.push("hooks");
  if (plugin.lsp) parts.push("language servers");
  if (!parts.length) return null;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Its ${list} are for Claude Code and are not used by the built-in agent.`;
}

/** Every name a preview offers for installation: skills, commands and servers. */
export function selectableParts(plugin: PluginAnalysis): string[] {
  return [...plugin.skills.map((row) => row.name), ...plugin.commands.map((row) => row.name), ...plugin.servers.map((row) => row.name)];
}

export const shortCommit = (sha: string) => sha.slice(0, 7);

/** A display name: a manifest's display name, else the id turned into words. */
export function pluginTitle(plugin: { displayName?: string | null; name: string }): string {
  if (plugin.displayName) return plugin.displayName;
  const name = plugin.name.replace(/[-_]+/g, " ").trim();
  return name ? name[0].toUpperCase() + name.slice(1) : plugin.name;
}

/** The installed plugin that came from this marketplace listing, if any. */
export function installedFromMarketplace(library: PluginLibrary | null, source: MarketplaceSource, name: string): InstalledPlugin | undefined {
  return library?.plugins.find((plugin) => plugin.origin.plugin === name
    && plugin.origin.owner.toLowerCase() === source.origin.owner.toLowerCase()
    && plugin.origin.repo.toLowerCase() === source.origin.repo.toLowerCase());
}

/**
 * The thumbnail image for a marketplace listing: the logo of the copy already
 * installed, else the avatar of the owner whose repository it lives in. A
 * listing in the source's own repository (or its owner's) has none; its tile
 * is generated and the source's avatar is its corner badge.
 */
export function listingImage(library: PluginLibrary | null, source: MarketplaceSource, plugin: MarketplacePlugin, installed?: InstalledPlugin): string | null {
  if (installed?.icon) return installed.icon;
  const owner = /^([A-Za-z0-9-]+)\/[^/]+$/.exec(plugin.location)?.[1]?.toLowerCase();
  if (!owner || owner === source.origin.owner.toLowerCase()) return null;
  return library?.avatars?.[owner] ?? null;
}

/** The marketplace a featured repository was added as, if it has been. */
export function addedSource(library: PluginLibrary | null, spec: string): MarketplaceSource | undefined {
  const [owner, repo] = spec.toLowerCase().split("/");
  return library?.marketplaces.find((source) => source.origin.owner.toLowerCase() === owner && source.origin.repo.toLowerCase() === repo);
}

/** An installed plugin that came straight from a repository (not a marketplace). */
export function installedFromRepository(library: PluginLibrary | null, spec: string): InstalledPlugin | undefined {
  const [owner, repo] = spec.toLowerCase().split("/");
  return library?.plugins.find((plugin) => !plugin.origin.plugin && plugin.origin.owner.toLowerCase() === owner && plugin.origin.repo.toLowerCase() === repo);
}

export type DiscoverKind = "all" | "plugin" | "skill" | "mcp";
/** One card in Discover: a bundled store entry, or a plugin a marketplace lists. */
export type DiscoverRow =
  | { type: "catalog"; key: string; entry: CatalogEntry }
  | { type: "listing"; key: string; source: MarketplaceSource; plugin: MarketplacePlugin; installed: InstalledPlugin | undefined };

const includes = (values: Array<string | null | undefined>, query: string) => values.some((value) => value?.toLowerCase().includes(query));

/**
 * The cards Discover shows for a search, a kind and a source (`all`,
 * `bundled`, or a marketplace id). Marketplace listings are plugins; the
 * bundled store keeps its own kinds.
 */
export function discoverRows(entries: CatalogEntry[], library: PluginLibrary | null, query: string, kind: DiscoverKind, source: string): DiscoverRow[] {
  const wanted = query.trim().toLowerCase();
  const rows: DiscoverRow[] = [];
  if (source === "all" || source === "bundled") {
    for (const entry of entries) {
      if (kind !== "all" && entry.kind !== kind) continue;
      if (wanted && !includes([entry.name, entry.summary, entry.description, ...entry.tags, ...entry.skills, ...entry.servers], wanted)) continue;
      rows.push({ type: "catalog", key: `catalog:${entry.id}`, entry });
    }
  }
  if (kind === "all" || kind === "plugin") {
    for (const market of library?.marketplaces ?? []) {
      if (source !== "all" && source !== market.id) continue;
      for (const plugin of market.plugins) {
        if (wanted && !includes([plugin.name, plugin.description, plugin.category, plugin.author, ...plugin.keywords], wanted)) continue;
        rows.push({ type: "listing", key: `${market.id}:${plugin.name}`, source: market, plugin, installed: installedFromMarketplace(library, market, plugin.name) });
      }
    }
  }
  return rows;
}
