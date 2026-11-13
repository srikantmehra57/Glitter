import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, GitCommitHorizontal, GitCompareArrows, GitGraph as GitGraphIcon, Globe2, Laptop, MousePointer2, Plug, Server } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { formatTokens } from "../lib/format";
import { activeWorkspace, currentThread, useAppStore } from "../lib/store";
import type { BrowserState } from "../lib/types";
import { Collapse } from "./Presence";

function EnvironmentSection({ title, summary, defaultOpen = false, trailing, children }: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  trailing?: ReactNode;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return <section className="environment-card">
    <button type="button" className="environment-card-head" aria-expanded={open} aria-controls={contentId} onClick={() => setOpen((value) => !value)}>
      <span className="environment-card-title">{title}</span>
      {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      {summary ? <span className="environment-card-summary">{summary}</span> : null}
      {trailing}
      {!summary && !trailing ? <span className="grow" /> : null}
    </button>
    <Collapse open={open}>{() => <div id={contentId} className="environment-card-body">{children()}</div>}</Collapse>
  </section>;
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function localServer(state: BrowserState | null) {
  if (state?.status !== "ready") return null;
  try {
    const url = new URL(state.url);
    if (!["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(url.hostname)) return null;
    return { name: state.title.trim() || url.hostname, address: url.host, url: state.url };
  } catch {
    return null;
  }
}

/** Workspace facts, Git destinations and agent-produced resources. */
export function EnvironmentPanel({ onCommitOrPush }: { onCommitOrPush: () => void }) {
  const s = useAppStore(useShallow((state) => ({
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    harnessMcp: state.harnessMcp,
    harnessMcpConfig: state.harnessMcpConfig,
    harnessMcpLoading: state.harnessMcpLoading,
    harnessMcpConfigLoading: state.harnessMcpConfigLoading,
    harnessMcpError: state.harnessMcpError,
    harnessMcpConfigError: state.harnessMcpConfigError,
    browserState: state.browserState,
    git: state.git,
    refreshHarnessMcp: state.refreshHarnessMcp,
    refreshHarnessMcpConfig: state.refreshHarnessMcpConfig,
    setSettingsOpen: state.setSettingsOpen,
    setInspectorTab: state.setInspectorTab,
    setBrowserOpen: state.setBrowserOpen,
    chooseProject: state.chooseProject,
    openFile: state.openFile,
  })));
  const workspace = activeWorkspace(s);
  const thread = currentThread(s);
  const sessionId = thread?.sessionId ?? null;

  useEffect(() => {
    if (!sessionId) return;
    void s.refreshHarnessMcp(sessionId);
    void s.refreshHarnessMcpConfig(sessionId);
  }, [sessionId, s.refreshHarnessMcp, s.refreshHarnessMcpConfig]);

  const context = thread?.context;
  const contextPercent = context?.windowTokens && context.usedTokens != null
    ? Math.min(100, Math.round((context.usedTokens / context.windowTokens) * 100))
    : null;
  const outputs = useMemo(() => {
    const seen = new Set<string>();
    const rows: Array<{ key: string; path: string; name: string }> = [];
    for (const item of thread?.items ?? []) {
      const path = item.presentation?.artifactPath?.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      rows.push({ key: item.itemId, path, name: fileName(path) });
    }
    return rows;
  }, [thread?.items]);

  const connectors = thread ? s.harnessMcpConfig?.servers ?? [] : [];
  const connectorsLoading = Boolean(thread && (s.harnessMcpLoading || s.harnessMcpConfigLoading));
  const connectorError = thread ? s.harnessMcpConfigError ?? s.harnessMcpError ?? s.harnessMcpConfig?.error ?? s.harnessMcp?.error : null;
  const connectorSummary = !thread ? "No thread" : connectorsLoading && !connectors.length ? "Loading…" : connectorError ? "Needs attention" : connectors.length ? `${connectors.length} configured` : "None";
  const server = localServer(s.browserState);
  const branch = s.git?.branch || thread?.hostBranch || "";
  const gitFiles = s.git?.files ?? [];
  const added = gitFiles.reduce((sum, file) => sum + file.added, 0);
  const removed = gitFiles.reduce((sum, file) => sum + file.removed, 0);
  const repository = Boolean(workspace && s.git && s.git.repository !== false);

  return <div className="environment-panel scroll" aria-label="Workspace environment">
    <EnvironmentSection title="Environmental Information" summary={branch || undefined} defaultOpen>{() => <>
      {workspace ? <button type="button" className="environment-row actionable" aria-label={`Changes, ${added} additions and ${removed} deletions`} onClick={() => s.setInspectorTab("changes")}>
        <span className="environment-icon"><GitCompareArrows size={15} aria-hidden="true" /></span>
        <span className="environment-primary">Changes</span>
        <span className="environment-diff"><span className={`add${added ? "" : " zero"}`}>+{added}</span><span className={`del${removed ? "" : " zero"}`}>−{removed}</span></span>
      </button> : null}
      {repository ? <>
        <button type="button" className="environment-row actionable" onClick={onCommitOrPush}>
          <span className="environment-icon"><GitCommitHorizontal size={15} aria-hidden="true" /></span>
          <span className="environment-primary">Commit or push</span>
        </button>
        <button type="button" className="environment-row actionable" onClick={() => s.setInspectorTab("graph")}>
          <span className="environment-icon"><GitGraphIcon size={15} aria-hidden="true" /></span>
          <span className="environment-primary">Git Graph</span>
        </button>
      </> : null}
      {workspace ? <div className="environment-git-divider" /> : null}
      <div className="environment-row">
        <span className="environment-icon"><Laptop size={15} aria-hidden="true" /></span>
        <span className="environment-primary">This computer</span>
      </div>
      {workspace ? <button type="button" className="environment-row actionable" title={workspace.path} onClick={() => s.setInspectorTab("files")}>
        <span className="environment-icon"><Folder size={15} aria-hidden="true" /></span>
        <span className="environment-primary">{workspace.name}</span>
        <span className="environment-secondary">{workspace.path}</span>
      </button> : <button type="button" className="environment-row actionable" onClick={() => void s.chooseProject()}>
        <span className="environment-icon"><Folder size={15} aria-hidden="true" /></span>
        <span className="environment-primary">Open a workspace</span>
      </button>}
      <div className="environment-row" title="Remote control is not available in Glitter. This workspace stays on this computer.">
        <span className="environment-icon"><MousePointer2 size={15} aria-hidden="true" /></span>
        <span className="environment-primary">Remote Control</span>
        <span className="environment-status">Local only</span>
      </div>
    </>}</EnvironmentSection>

    <EnvironmentSection title="Context" summary={contextPercent != null ? `${contextPercent}%` : "Not reported"} trailing={contextPercent != null ? <span className="environment-context-meter" aria-hidden="true"><span style={{ width: `${contextPercent}%` }} /></span> : undefined}>{() => <div className="environment-detail">
      {contextPercent != null && context ? <>
        <div className="environment-detail-row"><span>Context window used</span><strong>{formatTokens(context.usedTokens ?? 0)} / {formatTokens(context.windowTokens ?? 0)}</strong></div>
        <div className="environment-detail-row"><span>Remaining</span><strong>{formatTokens(Math.max(0, (context.windowTokens ?? 0) - (context.usedTokens ?? 0)))} tokens</strong></div>
      </> : <p>{thread ? "The agent has not reported context usage for this thread." : "Open a thread to see its context usage."}</p>}
    </div>}</EnvironmentSection>

    <EnvironmentSection title="Connectors" summary={connectorSummary}>{() => <>
      {connectorError ? <p className="environment-error" role="alert">{connectorError}</p> : null}
      {connectors.map((connector) => {
        const running = s.harnessMcp?.servers.find((item) => item.name === connector.name);
        const detail = `${connector.source === "workspace" ? "Workspace" : "Home"} · ${connector.transport}`;
        return <div className="environment-row" key={connector.name}>
          <span className="environment-icon"><Plug size={15} aria-hidden="true" /></span>
          <span className="environment-primary">{connector.name}</span>
          <span className="environment-secondary" title={detail}>{running ? `${running.tools} tools` : detail}</span>
        </div>;
      })}
      {!connectors.length && !connectorsLoading && !connectorError ? <p className="environment-empty">{thread ? "No MCP connectors configured." : "Open a thread to see its connectors."}</p> : null}
      {connectorsLoading && !connectors.length ? <p className="environment-empty">Loading connectors…</p> : null}
      {thread ? <div className="environment-card-actions"><button type="button" className="text-btn" onClick={() => s.setSettingsOpen(true, "Extensions")}>Manage connectors</button></div> : null}
    </>}</EnvironmentSection>

    <EnvironmentSection title="Outputs" defaultOpen>{() => <>
      {outputs.map((output) => <button type="button" className="environment-row actionable" key={output.key} title={output.path} onClick={() => void s.openFile(output.path)}>
        <span className="environment-icon">{/\.html?$/i.test(output.name) ? <Globe2 size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}</span>
        <span className="environment-primary">{output.name}</span>
      </button>)}
      {!outputs.length ? <p className="environment-empty">Saved tool outputs from this thread will appear here.</p> : null}
    </>}</EnvironmentSection>

    <EnvironmentSection title="Servers" defaultOpen>{() => <>
      {server ? <button type="button" className="environment-row actionable" aria-label={`Open ${server.name} in Browser`} title={server.url} onClick={() => s.setBrowserOpen(true)}>
        <span className="environment-icon"><Server size={15} aria-hidden="true" /></span>
        <span className="environment-primary">{server.name}</span>
        <span className="environment-secondary">{server.address}</span>
        <span className="environment-server-dot" aria-hidden="true" />
      </button> : <>
        <p className="environment-empty">Local servers opened in Browser will appear here.</p>
        {workspace ? <div className="environment-card-actions"><button type="button" className="text-btn" onClick={() => s.setBrowserOpen(true)}>Open Browser</button></div> : null}
      </>}
    </>}</EnvironmentSection>
  </div>;
}
