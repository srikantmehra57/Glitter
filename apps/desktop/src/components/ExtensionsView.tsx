import { useEffect, useState, type FormEvent } from "react";
import { describeError } from "../lib/errors";
import { useShallow } from "zustand/react/shallow";
import { Check, KeyRound, LogOut, Package, Plus, Puzzle, RefreshCw, Server, WandSparkles, X } from "lucide-react";
import { consentMcp, mcpLogin, mcpLogout, pluginInspect, pluginReview, reviewMcp, skillInspect, skillSet } from "../lib/bridge";
import { skillSelectorText, skillUseText } from "../lib/composerText";
import { ExtensionThumb } from "./ExtensionThumb";
import { mcpServerNameProblem, mcpServerSummary, parseMcpArguments, parseMcpKeyValues } from "../lib/mcpConfig";
import { activeWorkspace, currentThread, currentWorkspace, supportsSkills, useAppStore } from "../lib/store";
import { skillScopeArg, type HarnessMcpConfigServer, type HarnessMcpReview, type HarnessMcpScope, type HarnessMcpServerInput, type PluginDetail, type SkillDetail, type SkillEntry, type SkillRow } from "../lib/types";
import { ExtensionsStore } from "./ExtensionsStore";

const selectorText = (row: SkillRow) => skillSelectorText(row.selector);

function SkillCard({ row, onUse }: { row: SkillRow; onUse: (row: SkillRow) => void }) {
  return (
    <li className="extension-card">
      <ExtensionThumb kind="skill" id={row.selector} name={row.displayName ?? row.selector} size={32} />
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
    museBin: state.museBin,
    mcpServers: state.mcpServers,
    mcpLoading: state.mcpLoading,
    mcpError: state.mcpError,
    harnessMcp: state.harnessMcp,
    harnessMcpLoading: state.harnessMcpLoading,
    harnessMcpError: state.harnessMcpError,
    harnessMcpConfig: state.harnessMcpConfig,
    harnessMcpConfigLoading: state.harnessMcpConfigLoading,
    harnessMcpConfigError: state.harnessMcpConfigError,
    pluginEntries: state.pluginEntries,
    pluginsAvailableShown: state.pluginsAvailableShown,
    pluginsLoading: state.pluginsLoading,
    pluginsError: state.pluginsError,
    skillEntries: state.skillEntries,
    skillsLoading: state.skillsLoading,
    skillsError: state.skillsError,
    refreshMcpServers: state.refreshMcpServers,
    refreshHarnessMcp: state.refreshHarnessMcp,
    refreshHarnessMcpConfig: state.refreshHarnessMcpConfig,
    addHarnessMcpServer: state.addHarnessMcpServer,
    removeHarnessMcpServer: state.removeHarnessMcpServer,
    refreshSkills: state.refreshSkills,
    refreshManagedSkills: state.refreshManagedSkills,
    refreshPlugins: state.refreshPlugins,
    installPlugin: state.installPlugin,
    installSkill: state.installSkill,
    importSkills: state.importSkills,
    uninstallSkill: state.uninstallSkill,
    setComposer: state.setComposer,
    setSettingsOpen: state.setSettingsOpen,
    confirm: state.confirm,
  })));
  const thread = currentThread(s);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [skillBusy, setSkillBusy] = useState<string | null>(null);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [importFrom, setImportFrom] = useState<"claude" | "codex">("claude");
  const [importPreview, setImportPreview] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [inspectedSkill, setInspectedSkill] = useState<string | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [skillDetailLoading, setSkillDetailLoading] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState<string | null>(null);
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
    if (!s.preview) void s.refreshMcpServers();
    // Load the catalog once; per-session skills refresh with the thread lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.preview]);

  const harnessThread = thread?.agentId === "harness" ? thread : null;
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

  const authServer = async (server: string, login: boolean) => {
    setAuthBusy(server); setAuthError(null);
    try {
      if (login) await mcpLogin(server, s.museBin || undefined);
      else await mcpLogout(server, s.museBin || undefined);
      await s.refreshMcpServers();
    } catch (error) {
      setAuthError(describeError("Could not finish that", error));
    } finally {
      setAuthBusy(null);
    }
  };

  const skilled = thread != null && supportsSkills(thread.agentId);
  const harness = thread?.agentId === "harness";
  const skills = skilled ? thread.skills : null;
  const skillsState = !thread ? "none" : !skilled ? "foreign" : skills == null ? "unloaded" : skills.length ? "ready" : "empty";
  const workspace = currentWorkspace(s);

  const toggleSkill = async (entry: SkillEntry, enabled: boolean) => {
    const scope = skillScopeArg(entry.scope);
    if (!scope) return;
    if (scope === "project" && !workspace?.grantId) { setSkillError("Open a workspace to manage project skills."); return; }
    setSkillBusy(entry.id); setSkillError(null);
    try {
      await skillSet(entry.id, scope, enabled, workspace?.grantId ?? undefined, s.museBin || undefined);
      await s.refreshManagedSkills();
      if (thread && supportsSkills(thread.agentId)) await s.refreshSkills(thread.sessionId);
    } catch (error) {
      setSkillError(describeError("Could not finish that", error));
    } finally {
      setSkillBusy(null);
    }
  };

  const inspectPlugin = async (id: string) => {
    if (inspectedId === id) { setInspectedId(null); setDetail(null); setDetailError(null); return; }
    setInspectedId(id); setDetail(null); setDetailError(null); setDetailLoading(true);
    try {
      setDetail(await pluginInspect(id, s.museBin || undefined));
    } catch (error) {
      setDetailError(describeError("Could not finish that", error));
    } finally {
      setDetailLoading(false);
    }
  };

  const reviewPlugin = async (id: string, approve: boolean) => {
    const verb = approve ? "approve and enable" : "reject and disable";
    if (!(await s.confirm({ title: `${approve ? "Approve" : "Reject"} ${id}?`, body: `This ${verb}s its current runtime capabilities.`, confirmLabel: approve ? "Approve" : "Reject" }))) return;
    setReviewBusy(id); setReviewError(null);
    try {
      await pluginReview(id, approve, s.museBin || undefined);
      await s.refreshPlugins(s.pluginsAvailableShown);
      if (inspectedId === id) setDetail(await pluginInspect(id, s.museBin || undefined).catch(() => detail));
    } catch (error) {
      setReviewError(describeError("Could not finish that", error));
    } finally {
      setReviewBusy(null);
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
        <ExtensionsStore />
        <section className="extensions-section" aria-labelledby="extensions-skills-title">
          <div className="extensions-section-head">
            <h2 id="extensions-skills-title"><Puzzle size={15} aria-hidden="true" />Skills</h2>
            <button type="button" className="ghost-btn small" disabled={!skilled || skillsBusy} onClick={() => void refreshSkills()}>
              <RefreshCw size={11} className={skillsBusy ? "spin" : ""} />{skillsBusy ? "Refreshing…" : "Refresh"}
            </button>
          </div>
          {skillsState === "none" ? <p className="permission-note extension-empty">Open a thread to see its skills.</p> : null}
          {skillsState === "foreign" ? <p className="permission-note">Skills work with Muse and Harness; this thread runs on another agent.</p> : null}
          {harness ? <p className="permission-note">Harness loads skills from <code>.glitter/skills</code> and <code>.agents/skills</code>, in the workspace and in your home folder. A workspace skill wins over a home one with the same name.</p> : null}
          {skillsState === "unloaded" ? <p className="permission-note">The skill catalog has not loaded yet. Refresh to fetch it.</p> : null}
          {skillsState === "empty" ? <p className="permission-note">{harness ? "No skills yet. Install one from the Store above, or add a folder with a SKILL.md to one of those places, then refresh." : "No skills are available for this session. Workspace skills load only from trusted workspaces."}</p> : null}
          {skillsState === "ready" ? <ul className="extension-list">
            {(skills ?? []).map((row) => <SkillCard key={`${row.source ?? ""}:${row.selector}`} row={row} onUse={useSkill} />)}
          </ul> : null}
        </section>
        <section className="extensions-section" aria-labelledby="extensions-lifecycle-title">
          <div className="extensions-section-head">
            <h2 id="extensions-lifecycle-title"><WandSparkles size={15} aria-hidden="true" />Skill lifecycle</h2>
            <span className="extension-actions">
              <button type="button" className="ghost-btn small" disabled={s.skillsLoading} title="Install a skill from a folder" onClick={() => void s.installSkill()}>
                <WandSparkles size={11} />Install
              </button>
              <button type="button" className="ghost-btn small" disabled={s.skillsLoading} onClick={() => void s.refreshManagedSkills()}>
                <RefreshCw size={11} className={s.skillsLoading ? "spin" : ""} />{s.skillsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </span>
          </div>
          <p className="permission-note">Enable or disable CLI skills, including the open workspace's project skills.</p>
          {s.skillsError ? <p className="permission-note" role="alert">{s.skillsError}</p> : null}
          {skillError ? <p className="permission-note" role="alert">{skillError}</p> : null}
          <div className="import-row">
            <span className="import-label">Import from</span>
            <span className="usage-periods" role="tablist" aria-label="Import source">
              <button type="button" role="tab" aria-selected={importFrom === "claude"} onClick={() => { setImportFrom("claude"); setImportPreview(null); }}>Claude</button>
              <button type="button" role="tab" aria-selected={importFrom === "codex"} onClick={() => { setImportFrom("codex"); setImportPreview(null); }}>Codex</button>
            </span>
            <button
              type="button"
              className="secondary small"
              disabled={importBusy || s.skillsLoading}
              title={`Preview importing ${importFrom} skills`}
              onClick={() => {
                setImportBusy(true); setImportError(null);
                s.importSkills(importFrom, true).then(setImportPreview, (error) => setImportError(describeError("Could not finish that", error))).finally(() => setImportBusy(false));
              }}
            >{importBusy ? "Working…" : "Preview import"}</button>
            {importPreview ? <button
              type="button"
              className="ghost-btn small"
              disabled={importBusy || s.skillsLoading}
              title={`Import ${importFrom} skills into scope user`}
              onClick={() => {
                void s.confirm({ title: `Import ${importFrom} skills into your user scope?`, confirmLabel: "Import" }).then((ok) => {
                  if (!ok) return;
                  setImportBusy(true); setImportError(null);
                  s.importSkills(importFrom, false).then(() => setImportPreview(null), (error) => setImportError(describeError("Could not finish that", error))).finally(() => setImportBusy(false));
                });
              }}
            >Import</button> : null}
          </div>
          {importError ? <p className="permission-note" role="alert">{importError}</p> : null}
          {importPreview ? <pre className="import-preview">{importPreview}</pre> : null}
          {!s.skillEntries.length && !s.skillsLoading ? <p className="permission-note extension-empty">No skills found. Refresh to fetch the inventory.</p> : null}
          {s.skillEntries.length ? <ul className="extension-list">
            {s.skillEntries.map((entry) => {
              const scope = skillScopeArg(entry.scope);
              const on = entry.activation.toLowerCase() === "on";
              const uninstallable = entry.scope.toLowerCase() === "user" || entry.scope.toLowerCase() === "project" || entry.scope.toLowerCase() === "plugin";
              return (
                <li key={entry.id}>
                  <div className="extension-card">
                    <ExtensionThumb kind="skill" id={entry.id} size={32} />
                    <span className="extension-copy">
                      <span className="extension-name">{entry.id}<span className="picker-tag">{entry.scope || "unknown"}</span><span className={on ? "picker-tag" : "picker-tag warm"}>{on ? "On" : "Off"}</span></span>
                      {entry.description ? <span className="extension-meta">{entry.description}</span> : null}
                    </span>
                    <span className="extension-actions">
                      <button
                        type="button"
                        className="ghost-btn small"
                        aria-expanded={inspectedSkill === entry.id}
                        onClick={() => {
                          if (inspectedSkill === entry.id) { setInspectedSkill(null); setSkillDetail(null); setSkillDetailError(null); return; }
                          setInspectedSkill(entry.id); setSkillDetail(null); setSkillDetailError(null); setSkillDetailLoading(true);
                          skillInspect(entry.id, s.museBin || undefined).then(setSkillDetail, (error) => setSkillDetailError(describeError("Could not finish that", error))).finally(() => setSkillDetailLoading(false));
                        }}
                      >{inspectedSkill === entry.id ? "Hide" : "Inspect"}</button>
                      {uninstallable ? <button
                        type="button"
                        className="ghost-btn small"
                        disabled={s.skillsLoading}
                        title={`Uninstall ${entry.id}`}
                        onClick={() => { void s.confirm({ title: `Uninstall ${entry.id}?`, body: "Its files are removed. This cannot be undone.", confirmLabel: "Uninstall", danger: true }).then((ok) => { if (ok) void s.uninstallSkill(entry.id); }); }}
                      >Uninstall</button> : null}
                      {scope ? (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${on ? "Disable" : "Enable"} ${entry.id}`}
                          className="toggle"
                          disabled={skillBusy === entry.id}
                          onClick={() => void toggleSkill(entry, !on)}
                        ><i /></button>
                      ) : null}
                    </span>
                  </div>
                  {inspectedSkill === entry.id ? <div className="extension-detail">
                    {skillDetailLoading ? <p className="permission-note">Inspecting {entry.id}…</p> : null}
                    {skillDetailError ? <p className="permission-note" role="alert">{skillDetailError}</p> : null}
                    {skillDetail && !skillDetailLoading ? <>
                      {skillDetail.description ? <p className="permission-note">{skillDetail.description}</p> : null}
                      <p className="permission-note">Scope {skillDetail.scope || "unknown"} · {skillDetail.activation === "on" ? "on" : "off"}{skillDetail.path ? <> · <span className="extension-name">{skillDetail.path}</span></> : null}</p>
                    </> : null}
                  </div> : null}
                </li>
              );
            })}
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
                disabled={harnessThread ? Boolean(s.harnessMcpLoading || s.harnessMcpConfigLoading || mcpConsentBusy) : s.mcpLoading}
                onClick={() => { if (harnessThread) refreshHarnessMcp(true); else void s.refreshMcpServers(); }}
              >
                <RefreshCw size={11} className={(harnessThread ? (s.harnessMcpLoading || s.harnessMcpConfigLoading) : s.mcpLoading) ? "spin" : ""} />{(harnessThread ? (s.harnessMcpLoading || s.harnessMcpConfigLoading) : s.mcpLoading) ? "Refreshing…" : "Refresh"}
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
            {!s.harnessMcpConfig?.servers.length && !s.harnessMcpConfigLoading && !mcpFormOpen ? <p className="permission-note extension-empty">No MCP servers are configured. Install one from the Store above, add one here, or write .glitter/mcp.json yourself.</p> : null}
          </> : <>
            <p className="permission-note">Servers configured for the Muse CLI. OAuth servers need a sign-in before their tools work.</p>
            {s.mcpError ? <p className="permission-note" role="alert">{s.mcpError}</p> : null}
            {authError ? <p className="permission-note" role="alert">{authError}</p> : null}
            {!s.mcpServers.length && !s.mcpLoading ? <p className="permission-note extension-empty">No MCP servers are configured. Add them with the Muse CLI, then refresh.</p> : null}
            {s.mcpServers.length ? <ul className="extension-list">
              {s.mcpServers.map((server) => (
                <li key={server.name} className="extension-card">
                  <ExtensionThumb kind="mcp" id={server.name} size={32} />
                  <span className="extension-copy">
                    <span className="extension-name">{server.name}<span className="picker-tag">{server.transport}</span>{server.oauth ? <span className="picker-tag">OAuth</span> : null}</span>
                  </span>
                  {server.oauth ? (
                    <span className="extension-actions">
                      <button type="button" className="ghost-btn small" disabled={authBusy === server.name} title={`Sign in to ${server.name}`} onClick={() => void authServer(server.name, true)}>
                        <KeyRound size={11} />{authBusy === server.name ? "Working…" : "Sign in"}
                      </button>
                      <button type="button" className="ghost-btn small" disabled={authBusy === server.name} title={`Remove the saved credential for ${server.name}`} onClick={() => { void s.confirm({ title: `Remove the saved credential for ${server.name}?`, body: "The next connection asks you to sign in to this server again.", confirmLabel: "Remove", danger: true }).then((ok) => { if (ok) void authServer(server.name, false); }); }}>
                        <LogOut size={11} />Sign out
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul> : null}
          </>}
        </section>
        <section className="extensions-section" aria-labelledby="extensions-plugins-title">
          <div className="extensions-section-head">
            <h2 id="extensions-plugins-title"><Package size={15} aria-hidden="true" />Plugins</h2>
            <span className="extension-actions">
              <span className="usage-periods" role="tablist" aria-label="Plugin inventory">
                <button type="button" role="tab" aria-selected={!s.pluginsAvailableShown} onClick={() => void s.refreshPlugins(false)}>Installed</button>
                <button type="button" role="tab" aria-selected={s.pluginsAvailableShown} onClick={() => void s.refreshPlugins(true)}>Available</button>
              </span>
              <button type="button" className="ghost-btn small" disabled={s.pluginsLoading} title="Install a plugin from a bundle folder" onClick={() => void s.installPlugin()}>
                <Package size={11} />Install
              </button>
              <button type="button" className="ghost-btn small" disabled={s.pluginsLoading} onClick={() => void s.refreshPlugins(s.pluginsAvailableShown)}>
                <RefreshCw size={11} className={s.pluginsLoading ? "spin" : ""} />{s.pluginsLoading ? "Refreshing…" : "Refresh"}
              </button>
            </span>
          </div>
          <p className="permission-note">Inspect a plugin's runtime capabilities before approving it. Per-capability review and marketplace management still need the CLI.</p>
          {s.pluginsError ? <p className="permission-note" role="alert">{s.pluginsError}</p> : null}
          {reviewError ? <p className="permission-note" role="alert">{reviewError}</p> : null}
          {!s.pluginEntries.length && !s.pluginsLoading ? <p className="permission-note extension-empty">{s.pluginsAvailableShown ? "No marketplace plugins are available." : "No CLI plugins are installed. The Store above has skill bundles that install without a CLI."}</p> : null}
          {s.pluginEntries.length ? <ul className="extension-list">
            {s.pluginEntries.map((plugin) => (
              <li key={plugin.id}>
                <div className="extension-card">
                  <ExtensionThumb kind="plugin" id={plugin.id} size={32} />
                  <span className="extension-copy">
                    <span className="extension-name">{plugin.id}{plugin.version ? <span className="picker-tag">v{plugin.version}</span> : null}{plugin.enabled == null ? null : plugin.enabled ? <span className="picker-tag">Enabled</span> : <span className="picker-tag warm">Disabled</span>}</span>
                    {plugin.description ? <span className="extension-meta">{plugin.description}</span> : null}
                  </span>
                  <span className="extension-actions">
                    <button type="button" className="ghost-btn small" aria-expanded={inspectedId === plugin.id} onClick={() => void inspectPlugin(plugin.id)}>
                      {inspectedId === plugin.id ? "Hide" : "Inspect"}
                    </button>
                    {!s.pluginsAvailableShown ? <>
                      <button type="button" className="ghost-btn small" disabled={reviewBusy === plugin.id} title={`Approve and enable ${plugin.id}`} onClick={() => void reviewPlugin(plugin.id, true)}>
                        <Check size={11} />{reviewBusy === plugin.id ? "Working…" : "Approve"}
                      </button>
                      <button type="button" className="ghost-btn small" disabled={reviewBusy === plugin.id} title={`Reject and disable ${plugin.id}`} onClick={() => void reviewPlugin(plugin.id, false)}>
                        <X size={11} />Reject
                      </button>
                    </> : null}
                  </span>
                </div>
                {inspectedId === plugin.id ? <div className="extension-detail">
                  {detailLoading ? <p className="permission-note">Inspecting {plugin.id}…</p> : null}
                  {detailError ? <p className="permission-note" role="alert">{detailError}</p> : null}
                  {detail && !detailLoading ? detail.capabilities.length ? <ul className="capability-list">
                    {detail.capabilities.map((cap) => (
                      <li key={cap.id}>
                        <span className="extension-name">{cap.id}{cap.kind ? <span className="picker-tag">{cap.kind}</span> : null}{cap.enabled == null ? null : cap.enabled ? <span className="picker-tag">On</span> : <span className="picker-tag warm">Off</span>}</span>
                        <span className="extension-meta">{cap.description}</span>
                      </li>
                    ))}
                  </ul> : <p className="permission-note">No runtime capabilities reported.</p> : null}
                </div> : null}
              </li>
            ))}
          </ul> : null}
        </section>
      </div>
    </Shell>
  );
}
