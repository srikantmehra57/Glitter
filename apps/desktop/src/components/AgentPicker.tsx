import { useState, type ReactNode } from "react";
import { Info, RefreshCw } from "lucide-react";
import { brandSrc, modelBrand, providerBrand, type BrandMark } from "../lib/brands";
import { AGENT_LABELS, type AgentId, type AgentInfo } from "../lib/types";

const MARKS: Record<AgentId, { glyph: string; tone: string }> = {
  harness: { glyph: "H", tone: "harness" },
  muse: { glyph: "M", tone: "muse" },
  opencode: { glyph: "OC", tone: "opencode" },
  grok: { glyph: "G", tone: "grok" },
  gemini: { glyph: "Ge", tone: "gemini" },
  qwen: { glyph: "Q", tone: "qwen" },
  goose: { glyph: "Go", tone: "goose" },
  cline: { glyph: "Cl", tone: "cline" },
};

const ICONS: Partial<Record<AgentId, string>> = {
  muse: "/spark.svg",
  grok: "/agents/grok.svg",
  opencode: "/agents/opencode.svg",
  gemini: "/agents/gemini.svg",
  qwen: "/agents/qwen.svg",
  cline: "/brands/cline.svg",
};

function Mark({ brand, size }: { brand: BrandMark; size: number }) {
  if ("slug" in brand) {
    return (
      <span className={`agent-mark img ${brand.tone}`} style={{ width: size, height: size }} aria-hidden="true">
        <img src={brandSrc(brand.slug)} alt="" width={size} height={size} />
      </span>
    );
  }
  return <span className={`agent-mark ${brand.tone}`} style={{ width: size, height: size, fontSize: size * (brand.glyph.length > 1 ? 0.42 : 0.62) }} aria-hidden="true">{brand.glyph}</span>;
}

/** A harness provider, as its own logo. These are not the Harness agent. */
export function ProviderMark({ id, size = 16 }: { id: string; size?: number }) {
  return <Mark brand={providerBrand(id)} size={size} />;
}

/** The model family's logo, or a short letter when the lab has no mark on file. */
export function ModelMark({ modelId, providerId, size = 16 }: { modelId: string; providerId?: string; size?: number }) {
  const brand = modelBrand(modelId, providerId);
  if (!brand) return null;
  return <Mark brand={brand} size={size} />;
}

/**
 * A model row's icon: the model family's logo, else its provider's, else
 * `fallback` (the agent's own mark, for an agent that serves only its own). With
 * `badge`, the provider rides in the corner, for lists that mix providers.
 */
export function ModelIcon({ modelId, providerId, size = 16, badge = false, fallback = null }: { modelId: string; providerId?: string; size?: number; badge?: boolean; fallback?: ReactNode }) {
  const family = modelBrand(modelId, providerId);
  const icon = family ? <Mark brand={family} size={size} /> : providerId ? <ProviderMark id={providerId} size={size} /> : fallback;
  // The badge says something only when the provider is not the family itself (Claude via Anthropic).
  const host = providerId ? providerBrand(providerId) : null;
  const same = Boolean(family && host && "slug" in host && "slug" in family && host.slug === family.slug);
  if (!badge || !family || !providerId || same) return icon;
  return (
    <span className="model-icon-stack" style={{ width: size, height: size }} aria-hidden="true">
      {icon}
      <span className="model-icon-badge"><ProviderMark id={providerId} size={Math.round(size * 0.5)} /></span>
    </span>
  );
}

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

export type RailSource = { id: string; name: string; mark: ReactNode; count?: number };

type RailProps = {
  agents: AgentInfo[];
  value: AgentId;
  disabled: boolean;
  onChange: (id: AgentId) => void;
  onRescan: () => Promise<void>;
  onShowCapabilities?: () => void;
  /** Where the current agent's models come from: Harness providers, or the labs an agent's catalog mixes. */
  sources?: RailSource[];
  sourceId?: string;
  sourcesLabel?: string;
  onSourceChange?: (id: string) => void;
};

/** Arrow keys move between a vertical tablist's tabs, as in a sidebar. */
function moveFocus(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  const tabs = [...event.currentTarget.closest(".model-rail")!.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
}

/**
 * The model picker's left rail: every installed agent, each one click away,
 * then where the current agent's models come from. Picking an agent switches
 * this thread's agent; picking a source filters the list.
 */
export function SourceRail({ agents, value, disabled, onChange, onRescan, onShowCapabilities, sources = [], sourceId, sourcesLabel, onSourceChange }: RailProps) {
  const [scanning, setScanning] = useState(false);
  const installed = agents.filter((agent) => agent.found);
  const current = agents.find((agent) => agent.id === value);
  const shown = installed.some((agent) => agent.id === value) || !current ? installed : [current, ...installed];
  return (
    <nav className="model-rail" aria-label="Model sources">
      <div className="model-rail-scroll">
        {shown.length ? (
          <section className="model-rail-section">
            <h3 className="model-rail-label">Agents</h3>
            <div role="tablist" aria-orientation="vertical" aria-label="Agent" onKeyDown={moveFocus}>
              {shown.map((agent) => {
                const signInNeeded = (agent.id === "muse" || agent.id === "harness") && !agent.authenticated;
                const selected = agent.id === value;
                return (
                  <button
                    key={`agent:${agent.id}`}
                    type="button"
                    role="tab"
                    className="rail-tab agent"
                    aria-selected={selected}
                    aria-label={agent.name}
                    tabIndex={selected ? 0 : -1}
                    disabled={disabled || (signInNeeded && !selected)}
                    title={`${agent.name} · ${status(agent)}`}
                    onClick={() => { if (!selected) onChange(agent.id); }}
                  >
                    <AgentMark id={agent.id} size={18} />
                    <span className="rail-tab-name">{agent.name}</span>
                    {selected ? <span className="rail-tab-live" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}
        {sources.length ? (
          <section className="model-rail-section">
            <h3 className="model-rail-label">{sourcesLabel}</h3>
            <div role="tablist" aria-orientation="vertical" aria-label={sourcesLabel} onKeyDown={moveFocus}>
              {sources.map((source) => (
                <button
                  key={`source:${source.id}`}
                  type="button"
                  role="tab"
                  className="rail-tab"
                  aria-selected={source.id === sourceId}
                  aria-label={source.name}
                  tabIndex={source.id === sourceId ? 0 : -1}
                  onClick={() => { if (source.id !== sourceId) onSourceChange?.(source.id); }}
                >
                  {source.mark}
                  <span className="rail-tab-name">{source.name}</span>
                  {source.count != null ? <span className="rail-tab-count" aria-hidden="true">{source.count}</span> : null}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      <div className="model-rail-foot">
        {onShowCapabilities ? <button type="button" className="icon-btn" aria-label="Capabilities" data-tooltip={`${AGENT_LABELS[value]} capabilities`} data-tooltip-side="top" data-tooltip-align="start" onClick={onShowCapabilities}><Info size={13} aria-hidden="true" /></button> : null}
        <button type="button" className="icon-btn" aria-label={scanning ? "Scanning agents" : "Rescan agents"} data-tooltip="Rescan agents" data-tooltip-side="top" data-tooltip-align="start" disabled={disabled || scanning} onClick={() => { setScanning(true); void onRescan().finally(() => setScanning(false)); }}>
          <RefreshCw size={13} className={scanning ? "spin" : ""} aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
