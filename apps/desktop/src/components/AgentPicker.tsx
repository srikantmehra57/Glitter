import { useState } from "react";
import { Info, RefreshCw } from "lucide-react";
import { AGENT_LABELS, type AgentId, type AgentInfo } from "../lib/types";

const MARKS: Record<AgentId, { glyph: string; tone: string }> = {
  harness: { glyph: "H", tone: "harness" },
  muse: { glyph: "M", tone: "muse" },
  opencode: { glyph: "OC", tone: "opencode" },
  grok: { glyph: "G", tone: "grok" },
  gemini: { glyph: "Ge", tone: "gemini" },
  qwen: { glyph: "Q", tone: "qwen" },
  goose: { glyph: "Go", tone: "goose" },
};

const ICONS: Partial<Record<AgentId, string>> = {
  muse: "/spark.svg",
  grok: "/agents/grok.svg",
  opencode: "/agents/opencode.svg",
  gemini: "/agents/gemini.svg",
  qwen: "/agents/qwen.svg",
};

/** Agents with a published product mark use it; the rest stay lettered. */
export function AgentMark({ id, size = 16 }: { id: AgentId; size?: number }) {
  const icon = ICONS[id];
  if (icon) {
    return (
      <span className={`agent-mark img ${id}`} style={{ width: size, height: size }} aria-hidden="true">
        <img src={icon} alt="" width={size} height={size} />
      </span>
    );
  }
  const mark = MARKS[id] ?? { glyph: id.slice(0, 1).toUpperCase(), tone: "muse" };
  return <span className={`agent-mark ${mark.tone}`} style={{ width: size, height: size, fontSize: size * (mark.glyph.length > 1 ? 0.5 : 0.62) }} aria-hidden="true">{mark.glyph}</span>;
}

function status(agent: AgentInfo) {
  if (!agent.found) return "Not installed";
  if (agent.id === "muse" && !agent.authenticated) return "Needs sign-in";
  if (agent.id === "harness" && !agent.authenticated) return "Add a provider key";
  return [agent.version ? `v${agent.version}` : null, agent.verified ? null : "Experimental"].filter(Boolean).join(" · ") || "Ready";
}

type Props = {
  agents: AgentInfo[];
  value: AgentId;
  disabled: boolean;
  onChange: (id: AgentId) => void;
  onRescan: () => Promise<void>;
  onShowCapabilities?: () => void;
};

/**
 * The agents in the model picker's header, as tabs: every installed agent is one
 * click away, with no menu inside the menu. A tab switches this thread's agent.
 */
export function AgentTabs({ agents, value, disabled, onChange, onRescan, onShowCapabilities }: Props) {
  const [scanning, setScanning] = useState(false);
  const installed = agents.filter((agent) => agent.found);
  const current = agents.find((agent) => agent.id === value);
  const shown = installed.some((agent) => agent.id === value) || !current ? installed : [current, ...installed];
  return (
    <div className="model-agents">
      <div className="agent-tabs" role="tablist" aria-label="Agent" onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
        const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0) return;
        event.preventDefault();
        tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length]?.focus();
      }}>
        {shown.map((agent) => {
          const signInNeeded = (agent.id === "muse" || agent.id === "harness") && !agent.authenticated;
          return (
            <button
              key={agent.id}
              type="button"
              role="tab"
              className="agent-tab"
              aria-selected={agent.id === value}
              disabled={disabled || (signInNeeded && agent.id !== value)}
              aria-label={agent.name}
              data-tooltip={`${agent.name} · ${status(agent)}`}
              onClick={() => { if (agent.id !== value) onChange(agent.id); }}
            >
              <AgentMark id={agent.id} size={14} />
              {/* The current agent is named; the others show their mark, so any number fit in one row. */}
              <span className="agent-tab-name" aria-hidden="true">{agent.name}</span>
            </button>
          );
        })}
      </div>
      <div className="model-section-actions">
        {onShowCapabilities ? <button type="button" className="icon-btn" aria-label="Capabilities" data-tooltip={`${AGENT_LABELS[value]} capabilities`} onClick={onShowCapabilities}><Info size={13} aria-hidden="true" /></button> : null}
        <button type="button" className="icon-btn" aria-label={scanning ? "Scanning agents" : "Rescan agents"} data-tooltip="Rescan agents" data-tooltip-align="end" disabled={disabled || scanning} onClick={() => { setScanning(true); void onRescan().finally(() => setScanning(false)); }}>
          <RefreshCw size={13} className={scanning ? "spin" : ""} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
