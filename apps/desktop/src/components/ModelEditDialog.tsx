import { useEffect, useMemo, useRef, useState } from "react";
import { Check, LoaderCircle, X } from "lucide-react";
import { TIER_COPY, VOCABULARY } from "../lib/effort";
import { useModalDialog } from "../lib/dialogFocus";
import { describeError } from "../lib/errors";
import { humanizeModelLabel } from "../lib/format";
import { useRetained } from "../lib/presence";
import { useAppStore } from "../lib/store";
import { EFFORT_LABELS, type Model, type ReasoningEffort, type UserModelEntry } from "../lib/types";
import type { ProviderEntry } from "../lib/providers";
import { ModelIcon, ProviderMark } from "./AgentPicker";
import { SelectMenu } from "./SelectMenu";

/** What one dialog run edits: an existing entry, or null to add one. */
export type ModelEditRequest = { entry: UserModelEntry | null };

type Modality = "unknown" | "yes" | "no";
const toModality = (value: boolean | null | undefined): Modality => value === true ? "yes" : value === false ? "no" : "unknown";
const fromModality = (value: Modality): boolean | null => value === "yes" ? true : value === "no" ? false : null;
const MODALITY_OPTIONS: Array<{ value: Modality; label: string }> = [
  { value: "unknown", label: "Unknown" },
  { value: "yes", label: "Supported" },
  { value: "no", label: "Not supported" },
];

const TIER_CHOICES = VOCABULARY;

/**
 * Add or edit one model library entry. The provider's own listing suggests
 * models and fills in what it reports — context window, effort levels, price,
 * image support — and anything it does not report the user decides here. What
 * the user sets is what the harness keeps; what they leave open stays open.
 */
export function ModelEditDialog({ request, providers, onClose }: {
  request: ModelEditRequest | null;
  /** The configured providers a new model can come from. */
  providers: ProviderEntry[];
  onClose: () => void;
}) {
  const shown = useRetained(request);
  const open = Boolean(request);
  const editing = shown?.entry ?? null;
  const node = useRef<HTMLDialogElement>(null);
  const modelField = useRef<HTMLInputElement>(null);
  useModalDialog(open, node);
  const putModelEntry = useAppStore((state) => state.putModelEntry);
  const fetchProviderModels = useAppStore((state) => state.fetchProviderModels);

  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [efforts, setEfforts] = useState<ReasoningEffort[]>([]);
  const [defaultEffort, setDefaultEffort] = useState<ReasoningEffort | undefined>(undefined);
  const [images, setImages] = useState<Modality>("unknown");
  const [documents, setDocuments] = useState<Modality>("unknown");
  const [video, setVideo] = useState<Modality>("unknown");
  const [effortSource, setEffortSource] = useState<"fetched" | "user">("user");
  const [cost, setCost] = useState<UserModelEntry["cost"]>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Model[]>>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One form per run: the dialog is retained through its exit animation, so the
  // fields re-seed from the request the moment a new one arrives.
  useEffect(() => {
    if (!open) return;
    const entry = editing;
    setProviderId(entry?.providerId ?? providers[0]?.id ?? "");
    setModel(entry?.model ?? "");
    setDisplayName(entry?.displayName ?? "");
    setContextWindow(entry?.contextWindow ? String(entry.contextWindow) : "");
    setEfforts(entry?.efforts ?? []);
    setDefaultEffort(entry?.defaultEffort);
    setImages(toModality(entry?.images));
    setDocuments(toModality(entry?.documents));
    setVideo(toModality(entry?.video));
    setEffortSource(entry?.effortSource ?? "user");
    setCost(entry?.cost ?? null);
    setSuggestions({});
    setSuggestionsLoading(false);
    setSuggestionsError(null);
    setBusy(false);
    setError(null);
  }, [open, editing, providers]);

  // The provider's own listing powers the suggestions. A provider that will not
  // list (no key, offline, no /models) leaves the id field as the only input.
  useEffect(() => {
    if (!open || !providerId) return;
    if (suggestions[providerId]) return;
    let live = true;
    setSuggestionsLoading(true);
    setSuggestionsError(null);
    fetchProviderModels(providerId).then(
      (models) => { if (live) setSuggestions((all) => ({ ...all, [providerId]: models })); },
      (cause) => { if (live) setSuggestionsError(describeError("Could not list this provider's models", cause)); },
    ).finally(() => { if (live) setSuggestionsLoading(false); });
    return () => { live = false; };
  }, [open, providerId, fetchProviderModels]); // eslint-disable-line react-hooks/exhaustive-deps -- the cache check keeps one fetch per provider

  const listed = providerId ? suggestions[providerId] ?? [] : [];
  const needle = model.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!needle) return listed.slice(0, 8);
    const hits = listed.filter((row) => row.modelId.toLowerCase().includes(needle) || (row.displayLabel ?? "").toLowerCase().includes(needle));
    return hits.slice(0, 8);
  }, [listed, needle]);

  const applySuggestion = (row: Model) => {
    const bare = row.modelId.includes("/") ? row.modelId.slice(row.modelId.indexOf("/") + 1) : row.modelId;
    setModel(bare);
    setDisplayName(row.displayLabel && row.displayLabel !== bare ? row.displayLabel : "");
    setContextWindow(row.contextLimit ? String(row.contextLimit) : "");
    setEfforts(row.reasoningEfforts ?? []);
    setDefaultEffort(row.defaultReasoningEffort);
    setCost(row.cost ? { input: row.cost.input, output: row.cost.output, currency: row.cost.currency ?? null } : null);
    setEffortSource("fetched");
    // A listing that names no image support keeps the family heuristic in charge.
    if (typeof (row as Model & { images?: boolean | null }).images === "boolean") setImages(toModality((row as Model & { images?: boolean | null }).images));
    setError(null);
  };

  const toggleEffort = (tier: ReasoningEffort) => {
    setEffortSource("user");
    setDefaultEffort(undefined);
    setEfforts((all) => all.includes(tier) ? all.filter((item) => item !== tier) : [...TIER_CHOICES.filter((item) => all.includes(item) || item === tier)]);
  };

  const canSave = Boolean(providerId) && Boolean(model.trim()) && !/\s/.test(model.trim());
  const windowNumber = Number(contextWindow.trim());

  const save = async () => {
    if (!canSave || busy) return;
    setBusy(true);
    setError(null);
    try {
      await putModelEntry({
        providerId: providerId.trim(),
        model: model.trim(),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        contextWindow: contextWindow.trim() && Number.isFinite(windowNumber) && windowNumber > 0 ? Math.trunc(windowNumber) : null,
        ...(efforts.length ? { efforts, ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}) } : { efforts: [] }),
        images: fromModality(images),
        documents: fromModality(documents),
        video: fromModality(video),
        cost,
        effortSource,
      });
      onClose();
    } catch (cause) {
      setError(describeError("Could not save the model", cause));
      setBusy(false);
    }
  };

  return <dialog ref={node} className="modal model-edit-dialog" aria-labelledby="model-edit-title" aria-hidden={!open} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onClose={onClose} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <header className="model-edit-head">
      <h2 id="model-edit-title">{editing ? "Edit model" : "Add a model"}</h2>
      <button type="button" className="icon-btn" aria-label="Close" disabled={busy} onClick={onClose}><X size={16} /></button>
    </header>

    <div className="model-edit-body">
      <label className="field">
        <span>Provider</span>
        <SelectMenu
          id="model-edit-provider"
          ariaLabel="Provider"
          value={providerId}
          placeholder={providers.length ? "Choose a provider" : "No provider connected"}
          icon={providerId ? <ProviderMark id={providerId} size={15} name={providers.find((provider) => provider.id === providerId)?.custom ? providers.find((provider) => provider.id === providerId)?.name : undefined} /> : undefined}
          options={providers.map((provider) => ({ value: provider.id, label: provider.name, icon: <ProviderMark id={provider.id} size={16} name={provider.custom ? provider.name : undefined} /> }))}
          disabled={!providers.length}
          onChange={(value) => { setProviderId(String(value)); setModel(""); setDisplayName(""); setContextWindow(""); setEfforts([]); setDefaultEffort(undefined); setCost(null); setEffortSource("user"); setImages("unknown"); }}
        />
      </label>

      <label className="field">
        <span>Model</span>
        <input
          ref={modelField}
          type="text"
          value={model}
          placeholder={providerId ? "Pick a suggestion or type the model id" : "Choose a provider first"}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          aria-invalid={Boolean(model.trim()) && /\s/.test(model.trim())}
          onChange={(event) => setModel(event.target.value)}
        />
      </label>
      {suggestionsLoading ? <p className="model-edit-note" role="status"><LoaderCircle size={12} className="spin" aria-hidden="true" />Listing {providers.find((provider) => provider.id === providerId)?.name ?? "provider"} models…</p> : null}
      {suggestionsError ? <p className="model-edit-note" role="alert">{suggestionsError} Type the model id instead.</p> : null}
      {!suggestionsLoading && !suggestionsError && matches.length ? (
        <ul className="model-suggestions" aria-label="Model suggestions">
          {matches.map((row) => {
            const bare = row.modelId.includes("/") ? row.modelId.slice(row.modelId.indexOf("/") + 1) : row.modelId;
            const chosen = model.trim() === bare;
            return (
              <li key={row.modelId}>
                <button type="button" className={chosen ? "on" : ""} onClick={() => applySuggestion(row)}>
                  <ModelIcon modelId={row.modelId} providerId={row.providerId} size={16} fallback={<ProviderMark id={row.providerId ?? providerId} size={16} />} />
                  <span className="model-suggestion-copy">
                    <strong>{humanizeModelLabel(row.modelId, row.displayLabel)}</strong>
                    <span>{[row.contextLimit ? `${Math.round(row.contextLimit / 1000)}K context` : null, (row.reasoningEfforts ?? []).length ? `${(row.reasoningEfforts ?? []).length} effort levels` : "no effort levels", row.cost?.input ? `$${row.cost.input}/M in` : null].filter(Boolean).join(" · ") || "No details reported"}</span>
                  </span>
                  {chosen ? <Check size={13} aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <label className="field">
        <span>Name in the picker <em>(optional)</em></span>
        <input type="text" value={displayName} placeholder={model.trim() ? humanizeModelLabel(`${providerId}/${model.trim()}`) : "Shown instead of the model id"} spellCheck={false} autoComplete="off" maxLength={120} onChange={(event) => setDisplayName(event.target.value)} />
      </label>

      <label className="field">
        <span>Context window <em>(tokens, optional)</em></span>
        <input
          type="text"
          inputMode="numeric"
          value={contextWindow}
          placeholder="Unknown — learned from the provider"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={Boolean(contextWindow.trim()) && (!Number.isFinite(windowNumber) || windowNumber <= 0)}
          onChange={(event) => setContextWindow(event.target.value.replace(/[^\d_]/g, "").replace(/_/g, ""))}
        />
      </label>

      <div className="field">
        <span id="model-efforts-label">Reasoning levels</span>
        <div className="model-effort-chips" role="group" aria-labelledby="model-efforts-label">
          {TIER_CHOICES.map((tier) => {
            const on = efforts.includes(tier);
            const isDefault = on && defaultEffort === tier;
            return (
              <button key={tier} type="button" className={`model-effort-chip${on ? " on" : ""}`} aria-pressed={on} aria-label={isDefault ? `${TIER_COPY[tier].label} (default)` : undefined} onClick={() => { if (isDefault) setDefaultEffort(undefined); else toggleEffort(tier); }}>
                {TIER_COPY[tier].label}
                {isDefault ? <em aria-hidden="true">Default</em> : null}
              </button>
            );
          })}
        </div>
        <p className="field-help">{efforts.length
          ? (effortSource === "fetched" ? "Fetched from the provider. Click a level to make it the default, or remove levels the model rejects." : "Your own set. Click a level to make it the default.")
          : "No levels means the model exposes no effort choice. Add the ones it accepts."}</p>
        {efforts.length ? (
          <SelectMenu
            id="model-edit-default-effort"
            ariaLabel="Default reasoning level"
            value={defaultEffort && efforts.includes(defaultEffort) ? defaultEffort : undefined}
            placeholder="Pick the default level"
            options={efforts.map((tier) => ({ value: tier, label: EFFORT_LABELS[tier], ...(tier === "medium" ? { tag: "Common" } : {}) }))}
            onChange={(value) => setDefaultEffort(value as ReasoningEffort)}
          />
        ) : null}
      </div>

      <div className="field">
        <span id="model-supports-label">Supports</span>
        <p className="field-help">Text is always supported. Anything left unknown follows what the provider reports.</p>
        <div className="model-support-grid" role="group" aria-labelledby="model-supports-label">
          <label htmlFor="model-support-images">Images</label>
          <SelectMenu id="model-support-images" ariaLabel="Image support" value={images} placeholder="Unknown" options={MODALITY_OPTIONS} onChange={(value) => setImages(value as Modality)} />
          <label htmlFor="model-support-documents">Documents</label>
          <SelectMenu id="model-support-documents" ariaLabel="Document support" value={documents} placeholder="Unknown" options={MODALITY_OPTIONS} onChange={(value) => setDocuments(value as Modality)} />
          <label htmlFor="model-support-video">Video</label>
          <SelectMenu id="model-support-video" ariaLabel="Video support" value={video} placeholder="Unknown" options={MODALITY_OPTIONS} onChange={(value) => setVideo(value as Modality)} />
        </div>
      </div>

      {error ? <p className="model-edit-note danger" role="alert">{error}</p> : null}
    </div>

    <footer className="model-edit-foot">
      <span className="model-edit-foot-note">{providerId ? `${providers.find((provider) => provider.id === providerId)?.name ?? providerId} · ${model.trim() || "no model id yet"}` : "Pick a provider"}</span>
      <button type="button" className="ghost-btn" disabled={busy} onClick={onClose}>Cancel</button>
      <button type="button" className="primary" disabled={!canSave || busy} onClick={() => void save()}>{busy ? <><LoaderCircle size={13} className="spin" aria-hidden="true" />Saving…</> : editing ? "Save changes" : "Add model"}</button>
    </footer>
  </dialog>;
}
