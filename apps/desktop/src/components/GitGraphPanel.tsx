import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { activeWorkspace, useAppStore } from "../lib/store";

/** Read-only, bounded history for the active workspace or thread worktree. */
export function GitGraphPanel() {
  const s = useAppStore(useShallow((state) => ({
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedSessionId: state.selectedSessionId,
    threads: state.threads,
    git: state.git,
    gitLoading: state.gitLoading,
    graph: state.gitGraph,
    loading: state.gitGraphLoading,
    error: state.gitGraphError,
    refresh: state.refreshGitGraph,
  })));
  const workspace = activeWorkspace(s);
  const key = workspace ? `${workspace.id}\u0000${workspace.grantId ?? ""}` : "";
  const graph = s.graph?.key === key ? s.graph.data : null;
  const loading = s.loading === key;
  const error = s.error?.key === key ? s.error.message : null;

  useEffect(() => {
    if (workspace && s.git && s.git.repository !== false && !graph && !loading && !error && !s.gitLoading) void s.refresh();
  }, [workspace?.id, workspace?.grantId, graph, loading, error, s.git, s.gitLoading, s.refresh]);

  return <div className="git-graph-panel scroll" aria-label="Git commit history">
    {!workspace ? <p className="review-note">Open a workspace to see its Git history.</p>
      : s.git?.repository === false ? <p className="review-note">Git Graph needs a Git repository. Initialize one from Changes first.</p>
      : error ? <div className="banner" role="alert"><span>{error}</span><button type="button" className="ghost-btn small" onClick={() => void s.refresh()}>Retry</button></div>
      : loading && !graph ? <p className="review-note">Loading Git history…</p>
      : graph ? <>
        {graph.truncated ? <p className="review-note">Showing the most recent 200 commits. Large output may be shortened further.</p> : null}
        {loading ? <p className="review-note" role="status">Refreshing Git history…</p> : null}
        {graph.graph.trim() ? <pre className="git-graph" tabIndex={0} aria-label="Commit history graph">{graph.graph}</pre> : <p className="review-note">No commits yet.</p>}
      </> : <p className="review-note">Loading Git history…</p>}
  </div>;
}
