import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, KeyRound, LoaderCircle } from "lucide-react";
import { openUrl, providerKeySet, providerKeysGet, type ProviderStatus } from "../lib/bridge";
import { describeError } from "../lib/errors";
import { PROVIDER_IDS, PROVIDERS, type ProviderEntry } from "../lib/providers";
import { ProviderMark } from "./AgentPicker";
import { Collapse } from "./Presence";

/**
 * Settings → Providers: the keys the built-in harness calls models with. A key
 * goes straight to the native keychain; this page only ever reads back whether
 * one is saved and its last four characters.
 */
export function ProvidersPanel({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    providerKeysGet(PROVIDER_IDS).then((rows) => { if (live) setStatus(rows); }, (err) => { if (live) setError(describeError("Could not read saved providers", err)); });
    return () => { live = false; };
  }, []);
  const configured = status?.filter((row) => row.configured).length ?? 0;
  const save = async (provider: string, change: { key?: string; baseUrl?: string; clear?: boolean }) => {
    const rows = await providerKeySet(PROVIDER_IDS, provider, change);
    setStatus(rows);
    setEditing(null);
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
      {error ? <p className="settings-note" role="alert">{error}</p> : null}
      <div className="settings-card provider-list">
        {PROVIDERS.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            status={status?.find((row) => row.id === provider.id)}
            editing={editing === provider.id}
            onEdit={(open) => setEditing(open ? provider.id : null)}
            onSave={(change) => save(provider.id, change)}
          />
        ))}
      </div>
    </div>
  );
}

function ProviderRow({ provider, status, editing, onEdit, onSave }: { provider: ProviderEntry; status?: ProviderStatus; editing: boolean; onEdit: (open: boolean) => void; onSave: (change: { key?: string; baseUrl?: string; clear?: boolean }) => Promise<void> }) {
  const id = useId();
  const row = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(status?.configured);
  const needsUrl = provider.custom || provider.local;
  const keyUrl = provider.keyUrl;
  useEffect(() => {
    if (!editing) return;
    setKey("");
    setUrl(status?.baseUrl ?? (provider.custom ? "" : provider.defaultUrl ?? ""));
    setError(null);
    // A form opened near the foot of the list is brought into view once it has grown open.
    const timer = window.setTimeout(() => row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 260);
    return () => window.clearTimeout(timer);
  }, [editing]);
  const run = async (change: { key?: string; baseUrl?: string; clear?: boolean }) => {
    setBusy(true);
    setError(null);
    try { await onSave(change); }
    catch (err) { setError(describeError(change.clear ? "Could not remove the key" : "Could not save", err)); }
    finally { setBusy(false); }
  };
  const summary = configured
    ? [status?.keyHint ? `Key ${status.keyHint}` : provider.local ? "Enabled" : null, status?.baseUrl].filter(Boolean).join(" · ")
    : provider.detail;
  const canSave = provider.local ? true : provider.custom ? Boolean(url.trim()) && (Boolean(key.trim()) || (configured && url.trim() === status?.baseUrl)) : Boolean(key.trim());
  return (
    <div ref={row} className={`provider-row${configured ? " configured" : ""}`}>
      <div className="setting-row">
        <div className="setting-copy">
          <span className="setting-label"><ProviderMark id={provider.id} size={16} />{provider.name}{configured ? <span className="provider-badge">Connected</span> : null}</span>
          <span className="field-help">{summary}</span>
        </div>
        <div className="setting-control">
          {configured && !editing ? <button type="button" className="ghost-btn small danger-text" disabled={busy} onClick={() => void run({ clear: true })}>{busy ? <LoaderCircle size={11} className="spin" aria-hidden="true" /> : null}Remove</button> : null}
          <button type="button" className="ghost-btn small" aria-expanded={editing} aria-controls={`${id}-form`} onClick={() => onEdit(!editing)}>
            {editing ? "Cancel" : configured ? provider.local ? "Change address" : "Replace key" : provider.local ? "Enable" : "Add key"}
          </button>
        </div>
      </div>
      <Collapse open={editing}>{() => (
        <form id={`${id}-form`} className="provider-form" onSubmit={(event) => {
          event.preventDefault();
          if (!canSave || busy) return;
          void run({ ...(key.trim() ? { key: key.trim() } : {}), ...(needsUrl && url.trim() ? { baseUrl: url.trim() } : {}) });
        }}>
          {needsUrl ? (
            <label className="field">
              <span>Address</span>
              <input type="url" value={url} placeholder={provider.defaultUrl ?? "https://api.example.com/v1"} spellCheck={false} autoComplete="off" onChange={(event) => setUrl(event.target.value)} />
            </label>
          ) : null}
          {provider.local ? null : (
            <label className="field">
              <span>{configured ? "New API key" : "API key"}</span>
              <input type="password" value={key} placeholder={provider.placeholder ?? "API key"} spellCheck={false} autoComplete="off" autoFocus={!needsUrl} onChange={(event) => setKey(event.target.value)} />
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
