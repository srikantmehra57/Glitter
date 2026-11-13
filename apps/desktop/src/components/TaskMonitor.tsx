import { useMemo, useState } from "react";
import { describeError } from "../lib/errors";
import { Bot, Check, CircleAlert, CircleSlash, FileText, GitBranch, GitCompareArrows, ImageIcon, LoaderCircle, Monitor } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { openPath } from "../lib/bridge";
import { isTauri } from "../lib/format";
import { activeWorkspace, currentThread, useAppStore } from "../lib/store";
import { agentCounts, itemStatus } from "../lib/agent";
import type { TranscriptItem } from "../lib/types";

type MonitorSource =
  | { key: string; kind: "file"; name: string; path: string }
  | { key: string; kind: "image"; name: string; src: string };

type Subagent = { id: string; title: string; detail?: string; status: ReturnType<typeof itemStatus> };

// Subagents spawned inside this thread: the host's own subagent items, plus
// Task/Agent-style tool calls from agents that delegate through a tool.
const SUBAGENT_TOOL = /^(task|agent|subagent|spawn_?agent|dispatch_?agent)$/i;

/** A workflow's agents, one entry each, labelled with the workflow's name. */
function workflowAgents(item: TranscriptItem): Subagent[] {
  const { states } = agentCounts(item);
  return (item.children ?? []).map((child, index) => {
    const state = states[index];
    return {
      id: `${item.itemId}:${child.childId}:${child.attempt}`,
      title: child.label || `Agent ${index + 1}`,
      detail: [item.entryId, child.phase].filter(Boolean).join(" · ") || undefined,
      status: state === "pending" ? "running" : state,
    };
  });
}

function subagentFrom(item: TranscriptItem): Subagent | null {
  if (item.kind !== "subagent" && !(item.kind === "toolCall" && SUBAGENT_TOOL.test(item.tool ?? ""))) return null;
  let args: Record<string, unknown> = {};
  try { args = item.args ? JSON.parse(item.args) : {}; } catch { /* free-form args */ }
  const pick = (...keys: string[]) => keys.map((key) => args[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const title = item.objective || pick("description", "title", "name") || "Subagent";
  const detail = pick("subagent_type", "agent", "prompt") ?? item.fallbackText?.split("\n").find(Boolean);
  const status = item.failureReason ? "failed" : itemStatus(item.status);
  return { id: item.itemId, title, detail: detail && detail !== title ? detail : undefined, status };
}

function SubagentMark({ status }: { status: Subagent["status"] }) {
  if (status === "running") return <LoaderCircle size={14} className="spin" aria-label="Running" />;
  if (status === "failed") return <CircleAlert size={14} aria-label="Failed" />;
  if (status === "cancelled" || status === "skipped") return <CircleSlash size={14} aria-label="Stopped" />;
  return <Check size={14} aria-label="Done" />;
}

function fileName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** A line count; a zero recedes instead of drawing the eye in red or green. */
function DiffCount({ kind, value }: { kind: "add" | "del"; value: number }) {
  return <span className={`${kind}${value ? "" : " zero"}`}>{kind === "add" ? "+" : "−"}{value}</span>;
}

export function TaskMonitor() {
  const s = useAppStore(useShallow((state) => ({
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    workspaces: state.workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    contextRefs: state.contextRefs,
    images: state.images,
    git: state.git,
    setInspectorTab: state.setInspectorTab,
  })));
  const workspace = activeWorkspace(s);
  const thread = currentThread(s);
  const [error, setError] = useState<string | null>(null);
  const subagents = useMemo(() => (thread?.items ?? []).flatMap((item) => item.kind === "workflow" ? workflowAgents(item) : [subagentFrom(item)].filter((entry): entry is Subagent => entry != null)), [thread?.items]);
  const activeSubagents = subagents.filter((item) => item.status === "running").length;
  const sources = useMemo(() => {
    const collected = new Map<string, MonitorSource>();
    const addFile = (path: string) => collected.set(`file:${path}`, { key: `file:${path}`, kind: "file", name: fileName(path), path });
    const addImage = (name: string, mediaType: string, base64Data: string, key: string) => collected.set(key, { key, kind: "image", name, src: `data:${mediaType};base64,${base64Data}` });

    for (const item of thread?.items ?? []) {
      for (const ref of item.refs ?? []) addFile(ref.path);
      for (const [index, image] of (item.images ?? []).entries()) addImage(image.name, image.mediaType, image.base64Data, `image:${item.itemId}:${index}`);
    }
    for (const ref of s.contextRefs) addFile(ref.path);
    for (const [index, image] of s.images.entries()) addImage(image.name, image.mediaType, image.base64Data, `image:draft:${index}`);
    return [...collected.values()];
  }, [thread?.items, s.contextRefs, s.images]);

  const contextPercent = thread?.context?.windowTokens && thread.context.usedTokens != null
    ? Math.min(100, Math.round((thread.context.usedTokens / thread.context.windowTokens) * 100))
    : null;
  const openSource = (path: string) => {
    if (!workspace) return;
    if (!workspace.grantId && isTauri()) { setError("This folder is not granted. Re-open it to restore access."); return; }
    const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
    void openPath(absolute ? path : `${workspace.path}/${path}`, workspace.grantId ?? "preview", useAppStore.getState().editor).catch((cause) => setError(describeError(`Could not open ${path}`, cause)));
  };

  return (
    <div className="task-monitor scroll" aria-label="Task monitor">
      <section className="monitor-section">
        <div className="monitor-heading"><span>Environment</span></div>
        <button className="monitor-row actionable" onClick={() => s.setInspectorTab("changes")}>
          <span className="monitor-icon"><GitCompareArrows size={15} /></span>
          <span className="monitor-copy"><strong>Changes</strong><small>{s.git?.files.length ?? 0} changed files</small></span>
          {s.git?.dirty ? <span className="monitor-diff"><DiffCount kind="add" value={s.git.files.reduce((sum, file) => sum + file.added, 0)} /><DiffCount kind="del" value={s.git.files.reduce((sum, file) => sum + file.removed, 0)} /></span> : <span className="monitor-state">Clean</span>}
        </button>
        <div className="monitor-row">
          <span className="monitor-icon"><Monitor size={15} /></span>
          <span className="monitor-copy"><strong>Local</strong><small title={workspace?.path}>{workspace?.name ?? "No workspace open"}</small></span>
        </div>
        <button className="monitor-row actionable" aria-label="Open changes" onClick={() => s.setInspectorTab("changes")}>
          <span className="monitor-icon"><GitBranch size={15} /></span>
          <span className="monitor-copy"><strong>{s.git?.branch ?? thread?.hostBranch ?? "No branch"}</strong><small>{s.git?.dirty ? "Uncommitted changes" : "Working tree clean"}</small></span>
        </button>
      </section>

      <section className="monitor-section">
        <div className="monitor-heading"><span>Current task</span></div>
        {thread ? <div className="monitor-task">
          <div className="monitor-task-title"><span className={`monitor-status ${thread.status}`} />{thread.title}</div>
          <div className="monitor-task-meta">
            <span>{thread.status === "running" ? thread.activity === "composing" ? "Writing a reply" : thread.goal?.currentWork || "Working" : thread.status === "error" ? "Needs attention" : "Idle"}</span>
            {contextPercent != null ? <span>{contextPercent}% context</span> : null}
          </div>
          {thread.goal?.objective ? <p>{thread.goal.objective}</p> : null}
        </div> : <p className="monitor-empty">Select a thread to inspect its task.</p>}
      </section>

      <section className="monitor-section">
        <div className="monitor-heading"><span>Subagents</span><span className="monitor-count" title={`${activeSubagents} running`}>{activeSubagents ? `${activeSubagents} running` : subagents.length}</span></div>
        {subagents.map((item) => (
          <div key={item.id} className={`monitor-row subagent-row ${item.status}`}>
            <span className="monitor-icon"><SubagentMark status={item.status} /></span>
            <span className="monitor-copy"><strong title={item.title}>{item.title}</strong>{item.detail ? <small title={item.detail}>{item.detail}</small> : null}</span>
          </div>
        ))}
        {!subagents.length ? <div className="monitor-row muted-row"><span className="monitor-icon"><Bot size={15} /></span><span className="monitor-copy"><strong>No subagents</strong><small>{thread ? "Subagents this thread spawns will appear here." : "Select a thread to see its subagents."}</small></span></div> : null}
      </section>

      <section className="monitor-section">
        <div className="monitor-heading"><span>Sources</span><span className="monitor-count">{sources.length}</span></div>
        {sources.map((source) => source.kind === "image" ? (
          <div key={source.key} className="monitor-row source-row">
            <img className="source-thumb" src={source.src} alt="" />
            <span className="monitor-copy"><strong title={source.name}>{source.name}</strong><small>Attached image</small></span>
          </div>
        ) : (
          <button key={source.key} className="monitor-row source-row actionable" title={source.path} onClick={() => openSource(source.path)}>
            <span className="monitor-icon"><FileText size={15} /></span>
            <span className="monitor-copy"><strong>{source.name}</strong><small>{source.path}</small></span>
          </button>
        ))}
        {!sources.length ? <div className="monitor-row muted-row"><span className="monitor-icon"><ImageIcon size={15} /></span><span className="monitor-copy"><strong>No attached files</strong><small>Files and images from this thread will appear here.</small></span></div> : null}
        {error ? <p className="monitor-error" role="alert">{error}</p> : null}
      </section>
    </div>
  );
}
