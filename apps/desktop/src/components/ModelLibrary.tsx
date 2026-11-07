import { useEffect, useMemo, useState } from "react";
import { Activity, Check, ChevronDown, KeyRound, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { describeError } from "../lib/errors";
import { modelPriceParts } from "../lib/cost";
import { humanizeModelLabel } from "../lib/format";
import { modelVisibilityKey, withModelsHidden } from "../lib/modelVisibility";
import { providerIds, providerName, type ProviderEntry } from "../lib/providers";
import { AGENT_IDS, type AgentId, type AgentInfo, type Model, type ModelTestResult } from "../lib/types";
import { AgentMark, ModelIcon, ProviderMark } from "./AgentPicker";
import { Collapse } from "./Presence";

type Catalog = { models: Model[]; loading: boolean; error: string | null };
type TestState = { state: "running" } | { state: "ok"; result: ModelTestResult } | { state: "failed"; error: string };
type Group = { id: string; agentId: AgentId; name: string; mark: React.ReactNode; models: Model[]; catalog: Catalog; testable: boolean };

/** Rows shown before a long provider list folds the rest behind "Show more". */
const FOLD = 8;
/** A provider with more models than this gets its own search field. */
const SEARCHABLE = 10;

function matchesQuery(model: Model, needle: string) {
  return !needle || `${model.modelId} ${model.displayLabel ?? ""} ${humanizeModelLabel(model.modelId, model.displayLabel)}`.toLowerCase().includes(needle);
}

function seconds(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function contextLabel(limit?: number | null) {
  if (!limit) return null;
  return limit >= 1_000_000 ? `${Math.round(limit / 100_000) / 10}M context`.replace(".0M", "M") : `${Math.round(limit / 1000)}K context`;
}

/**
 * Settings → Models: every model each provider offers, with a switch that keeps
 * it in or out of the composer's picker, and — for the built-in agent, which
 * calls providers itself — a Test that sends one word and times the reply.
 */
export function ModelLibrary({ agents, customProviders: customs = [], hidden, onHiddenChange, hiddenProviders, onHiddenProvidersChange, loadCatalog, testModel, onManageProviders }: {
  agents: AgentInfo[];
  /** The custom endpoints the keychain holds, so their cards carry the user's own names. */
  customProviders?: ProviderEntry[];
  hidden: readonly string[];
  onHiddenChange: (next: string[]) => void;
  /** Providers switched off as a whole, by `providerKey`. */
  hiddenProviders: readonly string[];
  onHiddenProvidersChange: (next: string[]) => void;
  loadCatalog: (agentId: AgentId) => Promise<Model[]>;
  testModel: (agentId: AgentId, model: Model) => Promise<ModelTestResult>;
  onManageProviders: () => void;
}) {
  const ids = useMemo(() => AGENT_IDS.filter((id) => agents.some((agent) => agent.id === id)), [agents]);
  const [catalogs, setCatalogs] = useState<Partial<Record<AgentId, Catalog>>>({});
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const [groupQueries, setGroupQueries] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    for (const id of ids) {
      setCatalogs((all) => ({ ...all, [id]: { models: all[id]?.models ?? [], loading: true, error: null } }));
      loadCatalog(id).then(
        (models) => { if (live) setCatalogs((all) => ({ ...all, [id]: { models, loading: false, error: null } })); },
        (error) => { if (live) setCatalogs((all) => ({ ...all, [id]: { models: [], loading: false, error: describeError("Could not list its models", error) } })); },
      );
    }
    return () => { live = false; };
  }, [ids.join(","), loadCatalog]);

  const groups: Group[] = [];
  for (const id of ids) {
    const catalog = catalogs[id] ?? { models: [], loading: true, error: null };
    const info = agents.find((agent) => agent.id === id);
    if (id === "harness") {
      for (const providerId of providerIds(catalog.models)) {
        const providerLabel = providerName(providerId, customs);
        groups.push({ id: `harness:${providerId}`, agentId: id, name: providerLabel, mark: <ProviderMark id={providerId} size={22} name={providerLabel} />, models: catalog.models.filter((model) => model.providerId === providerId), catalog, testable: true });
      }
      continue;
    }
    groups.push({ id: `${id}:`, agentId: id, name: info?.name ?? id, mark: <AgentMark id={id} size={22} />, models: catalog.models, catalog, testable: false });
  }
  const harnessCatalog = catalogs.harness;
  const noProviders = ids.includes("harness") && harnessCatalog && !harnessCatalog.loading && !harnessCatalog.models.length;
  const needle = query.trim().toLowerCase();

  const hiddenSet = new Set(hidden);
  const isHidden = (agentId: AgentId, model: Model) => hiddenSet.has(modelVisibilityKey(agentId, model));
  const setHidden = (agentId: AgentId, models: Model[], hide: boolean) => onHiddenChange(withModelsHidden(hidden, agentId, models, hide));
  const runTest = async (group: Group, model: Model) => {
    const key = modelVisibilityKey(group.agentId, model);
    setTests((all) => ({ ...all, [key]: { state: "running" } }));
    try {
      const result = await testModel(group.agentId, model);
      setTests((all) => ({ ...all, [key]: { state: "ok", result } }));
    } catch (error) {
      setTests((all) => ({ ...all, [key]: { state: "failed", error: describeError("Test failed", error) } }));
    }
  };
  const testAll = async (group: Group, models: Model[]) => {
    // Two at a time: quick enough for a short list without tripping a provider's rate limit.
    const queue = [...models];
    const worker = async () => { for (let next = queue.shift(); next; next = queue.shift()) await runTest(group, next); };
    await Promise.all([worker(), worker()]);
  };

  return (
    <div className="model-library">
      <div className="model-library-tools">
        <label className="search-field">
          <Search size={13} aria-hidden="true" />
          <input value={query} placeholder="Search all models" aria-label="Search all models" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
          {query ? <button type="button" className="search-clear" aria-label="Clear model search" onClick={() => setQuery("")}><X size={12} /></button> : null}
        </label>
        <span className="model-library-count" aria-live="polite">{hidden.length ? `${hidden.length} hidden from the picker` : "Every model is in the picker"}</span>
      </div>
      {noProviders ? (
        <div className="settings-empty">
          <KeyRound size={18} aria-hidden="true" />
          <div><strong>No providers connected</strong><span>Add an API key and its models appear here and in the composer.</span></div>
          <button type="button" className="secondary small" onClick={onManageProviders}>Add a provider</button>
        </div>
      ) : null}
      {groups.map((group) => {
        const own = (groupQueries[group.id] ?? "").trim().toLowerCase();
        const matches = group.models.filter((model) => matchesQuery(model, needle) && matchesQuery(model, own));
        if (needle && !group.models.some((model) => matchesQuery(model, needle))) return null;
        const shown = group.models.filter((model) => !isHidden(group.agentId, model)).length;
        // A provider switched off keeps its list folded away; turning it back on restores its own model choices.
        const providerOff = hiddenProviders.includes(group.id);
        const open = providerOff ? false : needle ? true : !closed[group.id];
        const folded = !needle && !own && !unfolded[group.id] && matches.length > FOLD + 2;
        const rows = folded ? matches.slice(0, FOLD) : matches;
        const allShown = shown === group.models.length;
        const testing = group.models.some((model) => tests[modelVisibilityKey(group.agentId, model)]?.state === "running");
        return (
          <section key={group.id} className={`settings-card library-group${open ? " open" : ""}${providerOff ? " off" : ""}`} aria-label={group.name}>
            <div className="library-head">
              <button type="button" className="library-toggle" aria-expanded={open} disabled={providerOff} onClick={() => setClosed((all) => ({ ...all, [group.id]: open }))}>
                {group.mark}
                <span className="library-title">
                  <strong>{group.name}</strong>
                  <span>{providerOff ? "Off — not in the model picker" : group.catalog.loading && !group.models.length ? "Loading models…" : group.catalog.error ? "Unavailable" : `${shown} of ${group.models.length} in the picker`}</span>
                </span>
                <ChevronDown size={14} className="library-chevron" aria-hidden="true" />
              </button>
              <span className="library-actions">
                {!providerOff && group.testable && group.models.length ? <button type="button" className="ghost-btn small" disabled={testing} onClick={() => void testAll(group, matches.filter((model) => !isHidden(group.agentId, model)))}><Activity size={11} aria-hidden="true" />{testing ? "Testing…" : "Test shown"}</button> : null}
                {!providerOff && group.models.length ? <button type="button" className="ghost-btn small" onClick={() => setHidden(group.agentId, group.models, allShown)}>{allShown ? "Hide all" : "Show all"}</button> : null}
                <button type="button" role="switch" aria-checked={!providerOff} aria-label={`Use ${group.name} in the model picker`} data-tooltip={providerOff ? `Turn ${group.name} on` : `Turn ${group.name} off`} className="toggle library-provider-switch" onClick={() => onHiddenProvidersChange(providerOff ? hiddenProviders.filter((key) => key !== group.id) : [...hiddenProviders, group.id])}><i /></button>
              </span>
            </div>
            <Collapse open={open}>{() => (
              <div className="library-body">
                {group.models.length > SEARCHABLE ? (
                  <label className="search-field library-search">
                    <Search size={13} aria-hidden="true" />
                    <input value={groupQueries[group.id] ?? ""} placeholder={`Search ${group.models.length} ${group.name} models`} aria-label={`Search ${group.name} models`} spellCheck={false} onChange={(event) => setGroupQueries((all) => ({ ...all, [group.id]: event.target.value }))} />
                    {groupQueries[group.id] ? <button type="button" className="search-clear" aria-label={`Clear the ${group.name} search`} onClick={() => setGroupQueries((all) => ({ ...all, [group.id]: "" }))}><X size={12} /></button> : null}
                  </label>
                ) : null}
                {own && !matches.length ? <p className="library-empty">No {group.name} models match “{groupQueries[group.id]}”.</p> : null}
                {group.catalog.error ? <p className="settings-note danger" role="alert">{group.catalog.error}</p> : null}
                {group.catalog.loading && !group.models.length ? <p className="library-empty" role="status"><LoaderCircle size={12} className="spin" aria-hidden="true" />Loading {group.name} models…</p> : null}
                {!group.catalog.loading && !group.catalog.error && !group.models.length ? <p className="library-empty">{group.name} did not report any models.</p> : null}
                <ul className="library-list">
                  {rows.map((model) => {
                    const key = modelVisibilityKey(group.agentId, model);
                    const off = isHidden(group.agentId, model);
                    const name = humanizeModelLabel(model.modelId, model.displayLabel);
                    const test = tests[key];
                    const price = modelPriceParts(model.cost);
                    const meta = [contextLabel(model.contextLimit), price ? `${price[0]} / ${price[1]} per 1M` : null].filter(Boolean).join(" · ");
                    return (
                      <li key={key} className={off ? "off" : ""}>
                        <ModelIcon modelId={model.modelId} providerId={model.providerId} size={20} hostName={providerName(model.providerId, customs)} fallback={<AgentMark id={group.agentId} size={20} />} />
                        <span className="library-copy">
                          <span className="library-name"><span title={model.modelId}>{name}</span>{model.isDefault ? <span className="picker-tag">Default</span> : null}{model.free ? <span className="picker-tag free">Free</span> : null}</span>
                          {test?.state === "failed" ? <span className="library-meta danger" role="alert">{test.error}</span> : meta ? <span className="library-meta">{meta}</span> : null}
                        </span>
                        {group.testable ? (
                          <span className="library-test">
                            {test?.state === "ok" ? <span className="test-chip ok" title={test.result.reply ? `Replied “${test.result.reply}”` : "Replied"}><Check size={10} strokeWidth={3} aria-hidden="true" />{seconds(test.result.latencyMs)}</span> : null}
                            {test?.state === "failed" ? <span className="test-chip failed"><TriangleAlert size={10} aria-hidden="true" />No reply</span> : null}
                            <button type="button" className="icon-btn small" aria-label={`Test ${name}`} data-tooltip={test?.state === "running" ? "Testing…" : test ? "Test again" : "Test the reply"} disabled={test?.state === "running"} onClick={() => void runTest(group, model)}>
                              {test?.state === "running" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Activity size={14} aria-hidden="true" />}
                            </button>
                          </span>
                        ) : null}
                        <button type="button" role="switch" aria-checked={!off} aria-label={`Show ${name} in the model picker`} className="toggle" onClick={() => setHidden(group.agentId, [model], !off)}><i /></button>
                      </li>
                    );
                  })}
                </ul>
                {folded ? <button type="button" className="text-btn library-more" onClick={() => setUnfolded((all) => ({ ...all, [group.id]: true }))}>Show {matches.length - FOLD} more</button> : null}
                {!group.testable && group.models.length ? <p className="library-foot">Test runs for models the built-in agent calls directly. {group.name} models are checked by opening a thread on them.</p> : null}
              </div>
            )}</Collapse>
          </section>
        );
      })}
      {needle && !groups.some((group) => group.models.some((model) => matchesQuery(model, needle))) ? <p className="settings-note">No models match “{query}”.</p> : null}
    </div>
  );
}
