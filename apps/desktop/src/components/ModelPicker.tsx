import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EXIT_FAST_MS, usePresence } from "../lib/presence";
import { Activity, Check, ChevronDown, EyeOff, Info, KeyRound, Search, SlidersHorizontal, Sparkles, X, Zap } from "lucide-react";
import { isFastModel } from "../lib/effort";
import { humanizeModelLabel } from "../lib/format";
import { menuPosition } from "../lib/menuPosition";
import { leadingBrandSlug, modelBrand } from "../lib/brands";
import { pickerModels } from "../lib/modelVisibility";
import { ORCHESTRATOR_GOAL_COPY } from "../lib/orchestrator";
import { providerIds, providerName, type ProviderEntry } from "../lib/providers";
import { AGENT_IDS, AGENT_LABELS, type AgentId, type AgentInfo, type Model, type OrchestratorConfig } from "../lib/types";
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

function isFree(model: Model, agentId: AgentId) {
  // Cline retires promotions without renaming the id, so only its live list counts.
  if (agentId === "cline") return model.free === true;
  return model.description === "Free" || /[-:]free$/i.test(model.modelId) || (model.cost != null && Number(model.cost.input) === 0 && Number(model.cost.output) === 0);
}

/** Drop a retired "(free)" from what a search can match. The live free rows keep it. */
function searchText(model: Model, agentId: AgentId, source: string, customs: ProviderEntry[]) {
  const name = modelName(model);
  const provider = providerName(model.providerId, customs);
  // Only a model Cline has positively retired loses the word. An unknown mark
  // still matches, so a failed promotion lookup cannot hide every free row.
  if (agentId !== "cline" || model.free !== false) return `${model.modelId} ${name} ${provider} ${source}${model.free ? " free" : ""}`;
  const strip = (value: string) => value.replace(/\s*\(free\)/gi, " ").replace(/\bfree\b/gi, "");
  return `${strip(model.modelId)} ${strip(name)} ${strip(provider)} ${strip(source)}`;
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

type Catalog = { models: Model[]; loading: boolean; error?: string | null };

/**
 * One provider in the rail. A Harness provider (Anthropic, OpenRouter…) is the
 * built-in agent calling that provider with the user's key; every other agent
 * (Muse, Cline CLI…) is a provider of its own models. Picking a model from a
 * provider on another agent moves the thread to that agent.
 */
type Source = RailSource & { agentId: AgentId; providerId?: string; catalog: Catalog; models: Model[]; hidden: number };

type Props = {
  models: Model[];
  agentId: AgentId;
  agents?: AgentInfo[];
  /** Other agents' providers cannot be picked (a turn is running, no workspace). */
  agentDisabled?: boolean;
  /** The custom endpoints the keychain holds, so their names and marks are the user's own. */
  customProviders?: ProviderEntry[];
  value?: string;
  loading: boolean;
  disabled: boolean;
  applying?: boolean;
  title?: string;
  /** Settings → Models' switched-off models, as `modelVisibilityKey` strings. */
  hidden?: readonly string[];
  /** Providers switched off as a whole, as `providerKey` strings. */
  hiddenProviders?: readonly string[];
  onChange: (model: Model) => void;
  /** A model from a provider on another agent: the thread switches agent, then model. */
  onChooseOther?: (agentId: AgentId, model: Model) => void;
  /** Another agent's catalog, read when its provider is opened or a search needs it. */
  loadCatalog?: (agentId: AgentId) => Promise<Model[]>;
  onRescan?: () => Promise<void>;
  onShowCapabilities?: () => void;
  onManageModels?: () => void;
  /** Settings → Providers, to add a key. */
  onManageProviders?: () => void;
  /** The thread's Orchestrator block; null keeps the picker on manual models. */
  orchestrator?: OrchestratorConfig | null;
  /** False while Settings holds no Lead and Builder, so the row leads there first. */
  orchestratorReady?: boolean;
  /** Turns Orchestrator on or off for this thread. Present only for built-in agent threads. */
  onOrchestratorChange?: (enabled: boolean) => void;
  /** Settings → Orchestrator, opened when the roles are incomplete. */
  onManageOrchestrator?: () => void;
};

const SIZE = { width: 540, height: 480, short: 380 };
const PLAIN_SIZE = { width: 420, height: 460 };

/**
 * The model chip in the composer. One click opens it; one click on a row picks
 * it and closes. The rail lists providers and the list shows that provider's
 * models — two levels, nothing nested. Effort is its own control (EffortPicker).
 */
export function ModelPicker({ models, agentId, agents = [], agentDisabled, customProviders: customs = [], value, loading, disabled, applying, title, hidden, hiddenProviders, onChange, onChooseOther, loadCatalog, onRescan, onShowCapabilities, onManageModels, onManageProviders, orchestrator, orchestratorReady = false, onOrchestratorChange, onManageOrchestrator }: Props) {
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
  const [pinned, setPinned] = useState<string | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof menuPosition> | null>(null);
  const [catalogs, setCatalogs] = useState<Partial<Record<AgentId, Catalog>>>({});
  const requested = useRef(new Set<AgentId>());
  const selected = models.find((model) => modelKey(model) === value);
  const needle = query.trim().toLowerCase();
  const selectionLocked = disabled || loading || applying;
  const orchestratorOn = Boolean(orchestrator);

  // Agents shown as providers: the current one always, then every other installed one, in a fixed order.
  const shownAgents = useMemo(() => {
    const ids = new Set<AgentId>([agentId, ...agents.filter((agent) => agent.found).map((agent) => agent.id)]);
    return AGENT_IDS.filter((id) => ids.has(id));
  }, [agentId, agents]);
  const others = onChooseOther && loadCatalog ? shownAgents.filter((id) => id !== agentId) : [];

  const fetchCatalog = (id: AgentId) => {
    if (!loadCatalog || requested.current.has(id)) return;
    requested.current.add(id);
    setCatalogs((all) => ({ ...all, [id]: { models: all[id]?.models ?? [], loading: true } }));
    void loadCatalog(id).then(
      (list) => setCatalogs((all) => ({ ...all, [id]: { models: list, loading: false } })),
      (error) => { requested.current.delete(id); setCatalogs((all) => ({ ...all, [id]: { models: [], loading: false, error: error instanceof Error ? error.message : String(error) } })); },
    );
  };
  // Harness providers are listed from the start: they are local and cheap to read. CLI agents load when opened.
  useEffect(() => { if (open && others.includes("harness")) fetchCatalog("harness"); }, [open, others.join(",")]);
  useEffect(() => { if (open && needle) for (const id of others) fetchCatalog(id); }, [open, needle.length > 0]);
  useEffect(() => { if (!open) requested.current.clear(); }, [open]);

  const sources: Source[] = useMemo(() => {
    const list: Source[] = [];
    for (const id of shownAgents) {
      const current = id === agentId;
      if (!current && !others.includes(id)) continue;
      const catalog: Catalog = current ? { models, loading } : catalogs[id] ?? { models: [], loading: false };
      const info = agents.find((agent) => agent.id === id);
      const signIn = !current && (id === "muse" || id === "harness") && info?.authenticated === false;
      const visibleModels = pickerModels(catalog.models, id, hidden, current ? selected : undefined);
      if (id === "harness") {
        const providers = providerIds(catalog.models);
        if (!providers.length) {
          // With no key yet, the built-in agent still gets a row that leads to Providers.
          if (current || catalog.loading) list.push({ id: "harness:", agentId: id, name: catalog.loading ? "Your providers" : "Add a provider", mark: <span className="rail-key"><KeyRound size={12} aria-hidden="true" /></span>, catalog, models: [], hidden: 0, disabled: !current && Boolean(agentDisabled) });
          continue;
        }
        for (const providerId of providers) {
          const own = visibleModels.filter((model) => model.providerId === providerId);
          const providerLabel = providerName(providerId, customs);
          list.push({ id: `harness:${providerId}`, agentId: id, providerId, name: providerLabel, mark: <ProviderMark id={providerId} size={18} name={providerLabel} />, count: own.length, catalog, models: own, hidden: catalog.models.filter((model) => model.providerId === providerId).length - own.length, disabled: !current && (Boolean(agentDisabled) || signIn), live: current && selected?.providerId === providerId });
        }
        continue;
      }
      list.push({ id: `${id}:`, agentId: id, name: info?.name ?? AGENT_LABELS[id], mark: <AgentMark id={id} size={18} />, count: catalog.models.length ? visibleModels.length : undefined, catalog, models: visibleModels, hidden: catalog.models.length - visibleModels.length, disabled: !current && (Boolean(agentDisabled) || signIn), title: signIn ? `${info?.name ?? AGENT_LABELS[id]} · sign in from Settings → Agents` : undefined, live: current });
    }
    // A provider switched off in Settings → Models, or one with every model off, leaves the
    // rail — except the one the thread's model comes from, which stays reachable.
    return list.filter((item) => item.live || (!hiddenProviders?.includes(item.id) && !(item.hidden > 0 && !item.models.length)));
  }, [shownAgents, others.join(","), agentId, models, loading, catalogs, agents, hidden, hiddenProviders, selected, agentDisabled, customs]);

  const homeId = agentId === "harness" ? `harness:${selected?.providerId ?? ""}` : `${agentId}:`;
  const sourceId = pinned && sources.some((source) => source.id === pinned) ? pinned : sources.some((source) => source.id === homeId) ? homeId : sources.find((source) => source.agentId === agentId)?.id ?? sources[0]?.id;
  const source = sources.find((item) => item.id === sourceId);
  useEffect(() => { if (open && source && source.agentId !== agentId) fetchCatalog(source.agentId); }, [open, source?.agentId]);

  const railed = sources.length > 1 || Boolean(onRescan);
  const searchable = sources.reduce((total, item) => total + item.models.length, 0) > 6;
  const tall = (source?.models.length ?? 0) > 4 || sources.length > 6;

  // A search looks through every provider, not only the open one.
  const rows = useMemo(() => {
    const pool = needle ? sources : source ? [source] : [];
    const out: Array<{ model: Model; source: Source }> = [];
    for (const item of pool) {
      const matches = item.models.filter((model) => !needle || searchText(model, item.agentId, item.name, customs).toLowerCase().includes(needle));
      const order = [...new Set([selected?.providerId, ...matches.map((model) => model.providerId)])];
      const sorted = matches.slice().sort((a, b) => {
        const unavailable = Number(Boolean(a.unavailable)) - Number(Boolean(b.unavailable));
        const promoted = item.agentId === "cline" ? Number(b.free === true) - Number(a.free === true) : 0;
        return unavailable || promoted || order.indexOf(a.providerId) - order.indexOf(b.providerId);
      });
      for (const model of sorted) out.push({ model, source: item });
    }
    return out;
  }, [sources, source, needle, selected?.providerId]);
  const isSelected = (row: { model: Model; source: Source }) => row.source.agentId === agentId && modelKey(row.model) === value;
  const selectedIndex = rows.findIndex(isSelected);
  const activeIndex = Math.max(0, Math.min(active, rows.length - 1));
  const listModels = rows.map((row) => row.model);
  const unlisted = listModels.filter((model) => model.unlisted);
  // Headings: per provider while searching, per lab inside an agent that mixes labs.
  const groupOf = (row: { model: Model; source: Source }) => needle ? row.source.id : sectionOf(row.model, row.source.agentId);
  const grouped = new Set(rows.map(groupOf)).size > 1;
  // A list that mixes providers marks each row's provider in the corner of its icon.
  const mixed = new Set(listModels.map((item) => item.providerId)).size > 1;
  const freeCount = rows.filter((row) => isFree(row.model, row.source.agentId)).length;
  const sourceLoading = Boolean(source?.catalog.loading && !source.models.length);
  const contains = (target: Node | null) => Boolean(root.current?.contains(target) || panel.current?.contains(target));

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
      // With a rail the panel keeps one height, so switching providers does not make it jump.
      const height = railed ? (tall ? SIZE.height : SIZE.short) : Math.min(PLAIN_SIZE.height, popover.scrollHeight + popover.offsetHeight - popover.clientHeight);
      setPosition(menuPosition(anchor.getBoundingClientRect(), { width: railed ? SIZE.width : PLAIN_SIZE.width, height }, bounds, false));
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

  useEffect(() => { setQuery(""); setActive(0); setPinned(null); }, [agentId]);
  useEffect(() => { if (!open) setPinned(null); }, [open]);
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
  const choose = (row: { model: Model; source: Source }) => {
    if (selectionLocked || row.source.disabled) return;
    if (row.source.agentId !== agentId) onChooseOther?.(row.source.agentId, row.model);
    else if (orchestratorOn || modelKey(row.model) !== value) onChange(row.model);
    close();
  };
  const openPanel = () => {
    setActive(Math.max(0, selectedIndex));
    setPosition(null);
    setOpen(true);
  };
  const pickSource = (id: string) => {
    setPinned(id);
    setQuery("");
    setActive(0);
    const catalog = panel.current?.querySelector(".model-catalog");
    if (catalog) catalog.scrollTop = 0;
  };

  const chipProvider = agentId === "harness" ? selected?.providerId : undefined;
  const label = selected ? shownName(selected, agentId) : loading ? "Loading…" : !models.length ? "No models" : "Choose model";
  const selectedBrand = selected ? modelBrand(selected.modelId, selected.providerId) : null;
  const showModelIcon = Boolean(selected && selectedBrand && "slug" in selectedBrand && selectedBrand.slug !== leadingBrandSlug(agentId, chipProvider));
  const chipSource = chipProvider ? providerName(chipProvider, customs) : agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId];
  const headTitle = needle ? "All providers" : source?.name ?? chipSource;
  const headMark: ReactNode = needle ? <span className="rail-key"><Search size={13} aria-hidden="true" /></span> : source?.mark ?? <AgentMark id={agentId} size={28} />;
  const summary = sourceLoading ? "Loading…" : needle ? `${rows.length} ${rows.length === 1 ? "match" : "matches"}` : `${rows.length} ${rows.length === 1 ? "model" : "models"}${freeCount ? ` · ${freeCount} free` : ""}`;
  const emptyText = query ? `No models match “${query}”.`
    : source?.catalog.error ? `${source.name} could not list its models. ${source.catalog.error}`
    : source?.agentId === "harness" ? "No models yet. Add a provider key to see its models."
    : source?.hidden ? "Every model here is switched off. Turn some back on in Settings → Models."
    : "No models available. Rescan agents to try again.";

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
        aria-description={orchestrator ? `Orchestrator · ${ORCHESTRATOR_GOAL_COPY[orchestrator.goal].label}` : `${chipSource} · ${label}`}
        disabled={disabled}
        onClick={() => { if (open) setOpen(false); else openPanel(); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); openPanel(); }
        }}
      >
        {orchestrator ? <span className="model-orchestrator-mark"><Activity size={15} aria-hidden="true" /></span>
          : chipProvider ? <ProviderMark id={chipProvider} size={16} name={providerName(chipProvider, customs)} /> : <AgentMark id={agentId} size={16} />}
        {!orchestrator && showModelIcon && selected ? <ModelMark modelId={selected.modelId} providerId={selected.providerId} size={16} /> : null}
        <span className="picker-value">{orchestrator ? "Orchestrator" : label}</span>
        {!orchestrator && selected && isFastModel(selected) ? <Zap size={12} className="model-fast" aria-label="Fast" /> : null}
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
              sources={sources}
              sourceId={needle ? undefined : sourceId}
              onSourceChange={pickSource}
              onRescan={onRescan}
              onShowCapabilities={onShowCapabilities ? () => { close(); onShowCapabilities(); } : undefined}
              capabilitiesLabel={`${AGENT_LABELS[agentId]} capabilities`}
            />
          ) : null}
          <div className="model-main">
            <div className="model-picker-head">
              <span className="model-head-mark" key={needle ? "search" : sourceId ?? ""}>{headMark}</span>
              <span className="model-head-copy">
                <span className="model-picker-title">{headTitle}</span>
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
                aria-activedescendant={rows.length ? `${listId}-${activeIndex}` : undefined}
                value={query}
                placeholder={railed ? "Search every provider’s models" : "Search models"}
                aria-label="Search models"
                disabled={disabled || loading}
                onChange={(event) => { setQuery(event.target.value); setActive(0); }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(rows.length - 1, index + 1)); }
                  else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
                  else if (event.key === "Enter" && rows[activeIndex]) { event.preventDefault(); choose(rows[activeIndex]); }
                }}
              />
              {query ? <button type="button" className="icon-btn" aria-label="Clear model search" onClick={() => { setQuery(""); setActive(0); search.current?.focus(); }}><X size={12} aria-hidden="true" /></button> : null}
            </label> : null}
            {onOrchestratorChange && !needle ? (
              <div className="model-orchestrator">
                <button
                  type="button"
                  role="switch"
                  aria-checked={orchestratorOn}
                  className="model-option model-orchestrator-row"
                  disabled={Boolean(disabled || applying)}
                  onClick={() => {
                    // Incomplete roles cannot route a turn: the row leads to Settings instead of switching.
                    if (!orchestratorOn && !orchestratorReady) { close(); onManageOrchestrator?.(); return; }
                    onOrchestratorChange(!orchestratorOn);
                    close();
                  }}
                >
                  <span className="model-icon"><span className="model-orchestrator-mark"><Activity size={20} aria-hidden="true" /></span></span>
                  <span className="model-copy">
                    <span className="model-name">
                      <span className="model-label">Orchestrator</span>
                      {!orchestratorOn && !orchestratorReady ? <span className="picker-tag">Set up</span> : null}
                    </span>
                    <span className="model-meta">
                      {orchestrator ? `${ORCHESTRATOR_GOAL_COPY[orchestrator.goal].label} · Lead, Builder and Small-task come from Settings`
                        : orchestratorReady ? "Route each message across the role models in Settings"
                        : "Choose a Lead and a Builder in Settings first"}
                    </span>
                  </span>
                  <span className={`orchestrator-switch${orchestratorOn ? " on" : ""}`} aria-hidden="true"><i /></span>
                </button>
              </div>
            ) : null}
            <div className="model-catalog">
              <div key={needle ? "search" : sourceId ?? ""} id={listId} role="listbox" aria-label="Model" aria-busy={Boolean(sourceLoading || applying)}>
                {sourceLoading && !needle ? <p className="picker-empty" role="status">Loading {source?.name ?? "models"}…</p> : !rows.length ? <p className="picker-empty">{emptyText}</p> : null}
                {rows.map((row, index) => {
                  const { model } = row;
                  const owner = row.source.agentId;
                  const price = costParts(model.cost);
                  const contributor = CONTRIBUTOR.test(model.modelId);
                  const specs = [contextLabel(model.contextLimit), !contributor && model.description !== "Free" && model.description !== providerName(model.providerId, customs) ? model.description : null].filter(Boolean).join(" · ");
                  const free = isFree(model, owner);
                  const name = shownName(model, owner);
                  const group = groupOf(row);
                  const heading = grouped && (index === 0 || groupOf(rows[index - 1]) !== group);
                  const rowSelected = isSelected(row);
                  return (
                    <div key={`${row.source.id}\u0000${modelKey(model)}`} role="presentation" className="model-row" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
                      {heading ? (
                        <div className={`menu-heading group${group === "free" ? " free" : ""}`}>
                          {needle ? <>{row.source.mark}{row.source.name}</> : group === "free" ? <><Sparkles size={12} aria-hidden="true" />Free right now</> : <>{model.providerId ? <ProviderMark id={model.providerId} size={14} name={providerName(model.providerId, customs)} /> : null}{providerName(model.providerId, customs)}</>}
                        </div>
                      ) : null}
                      <button
                        ref={(node) => { items.current[index] = node; }}
                        id={`${listId}-${index}`}
                        type="button"
                        role="option"
                        aria-selected={rowSelected}
                        aria-description={[model.unlisted ? unlistedNote([name]) : "", contributor ? dataNote(model) : model.description ?? "", owner !== agentId ? `Switches this thread to ${row.source.agentId === "harness" ? "the built-in agent" : row.source.name}` : ""].filter(Boolean).join(" ") || undefined}
                        tabIndex={index === activeIndex ? 0 : -1}
                        disabled={Boolean(selectionLocked || row.source.disabled)}
                        className={`model-option ${index === activeIndex ? "active" : ""} ${model.unavailable ? "unavailable" : ""}`}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => choose(row)}
                        onKeyDown={(event) => {
                          const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                          const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : step ? (index + step + rows.length) % rows.length : -1;
                          if (next < 0) return;
                          event.preventDefault(); setActive(next); items.current[next]?.focus();
                        }}
                      >
                        <span className="model-icon"><ModelIcon modelId={model.modelId} providerId={model.providerId} size={22} badge={mixed} hostName={providerName(model.providerId, customs)} fallback={<AgentMark id={owner} size={22} />} /></span>
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
              {listModels.some((model) => costParts(model.cost)) ? <p className="model-pricing-note">Prices per 1M tokens</p> : null}
              {unlisted.length ? <p className="picker-note"><Info size={11} aria-hidden="true" />{unlistedNote(unlisted.map((model) => shownName(model, agentId)))}</p> : null}
              {listModels.some((model) => CONTRIBUTOR.test(model.modelId)) ? <p className="picker-note"><Info size={11} aria-hidden="true" />Contributor models are discounted because your content, including inter-session messages, may be used for product improvement.</p> : null}
            </div>
            {onManageModels || onManageProviders ? (
              <div className="model-picker-foot">
                {source?.hidden && !needle ? <button type="button" className="ghost-btn small quiet" onClick={() => { close(); onManageModels?.(); }}><EyeOff size={11} aria-hidden="true" />{source.hidden} hidden</button> : <span />}
                <span className="model-picker-foot-actions">
                  {onManageProviders ? <button type="button" className="ghost-btn small" onClick={() => { close(); onManageProviders(); }}><KeyRound size={11} aria-hidden="true" />Manage providers</button> : null}
                  {onManageModels ? <button type="button" className="ghost-btn small" onClick={() => { close(); onManageModels(); }}><SlidersHorizontal size={11} aria-hidden="true" />Manage models</button> : null}
                </span>
              </div>
            ) : null}
          </div>
        </div>,
        root.current?.closest("dialog") ?? document.body,
      ) : null}
    </div>
  );
}
