import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, Download, RefreshCw, Search, Server, Store, Trash2, WandSparkles, X } from "lucide-react";
import { describeError } from "../lib/errors";
import { currentThread, currentWorkspace, useAppStore } from "../lib/store";
import type { CatalogEntry, CatalogKind } from "../lib/types";
import { ExtensionThumb } from "./ExtensionThumb";

type Filter = "all" | CatalogKind;

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "skill", label: "Skills" },
  { id: "plugin", label: "Plugins" },
  { id: "mcp", label: "MCP servers" },
];

const KIND_LABEL: Record<CatalogKind, string> = { skill: "Skill", plugin: "Plugin", mcp: "MCP server" };

const matches = (entry: CatalogEntry, query: string) => {
  if (!query) return true;
  return [entry.name, entry.summary, entry.description, ...entry.tags, ...entry.skills, ...entry.servers].some((value) => value.toLowerCase().includes(query));
};

export function ExtensionsStore() {
  const s = useAppStore(useShallow((state) => ({
    entries: state.catalogEntries,
    skillsRoot: state.catalogSkillsRoot,
    loading: state.catalogLoading,
    error: state.catalogError,
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
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const workspace = currentWorkspace(s);
  const thread = currentThread(s);
  const harnessThread = thread?.agentId === "harness" ? thread : null;

  useEffect(() => {
    void s.refreshCatalog();
    // The listing includes workspace-scoped servers, so it follows the open workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.selectedWorkspaceId, s.preview]);

  const shown = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    return s.entries.filter((entry) => (filter === "all" || entry.kind === filter) && matches(entry, wanted));
  }, [s.entries, filter, query]);

  const install = async (entry: CatalogEntry) => {
    if (entry.requiresWorkspace && !workspace?.grantId) {
      setActionError(`Open a workspace before installing ${entry.name}. Its server is scoped to a workspace.`);
      return;
    }
    if (entry.servers.length) {
      const where = entry.scope === "workspace" ? "this workspace" : entry.scope === "mixed" ? "this workspace and your home folder" : "your home folder";
      const ok = await s.confirm({
        title: `Install ${entry.name}?`,
        body: `This adds ${entry.servers.length === 1 ? "an MCP server" : "MCP servers"} to ${where}'s .glitter/mcp.json: ${entry.servers.join(", ")}. Every tool call still asks for approval.`,
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

  return (
    <section className="extensions-section catalog-section" aria-labelledby="extensions-store-title">
      <div className="extensions-section-head">
        <h2 id="extensions-store-title"><Store size={15} aria-hidden="true" />Store</h2>
        <button type="button" className="ghost-btn small" disabled={s.loading} onClick={() => void s.refreshCatalog()}>
          <RefreshCw size={11} className={s.loading ? "spin" : ""} />{s.loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="permission-note">Curated skills, MCP servers and skill bundles that ship with Glitter. Installing needs no network, CLI or account.</p>
      <div className="catalog-toolbar">
        <label className="search-field">
          <Search size={13} aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the store" aria-label="Search the store" spellCheck={false} />
          {query ? <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}><X size={12} /></button> : null}
        </label>
        <span className="usage-periods" role="tablist" aria-label="Extension kind">
          {FILTERS.map((option) => (
            <button key={option.id} type="button" role="tab" aria-selected={filter === option.id} onClick={() => setFilter(option.id)}>{option.label}</button>
          ))}
        </span>
      </div>
      {s.error ? <p className="permission-note" role="alert">{s.error}</p> : null}
      {actionError ? <p className="permission-note" role="alert">{actionError}</p> : null}
      <p className="permission-note catalog-notice" role="status" aria-live="polite">{notice ?? ""}</p>
      {!shown.length && !s.loading ? <p className="permission-note extension-empty">{s.entries.length ? "No extensions match that search." : "The store could not be read. Refresh to try again."}</p> : null}
      {shown.length ? <ul className="extension-list catalog-list">
        {shown.map((entry) => {
          const isBusy = busy === entry.id;
          const blocked = entry.requiresWorkspace && !workspace?.grantId;
          return (
            <li key={entry.id} className={`catalog-card${entry.installed ? " installed" : ""}`}>
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
                {blocked ? <span className="extension-meta">Open a workspace to install this server.</span> : <span />}
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
        })}
      </ul> : null}
      {s.skillsRoot ? <p className="permission-note catalog-root">Skills install to <code>{s.skillsRoot}</code>; servers are merged into <code>.glitter/mcp.json</code>. Remove keeps anything you edited.</p> : null}
    </section>
  );
}
