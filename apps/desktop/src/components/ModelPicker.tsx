import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EXIT_FAST_MS, usePresence } from "../lib/presence";
import { Check, ChevronDown, Info, KeyRound, Search, Sparkles, X, Zap } from "lucide-react";
import { isFastModel } from "../lib/effort";
import { humanizeModelLabel } from "../lib/format";
import { menuPosition } from "../lib/menuPosition";
import { leadingBrandSlug, modelBrand } from "../lib/brands";
import { PROVIDERS } from "../lib/providers";
import { AGENT_LABELS, type AgentId, type AgentInfo, type Model } from "../lib/types";
import { AgentMark, ModelIcon, ModelMark, ProviderMark, SourceRail, type RailSource } from "./AgentPicker";

export function modelKey(model: { modelId: string; providerId?: string }) {
  return JSON.stringify([model.providerId ?? "", model.modelId]);
}

const CONTRIBUTOR = /[-\s]contributor([-:]free)?$/i;
const CONTRIBUTOR_NOTE = "Contributor model: discounted tokens in exchange for data. Your content, including inter-session messages, may be used for product improvement.";

/** The service's own description when it has one, else the known contributor terms. */
function dataNote(model: Model) {
  const description = model.description?.trim();
  return description && description !== "Free" ? description : CONTRIBUTOR_NOTE;
}

function modelName(model: Model) {
  const name = humanizeModelLabel(model.modelId.replace(CONTRIBUTOR, ""), model.displayLabel?.replace(CONTRIBUTOR, ""));
  return CONTRIBUTOR.test(model.modelId) ? `${name} · Contributor` : name;
}

/** Why a model the catalog leaves out is still offered. */
function unlistedNote(names: string[]) {
  const many = names.length > 1;
  return `${names.join(" and ")} ${many ? "are" : "is"} not in the current model list. ${many ? "They stay" : "It stays"} here because this thread or your default model uses ${many ? "them" : "it"}.`;
}

const PROVIDER_NAMES: Record<string, string> = { opencode: "OpenCode Zen", meta: "Meta", grok: "xAI", "x-ai": "xAI", "z-ai": "Z.ai", moonshotai: "Moonshot AI", mistralai: "Mistral", "meta-llama": "Meta", "deepseek-ai": "DeepSeek", qwen: "Qwen", "cline-free": "Cline" };

function providerName(id?: string) {
  if (!id) return "Models";
  return PROVIDERS.find((provider) => provider.id === id)?.name ?? PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Providers in Settings order, then any id the catalog adds. */
function providerIds(models: Model[]): string[] {
  const ids = [...new Set(models.map((model) => model.providerId).filter((id): id is string => Boolean(id)))];
  const order = PROVIDERS.map((provider) => provider.id);
  return ids.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib) || a.localeCompare(b);
  });
}

function isFree(model: Model, agentId: AgentId) {
  // Cline retires promotions without renaming the id, so only its live list counts.
  if (agentId === "cline") return model.free === true;
  return model.description === "Free" || /[-:]free$/i.test(model.modelId) || (model.cost != null && Number(model.cost.input) === 0 && Number(model.cost.output) === 0);
}

/** Drop a retired "(free)" from what a search can match. The live free rows keep it. */
function searchText(model: Model, agentId: AgentId) {
  const name = modelName(model);
  const provider = providerName(model.providerId);
  // Only a model Cline has positively retired loses the word. An unknown mark
  // still matches, so a failed promotion lookup cannot hide every free row.
  if (agentId !== "cline" || model.free !== false) return `${model.modelId} ${name} ${provider}${model.free ? " free" : ""}`;
  const strip = (value: string) => value.replace(/\s*\(free\)/gi, " ").replace(/\bfree\b/gi, "");
  return `${strip(model.modelId)} ${strip(name)} ${strip(provider)}`;
}

function shownName(model: Model, agentId: AgentId) {
  const name = modelName(model);
  if (agentId === "cline" && model.free === false) return name.replace(/\s*\(free\)/gi, "").replace(/[ \t]{2,}/g, " ").trim();
  return name;
}

/** Cline's promoted free models get their own section at the top; the rest group by lab. */
function sectionOf(model: Model, agentId: AgentId) {
  return agentId === "cline" && model.free === true ? "free" : model.providerId ?? "";
}

function contextLabel(limit?: number | null) {
  if (!limit) return null;
  return limit >= 1_000_000 ? `${Math.round(limit / 100_000) / 10}M context`.replace(".0M", "M") : `${Math.round(limit / 1000)}K context`;
}

/** Input and output price, or null when the model is free or unpriced. */
function costParts(cost: Model["cost"]): [string, string] | null {
  if (!cost || (Number(cost.input) === 0 && Number(cost.output) === 0)) return null;
  const sign = !cost.currency || cost.currency === "USD" ? "$" : `${cost.currency} `;
  return [`${sign}${cost.input}`, `${sign}${cost.output}`];
}

type Props = {
  models: Model[];
  agentId: AgentId;
  agents?: AgentInfo[];
  agentDisabled?: boolean;
  value?: string;
  loading: boolean;
  disabled: boolean;
  applying?: boolean;
  title?: string;
  onChange: (model: Model) => void;
  onAgentChange?: (id: AgentId) => void;
  onRescan?: () => Promise<void>;
  onShowCapabilities?: () => void;
  onContributorSettings?: () => void;
  /** The built-in harness: open Settings → Providers to add a key. */
  onManageProviders?: () => void;
};

const ALL = "all";
const RAIL_SIZE = { width: 620, height: 480, short: 372 };
const PLAIN_SIZE = { width: 400, height: 460 };

/**
 * The model chip in the composer. One click opens the models straight away;
 * one click on a row picks it and closes. A rail on the left lists where
 * models come from (Harness providers, or the labs an agent's catalog mixes)
 * and the installed agents, so nothing here opens a second menu. Effort is
 * its own control (EffortPicker).
 */
export function ModelPicker({ models, agentId, agents = [], agentDisabled, value, loading, disabled, applying, title, onChange, onAgentChange, onRescan, onShowCapabilities, onContributorSettings, onManageProviders }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const dialogId = useId();
  const [open, setOpen] = useState(false);
  const pop = usePresence(open, EXIT_FAST_MS);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const [pinnedSource, setPinnedSource] = useState<string | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof menuPosition> | null>(null);
  const selected = models.find((model) => modelKey(model) === value);
  const agentName = agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId];
  const harness = agentId === "harness";
  // Harness: one provider at a time, as in Settings. Other agents: their catalog's labs, or all of them.
  const labs = providerIds(models);
  const harnessProviders = harness ? labs : [];
  const showLabs = !harness && labs.length > 1;
  const pinned = pinnedSource && (pinnedSource === ALL || labs.includes(pinnedSource)) ? pinnedSource : undefined;
  const activeProvider = harness ? (pinned && pinned !== ALL ? pinned : selected?.providerId && labs.includes(selected.providerId) ? selected.providerId : labs[0]) : undefined;
  const activeLab = showLabs ? pinned ?? ALL : ALL;
  const sourceId = harness ? activeProvider : activeLab;
  const chipProvider = harness ? (selected?.providerId && labs.includes(selected.providerId) ? selected.providerId : activeProvider) : undefined;
  const listedProvider = open ? activeProvider : chipProvider;
  const sourceName = listedProvider ? providerName(listedProvider) : activeLab !== ALL ? providerName(activeLab) : agentName;
  const selectionLocked = disabled || loading || applying;
  const searchable = models.length > 6;
  const railed = Boolean(onAgentChange && onRescan) || showLabs;
  // A short catalog with few sources gets a shorter panel; a long one keeps the full height.
  const tall = models.length > 4 || labs.length + agents.length > 6;
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => {
    // A search looks through every source of this agent, not only the one picked.
    const pool = needle ? models : activeProvider ? models.filter((model) => model.providerId === activeProvider) : activeLab !== ALL ? models.filter((model) => model.providerId === activeLab) : models;
    const matches = pool.filter((model) => !needle || searchText(model, agentId).toLowerCase().includes(needle));
    const order = [...new Set([selected?.providerId, ...matches.map((model) => model.providerId)])];
    return matches.slice().sort((a, b) => {
      const unavailable = Number(Boolean(a.unavailable)) - Number(Boolean(b.unavailable));
      const promoted = agentId === "cline" ? Number(b.free === true) - Number(a.free === true) : 0;
      return unavailable || promoted || order.indexOf(a.providerId) - order.indexOf(b.providerId);
    });
  }, [models, needle, selected?.providerId, activeProvider, activeLab, agentId]);
  const selectedIndex = visible.findIndex((model) => modelKey(model) === value);
  const activeIndex = Math.max(0, Math.min(active, visible.length - 1));
  const unlisted = models.filter((model) => model.unlisted);
  const grouped = new Set(visible.map((item) => sectionOf(item, agentId))).size > 1;
  // A list that mixes providers marks each row's provider in the corner of its icon.
  const mixed = new Set(visible.map((item) => item.providerId)).size > 1;
  const freeCount = visible.filter((model) => isFree(model, agentId)).length;
  const contains = (target: Node | null) => Boolean(root.current?.contains(target) || panel.current?.contains(target));

  const sources: RailSource[] = harness
    ? harnessProviders.map((id) => ({ id, name: providerName(id), mark: <ProviderMark id={id} size={18} />, count: models.filter((model) => model.providerId === id).length }))
    : showLabs ? [
      { id: ALL, name: "All models", mark: <AgentMark id={agentId} size={18} />, count: models.length },
      ...labs.map((id) => ({ id, name: providerName(id), mark: <ProviderMark id={id} size={18} />, count: models.filter((model) => model.providerId === id).length })),
    ] : [];

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current;
    const popover = panel.current;
    const update = () => {
      const bounds = root.current?.closest("dialog")?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      // With a rail the panel keeps one height, so switching sources does not make it jump.
      // Without one, block layout keeps the content's natural height while a catalog loads.
      const height = railed ? (tall ? RAIL_SIZE.height : RAIL_SIZE.short) : Math.min(PLAIN_SIZE.height, popover.scrollHeight + popover.offsetHeight - popover.clientHeight);
      setPosition(menuPosition(anchor.getBoundingClientRect(), { width: railed ? RAIL_SIZE.width : PLAIN_SIZE.width, height }, bounds, false));
    };
    const dismissOnScroll = (event: Event) => { if (!contains(event.target as Node)) setOpen(false); };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [open, models, agentId, value, query, railed, tall]);

  // Once positioned, focus lands in the list: the search field, or the selected row.
  useEffect(() => {
    if (!open) { setQuery(""); return; }
    if (!position || disabled) return;
    (searchable ? search.current : items.current[activeIndex])?.focus();
  }, [open, loading, agentId, searchable, disabled, position !== null]);

  useEffect(() => { setQuery(""); setActive(0); setPinnedSource(null); }, [agentId]);
  useEffect(() => { if (!open) setPinnedSource(null); }, [open]);
  useEffect(() => {
    if (!open) return;
    // Scroll the catalog only; scrollIntoView can move the anchor's thread.
    const item = items.current[activeIndex];
    const catalog = panel.current?.querySelector(".model-catalog");
    if (!item || !catalog) return;
    const row = item.getBoundingClientRect();
    const viewport = catalog.getBoundingClientRect();
    if (row.top < viewport.top) catalog.scrollTop -= viewport.top - row.top;
    else if (row.bottom > viewport.bottom) catalog.scrollTop += row.bottom - viewport.bottom;
  }, [open, activeIndex]);

  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (model: Model) => {
    if (selectionLocked) return;
    if (modelKey(model) !== value) onChange(model);
    close();
  };
  const openPanel = () => {
    setActive(Math.max(0, selectedIndex));
    setPosition(null);
    setOpen(true);
  };
  const pickSource = (id: string) => {
    setPinnedSource(id);
    setQuery("");
    setActive(0);
    const catalog = panel.current?.querySelector(".model-catalog");
    if (catalog) catalog.scrollTop = 0;
  };
  const label = selected ? shownName(selected, agentId) : loading ? "Loading…" : !models.length ? "No models" : "Choose model";
  const selectedBrand = selected ? modelBrand(selected.modelId, selected.providerId) : null;
  const showModelIcon = Boolean(selected && selectedBrand && "slug" in selectedBrand && selectedBrand.slug !== leadingBrandSlug(agentId, chipProvider));
  const headMark = listedProvider ? <ProviderMark id={listedProvider} size={28} /> : activeLab !== ALL ? <ProviderMark id={activeLab} size={28} /> : <AgentMark id={agentId} size={28} />;
  const summary = loading ? "Loading…" : needle ? `${visible.length} ${visible.length === 1 ? "match" : "matches"}` : `${visible.length} ${visible.length === 1 ? "model" : "models"}${freeCount ? ` · ${freeCount} free` : ""}`;

  return (
    <div ref={root} className="picker model-picker" title={title}>
      <button
        ref={trigger}
        id="model-picker"
        type="button"
        className="picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={pop.mounted ? dialogId : undefined}
        aria-label="Model"
        aria-description={`${sourceName} · ${label}`}
        disabled={disabled}
        onClick={() => { if (open) setOpen(false); else openPanel(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); openPanel(); }
        }}
      >
        {chipProvider ? <ProviderMark id={chipProvider} size={16} /> : <AgentMark id={agentId} size={16} />}
        {showModelIcon && selected ? <ModelMark modelId={selected.modelId} providerId={selected.providerId} size={16} /> : null}
        <span className="picker-value">{label}</span>
        {selected && isFastModel(selected) ? <Zap size={12} className="model-fast" aria-label="Fast" /> : null}
        <ChevronDown size={12} className="select-chevron" data-open={open || undefined} aria-hidden="true" />
      </button>
      {pop.mounted ? createPortal(
        <div
          ref={panel}
          id={dialogId}
          className={`picker-pop model-pop model-picker-pop${railed ? " railed" : ""}${pop.closing ? " closing" : ""}`}
          role="dialog"
          aria-label="Choose a model"
          style={position ? { ...position, ...(railed ? { height: position.maxHeight } : {}) } : { visibility: "hidden" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation();
              setOpen(false); trigger.current?.focus();
            } else if (event.key === "Tab") {
              const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), input:not(:disabled)')];
              const end = event.shiftKey ? controls[0] : controls[controls.length - 1];
              if (event.target === end) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
            }
          }}
        >
          {railed ? (
            <SourceRail
              agents={onAgentChange ? agents : []}
              value={agentId}
              disabled={Boolean(agentDisabled || disabled || applying)}
              onChange={(id) => onAgentChange?.(id)}
              onRescan={onRescan ?? (async () => {})}
              onShowCapabilities={onShowCapabilities ? () => { close(); onShowCapabilities(); } : undefined}
              sources={sources}
              sourceId={sourceId}
              sourcesLabel={harness ? "Providers" : "Labs"}
              onSourceChange={pickSource}
            />
          ) : null}
          <div className="model-main">
            <div className="model-picker-head">
              <span className="model-head-mark" key={`${agentId}:${sourceId ?? ""}`}>{headMark}</span>
              <span className="model-head-copy">
                <span className="model-picker-title">{sourceName}</span>
                <span className="model-head-summary" aria-live="polite">{summary}</span>
              </span>
              <button type="button" className="icon-btn" aria-label="Close model picker" onClick={close}><X size={13} aria-hidden="true" /></button>
            </div>
            {searchable ? <label className="picker-search model-picker-search">
              <Search size={14} aria-hidden="true" />
              <input
                ref={search}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={visible.length ? `${listId}-${activeIndex}` : undefined}
                value={query}
                placeholder={railed ? `Search all ${agentName} models` : `Search ${sourceName} models`}
                aria-label="Search models"
                disabled={disabled || loading}
                onChange={(event) => { setQuery(event.target.value); setActive(0); }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(visible.length - 1, index + 1)); }
                  else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
                  else if (event.key === "Enter" && visible[activeIndex]) { event.preventDefault(); choose(visible[activeIndex]); }
                }}
              />
              {query ? <button type="button" className="icon-btn" aria-label="Clear model search" onClick={() => { setQuery(""); setActive(0); search.current?.focus(); }}><X size={12} aria-hidden="true" /></button> : null}
            </label> : null}
            <div className="model-catalog">
              <div key={`${agentId}:${sourceId ?? ""}`} id={listId} role="listbox" aria-label="Model" aria-busy={Boolean(loading || applying)}>
                {loading ? <p className="picker-empty" role="status">Loading {sourceName} models…</p> : !visible.length ? <p className="picker-empty">{query ? `No models match “${query}”.` : harness ? "No models yet. Add a provider key to see its models." : "No models available. Rescan agents to try again."}</p> : null}
                {visible.map((model, index) => {
                  const price = costParts(model.cost);
                  const contributor = CONTRIBUTOR.test(model.modelId);
                  const specs = [contextLabel(model.contextLimit), !contributor && model.description !== "Free" && model.description !== providerName(model.providerId) ? model.description : null].filter(Boolean).join(" · ");
                  const free = isFree(model, agentId);
                  const name = shownName(model, agentId);
                  const section = sectionOf(model, agentId);
                  const group = index === 0 || sectionOf(visible[index - 1], agentId) !== section;
                  const rowSelected = index === selectedIndex;
                  return (
                    <div key={modelKey(model)} role="presentation" className="model-row" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
                      {group && grouped ? (
                        <div className={`menu-heading group${section === "free" ? " free" : ""}`}>
                          {section === "free" ? <><Sparkles size={12} aria-hidden="true" />Free right now</> : <>{model.providerId ? <ProviderMark id={model.providerId} size={14} /> : null}{providerName(model.providerId)}</>}
                        </div>
                      ) : null}
                      <button
                        ref={(node) => { items.current[index] = node; }}
                        id={`${listId}-${index}`}
                        type="button"
                        role="option"
                        aria-selected={rowSelected}
                        aria-description={[model.unlisted ? unlistedNote([name]) : "", contributor ? dataNote(model) : model.description ?? ""].filter(Boolean).join(" ") || undefined}
                        tabIndex={index === activeIndex ? 0 : -1}
                        disabled={Boolean(selectionLocked)}
                        className={`model-option ${index === activeIndex ? "active" : ""} ${model.unavailable ? "unavailable" : ""}`}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => choose(model)}
                        onKeyDown={(event) => {
                          const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                          const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : step ? (index + step + visible.length) % visible.length : -1;
                          if (next < 0) return;
                          event.preventDefault(); setActive(next); items.current[next]?.focus();
                        }}
                      >
                        <span className="model-icon"><ModelIcon modelId={model.modelId} providerId={model.providerId} size={22} badge={mixed} fallback={<AgentMark id={agentId} size={22} />} /></span>
                        <span className="model-copy">
                          <span className="model-name">
                            <span className="model-label" title={name}>{name}</span>
                            {isFastModel(model) ? <span className="picker-tag fast"><Zap size={10} aria-hidden="true" />Fast</span> : null}
                            {model.isDefault ? <span className="picker-tag">Default</span> : null}
                            {model.unavailable ? <span className="picker-tag warm">Unavailable</span> : model.unlisted ? <span className="picker-tag">Not listed</span> : free ? <span className="picker-tag free">Free</span> : null}
                          </span>
                          {specs ? <span className="model-meta" title={specs}>{specs}</span> : null}
                        </span>
                        {price ? <span className="model-price" title="Price per 1M tokens"><span><strong>{price[0]}</strong> in</span><span><strong>{price[1]}</strong> out</span></span> : null}
                        <span className="model-check" aria-hidden="true">{rowSelected ? <Check size={13} strokeWidth={3} /> : null}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
              {models.some((model) => costParts(model.cost)) ? <p className="model-pricing-note">Prices per 1M tokens</p> : null}
              {unlisted.length ? <p className="picker-note"><Info size={11} aria-hidden="true" />{unlistedNote(unlisted.map((model) => shownName(model, agentId)))}</p> : null}
              {models.some((model) => CONTRIBUTOR.test(model.modelId)) ? <p className="picker-note"><Info size={11} aria-hidden="true" />Contributor models are discounted because your content, including inter-session messages, may be used for product improvement.</p> : null}
            </div>
            {(agentId === "muse" && onContributorSettings) || (harness && onManageProviders) ? (
              <div className="model-picker-foot">
                {harness && onManageProviders ? <button type="button" className="ghost-btn small" onClick={() => { close(); onManageProviders(); }}><KeyRound size={11} aria-hidden="true" />Manage providers</button> : null}
                {agentId === "muse" && onContributorSettings ? <button type="button" className="ghost-btn small" onClick={() => { close(); onContributorSettings(); }}>Contributor settings</button> : null}
              </div>
            ) : null}
          </div>
        </div>,
        root.current?.closest("dialog") ?? document.body,
      ) : null}
    </div>
  );
}
