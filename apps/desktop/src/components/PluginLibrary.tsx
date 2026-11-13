import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, CircleArrowUp, ExternalLink, FolderGit2, Info, Package, Plus, RefreshCw, Store, Trash2 } from "lucide-react";
import { openUrl } from "../lib/bridge";
import { describeError } from "../lib/errors";
import { relativeTime } from "../lib/format";
import { FEATURED_SOURCES, addedSource, installedFromRepository, installedSummary, pluginTitle, shortCommit, unsupportedSummary, type FeaturedSource } from "../lib/pluginLibrary";
import { currentThread, useAppStore } from "../lib/store";
import type { InstalledPlugin, MarketplaceSource } from "../lib/types";
import { ExtensionThumb } from "./ExtensionThumb";
import type { GithubRequest } from "./GithubInstallDialog";
import { Collapse } from "./Presence";

export type OpenGithub = (request: Omit<GithubRequest, "id">) => void;

const ago = (ms: number) => {
  const when = relativeTime(new Date(ms).toISOString());
  return !when ? "" : when === "now" ? "just now" : `${when} ago`;
};

/** Everything a plugin has installed now, for an update that keeps the same choice. */
function currentSelection(plugin: InstalledPlugin): string[] | null {
  const everything = plugin.skills.length + plugin.commands.length === plugin.availableSkills.length && plugin.servers.length === plugin.serverDetails.length;
  if (!plugin.enabled || everything) return null;
  return [...plugin.skills, ...plugin.commands, ...plugin.servers];
}

/** Plugins installed from GitHub: a switch, its parts, its source, update and remove. */
export function InstalledPlugins({ onOpen }: { onOpen: OpenGithub }) {
  const s = useAppStore(useShallow((state) => ({
    library: state.library,
    loading: state.libraryLoading,
    updates: state.libraryUpdates,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    setEnabled: state.setLibraryPluginEnabled,
    remove: state.removeLibraryPlugin,
    checkUpdates: state.checkLibraryUpdates,
    confirm: state.confirm,
  })));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const thread = currentThread(s);
  const plugins = s.library?.plugins ?? [];

  const toggle = async (plugin: InstalledPlugin) => {
    setBusy(plugin.id); setProblem(null); setNotice(null);
    try {
      const outcome = await s.setEnabled(plugin.id, !plugin.enabled, thread?.sessionId);
      if (outcome.problems.length) setProblem(`${pluginTitle(plugin)}: ${outcome.problems.join(" ")}`);
      else setNotice(plugin.enabled ? `Turned ${pluginTitle(plugin)} off. Its files stay, so turning it on needs no download.` : `Turned ${pluginTitle(plugin)} on.`);
    } catch (error) {
      setProblem(describeError(`Could not turn ${pluginTitle(plugin)} ${plugin.enabled ? "off" : "on"}`, error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (plugin: InstalledPlugin) => {
    const ok = await s.confirm({
      title: `Remove ${pluginTitle(plugin)}?`,
      body: "Its skills and MCP servers are taken out, and its downloaded files are deleted. A server you edited after installing is kept.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    setBusy(plugin.id); setProblem(null); setNotice(null);
    try {
      const problems = await s.remove(plugin.id, thread?.sessionId);
      if (problems.length) setProblem(problems.join(" "));
      else setNotice(`Removed ${pluginTitle(plugin)}.`);
      setExpanded(null);
    } catch (error) {
      setProblem(describeError(`Could not remove ${pluginTitle(plugin)}`, error));
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    setChecking(true); setProblem(null); setNotice(null);
    try {
      const updates = await s.checkUpdates();
      const count = updates.filter((update) => update.kind === "plugin").length;
      setNotice(count ? `${count} plugin${count === 1 ? " has" : "s have"} newer commits on GitHub.` : "Every plugin is up to date.");
    } catch (error) {
      setProblem(describeError("Could not check for updates", error));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="extensions-section" aria-labelledby="library-plugins-title">
      <div className="extensions-section-head">
        <h2 id="library-plugins-title"><Package size={15} aria-hidden="true" />Plugins{plugins.length ? <span className="section-count">{plugins.length}</span> : null}</h2>
        <span className="extension-actions">
          {plugins.length ? <button type="button" className="ghost-btn small" disabled={checking} onClick={() => void check()}>
            <RefreshCw size={11} className={checking ? "spin" : ""} />{checking ? "Checking…" : "Check for updates"}
          </button> : null}
          <button type="button" className="ghost-btn small" onClick={() => onOpen({})}><FolderGit2 size={11} />Add from GitHub</button>
        </span>
      </div>
      {problem ? <p className="permission-note" role="alert">{problem}</p> : null}
      <p className="permission-note catalog-notice" role="status" aria-live="polite">{notice ?? ""}</p>
      {!plugins.length && !s.loading ? <p className="permission-note extension-empty">No plugins from GitHub yet. Paste a repository link with Add from GitHub, or install one from a source in Discover.</p> : null}
      {plugins.length ? <ul className="extension-list plugins-list">
        {plugins.map((plugin) => {
          const open = expanded === plugin.id;
          const update = s.updates.find((row) => row.kind === "plugin" && row.id === plugin.id);
          const unsupported = unsupportedSummary(plugin);
          const title = pluginTitle(plugin);
          return (
            <li key={plugin.id} className={`plugins-row${plugin.enabled ? "" : " off"}${open ? " open" : ""}`}>
              <div className="extension-card plugins-card">
                <ExtensionThumb kind="plugin" id={plugin.id} name={plugin.name} size={36} src={plugin.icon ?? (plugin.origin.plugin ? null : plugin.avatar)} badge={plugin.icon || plugin.origin.plugin ? plugin.avatar : null} category={plugin.category} />
                <button type="button" className="plugins-card-main" aria-expanded={open} aria-controls={`library-detail-${plugin.id}`} onClick={() => setExpanded(open ? null : plugin.id)}>
                  <span className="plugins-name">
                    {title}
                    {plugin.version ? <span className="picker-tag">v{plugin.version}</span> : null}
                    {update ? <span className="picker-tag warm"><CircleArrowUp size={9} />Update</span> : null}
                    {!plugin.enabled ? <span className="picker-tag">Off</span> : null}
                  </span>
                  {plugin.description ? <span className="extension-meta plugins-description">{plugin.description}</span> : null}
                  <span className="plugins-facts">
                    <span>{plugin.origin.owner}/{plugin.origin.repo}</span>
                    <span>{plugin.enabled ? installedSummary(plugin) : "Off"}</span>
                    <span>Updated {ago(plugin.updatedAt)}</span>
                  </span>
                </button>
                <span className="extension-actions">
                  {update ? <button type="button" className="secondary small" disabled={busy === plugin.id} onClick={() => onOpen({ source: plugin.origin.spec, plugin: plugin.origin.plugin, selected: currentSelection(plugin), update: true })}>Update</button> : null}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={plugin.enabled}
                    aria-label={`${plugin.enabled ? "Turn off" : "Turn on"} ${title}`}
                    className="toggle"
                    disabled={busy === plugin.id}
                    onClick={() => void toggle(plugin)}
                  ><i /></button>
                </span>
              </div>
              <Collapse open={open}>{() => (
                <div className="plugins-detail" id={`library-detail-${plugin.id}`}>
                  {plugin.longDescription ? <p className="plugins-long">{plugin.longDescription}</p> : null}
                  {plugin.availableSkills.length ? <div className="plugins-parts">
                    <span className="plugins-label">Skills and commands</span>
                    <span className="plugins-chips">
                      {plugin.availableSkills.map((skill) => {
                        const on = plugin.skills.includes(skill.name) || plugin.commands.includes(skill.name);
                        return <code key={skill.name} className={on ? "" : "dim"} title={on ? skill.description : `Not installed. ${skill.description}`}>{plugin.commands.includes(skill.name) || skill.folder.endsWith(".md") ? "/" : ""}{skill.name}</code>;
                      })}
                    </span>
                  </div> : null}
                  {plugin.serverDetails.length ? <div className="plugins-parts">
                    <span className="plugins-label">MCP servers</span>
                    <ul className="plugins-servers">
                      {plugin.serverDetails.map((server) => <li key={server.name} className={plugin.servers.includes(server.name) ? "" : "dim"}><code>{server.name}</code><span title={server.display}>{server.display}</span></li>)}
                    </ul>
                  </div> : null}
                  {unsupported || plugin.notes.length ? <ul className="github-notes">
                    {unsupported ? <li><Info size={12} aria-hidden="true" />{unsupported}</li> : null}
                    {plugin.notes.map((note) => <li key={note}><Info size={12} aria-hidden="true" />{note}</li>)}
                  </ul> : null}
                  <dl className="plugins-meta">
                    {plugin.author ? <><dt>Author</dt><dd>{plugin.author}</dd></> : null}
                    <dt>Source</dt><dd>{plugin.origin.plugin ? `${plugin.origin.plugin} in ` : ""}{plugin.origin.owner}/{plugin.origin.repo}{plugin.origin.ref ? ` @ ${plugin.origin.ref}` : ""}</dd>
                    <dt>Commit</dt><dd><code>{shortCommit(plugin.origin.commit)}</code></dd>
                    {plugin.license ? <><dt>License</dt><dd>{plugin.license}</dd></> : null}
                    <dt>Folder</dt><dd><code>{plugin.folder}</code></dd>
                  </dl>
                  <div className="plugins-detail-actions">
                    <button type="button" className="ghost-btn small" onClick={() => void openUrl(plugin.origin.url)}><ExternalLink size={11} />View on GitHub</button>
                    {plugin.homepage && plugin.homepage !== plugin.origin.url ? <button type="button" className="ghost-btn small" onClick={() => void openUrl(plugin.homepage!)}><ExternalLink size={11} />Homepage</button> : null}
                    <button type="button" className="ghost-btn small" disabled={busy === plugin.id} onClick={() => onOpen({ source: plugin.origin.spec, plugin: plugin.origin.plugin, selected: currentSelection(plugin), update: true })}><RefreshCw size={11} />Fetch latest</button>
                    <span className="grow" />
                    <button type="button" className="ghost-btn small danger-text" disabled={busy === plugin.id} onClick={() => void remove(plugin)}><Trash2 size={11} />{busy === plugin.id ? "Working…" : "Remove"}</button>
                  </div>
                </div>
              )}</Collapse>
            </li>
          );
        })}
      </ul> : null}
    </section>
  );
}

/** A well-known repository offered before the user has added it. */
export function FeaturedCard({ featured, onOpen, compact = false }: { featured: FeaturedSource; onOpen: OpenGithub; compact?: boolean }) {
  const library = useAppStore((state) => state.library);
  const added = featured.kind === "marketplace" ? addedSource(library, featured.spec) : installedFromRepository(library, featured.spec);
  return (
    <li className={`featured-card${compact ? " compact" : ""}`}>
      <ExtensionThumb kind={featured.kind === "marketplace" ? "plugin" : "skill"} id={featured.spec} name={featured.name} size={compact ? 32 : 40} />
      <span className="featured-copy">
        <span className="featured-name">{featured.name}{added ? <span className="picker-tag free"><Check size={9} />{featured.kind === "marketplace" ? "Added" : "Installed"}</span> : null}</span>
        <span className="featured-owner">{featured.owner} · <code>{featured.spec}</code></span>
        {compact ? null : <span className="featured-summary">{featured.summary}</span>}
      </span>
      <button type="button" className={added ? "ghost-btn small" : "secondary small"} onClick={() => onOpen({ source: featured.spec })}>
        {added ? "Open" : featured.kind === "marketplace" ? <><Plus size={11} />Add</> : "Get"}
      </button>
    </li>
  );
}

/** Marketplaces added as sources: their plugins list in Discover. */
export function PluginSources({ onOpen, onBrowse }: { onOpen: OpenGithub; onBrowse: (id: string) => void }) {
  const s = useAppStore(useShallow((state) => ({
    library: state.library,
    loading: state.libraryLoading,
    updates: state.libraryUpdates,
    refreshMarketplace: state.refreshMarketplace,
    removeMarketplace: state.removeMarketplace,
    confirm: state.confirm,
  })));
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sources = s.library?.marketplaces ?? [];

  const refresh = async (source: MarketplaceSource) => {
    setBusy(source.id); setProblem(null); setNotice(null);
    try {
      const fresh = await s.refreshMarketplace(source.id);
      setNotice(`${pluginTitle(fresh)} lists ${fresh.plugins.length} plugin${fresh.plugins.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setProblem(describeError(`Could not refresh ${pluginTitle(source)}`, error));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (source: MarketplaceSource) => {
    const ok = await s.confirm({ title: `Remove ${pluginTitle(source)}?`, body: "Its plugins leave Discover. Plugins you installed from it stay installed.", confirmLabel: "Remove", danger: true });
    if (!ok) return;
    setBusy(source.id); setProblem(null); setNotice(null);
    try {
      await s.removeMarketplace(source.id);
      setNotice(`Removed ${pluginTitle(source)}.`);
    } catch (error) {
      setProblem(describeError(`Could not remove ${pluginTitle(source)}`, error));
    } finally {
      setBusy(null);
    }
  };

  return <>
    <section className="extensions-section" aria-labelledby="library-sources-title">
      <div className="extensions-section-head">
        <h2 id="library-sources-title"><Store size={15} aria-hidden="true" />Sources{sources.length ? <span className="section-count">{sources.length}</span> : null}</h2>
        <button type="button" className="ghost-btn small" onClick={() => onOpen({})}><Plus size={11} />Add source</button>
      </div>
      <p className="permission-note">A source is a GitHub repository with a plugin marketplace, in the Claude Code or Codex format. Its plugins list in Discover; each one is fetched and shown to you before it installs.</p>
      {problem ? <p className="permission-note" role="alert">{problem}</p> : null}
      <p className="permission-note catalog-notice" role="status" aria-live="polite">{notice ?? ""}</p>
      {!sources.length && !s.loading ? <p className="permission-note extension-empty">No sources yet. Add one below, or paste any marketplace repository with Add source.</p> : null}
      {sources.length ? <ul className="extension-list">
        {sources.map((source) => {
          const update = s.updates.find((row) => row.kind === "marketplace" && row.id === source.id);
          return (
            <li key={source.id} className="extension-card source-card">
              <ExtensionThumb kind="plugin" id={source.id} name={source.name} size={36} src={source.avatar} />
              <span className="extension-copy">
                <span className="plugins-name">{pluginTitle(source)}{update ? <span className="picker-tag warm"><CircleArrowUp size={9} />New commits</span> : null}</span>
                {source.description ? <span className="extension-meta plugins-description">{source.description}</span> : null}
                <span className="plugins-facts">
                  <span>{source.origin.owner}/{source.origin.repo}</span>
                  <span>{source.plugins.length} plugin{source.plugins.length === 1 ? "" : "s"}</span>
                  <span>Refreshed {ago(source.refreshedAt)}</span>
                </span>
              </span>
              <span className="extension-actions">
                <button type="button" className="ghost-btn small" onClick={() => onBrowse(source.id)}>Browse</button>
                <button type="button" className="icon-btn small" aria-label={`Refresh ${pluginTitle(source)}`} title="Refresh" disabled={busy === source.id} onClick={() => void refresh(source)}><RefreshCw size={13} className={busy === source.id ? "spin" : ""} /></button>
                <button type="button" className="icon-btn small" aria-label={`Remove ${pluginTitle(source)}`} title="Remove" disabled={busy === source.id} onClick={() => void remove(source)}><Trash2 size={13} /></button>
              </span>
            </li>
          );
        })}
      </ul> : null}
    </section>
    <section className="extensions-section" aria-labelledby="library-featured-title">
      <div className="extensions-section-head">
        <h2 id="library-featured-title"><FolderGit2 size={15} aria-hidden="true" />Featured on GitHub</h2>
      </div>
      <ul className="featured-list">
        {FEATURED_SOURCES.map((featured) => <FeaturedCard key={featured.spec} featured={featured} onOpen={onOpen} />)}
      </ul>
    </section>
  </>;
}
