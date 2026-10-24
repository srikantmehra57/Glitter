import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, KeyRound, LoaderCircle, Plus } from "lucide-react";
import { openUrl, providerKeySet } from "../lib/bridge";
import { describeError } from "../lib/errors";
import { PROVIDER_IDS, PROVIDERS, customProviders, providerWireLabel, type ProviderEntry, type ProviderWire } from "../lib/providers";
import { useAppStore } from "../lib/store";
import { ProviderMark } from "./AgentPicker";
import { Collapse } from "./Presence";

/**
 * Settings → Providers: the keys the built-in harness calls models with. A key
 * goes straight to the native keychain; this page only ever reads back whether
 * one is saved and its last four characters. Custom endpoints are added here —
 * named, typed by the API they speak, any number of them — and the native side
 * mints their ids.
 */
export function ProvidersPanel({ onChanged }: { onChanged: () => void }) {
  const status = useAppStore((state) => state.providerStatus);
  const readError = useAppStore((state) => state.providerStatusError);
  const refreshProviders = useAppStore((state) => state.refreshProviders);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (!status) void refreshProviders(); }, [status, refreshProviders]);
  const configured = status?.filter((row) => row.configured).length ?? 0;
  const customs = customProviders(status ?? []);
  const save = async (provider: string, change: { key?: string; baseUrl?: string; name?: string; wire?: string; clear?: boolean }) => {
    const rows = await providerKeySet(PROVIDER_IDS, provider, change);
    useAppStore.setState({ providerStatus: rows });
    setEditing(null);
    setAdding(false);
    onChanged();
  };
  return (
    <div className="providers-panel">
      <div className="settings-callout">
        <KeyRound size={15} aria-hidden="true" />
        <div>
          <strong>Bring your own key</strong>
          <span>The built-in agent calls these providers directly. A key is sent only to the provider it belongs to, and that provider bills your account for what you use.</span>
        </div>
      </div>
      <div className="settings-card-heading"><h4>Model providers</h4><p>{status ? configured ? `${configured} connected. Their models appear in the composer’s model picker and under Models.` : "Add a key for at least one provider to start." : "Reading saved providers…"}</p></div>
      {readError ? <p className="settings-note" role="alert">{readError}</p> : null}
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
    </div>
  );
}

/** What a row's open form carries to the keychain. */
type SaveChange = { key?: string; baseUrl?: string; name?: string; wire?: string; clear?: boolean };

function ProviderRow({ provider, status, editing, onEdit, onSave }: { provider: ProviderEntry; status?: { configured: boolean; keyHint: string | null; baseUrl: string | null }; editing: boolean; onEdit: (open: boolean) => void; onSave: (change: SaveChange) => Promise<void> }) {
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
  }, [editing]);
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
          <span className="setting-label"><ProviderMark id={provider.id} size={16} name={provider.custom ? provider.name : undefined} />{provider.name}{configured ? <span className="provider-badge">Connected</span> : null}</span>
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
