import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Download, FolderGit2, RefreshCw, Search, Server, Trash2, WandSparkles, X } from "lucide-react";
import { describeError } from "../lib/errors";
import { FEATURED_SOURCES, discoverRows, listingImage, pluginTitle, type DiscoverKind, type DiscoverRow } from "../lib/pluginLibrary";
import { currentThread, currentWorkspace, useAppStore } from "../lib/store";
import type { CatalogEntry, CatalogKind } from "../lib/types";
import { ExtensionThumb } from "./ExtensionThumb";
import { FeaturedCard, type OpenGithub } from "./PluginLibrary";
import { SelectMenu } from "./SelectMenu";

const FILTERS: Array<{ id: DiscoverKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "plugin", label: "Plugins" },
  { id: "skill", label: "Skills" },
  { id: "mcp", label: "MCP servers" },
];

const KIND_LABEL: Record<CatalogKind, string> = { skill: "Skill", plugin: "Plugin", mcp: "MCP server" };
/** Cards drawn at once; a large marketplace pages in with Show more. */
const PAGE = 36;

/**
 * Discover: the bundled store (installs offline, in one click) and the plugins
 * every added source lists (fetched from GitHub and reviewed before install).
 */
export function ExtensionsStore({ source: controlledSource, onSource, onOpen }: {
  source?: string;
  onSource?: (source: string) => void;
  onOpen?: OpenGithub;
} = {}) {
  const s = useAppStore(useShallow((state) => ({
    entries: state.catalogEntries,
    skillsRoot: state.catalogSkillsRoot,
    loading: state.catalogLoading,
    error: state.catalogError,
    library: state.library,
    libraryLoading: state.libraryLoading,
    preview: state.preview,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    refreshCatalog: state.refreshCatalog,
    installCatalogEntry: state.installCatalogEntry,
    removeCatalogEntry: state.removeCatalogEntry,
    confirm: state.confirm,
  })));
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<DiscoverKind>("all");
  const [ownSource, setOwnSource] = useState("all");
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const source = controlledSource ?? ownSource;
  const setSource = onSource ?? setOwnSource;

  const workspace = currentWorkspace(s);
  const thread = currentThread(s);
  const harnessThread = thread?.agentId === "harness" ? thread : null;
  const marketplaces = s.library?.marketplaces ?? [];

  useEffect(() => {
    void s.refreshCatalog();
    // The listing includes workspace-scoped servers, so it follows the open workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.selectedWorkspaceId, s.preview]);

  // A source that was removed falls back to everything.
  useEffect(() => {
    if (source !== "all" && source !== "bundled" && s.library && !marketplaces.some((market) => market.id === source)) setSource("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.library]);

  useEffect(() => setLimit(PAGE), [query, filter, source]);

  const rows = useMemo(() => discoverRows(s.entries, s.library, query, filter, source), [s.entries, s.library, query, filter, source]);
  const shown = rows.slice(0, limit);
  const showFeatured = Boolean(onOpen) && !query && filter === "all" && source === "all" && !marketplaces.length;

  const install = async (entry: CatalogEntry) => {
    if (entry.requiresWorkspace && !workspace?.grantId) {
      setActionError(`Open a workspace before installing ${entry.name}. Its server is scoped to a workspace.`);
      return;
    }
    if (entry.servers.length) {
      const where = entry.scope === "workspace" ? "this workspace" : entry.scope === "mixed" ? "this workspace and your home folder" : "your home folder";
      const ok = await s.confirm({
        title: `Install ${entry.name}?`,
        body: `This adds ${entry.servers.length === 1 ? "an MCP server" : "MCP servers"} to ${where}'s .glitter/mcp.json: ${entry.servers.join(", ")}. Tool calls follow the thread's permissions and grants.${entry.commands.some((command) => /\bnpx\b/.test(command)) ? " Starting an npx server may require a runtime and a network download." : ""}`,
        confirmLabel: "Install",
      });
      if (!ok) return;
    }
    setBusy(entry.id); setActionError(null); setNotice(null);
    try {
      const result = await s.installCatalogEntry(entry.id, harnessThread?.sessionId);
      const installed = [...result.installedSkills, ...result.installedServers];
      if (result.errors.length) setActionError(`${entry.name}: ${result.errors.join(" ")}`);
      if (installed.length) setNotice(`Installed ${installed.join(", ")}.`);
      else if (!result.errors.length) setNotice(`${entry.name} is already installed.`);
    } catch (error) {
      setActionError(describeError(`Could not install ${entry.name}`, error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (entry: CatalogEntry) => {
    const ok = await s.confirm({
      title: `Remove ${entry.name}?`,
      body: "Its store-installed skills and server entries are removed. Anything you changed or added yourself is kept.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy(entry.id); setActionError(null); setNotice(null);
    try {
      const result = await s.removeCatalogEntry(entry.id, harnessThread?.sessionId);
      if (result.errors.length) setActionError(`${entry.name}: ${result.errors.join(" ")}`);
      if (result.removed.length) setNotice(`Removed ${result.removed.join(", ")}.`);
      else if (result.skipped.length) setNotice(`${entry.name} had no store-owned files left to remove.`);
    } catch (error) {
      setActionError(describeError(`Could not remove ${entry.name}`, error));
    } finally {
      setBusy(null);
    }
  };

  const catalogCard = (entry: CatalogEntry) => {
    const isBusy = busy === entry.id;
    const blocked = entry.requiresWorkspace && !workspace?.grantId;
    return (
      <li key={`catalog:${entry.id}`} className={`catalog-card${entry.installed ? " installed" : ""}`}>
        <div className="catalog-card-head">
          <ExtensionThumb kind={entry.kind} id={entry.id} name={entry.name} size={40} />
          <span className="catalog-card-copy">
            <span className="catalog-name">{entry.name}
              {entry.installed ? <span className="picker-tag free"><Check size={9} />Installed</span> : entry.installedParts > 0 ? <span className="picker-tag warm">{entry.installedParts}/{entry.totalParts} installed</span> : null}
            </span>
            <span className="catalog-kind">{[KIND_LABEL[entry.kind], ...entry.tags].join(" · ")}</span>
          </span>
        </div>
        <p className="catalog-description" title={entry.description}>{entry.summary}</p>
        {/* A bundle lists what it installs; a single skill or server would only repeat its own name. */}
        {entry.kind === "plugin" && (entry.skills.length || entry.servers.length) ? <div className="catalog-parts">
          {entry.skills.length ? <span><WandSparkles size={11} aria-hidden="true" />{entry.skills.map((skill) => <code key={skill}>{skill}</code>)}</span> : null}
          {entry.servers.length ? <span><Server size={11} aria-hidden="true" />{entry.servers.map((server) => <code key={server}>{server}</code>)}</span> : null}
        </div> : null}
        {entry.commands.length ? <div className="catalog-commands" aria-label="Commands this extension adds">
          {entry.commands.map((command) => <code key={command} title={command}>{command}</code>)}
        </div> : null}
        <div className="catalog-card-foot">
          {blocked ? <span className="extension-meta">Open a workspace to install this server.</span> : <span className="catalog-source">Bundled with Glitter</span>}
          <span className="extension-actions">
            {entry.installed || entry.installedParts > 0 ? <button type="button" className="ghost-btn small" disabled={isBusy} title={`Remove ${entry.name}`} onClick={() => void remove(entry)}>
              <Trash2 size={11} />{isBusy ? "Working…" : "Remove"}
            </button> : null}
            {!entry.installed ? <button
              type="button"
              className="secondary small catalog-install"
              disabled={isBusy || blocked}
              title={blocked ? "Open a workspace to install this server" : `Install ${entry.name}`}
              onClick={() => void install(entry)}
            >
              <Download size={11} />{isBusy ? "Installing…" : entry.installedParts > 0 ? "Finish install" : "Install"}
            </button> : null}
          </span>
        </div>
      </li>
    );
  };

  const listingCard = (row: Extract<DiscoverRow, { type: "listing" }>) => {
    const { plugin, source: market, installed } = row;
    const title = pluginTitle(plugin);
    const external = plugin.location !== "This repository" && plugin.supported;
    const open = () => onOpen?.({ source: market.origin.spec, plugin: plugin.name, update: Boolean(installed) });
    return (
      <li key={row.key} className={`catalog-card listing-card${installed ? " installed" : ""}`}>
        <div className="catalog-card-head">
          <ExtensionThumb kind="plugin" id={plugin.name} name={plugin.name} category={plugin.category} size={40} src={listingImage(s.library, market, plugin, installed)} badge={market.avatar} />
          <span className="catalog-card-copy">
            <span className="catalog-name">{title}
              {installed ? <span className="picker-tag free"><Check size={9} />Installed</span> : null}
            </span>
            <span className="catalog-kind">{["Plugin", plugin.category, plugin.author].filter(Boolean).join(" · ")}</span>
          </span>
        </div>
        <p className="catalog-description" title={plugin.description ?? undefined}>{plugin.description ?? "No description."}</p>
        {external ? <div className="catalog-parts"><span><FolderGit2 size={11} aria-hidden="true" /><code>{plugin.location}</code></span></div> : null}
        <div className="catalog-card-foot">
          <span className="catalog-source" title={`${market.origin.owner}/${market.origin.repo}`}>from {pluginTitle(market)}</span>
          <span className="extension-actions">
            {!plugin.supported ? <span className="extension-meta">Not on GitHub</span>
              : installed ? <button type="button" className="ghost-btn small" disabled={!onOpen} onClick={open}>Reinstall</button>
              : <button type="button" className="secondary small catalog-install" disabled={!onOpen} title={`Review and install ${title}`} onClick={open}><Download size={11} />Install</button>}
          </span>
        </div>
      </li>
    );
  };

  const sourceOptions = [
    { value: "all", label: "All sources" },
    { value: "bundled", label: "Bundled with Glitter", description: `${s.entries.length} extensions, offline` },
    ...marketplaces.map((market) => ({ value: market.id, label: pluginTitle(market), description: `${market.plugins.length} plugins · ${market.origin.owner}/${market.origin.repo}` })),
  ];
  const loading = s.loading || s.libraryLoading;

  return (
    <section className="extensions-section catalog-section" aria-label="Discover">
      <div className="catalog-toolbar">
        <label className="search-field">
          <Search size={13} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={marketplaces.length ? "Search extensions" : "Search the store"} aria-label="Search the store" spellCheck={false} />
          {query ? <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}><X size={12} /></button> : null}
        </label>
        <span className="usage-periods" role="tablist" aria-label="Extension kind">
          {FILTERS.map((option) => (
            <button key={option.id} type="button" role="tab" aria-selected={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}</button>
          ))}
        </span>
        {marketplaces.length ? <SelectMenu id="discover-source" className="catalog-source-select" ariaLabel="Source" value={source} placeholder="All sources" options={sourceOptions} onChange={setSource} /> : null}
        <button type="button" className="icon-btn small catalog-refresh" aria-label="Refresh the store" title="Refresh" disabled={loading} onClick={() => void s.refreshCatalog()}>
          <RefreshCw size={13} className={loading ? "spin" : ""} />
        </button>
      </div>
      {s.error ? <p className="permission-note" role="alert">{s.error}</p> : null}
      {actionError ? <p className="permission-note" role="alert">{actionError}</p> : null}
      <p className="permission-note catalog-notice" role="status" aria-live="polite">{notice ?? ""}</p>
      {showFeatured && onOpen ? <div className="discover-featured">
        <div className="discover-featured-head">
          <span>Featured on GitHub</span>
          <span className="extension-meta">Add a source to browse its plugins here.</span>
        </div>
        <ul className="featured-list compact">
          {FEATURED_SOURCES.slice(0, 4).map((featured) => <FeaturedCard key={featured.spec} featured={featured} onOpen={onOpen} compact />)}
        </ul>
      </div> : null}
      {rows.length ? <p className="catalog-count">{rows.length === 1 ? "1 extension" : `${rows.length} extensions`}{source !== "all" ? ` in ${sourceOptions.find((option) => option.value === source)?.label ?? "this source"}` : ""}</p> : null}
      {!rows.length && !loading ? <p className="permission-note extension-empty">{s.entries.length || marketplaces.length ? "No extensions match that search." : "The store could not be read. Refresh to try again."}</p> : null}
      {shown.length ? <ul className="extension-list catalog-list">
        {shown.map((row) => row.type === "catalog" ? catalogCard(row.entry) : listingCard(row))}
      </ul> : null}
      {rows.length > shown.length ? <div className="catalog-more">
        <button type="button" className="ghost-btn" onClick={() => setLimit((current) => current + PAGE)}>Show {Math.min(PAGE, rows.length - shown.length)} more</button>
        <span className="extension-meta">{shown.length} of {rows.length}</span>
      </div> : null}
      {s.skillsRoot && (source === "all" || source === "bundled") ? <p className="permission-note catalog-root">Skills install to <code>{s.skillsRoot}</code>; servers are merged into <code>.glitter/mcp.json</code>. Remove keeps anything you edited.</p> : null}
    </section>
  );
}
