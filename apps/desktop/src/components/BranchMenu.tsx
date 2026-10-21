import { useEffect, useRef, useState } from "react";
import { EXIT_FAST_MS, usePresence } from "../lib/presence";
import { Check, GitBranch, Plus } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { describeError } from "../lib/errors";
import { useAppStore } from "../lib/store";

/** The branch chip in the thread header: shows the current branch and switches or creates one. */
export function BranchMenu({ branch, worktree, locked }: { branch: string; worktree: boolean; locked: boolean }) {
  const s = useAppStore(useShallow((state) => ({
    dirty: Boolean(state.git?.dirty),
    repository: state.git?.repository !== false && Boolean(state.git),
    branches: state.branches,
    refreshBranches: state.refreshBranches,
    switchBranch: state.switchBranch,
    confirm: state.confirm,
  })));
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const pop = usePresence(open, EXIT_FAST_MS);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const label = `${worktree ? "Worktree branch" : "Current branch"}: ${branch}${s.dirty ? " · uncommitted changes" : ""}`;
  const chip = <><GitBranch size={12} aria-hidden="true" /><span className="branch-name">{branch}</span>{s.dirty ? <i className="dirty" aria-label="uncommitted changes" /> : null}</>;
  // Without a repository snapshot there is nothing to switch; the chip stays a label.
  if (!s.repository) return <span className="branch" title={label}>{chip}</span>;
  const go = async (target: string, create: boolean) => {
    if (busy || !target.trim()) return;
    setError(null);
    // Git carries uncommitted changes to the other branch, and stops when it cannot.
    if (s.dirty && !(await s.confirm({ title: `${create ? "Create" : "Switch to"} ${target.trim()} with uncommitted changes?`, body: "Your changes come along. If they would be overwritten on that branch, nothing is switched.", confirmLabel: create ? "Create branch" : "Switch" }))) return;
    setBusy(true);
    try {
      await s.switchBranch(target.trim(), create);
      setName("");
      setOpen(false);
    } catch (cause) {
      setError(describeError(create ? "Could not create the branch" : "Could not switch branches", cause));
    } finally { setBusy(false); }
  };
  return <div ref={root} className="branch-menu" onKeyDown={(event) => { if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } }}>
    <button type="button" className="branch" aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={locked ? "Stop the running turn to switch branches" : label} disabled={locked} onClick={() => { if (!open) { setError(null); void s.refreshBranches(); } setOpen(!open); }}>{chip}</button>
    {pop.mounted ? <div className={`branch-popover${pop.closing ? " closing" : ""}`} role="dialog" aria-label="Branches">
      <form className="branch-new" onSubmit={(event) => { event.preventDefault(); void go(name, true); }}>
        <input aria-label="New branch name" placeholder="New branch from here" value={name} maxLength={200} spellCheck={false} autoFocus onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="ghost-btn small" disabled={busy || !name.trim()}><Plus size={12} />Create</button>
      </form>
      {error ? <p className="branch-error" role="alert">{error}</p> : null}
      <div className="menu-heading" aria-hidden="true">Recent branches</div>
      {!s.branches ? <p className="branch-note">Loading branches…</p> : <ul>
        {s.branches.map((item) => <li key={item.name}>
          <button type="button" disabled={busy || item.current} aria-current={item.current ? "true" : undefined} title={item.upstream ? `${item.name} → ${item.upstream}` : item.name} onClick={() => void go(item.name, false)}>
            <span className="branch-name">{item.name}</span>
            {item.current ? <Check size={12} aria-hidden="true" /> : null}
          </button>
        </li>)}
      </ul>}
    </div> : null}
  </div>;
}
