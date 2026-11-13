import { GitBranch } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { currentThread, currentWorkspace, useAppStore } from "../lib/store";
import { SelectMenu } from "./SelectMenu";

/**
 * Where a new thread works: the workspace folder, or a worktree of its
 * own. Shown in the thread header while the workspace draft is open; an
 * existing thread already has its place and shows its branch instead.
 */
export function WorkLocation() {
  const s = useAppStore(useShallow((state) => {
    const workspace = currentWorkspace(state);
    return {
      shown: Boolean(workspace) && !currentThread(state),
      worktree: workspace ? state.drafts[`project:${workspace.id}`]?.worktree : undefined,
      repository: state.git?.repository !== false,
      disabled: state.starting || state.submitting,
      setDraftWorktree: state.setDraftWorktree,
    };
  }));
  if (!s.shown) return null;
  const worktree = s.worktree;
  return <div className="work-location">
    <SelectMenu
      id="work-location"
      ariaLabel="Where this thread works"
      heading="Where this thread works"
      value={worktree ? "worktree" : "local"}
      placeholder="Local"
      disabled={s.disabled}
      icon={<GitBranch size={12} aria-hidden="true" />}
      options={[
        { value: "local", label: "Local", description: "Edit the workspace folder directly" },
        { value: "worktree", label: "Worktree", description: s.repository ? "Its own copy and branch" : "Needs a Git repository", disabled: !s.repository && !worktree },
      ]}
      onChange={(value) => s.setDraftWorktree(value === "worktree" ? { base: worktree?.base ?? "" } : null)}
    />
    {worktree ? <input aria-label="Base branch or commit" title="The worktree starts from the last commit of this branch. Leave empty for the current branch." placeholder="Base: current branch" value={worktree.base} maxLength={256} disabled={s.disabled} spellCheck={false} onChange={(event) => s.setDraftWorktree({ base: event.target.value })} /> : null}
  </div>;
}
