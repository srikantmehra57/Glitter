import { useEffect, useRef, useState } from "react";
import { describeError } from "../lib/errors";
import { Eye, EyeOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isTauri } from "../lib/format";
import { useModalDialog } from "../lib/dialogFocus";
import { usePresence } from "../lib/presence";
import { readyAgents, useAppStore } from "../lib/store";
import { LoginPanel } from "./LoginPanel";
import { EmberTiles } from "./EmberTiles";
import type { Settings } from "../lib/types";

export function Onboarding() {
  const s = useAppStore(useShallow((state) => ({
    museApiKey: state.museApiKey,
    detection: state.detection,
    detectionChecked: state.detectionChecked,
    agents: state.agents,
    enabledAgents: state.enabledAgents,
    workspaces: state.workspaces,
    preview: state.preview,
    settingsOpen: state.settingsOpen,
    error: state.error,
    commitSettings: state.commitSettings,
    refreshDetection: state.refreshDetection,
    startHost: state.startHost,
    chooseProject: state.chooseProject,
    enterPreview: state.enterPreview,
    setSettingsOpen: state.setSettingsOpen,
  })));
  const dialog = useRef<HTMLDialogElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [apiKey, setApiKey] = useState(s.museApiKey);
  const [showKey, setShowKey] = useState(false);
  const browserPreview = !isTauri();
  // Any ready agent (the built-in agent with a provider key, Muse, OpenCode, …) is enough to start working.
  const anyReady = readyAgents(s).length > 0;
  // The window opens before agent detection finishes. Until it has, "no key" and
  // "not signed in" are not facts yet, so none of these welcome states may show.
  const settled = s.detectionChecked;
  const needsSetup = Boolean(!browserPreview && settled && !anyReady);
  // Muse is one way in, offered only when its CLI is installed and waiting for a credential.
  const museWaiting = Boolean(needsSetup && s.detection?.found && !s.detection.authenticated);
  const needsProject = Boolean(!browserPreview && settled && !s.workspaces.length && anyReady);
  const show = !dismissed && !s.preview && !s.settingsOpen && (browserPreview || needsSetup || checking || Boolean(error) || needsProject);
  // The dialog stays mounted for one exit after it is dismissed, so it can animate out.
  const { mounted } = usePresence(show);
  useModalDialog(show, dialog);
  useEffect(() => {
    if (show) setApiKey(s.museApiKey);
  }, [s.museApiKey, show]);
  const connect = async (patch: Partial<Settings>) => {
    setChecking(true);
    setError("");
    try {
      await s.commitSettings(patch);
      await s.refreshDetection();
      const detection = useAppStore.getState().detection;
      if (!detection?.found) throw new Error("Muse CLI was not found. Install it or set a custom binary path in Settings → Agents.");
      if (!detection.authenticated) throw new Error(patch.museAuthMode === "subscription" ? "No Muse sign-in was found. Use Sign in with Meta above, then choose Recheck." : "Muse did not accept that credential.");
      await s.startHost(true);
      setDismissed(true);
    } catch (cause) {
      setError(describeError(`Could not connect`, cause));
    } finally { setChecking(false); }
  };
  const connectWithApiKey = async () => {
    const value = apiKey.trim();
    if (!value) { setError("Paste your Muse API key to continue."); return; }
    await connect({ museApiKey: value, museAuthMode: "apiKey" });
  };
  const openProviders = () => { setDismissed(true); s.setSettingsOpen(true, "Providers"); };
  if (!mounted) return null;
  return <dialog ref={dialog} className="hero" aria-labelledby="onboarding-title" onCancel={(event) => { event.preventDefault(); setDismissed(true); }}>
    <EmberTiles />
    <div className="brand" style={{ paddingLeft: 0 }}><img src="/spark.svg" alt="" /><span>Glitter</span></div>
    <h2 id="onboarding-title">
      {browserPreview ? "This tab cannot reach your agents"
        : needsSetup ? "Connect a model to start"
        : needsProject ? "Open a workspace"
        : "Welcome to Glitter"}
    </h2>
    <p>
      {browserPreview ? "The browser preview never calls a model provider or an agent CLI. Use the Glitter desktop window to work for real, or explore the interface here."
        : needsSetup ? "Glitter’s built-in agent runs on this Mac and calls the model provider you choose — Anthropic, OpenAI, OpenRouter and more — with your own API key. Keys stay in your Mac’s keychain."
        : needsProject ? "Your agent is ready. Open a workspace, then start a thread."
        : "Glitter is an agent harness for your code. Connect a model provider, or use an agent CLI you already have."}
    </p>
    {(error || s.error) && <p role="alert">{error || s.error}</p>}
    <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
      {browserPreview ? (
        <button className="primary" onClick={s.enterPreview}>Explore the interface</button>
      ) : needsProject ? (
        <button className="primary" onClick={() => { setDismissed(true); void s.chooseProject(); }}>Open a workspace</button>
      ) : (
        <button className="primary" onClick={openProviders}>Add a provider key</button>
      )}
      {!browserPreview && !needsProject ? (
        <button className="chip" disabled={checking} onClick={() => { setChecking(true); setError(""); void s.refreshDetection().catch((cause) => setError(describeError("Could not continue", cause))).finally(() => setChecking(false)); }}>{checking ? "Checking…" : "Recheck"}</button>
      ) : null}
      {!browserPreview ? (
        <button className="chip" onClick={s.enterPreview}>Explore the interface</button>
      ) : null}
      <button className="text-btn" onClick={() => setDismissed(true)}>Close</button>
    </div>
    {museWaiting ? <details className="onboarding-alt">
      <summary>Use Muse instead</summary>
      <p>The Muse CLI is installed but has no credential yet. Use the subscription you signed into with the CLI, or pay per token with an API key.</p>
      <div className="field"><label htmlFor="onboarding-api-key">Muse API key</label><div className="input-with-action"><input id="onboarding-api-key" type={showKey ? "text" : "password"} value={apiKey} placeholder="Paste API key" autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} /><button type="button" className="icon-btn input-action" aria-label={showKey ? "Hide API key" : "Show API key"} aria-pressed={showKey} title={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div><span className="field-help">Optional. Your key stays local and is only passed to Muse. Leave it empty if your subscription should pay.</span></div>
      {!s.detection?.subscriptionAvailable ? <LoginPanel /> : null}
      <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
        <button className="chip" disabled={checking} onClick={() => void connect({ museAuthMode: "subscription" })}>{checking ? "Connecting…" : "Use my subscription"}</button>
        <button className="chip" disabled={checking} onClick={() => void connectWithApiKey()}>Use an API key</button>
      </div>
    </details> : null}
    <p className="muted" style={{ marginTop: 16, marginBottom: 0 }}>Independent. Not affiliated with Meta or any model provider.</p>
  </dialog>;
}
