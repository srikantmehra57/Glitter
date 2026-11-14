import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Activity, Check, ChevronDown, ExternalLink, FileText, Globe, Image as ImageIcon, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Search, Trash2, TriangleAlert, Video, X } from "lucide-react";
import { openUrl, providerKeySet } from "../lib/bridge";
import { modelPriceParts } from "../lib/cost";
import { describeError } from "../lib/errors";
import { humanizeModelLabel, humanizeProvider } from "../lib/format";
import { EFFORT_LABELS, type AgentId, type Model, type ModelTestResult, type ReasoningEffort, type Settings, type UserModelEntry } from "../lib/types";
import { VOCABULARY } from "../lib/effort";
import { KEYED_PROVIDER_IDS, PROVIDERS, SEARCH_PROVIDERS, customProviders, isCustomProviderId, providerName, providerWireLabel, type ProviderEntry, type ProviderWire } from "../lib/providers";
import { useAppStore } from "../lib/store";
import { AgentMark, ModelIcon, ProviderMark } from "./AgentPicker";
import { ModelEditDialog, type ModelEditRequest } from "./ModelEditDialog";
import { modelKey } from "./ModelPicker";
import { Collapse } from "./Presence";
import { SectionHead, SettingRow } from "./SettingsSection";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";

/**
 * Settings → Models & providers: the keys the built-in harness calls models
 * with, and the model library — the models the user added, with the context
 * window, effort levels and modality support they chose. A key goes straight
 * to the native keychain; this page only ever reads back whether one is saved
 * and its last four characters. Custom endpoints are added here — named, typed
 * by the API they speak, any number of them — and the native side mints their ids.
 */
export function ModelsProviders({ draft, edit }: { draft: Settings; edit: (patch: Partial<Settings>) => void }) {
  const s = useAppStore(useShallow((state) => ({
    providerStatus: state.providerStatus,
    providerStatusError: state.providerStatusError,
    refreshProviders: state.refreshProviders,
    refreshDetection: state.refreshDetection,
    models: state.models,
    modelsLoading: state.modelsLoading,
    modelsError: state.modelsError,
    refreshModels: state.refreshModels,
    refreshModelLibrary: state.refreshModelLibrary,
    testModel: state.testModel,
    confirm: state.confirm,
  })));
  const [editRequest, setEditRequest] = useState<ModelEditRequest | null>(null);
  useEffect(() => { if (!s.providerStatus) void s.refreshProviders(); }, [s.providerStatus, s.refreshProviders]);

  const customs = customProviders(s.providerStatus ?? []);
  const configured = s.providerStatus?.filter((row) => row.configured && (PROVIDERS.some((provider) => provider.id === row.id) || isCustomProviderId(row.id))).length ?? 0;
  // A new model can only come from a provider that would answer: one with a key.
  const modelProviders = [...PROVIDERS, ...customs].filter((provider) => s.providerStatus?.find((row) => row.id === provider.id)?.configured);
  const saveProvider = async (provider: string, change: { key?: string; baseUrl?: string; name?: string; wire?: string; clear?: boolean }) => {
    const rows = await providerKeySet(KEYED_PROVIDER_IDS, provider, change);
    useAppStore.setState({ providerStatus: rows });
    void s.refreshDetection().then(() => { void s.refreshModels(true); });
  };

  return (
    <div className="providers-panel">
      <SectionHead title="New thread defaults" help="The composer can change both for any thread." />
      <DefaultsCard draft={draft} edit={edit} />

      <SectionHead title="Providers" help="Connect model providers with your own API keys. Keys stay in your Mac’s keychain." />
      <div className="settings-callout">
        <KeyRound size={15} aria-hidden="true" />
        <div>
          <strong>Bring your own key</strong>
          <span>The built-in agent calls these providers directly. A key is sent only to the provider it belongs to, and that provider bills your account for what you use.</span>
        </div>
      </div>
      <div className="settings-card-heading"><h4>Model providers</h4><p>{s.providerStatus ? configured ? `${configured} connected. Add the models you want from them below.` : "Add a key for at least one provider to start." : "Reading saved providers…"}</p></div>
      {s.providerStatusError ? <p className="settings-note" role="alert">{s.providerStatusError}</p> : null}
      <ProviderRows onChanged={saveProvider} />

      <SectionHead
        title="Model library"
        help="The picker offers exactly these models. Adding one fetches what the provider reports — context window, effort levels, price — and you can correct anything it leaves out."
        action={<button type="button" className="ghost-btn small" disabled={!modelProviders.length} onClick={() => setEditRequest({ entry: null })}><Plus size={11} aria-hidden="true" />Add model</button>}
      />
      <ModelLibraryRows onEdit={(entry) => setEditRequest({ entry })} />
      {s.modelsError ? <p className="settings-note" role="alert">{s.modelsError}</p> : null}

      <ModelEditDialog request={editRequest} providers={modelProviders} onClose={() => setEditRequest(null)} />
    </div>
  );
}

/** The default model and effort a new thread starts on, chosen from the library. */
function DefaultsCard({ draft, edit }: { draft: Settings; edit: (patch: Partial<Settings>) => void }) {
  const s = useAppStore(useShallow((state) => ({
    models: state.models,
    modelsLoading: state.modelsLoading,
    refreshModels: state.refreshModels,
    refreshModelLibrary: state.refreshModelLibrary,
  })));
  const [refreshing, setRefreshing] = useState(false);
  const agentId: AgentId = "harness";
  const models = s.models;
  const modelOptions: SelectMenuOption[] = models.map((model) => ({
    value: modelKey(model),
    label: humanizeModelLabel(model.modelId, model.displayLabel),
    description: humanizeProvider(model.providerId),
    icon: <ModelIcon modelId={model.modelId} providerId={model.providerId} size={18} fallback={<AgentMark id={agentId} size={18} />} />,
  }));
  const selected = models.find((model) => model.modelId === draft.defaultModel && (model.providerId ?? "") === (draft.defaultProviderId ?? ""));
  const defaultModelValue = draft.defaultModel ? modelKey(selected ?? { modelId: draft.defaultModel, providerId: draft.defaultProviderId }) : undefined;
  if (defaultModelValue && !modelOptions.some((option) => option.value === defaultModelValue)) {
    modelOptions.push({ value: defaultModelValue, label: humanizeModelLabel(draft.defaultModel), description: selected ? "Not in your model library" : "Saved selection · not in the current catalog" });
  }
  const refresh = () => {
    setRefreshing(true);
    void s.refreshModelLibrary().finally(() => setRefreshing(false));
  };
  return <>
    <section className="settings-card" aria-label="New thread defaults">
      <SettingRow label={<label htmlFor="default-model">Default model</label>} help={<>{draft.defaultModel && !selected ? <span>This saved model is not in your library. Choose a current model. </span> : null}{draft.defaultModel ? <button className="text-btn" type="button" onClick={() => edit({ defaultModel: "", defaultProviderId: undefined })}>Use the agent’s default</button> : "New threads start on the agent’s own default."}</>}>
        <SelectMenu
          id="default-model"
          ariaLabel="Default model"
          icon={draft.defaultModel && selected ? <ModelIcon modelId={selected.modelId} providerId={selected.providerId} size={15} fallback={<AgentMark id={agentId} size={15} />} /> : undefined}
          value={defaultModelValue}
          placeholder={s.modelsLoading ? "Loading models…" : models.length ? "Agent default" : "Add a model to choose one"}
          options={modelOptions}
          disabled={s.modelsLoading || !models.length}
          onChange={(value) => { const model = models.find((row) => modelKey(row) === value); if (model) edit({ defaultModel: model.modelId, defaultProviderId: model.providerId }); }}
        />
      </SettingRow>
      <SettingRow label={<label htmlFor="default-effort">Default reasoning effort</label>} help="More effort gives the model longer on hard problems; less suits quick edits and questions.">
        <SelectMenu id="default-effort" ariaLabel="Default reasoning effort" value={draft.defaultEffort} placeholder="Agent default" options={VOCABULARY.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))} onChange={(value) => edit({ defaultEffort: value as ReasoningEffort })} />
      </SettingRow>
    </section>
    <p className="settings-note">{s.modelsLoading ? "Loading models…" : <button type="button" className="text-btn" onClick={refresh}><RefreshCw size={11} className={refreshing ? "spin" : ""} aria-hidden="true" />Refresh the library’s details</button>}</p>
  </>;
}

// ─── Provider rows (moved from the Providers page, unchanged in behavior) ────

type SaveChange = { key?: string; baseUrl?: string; name?: string; wire?: string; clear?: boolean };

function ProviderRows({ onChanged }: { onChanged: (provider: string, change: SaveChange) => Promise<void> }) {
  const status = useAppStore((state) => state.providerStatus);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const searchKey = SEARCH_PROVIDERS.find((provider) => status?.some((row) => row.id === provider.id && row.configured));
  const customs = customProviders(status ?? []);
  const save = async (provider: string, change: SaveChange) => {
    await onChanged(provider, change);
    setEditing(null);
    setAdding(false);
  };
  return <>
    <div className="settings-card provider-list">
      {PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          status={status?.find((row) => row.id === provider.id)}
          editing={editing === provider.id}
          onEdit={(open) => { setEditing(open ? provider.id : null); setAdding(false); }}
          onSave={(change) => save(provider.id, change)}
        />
      ))}
      {customs.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          status={status?.find((row) => row.id === provider.id)}
          editing={editing === provider.id}
          onEdit={(open) => { setEditing(open ? provider.id : null); setAdding(false); }}
          onSave={(change) => save(provider.id, change)}
        />
      ))}
      {adding ? (
        <CustomProviderRow onCancel={() => setAdding(false)} onSave={(change) => save("custom", change)} />
      ) : (
        <button type="button" className="provider-add" onClick={() => { setAdding(true); setEditing(null); }}>
          <Plus size={14} aria-hidden="true" />
          Add a custom endpoint
        </button>
      )}
    </div>
    <div className="settings-card-heading"><h4>Web search</h4><p>{searchKey ? `The built-in agent searches with ${searchKey.name}. Each search goes to that provider with your key.` : "Optional. Add a key and the built-in agent can search the web. Without one it can still fetch pages you or it name."}</p></div>
    <div className="settings-card provider-list">
      {SEARCH_PROVIDERS.map((provider) => (
        <ProviderRow
          key={provider.id}
          provider={provider}
          icon={<Globe size={16} aria-hidden="true" />}
          status={status?.find((row) => row.id === provider.id)}
          editing={editing === provider.id}
          onEdit={(open) => { setEditing(open ? provider.id : null); setAdding(false); }}
          onSave={(change) => save(provider.id, change)}
        />
      ))}
    </div>
  </>;
}

function ProviderRow({ provider, icon, status, editing, onEdit, onSave }: { provider: ProviderEntry; icon?: ReactNode; status?: { configured: boolean; keyHint: string | null; baseUrl: string | null }; editing: boolean; onEdit: (open: boolean) => void; onSave: (change: SaveChange) => Promise<void> }) {
  const id = useId();
  const row = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [wire, setWire] = useState<ProviderWire>("openai");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(status?.configured);
  const needsUrl = provider.custom || provider.local;
  const keyUrl = provider.keyUrl;
  useEffect(() => {
    if (!editing) return;
    setKey("");
    setUrl(status?.baseUrl ?? (provider.custom ? "" : provider.defaultUrl ?? ""));
    setName(provider.custom ? provider.name : "");
    setWire(provider.custom && provider.wire ? provider.wire : "openai");
    setError(null);
    // A form opened near the foot of the list is brought into view once it has grown open.
    const timer = window.setTimeout(() => row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 260);
    return () => window.clearTimeout(timer);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps -- the form re-seeds only when it opens
  const run = async (change: SaveChange) => {
    setBusy(true);
    setError(null);
    try { await onSave(change); }
    catch (err) { setError(describeError(change.clear ? "Could not remove the provider" : "Could not save", err)); }
    finally { setBusy(false); }
  };
  // A saved key is never re-pointed: a changed address asks for the key again.
  const urlChanged = Boolean(url.trim() && url.trim() !== status?.baseUrl);
  const keyNeeded = provider.custom ? urlChanged && Boolean(status?.keyHint) : !provider.local;
  const summary = configured
    ? [status?.keyHint ? `Key ${status.keyHint}` : provider.local || provider.custom ? "Enabled" : null, status?.baseUrl].filter(Boolean).join(" · ")
    : provider.detail;
  const canSave = provider.local ? true
    : provider.custom ? Boolean(name.trim() && url.trim()) && (!keyNeeded || Boolean(key.trim()))
    : Boolean(key.trim());
  return (
    <div ref={row} className={`provider-row${configured ? " configured" : ""}`}>
      <div className="setting-row">
        <div className="setting-copy">
          <span className="setting-label">{icon ?? <ProviderMark id={provider.id} size={16} name={provider.custom ? provider.name : undefined} />}{provider.name}{configured ? <span className="provider-badge">Connected</span> : null}</span>
          <span className="field-help">{provider.custom && provider.wire ? [providerWireLabel(provider.wire), summary].filter(Boolean).join(" · ") : summary}</span>
        </div>
        <div className="setting-control">
          {configured && !editing ? <button type="button" className="ghost-btn small danger-text" disabled={busy} onClick={() => void run({ clear: true })}>{busy ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : null}Remove</button> : null}
          <button type="button" className="ghost-btn small" aria-expanded={editing} aria-controls={`${id}-form`} onClick={() => onEdit(!editing)}>
            {editing ? "Cancel" : configured ? provider.local || provider.custom ? "Edit" : "Replace key" : provider.local ? "Enable" : "Add key"}
          </button>
        </div>
      </div>
      <Collapse open={editing}>{() => (
        <form id={`${id}-form`} className="provider-form" onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || busy) return;
          void run({
            ...(key.trim() ? { key: key.trim() } : {}),
            ...(needsUrl && url.trim() ? { baseUrl: url.trim() } : {}),
            ...(provider.custom && name.trim() ? { name: name.trim() } : {}),
            ...(provider.custom ? { wire } : {}),
          });
        }}>
          {provider.custom ? (
            <label className="field">
              <span>Name</span>
              <input type="text" value={name} placeholder="Work gateway" spellCheck={false} autoComplete="off" maxLength={40} onChange={(event) => setName(event.target.value)} />
            </label>
          ) : null}
          {provider.custom ? (
            <label className="field">
              <span>API type</span>
              <select value={wire} onChange={(event) => setWire(event.target.value as ProviderWire)}>
                <option value="openai">OpenAI-compatible — Chat Completions</option>
                <option value="anthropic">Anthropic — Messages</option>
              </select>
            </label>
          ) : null}
          {needsUrl ? (
            <label className="field">
              <span>Address</span>
              <input type="url" value={url} placeholder={provider.defaultUrl ?? "https://api.example.com/v1"} spellCheck={false} autoComplete="off" onChange={(event) => setUrl(event.target.value)} />
            </label>
          ) : null}
          {provider.local ? null : (
            <label className="field">
              <span>{configured ? keyNeeded ? "New API key" : "API key (optional)" : provider.custom ? "API key (optional)" : "API key"}</span>
              <input type="password" value={key} placeholder={provider.custom ? "Empty if the endpoint needs no key" : provider.placeholder ?? "API key"} spellCheck={false} autoComplete="off" autoFocus={!needsUrl} onChange={(event) => setKey(event.target.value)} />
            </label>
          )}
          {provider.custom && configured ? <p className="field-help">Changing the address needs the key again, so a saved key is never sent to a new server.</p> : null}
          {error ? <p className="settings-note danger" role="alert">{error}</p> : null}
          <div className="provider-form-actions">
            {keyUrl ? (
              <button type="button" className="text-btn provider-key-link" onClick={() => void openUrl(keyUrl).catch((cause) => setError(describeError("Could not open the browser", cause)))}>
                Get a key at {new URL(keyUrl).hostname}<ExternalLink size={11} aria-hidden="true" />
              </button>
            ) : null}
            <button type="submit" className="primary" disabled={!canSave || busy}>{busy ? <><LoaderCircle size={13} className="spin" aria-hidden="true" />Saving…</> : "Save"}</button>
          </div>
        </form>
      )}</Collapse>
    </div>
  );
}

/** The add form: a name, the API type, the address, and a key when the endpoint wants one. */
function CustomProviderRow({ onCancel, onSave }: { onCancel: () => void; onSave: (change: SaveChange) => Promise<void> }) {
  const row = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [wire, setWire] = useState<ProviderWire>("openai");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = Boolean(name.trim() && url.trim());
  useEffect(() => {
    const timer = window.setTimeout(() => row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 260);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div ref={row} className="provider-row">
      <div className="setting-row">
        <div className="setting-copy">
          <span className="setting-label"><ProviderMark id="custom" size={16} name={name.trim() || undefined} />New custom endpoint</span>
          <span className="field-help">Any OpenAI-compatible or Anthropic-compatible API, such as a company gateway or vLLM.</span>
        </div>
        <div className="setting-control">
          <button type="button" className="ghost-btn small" onClick={onCancel}>Cancel</button>
        </div>
      </div>
      <Collapse open>{() => (
        <form className="provider-form" onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || busy) return;
          setBusy(true);
          setError(null);
          onSave({ name: name.trim(), wire, baseUrl: url.trim(), ...(key.trim() ? { key: key.trim() } : {}) })
            .catch((err) => { setError(describeError("Could not save", err)); setBusy(false); });
        }}>
          <label className="field">
            <span>Name</span>
            <input type="text" value={name} placeholder="Work gateway" spellCheck={false} autoComplete="off" maxLength={40} autoFocus onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="field">
            <span>API type</span>
            <select value={wire} onChange={(event) => setWire(event.target.value as ProviderWire)}>
              <option value="openai">OpenAI-compatible — Chat Completions</option>
              <option value="anthropic">Anthropic — Messages</option>
            </select>
          </label>
          <label className="field">
            <span>Address</span>
            <input type="url" value={url} placeholder="https://api.example.com/v1" spellCheck={false} autoComplete="off" onChange={(event) => setUrl(event.target.value)} />
          </label>
          <label className="field">
            <span>API key (optional)</span>
            <input type="password" value={key} placeholder="Empty if the endpoint needs no key" spellCheck={false} autoComplete="off" onChange={(event) => setKey(event.target.value)} />
          </label>
          {error ? <p className="settings-note danger" role="alert">{error}</p> : null}
          <div className="provider-form-actions">
            <button type="submit" className="primary" disabled={!canSave || busy}>{busy ? <><LoaderCircle size={13} className="spin" aria-hidden="true" />Saving…</> : "Add endpoint"}</button>
          </div>
        </form>
      )}</Collapse>
    </div>
  );
}

// ─── The model library ───────────────────────────────────────────────────────

type TestState = { state: "running" } | { state: "ok"; result: ModelTestResult } | { state: "failed"; error: string };

function contextLabel(limit?: number | null) {
  if (!limit) return "Context unknown";
  return limit >= 1_000_000 ? `${Math.round(limit / 100_000) / 10}M context`.replace(".0M", "M") : `${Math.round(limit / 1000)}K context`;
}

function seconds(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function effortSummary(model: Model): string | null {
  const tiers = model.reasoningEfforts ?? [];
  if (!tiers.length) return null;
  return tiers.length === 1 ? EFFORT_LABELS[tiers[0]] : `${EFFORT_LABELS[tiers[0]]} – ${EFFORT_LABELS[tiers[tiers.length - 1]]}`;
}

/** The library's rows, grouped by provider, with Edit, Test and Remove per model. */
function ModelLibraryRows({ onEdit }: { onEdit: (entry: UserModelEntry) => void }) {
  const s = useAppStore(useShallow((state) => ({
    models: state.models,
    modelsLoading: state.modelsLoading,
    testModel: state.testModel,
    confirm: state.confirm,
    removeModelEntry: state.removeModelEntry,
    providerStatus: state.providerStatus,
    modelLibrary: state.modelLibrary,
  })));
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const customs = customProviders(s.providerStatus ?? []);
  const needle = query.trim().toLowerCase();
  const matches = (model: Model) => !needle || `${model.modelId} ${model.displayLabel ?? ""} ${humanizeModelLabel(model.modelId, model.displayLabel)}`.toLowerCase().includes(needle);
  /** The row's library entry, so the dialog shows exactly what the user set. */
  const entryFor = (model: Model): UserModelEntry => {
    const bare = model.modelId.includes("/") ? model.modelId.slice(model.modelId.indexOf("/") + 1) : model.modelId;
    return s.modelLibrary?.find((item) => item.providerId === model.providerId && item.model === bare) ?? {
      providerId: model.providerId ?? "",
      model: bare,
      displayName: model.displayLabel,
      contextWindow: model.contextLimit ?? null,
      efforts: model.reasoningEfforts,
      defaultEffort: model.defaultReasoningEffort,
      images: model.images ?? null,
      documents: model.documents ?? null,
      video: model.video ?? null,
      cost: model.cost ? { input: model.cost.input, output: model.cost.output, currency: model.cost.currency ?? null } : null,
      source: "migrated",
      addedAt: new Date(0).toISOString(),
    };
  };

  const groups: Array<{ id: string; name: string; models: Model[] }> = [];
  for (const model of s.models.filter(matches)) {
    const providerId = model.providerId ?? "";
    const name = providerName(providerId, customs);
    let group = groups.find((item) => item.id === providerId);
    if (!group) { group = { id: providerId, name, models: [] }; groups.push(group); }
    group.models.push(model);
  }

  const runTest = async (model: Model) => {
    const key = modelKey(model);
    setTests((all) => ({ ...all, [key]: { state: "running" } }));
    try {
      const result = await s.testModel("harness", model);
      setTests((all) => ({ ...all, [key]: { state: "ok", result } }));
    } catch (error) {
      setTests((all) => ({ ...all, [key]: { state: "failed", error: describeError("Test failed", error) } }));
    }
  };
  const remove = (model: Model) => {
    const name = humanizeModelLabel(model.modelId, model.displayLabel);
    void s.confirm({
      title: `Remove ${name} from your library?`,
      body: "It leaves the model picker and new threads cannot start on it. Threads already using it keep their model until you change it.",
      confirmLabel: "Remove",
      danger: true,
    }).then((ok) => { if (ok) void s.removeModelEntry(model.modelId); });
  };

  if (!s.models.length) {
    return s.modelsLoading ? (
      <div className="settings-card"><p className="library-empty" role="status"><LoaderCircle size={12} className="spin" aria-hidden="true" />Loading your models…</p></div>
    ) : (
      <div className="settings-empty">
        <ModelIcon modelId="" providerId="" size={18} fallback={<AgentMark id="harness" size={18} />} />
        <div><strong>No models yet</strong><span>Add the models you want from a connected provider. Past threads’ models were added for you.</span></div>
      </div>
    );
  }

  return <div className="model-library">
    <div className="model-library-tools">
      <label className="search-field">
        <Search size={13} aria-hidden="true" />
        <input value={query} placeholder="Search your models" aria-label="Search your models" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
        {query ? <button type="button" className="search-clear" aria-label="Clear model search" onClick={() => setQuery("")}><X size={12} /></button> : null}
      </label>
      <span className="model-library-count" aria-live="polite">{s.models.length} in the picker</span>
    </div>
    {groups.map((group) => {
      const open = needle ? true : !closed[group.id];
      const testing = group.models.some((model) => tests[modelKey(model)]?.state === "running");
      return (
        <section key={group.id} className={`settings-card library-group${open ? " open" : ""}`} aria-label={group.name}>
          <div className="library-head">
            <button type="button" className="library-toggle" aria-expanded={open} onClick={() => setClosed((all) => ({ ...all, [group.id]: open }))}>
              <ProviderMark id={group.id} size={22} name={group.name} />
              <span className="library-title">
                <strong>{group.name}</strong>
                <span>{group.models.length} {group.models.length === 1 ? "model" : "models"}</span>
              </span>
              <ChevronDown size={14} className="library-chevron" aria-hidden="true" />
            </button>
            <span className="library-actions">
              {group.models.length ? <button type="button" className="ghost-btn small" disabled={testing} onClick={() => { for (const model of group.models) void runTest(model); }}><Activity size={11} aria-hidden="true" />{testing ? "Testing…" : "Test shown"}</button> : null}
            </span>
          </div>
          <Collapse open={open}>{() => (
            <div className="library-body">
              <ul className="library-list">
                {group.models.map((model) => {
                  const key = modelKey(model);
                  const name = humanizeModelLabel(model.modelId, model.displayLabel);
                  const test = tests[key];
                  const price = modelPriceParts(model.cost);
                  const tiers = effortSummary(model);
                  const meta = [
                    contextLabel(model.contextLimit),
                    tiers ? `${tiers} effort` : null,
                    price ? `${price[0]} / ${price[1]} per 1M` : null,
                  ].filter(Boolean).join(" · ");
                  return (
                    <li key={key} className={model.unavailable ? "off" : ""}>
                      <ModelIcon modelId={model.modelId} providerId={model.providerId} size={20} hostName={providerName(model.providerId, customs)} fallback={<AgentMark id="harness" size={20} />} />
                      <span className="library-copy">
                        <span className="library-name">
                          <span title={model.modelId}>{name}</span>
                          {model.isDefault ? <span className="picker-tag">Default</span> : null}
                          {model.free ? <span className="picker-tag free">Free</span> : null}
                          {model.unavailable ? <span className="picker-tag">Needs key</span> : null}
                          {model.images === true ? <span className="picker-tag" title="Supports images"><ImageIcon size={10} aria-hidden="true" /></span> : null}
                          {model.documents === true ? <span className="picker-tag" title="Supports documents"><FileText size={10} aria-hidden="true" /></span> : null}
                          {model.video === true ? <span className="picker-tag" title="Supports video"><Video size={10} aria-hidden="true" /></span> : null}
                        </span>
                        {test?.state === "failed" ? <span className="library-meta danger" role="alert">{test.error}</span> : meta ? <span className="library-meta">{meta}</span> : null}
                      </span>
                      <span className="library-test">
                        {test?.state === "ok" ? <span className="test-chip ok" title={test.result.reply ? `Replied “${test.result.reply}”` : "Replied"}><Check size={10} strokeWidth={3} aria-hidden="true" />{seconds(test.result.latencyMs)}</span> : null}
                        {test?.state === "failed" ? <span className="test-chip failed"><TriangleAlert size={10} aria-hidden="true" />No reply</span> : null}
                        <button type="button" className="icon-btn small" aria-label={`Edit ${name}`} data-tooltip="Edit" onClick={() => onEdit(entryFor(model))}><Pencil size={14} aria-hidden="true" /></button>
                        <button type="button" className="icon-btn small" aria-label={`Test ${name}`} data-tooltip={test?.state === "running" ? "Testing…" : test ? "Test again" : "Test the reply"} disabled={test?.state === "running"} onClick={() => void runTest(model)}>
                          {test?.state === "running" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Activity size={14} aria-hidden="true" />}
                        </button>
                        <button type="button" className="icon-btn small" aria-label={`Remove ${name}`} data-tooltip="Remove" onClick={() => remove(model)}><Trash2 size={14} aria-hidden="true" /></button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}</Collapse>
        </section>
      );
    })}
    {needle && !groups.length ? <p className="settings-note">No models match “{query}”.</p> : null}
  </div>;
}
