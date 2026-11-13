import { useEffect, useRef, useState, type FormEvent } from "react";
import { describeError } from "../lib/errors";
import { useShallow } from "zustand/react/shallow";
import { FolderGit2, Package, Plus, Puzzle, RefreshCw, Server, Trash2 } from "lucide-react";
import { consentMcp, reviewMcp } from "../lib/bridge";
import { skillSelectorText, skillUseText } from "../lib/composerText";
import { ExtensionThumb } from "./ExtensionThumb";
import { mcpServerNameProblem, mcpServerSummary, parseMcpArguments, parseMcpKeyValues } from "../lib/mcpConfig";
import { activeWorkspace, currentThread, useAppStore } from "../lib/store";
import { type HarnessMcpConfigServer, type HarnessMcpReview, type HarnessMcpScope, type HarnessMcpServerInput, type SkillRow } from "../lib/types";
import { ExtensionsStore } from "./ExtensionsStore";
import { GithubInstallDialog, type GithubRequest } from "./GithubInstallDialog";
import { InstalledPlugins, PluginSources, type OpenGithub } from "./PluginLibrary";

type LibraryTab = "discover" | "installed" | "sources";
const TABS: Array<{ id: LibraryTab; label: string }> = [
  { id: "discover", label: "Discover" },
  { id: "installed", label: "Installed" },
  { id: "sources", label: "Sources" },
];

const selectorText = (row: SkillRow) => skillSelectorText(row.selector);

function SkillCard({ row, onUse }: { row: SkillRow; onUse: (row: SkillRow) => void }) {
  return (
    <li className="extension-card">
      <ExtensionThumb kind="skill" id={row.selector} name={row.displayName ?? row.selector} size={32} src={row.icon} />
      <span className="extension-copy">
        <span className="extension-name">{selectorText(row)}{row.displayName && row.displayName !== row.selector ? <span className="picker-tag">{row.displayName}</span> : null}{row.source ? <span className="picker-tag">{row.source}</span> : null}</span>
        {row.description ? <span className="extension-meta">{row.description}</span> : null}
        {row.argumentHint ? <span className="extension-meta">Arguments: {row.argumentHint}</span> : null}
      </span>
      <button type="button" className="ghost-btn small" onClick={() => onUse(row)}>Use</button>
    </li>
  );
}

export function ExtensionsView({ onOpenThreads, embedded = false }: { onOpenThreads?: () => void; embedded?: boolean }) {
  const s = useAppStore(useShallow((state) => ({
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    preview: state.preview,
    composer: state.composer,
    harnessMcp: state.harnessMcp,
    harnessMcpLoading: state.harnessMcpLoading,
    harnessMcpError: state.harnessMcpError,
    harnessMcpConfig: state.harnessMcpConfig,
    harnessMcpConfigLoading: state.harnessMcpConfigLoading,
    harnessMcpConfigError: state.harnessMcpConfigError,
    refreshHarnessMcp: state.refreshHarnessMcp,
    refreshHarnessMcpConfig: state.refreshHarnessMcpConfig,
    addHarnessMcpServer: state.addHarnessMcpServer,
    removeHarnessMcpServer: state.removeHarnessMcpServer,
    refreshSkills: state.refreshSkills,
    setComposer: state.setComposer,
    setSettingsOpen: state.setSettingsOpen,
    confirm: state.confirm,
    library: state.library,
    libraryUpdates: state.libraryUpdates,
    refreshLibrary: state.refreshLibrary,
    checkLibraryUpdates: state.checkLibraryUpdates,
    catalogEntries: state.catalogEntries,
    removeCatalogEntry: state.removeCatalogEntry,
  })));
  const [tab, setTab] = useState<LibraryTab>("discover");
  const [discoverSource, setDiscoverSource] = useState("all");
  const [github, setGithub] = useState<GithubRequest | null>(null);
  const githubRequests = useRef(0);
  const updatesChecked = useRef(false);
  const [storeBusy, setStoreBusy] = useState<string | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const openGithub: OpenGithub = (request) => setGithub({ ...request, id: ++githubRequests.current });
  const bar = useRef<HTMLDivElement>(null);
  /** A tab opens at its top: when the bar is stuck, scroll back to where it sits. */
  const showTab = (next: LibraryTab) => {
    setTab(next);
    const node = bar.current;
    let scroller = node?.parentElement ?? null;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!node || !scroller) return;
    const stuck = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top <= 1;
    if (stuck && scroller.scrollTop > 0) scroller.scrollTo({ top: 0, behavior: "smooth" });
  };
  const thread = currentThread(s);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [mcpName, setMcpName] = useState("");
  const [mcpScope, setMcpScope] = useState<HarnessMcpScope>("workspace");
  const [mcpTransport, setMcpTransport] = useState<"stdio" | "http">("stdio");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpArgs, setMcpArgs] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpEnv, setMcpEnv] = useState("");
  const [mcpHeaders, setMcpHeaders] = useState("");
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpRowBusy, setMcpRowBusy] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpFormError, setMcpFormError] = useState<string | null>(null);
  const [mcpApproval, setMcpApproval] = useState<HarnessMcpReview | null>(null);
  const [mcpApprovalLoading, setMcpApprovalLoading] = useState(false);
  const [mcpApprovalError, setMcpApprovalError] = useState<string | null>(null);
  const [mcpApprovalVersion, setMcpApprovalVersion] = useState(0);
  const [mcpConsentBusy, setMcpConsentBusy] = useState(false);

  useEffect(() => {
    void s.refreshLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.preview]);

  // Asking GitHub for newer commits waits until the user looks at what is installed.
  useEffect(() => {
    if (tab === "discover" || updatesChecked.current || !s.library) return;
    if (!s.library.plugins.length && !s.library.marketplaces.length) return;
    updatesChecked.current = true;
    void s.checkLibraryUpdates().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, s.library]);

  const harnessThread = thread ?? null;
  const harnessSessionId = harnessThread?.sessionId ?? null;
  const mcpGrantId = activeWorkspace(s)?.grantId ?? (s.preview ? "preview" : null);
  const mcpApproved = Boolean(mcpApproval?.trusted && mcpApproval.current);
  const mcpReviewReady = Boolean(s.harnessMcpConfig && !s.harnessMcpConfigLoading && !s.harnessMcpConfigError && !s.harnessMcpConfig.error);
  useEffect(() => {
    if (!harnessThread) return;
    void s.refreshHarnessMcp(harnessThread.sessionId);
    void s.refreshHarnessMcpConfig(harnessThread.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessThread?.sessionId]);

  useEffect(() => {
    let cancelled = false;
    setMcpApproval(null);
    setMcpApprovalError(null);
    if (!harnessSessionId || !mcpGrantId) {
      setMcpApprovalLoading(false);
      return;
    }
    setMcpApprovalLoading(true);
    void reviewMcp(mcpGrantId).then((review) => {
      if (!cancelled) setMcpApproval(review);
    }).catch((error) => {
      if (!cancelled) setMcpApprovalError(describeError("Could not review MCP startup approval", error));
    }).finally(() => {
      if (!cancelled) setMcpApprovalLoading(false);
    });
    return () => { cancelled = true; };
  }, [harnessSessionId, mcpGrantId, mcpApprovalVersion]);

  const changeMcpConsent = async (approve: boolean) => {
    if (!harnessThread || !mcpGrantId || mcpConsentBusy) return;
    const expectedDigest = mcpApproval?.configurationDigest;
    if (approve && (!mcpReviewReady || !mcpApproval?.hasWorkspaceConfig || !expectedDigest)) return;
    const sessionId = harnessThread.sessionId;
    const grantId = mcpGrantId;
    const owns = () => {
      const current = useAppStore.getState();
      const currentGrant = activeWorkspace(current)?.grantId ?? (current.preview ? "preview" : null);
      return currentThread(current)?.sessionId === sessionId && currentGrant === grantId;
    };
    setMcpConsentBusy(true);
    setMcpApprovalError(null);
    try {
      await consentMcp(grantId, approve, approve ? expectedDigest : undefined);
      if (!owns()) return;
      const review = await reviewMcp(grantId);
      if (!owns()) return;
      setMcpApproval(review);
      await Promise.all([s.refreshHarnessMcp(sessionId, true), s.refreshHarnessMcpConfig(sessionId)]);
    } catch (error) {
      if (!owns()) return;
      if (/configuration changed/i.test(String(error))) setMcpApprovalVersion((version) => version + 1);
      else setMcpApprovalError(describeError("Could not update MCP startup approval", error));
    } finally {
      setMcpConsentBusy(false);
    }
  };

  const refreshHarnessMcp = (refresh: boolean) => {
    if (!harnessThread) return;
    if (refresh) setMcpApprovalVersion((version) => version + 1);
    void s.refreshHarnessMcp(harnessThread.sessionId, refresh);
    void s.refreshHarnessMcpConfig(harnessThread.sessionId);
  };

  const submitMcpServer = async (event: FormEvent) => {
    event.preventDefault();
    if (!harnessThread || mcpBusy || mcpConsentBusy) return;
    const name = mcpName.trim();
    const problem = mcpServerNameProblem(name);
    if (problem) { setMcpFormError(problem); return; }
    let server: HarnessMcpServerInput;
    try {
      if (mcpTransport === "stdio") {
        const command = mcpCommand.trim();
        if (!command) throw new Error("A stdio server needs a command, such as npx.");
        server = { name, transport: "stdio", command, args: parseMcpArguments(mcpArgs), env: parseMcpKeyValues(mcpEnv, "env") };
      } else {
        const url = mcpUrl.trim();
        if (!url) throw new Error("An HTTP server needs a URL.");
        server = { name, transport: "http", url, headers: parseMcpKeyValues(mcpHeaders, "headers") };
      }
    } catch (error) {
      setMcpFormError(describeError("Check the server details", error));
      return;
    }
    setMcpBusy(true); setMcpFormError(null);
    try {
      await s.addHarnessMcpServer(harnessThread.sessionId, mcpScope, server);
      setMcpApprovalVersion((version) => version + 1);
      setMcpName(""); setMcpCommand(""); setMcpArgs(""); setMcpUrl(""); setMcpEnv(""); setMcpHeaders("");
      setMcpFormOpen(false);
    } catch (error) {
      setMcpFormError(describeError("Could not add the server", error));
    } finally {
      setMcpBusy(false);
    }
  };

  const removeMcpServer = async (server: HarnessMcpConfigServer) => {
    if (!harnessThread || mcpConsentBusy) return;
    const where = server.source === "workspace" ? "this workspace" : "your home folder";
    if (!(await s.confirm({ title: `Remove ${server.name}?`, body: `Its entry is removed from ${where}'s .glitter/mcp.json.`, confirmLabel: "Remove", danger: true }))) return;
    setMcpRowBusy(server.name); setMcpError(null);
    try {
      await s.removeHarnessMcpServer(harnessThread.sessionId, server.source, server.name);
      setMcpApprovalVersion((version) => version + 1);
    } catch (error) {
      setMcpError(describeError("Could not remove the server", error));
    } finally {
      setMcpRowBusy(null);
    }
  };

  const refreshSkills = async () => {
    if (!thread || skillsBusy) return;
    setSkillsBusy(true);
    try { await s.refreshSkills(thread.sessionId); }
    finally { setSkillsBusy(false); }
  };

  const useSkill = (row: SkillRow) => {
    s.setComposer(skillUseText(row.selector, s.composer));
    // From Settings the composer is behind the dialog; close it so the
    // inserted text is where the user is looking.
    if (embedded) s.setSettingsOpen(false);
    onOpenThreads?.();
  };

  const skills = thread ? thread.skills : null;
  const skillsState = !thread ? "none" : skills == null ? "unloaded" : skills.length ? "ready" : "empty";

  const storeInstalled = s.catalogEntries.filter((entry) => entry.installed || entry.installedParts > 0);
  const installedCount = (s.library?.plugins.length ?? 0) + storeInstalled.length;

  const removeStoreEntry = async (id: string, name: string) => {
    const ok = await s.confirm({ title: `Remove ${name}?`, body: "Its store-installed skills and server entries are removed. Anything you changed or added yourself is kept.", confirmLabel: "Remove", danger: true });
    if (!ok) return;
    setStoreBusy(id); setStoreError(null);
    try {
      const result = await s.removeCatalogEntry(id, harnessThread?.sessionId);
      if (result.errors.length) setStoreError(`${name}: ${result.errors.join(" ")}`);
    } catch (error) {
      setStoreError(describeError(`Could not remove ${name}`, error));
    } finally {
      setStoreBusy(null);
    }
  };

  const Shell = embedded ? "div" : "main";
  const shellProps = embedded
    ? { className: "extensions-embed" }
    : { id: "main-content", tabIndex: -1, className: "main extensions-main solo" };

  return (
    <Shell {...shellProps}>
      {embedded ? null : (
        <header className="topbar extensions-topbar" data-tauri-drag-region>
          <div>
            <h1>Extensions</h1>
            <span>Skills and MCP servers for {thread ? `“${thread.title}”` : "the selected thread"}</span>
          </div>
        </header>
      )}
      <div className="extensions-scroll">
        <div className="plugins-bar" ref={bar}>
          <span className="plugins-tabs" role="tablist" aria-label="Extensions">
            {TABS.map((option) => {
              const count = option.id === "installed" ? installedCount : option.id === "sources" ? s.library?.marketplaces.length ?? 0 : 0;
              const updates = option.id === "installed" ? s.libraryUpdates.filter((update) => update.kind === "plugin").length : 0;
              return (
                <button key={option.id} type="button" role="tab" id={`library-tab-${option.id}`} aria-controls={`library-panel-${option.id}`} aria-selected={tab === option.id} onClick={() => showTab(option.id)}>
                  {option.label}
                  {count ? <span className="plugins-tab-count">{count}</span> : null}
                  {updates ? <span className="plugins-tab-dot" aria-label={`${updates} update${updates === 1 ? "" : "s"}`} /> : null}
                </button>
              );
            })}
          </span>
          <button type="button" className="primary plugins-add" onClick={() => openGithub({})}><FolderGit2 size={13} aria-hidden="true" />Add from GitHub</button>
        </div>
        <div className="plugins-panel" role="tabpanel" id="library-panel-discover" aria-labelledby="library-tab-discover" hidden={tab !== "discover"}>
          <ExtensionsStore source={discoverSource} onSource={setDiscoverSource} onOpen={openGithub} />
        </div>
        <div className="plugins-panel" role="tabpanel" id="library-panel-sources" aria-labelledby="library-tab-sources" hidden={tab !== "sources"}>
          <PluginSources onOpen={openGithub} onBrowse={(id) => { setDiscoverSource(id); showTab("discover"); }} />
        </div>
        <div className="plugins-panel" role="tabpanel" id="library-panel-installed" aria-labelledby="library-tab-installed" hidden={tab !== "installed"}>
        <InstalledPlugins onOpen={openGithub} />
        {storeInstalled.length ? <section className="extensions-section" aria-labelledby="extensions-bundled-title">
          <div className="extensions-section-head">
            <h2 id="extensions-bundled-title"><Package size={15} aria-hidden="true" />From the store<span className="section-count">{storeInstalled.length}</span></h2>
          </div>
          {storeError ? <p className="permission-note" role="alert">{storeError}</p> : null}
          <ul className="extension-list">
            {storeInstalled.map((entry) => (
              <li key={entry.id} className="extension-card">
                <ExtensionThumb kind={entry.kind} id={entry.id} name={entry.name} size={32} />
                <span className="extension-copy">
                  <span className="plugins-name">{entry.name}{entry.installed ? null : <span className="picker-tag warm">{entry.installedParts}/{entry.totalParts} installed</span>}</span>
                  <span className="extension-meta plugins-description">{entry.summary}</span>
                </span>
                <span className="extension-actions">
                  <button type="button" className="ghost-btn small" disabled={storeBusy === entry.id} title={`Remove ${entry.name}`} onClick={() => void removeStoreEntry(entry.id, entry.name)}><Trash2 size={11} />{storeBusy === entry.id ? "Working…" : "Remove"}</button>
                </span>
              </li>
            ))}
          </ul>
        </section> : null}
        <section className="extensions-section" aria-labelledby="extensions-skills-title">
          <div className="extensions-section-head">
            <h2 id="extensions-skills-title"><Puzzle size={15} aria-hidden="true" />Skills</h2>
            <button type="button" className="ghost-btn small" disabled={!thread || skillsBusy} onClick={() => void refreshSkills()}>
              <RefreshCw size={11} className={skillsBusy ? "spin" : ""} />{skillsBusy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {skillsState === "none" ? <p className="permission-note extension-empty">Open a thread to see its skills.</p> : null}
          {thread ? <p className="permission-note">The agent loads skills from <code>.glitter/skills</code> and <code>.agents/skills</code>, in the workspace and in your home folder. A workspace skill wins over a home one with the same name.</p> : null}
          {skillsState === "unloaded" ? <p className="permission-note">The skill catalog has not loaded yet. Refresh to fetch it.</p> : null}
          {skillsState === "empty" ? <p className="permission-note">No skills yet. Install one from Discover, or add a folder with a SKILL.md to one of those places, then refresh.</p> : null}
          {skillsState === "ready" ? <ul className="extension-list">
            {(skills ?? []).map((row) => <SkillCard key={`${row.source ?? ""}:${row.selector}`} row={row} onUse={useSkill} />)}
          </ul> : null}
        </section>
        <section className="extensions-section" aria-labelledby="extensions-mcp-title">
          <div className="extensions-section-head">
            <h2 id="extensions-mcp-title"><Server size={15} aria-hidden="true" />MCP servers</h2>
            <span className="extension-actions">
              {harnessThread ? <button
                type="button"
                className="ghost-btn small"
                aria-expanded={mcpFormOpen}
                disabled={mcpConsentBusy}
                onClick={() => { setMcpFormOpen(!mcpFormOpen); setMcpFormError(null); }}
              >
                <Plus size={11} />{mcpFormOpen ? "Close form" : "Add server"}
              </button> : null}
              <button
                type="button"
                className="ghost-btn small"
                disabled={!harnessThread || Boolean(s.harnessMcpLoading || s.harnessMcpConfigLoading || mcpConsentBusy)}
                onClick={() => refreshHarnessMcp(true)}
              >
                <RefreshCw size={11} className={s.harnessMcpLoading || s.harnessMcpConfigLoading ? "spin" : ""} />{s.harnessMcpLoading || s.harnessMcpConfigLoading ? "Refreshing…" : "Refresh"}
              </button>
            </span>
          </div>
          {harnessThread ? <>
            <p className="permission-note">Servers come from .glitter/mcp.json: this workspace's file first, then your home folder. Workspace servers need startup approval, and tool calls still follow the thread's permissions.</p>
            {mcpApprovalError ? <p className="permission-note" role="alert">{mcpApprovalError} <button type="button" className="ghost-btn small" onClick={() => setMcpApprovalVersion((version) => version + 1)}>Retry review</button></p> : null}
            {mcpApprovalLoading && !mcpApproval ? <div className="extension-card mcp-consent"><span className="extension-copy"><span className="extension-name">Checking MCP startup approval…</span><span className="extension-meta">The redacted server configuration remains available below.</span></span></div> : null}
            {mcpApproval?.hasWorkspaceConfig ? <div className="extension-card mcp-consent">
              <span className="extension-copy">
                <span className="extension-name">{mcpApproved ? "MCP startup approved" : mcpApproval.trusted ? "MCP configuration changed" : "MCP startup approval needed"}<span className={mcpApproved ? "picker-tag" : "picker-tag warm"}>{mcpApproved ? "Approved" : "Disabled"}</span></span>
                <span className="extension-meta">{mcpApproved ? "This exact workspace and home configuration may start. Any change requires review again." : "Review the redacted rows below. Workspace servers stay off until you approve the exact workspace and home configuration shown now."}</span>
              </span>
              <span className="extension-actions">
                {mcpApproved ? <button type="button" className="ghost-btn small" disabled={mcpConsentBusy || mcpApprovalLoading} onClick={() => void changeMcpConsent(false)}>{mcpConsentBusy ? "Revoking…" : "Revoke approval"}</button> : <>
                  <button type="button" className="ghost-btn small" disabled={mcpConsentBusy || mcpApprovalLoading} onClick={() => void changeMcpConsent(false)}>Keep disabled</button>
                  <button type="button" className="primary" disabled={mcpConsentBusy || mcpApprovalLoading || !mcpReviewReady || !mcpApproval.configurationDigest} onClick={() => void changeMcpConsent(true)}>{mcpConsentBusy ? "Applying…" : "Approve startup"}</button>
                </>}
              </span>
            </div> : null}
            {s.harnessMcpError ? <p className="permission-note" role="alert">{s.harnessMcpError}</p> : null}
            {s.harnessMcpConfigError ? <p className="permission-note" role="alert">{s.harnessMcpConfigError}</p> : null}
            {s.harnessMcp?.error ? <p className="permission-note" role="alert">{s.harnessMcp.error}</p> : null}
            {s.harnessMcpConfig?.error ? <p className="permission-note" role="alert">{s.harnessMcpConfig.error}</p> : null}
            {mcpError ? <p className="permission-note" role="alert">{mcpError}</p> : null}
            {mcpFormOpen ? <form className="mcp-form" onSubmit={(event) => void submitMcpServer(event)}>
              <div className="mcp-form-grid">
                <div className="field">
                  <label htmlFor="mcp-name">Name</label>
                  <input id="mcp-name" value={mcpName} autoComplete="off" spellCheck={false} disabled={mcpBusy} placeholder="docs" onChange={(event) => setMcpName(event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="mcp-scope">Save to</label>
                  <select id="mcp-scope" value={mcpScope} disabled={mcpBusy} onChange={(event) => setMcpScope(event.target.value as HarnessMcpScope)}>
                    <option value="workspace">This workspace</option>
                    <option value="home">Home folder</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="mcp-transport">Connection</label>
                  <select id="mcp-transport" value={mcpTransport} disabled={mcpBusy} onChange={(event) => setMcpTransport(event.target.value as "stdio" | "http")}>
                    <option value="stdio">stdio · a local command</option>
                    <option value="http">HTTP · a URL</option>
                  </select>
                </div>
              </div>
              {mcpTransport === "stdio" ? <>
                <div className="field">
                  <label htmlFor="mcp-command">Command</label>
                  <input id="mcp-command" value={mcpCommand} autoComplete="off" spellCheck={false} disabled={mcpBusy} placeholder="npx" onChange={(event) => setMcpCommand(event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="mcp-args">Arguments</label>
                  <input id="mcp-args" value={mcpArgs} autoComplete="off" spellCheck={false} disabled={mcpBusy} placeholder="-y @modelcontextprotocol/server-filesystem ." onChange={(event) => setMcpArgs(event.target.value)} />
                  <span className="field-help">Split on spaces. Use quotes for an argument that contains spaces.</span>
                </div>
                <div className="field">
                  <label htmlFor="mcp-env">Environment (optional)</label>
                  <textarea id="mcp-env" value={mcpEnv} rows={3} spellCheck={false} disabled={mcpBusy} placeholder={"GITHUB_TOKEN=…\nLOG_LEVEL=debug"} onChange={(event) => setMcpEnv(event.target.value)} />
                  <span className="field-help">One NAME=value per line. Values are written to the file and never shown again.</span>
                </div>
              </> : <>
                <div className="field">
                  <label htmlFor="mcp-url">URL</label>
                  <input id="mcp-url" type="url" value={mcpUrl} autoComplete="off" spellCheck={false} disabled={mcpBusy} placeholder="https://example.com/mcp" onChange={(event) => setMcpUrl(event.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="mcp-headers">Headers (optional)</label>
                  <textarea id="mcp-headers" value={mcpHeaders} rows={3} spellCheck={false} disabled={mcpBusy} placeholder={"Authorization: Bearer …"} onChange={(event) => setMcpHeaders(event.target.value)} />
                  <span className="field-help">One Name: value per line. Values are written to the file and never shown again.</span>
                </div>
              </>}
              {mcpFormError ? <p className="permission-note" role="alert">{mcpFormError}</p> : null}
              <div className="mcp-form-actions">
                <button type="button" className="ghost-btn small" disabled={mcpBusy} onClick={() => { setMcpFormOpen(false); setMcpFormError(null); }}>Cancel</button>
                <button type="submit" className="primary" disabled={mcpBusy || mcpConsentBusy}>{mcpBusy ? "Adding…" : "Add server"}</button>
              </div>
            </form> : null}
            {s.harnessMcpConfig?.servers.length ? <ul className="extension-list">
              {s.harnessMcpConfig.servers.map((server) => {
                const tools = s.harnessMcp?.servers.find((row) => row.name === server.name)?.tools;
                return (
                  <li key={`${server.source}:${server.name}`} className="extension-card">
                    <ExtensionThumb kind="mcp" id={server.name} size={32} />
                    <span className="extension-copy">
                      <span className="extension-name">{server.name}<span className="picker-tag">{server.source === "workspace" ? "Workspace" : "Home"}</span><span className="picker-tag">{server.transport}</span>{tools != null ? <span className="picker-tag">{tools} tool{tools === 1 ? "" : "s"}</span> : null}{server.error ? <span className="picker-tag warm">Needs attention</span> : null}</span>
                      <span className="extension-meta">{mcpServerSummary(server)}</span>
                      {server.error ? <span className="extension-meta mcp-error">{server.error}</span> : null}
                    </span>
                    <span className="extension-actions">
                      <button type="button" className="ghost-btn small" disabled={mcpConsentBusy || mcpRowBusy === server.name} title={`Remove ${server.name}`} onClick={() => void removeMcpServer(server)}>{mcpRowBusy === server.name ? "Removing…" : "Remove"}</button>
                    </span>
                  </li>
                );
              })}
            </ul> : null}
            {!s.harnessMcpConfig?.servers.length && !s.harnessMcpConfigLoading && !mcpFormOpen ? <p className="permission-note extension-empty">No MCP servers are configured. Install one from Discover, add one here, or write .glitter/mcp.json yourself.</p> : null}
          </> : <p className="permission-note extension-empty">Open a thread to see its MCP servers.</p>}
        </section>
        </div>
      </div>
      <GithubInstallDialog request={github} onClose={() => setGithub(null)} onAddedSource={(id) => { setDiscoverSource(id); showTab("discover"); }} />
    </Shell>
  );
}
