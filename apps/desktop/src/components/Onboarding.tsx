import { useEffect, useRef, useState } from "react";
import { describeError } from "../lib/errors";
import { Eye, EyeOff } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { openUrl } from "../lib/bridge";
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
  const [copiedInstall, setCopiedInstall] = useState(false);
  const browserPreview = !isTauri();
  // Any ready agent (Muse, OpenCode, Grok, …) is enough to start working.
  const anyReady = readyAgents(s).length > 0;
  // The window opens before agent detection finishes. Until it has, "no CLI" and
  // "not signed in" are not facts yet, so none of these welcome states may show.
  const settled = s.detectionChecked;
  const needsAuth = Boolean(!browserPreview && settled && !anyReady && s.detection?.found && !s.detection.authenticated);
  const noCli = !browserPreview && settled && !s.detection?.found && !s.agents.some((agent) => agent.found);
  const needsProject = Boolean(!browserPreview && settled && !s.workspaces.length && anyReady);
  const show = !dismissed && !s.preview && !s.settingsOpen && (browserPreview || needsAuth || checking || Boolean(error) || (!s.workspaces.length && noCli) || needsProject);
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
      if (!detection?.found) throw new Error("Muse CLI was not found. Install it or set a custom binary path in Settings.");
      if (!detection.authenticated) throw new Error(patch.museAuthMode === "subscription" ? "No Muse Code sign-in was found. Use Sign in with Meta above, then choose Recheck." : "Muse did not accept that credential.");
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
  if (!mounted) return null;
  return <dialog ref={dialog} className="hero" aria-labelledby="onboarding-title" onCancel={(event) => { event.preventDefault(); setDismissed(true); }}>
    <EmberTiles />
    <div className="brand" style={{ paddingLeft: 0 }}><img src="/spark.svg" alt="" /><span>Muse Code</span></div>
    <h2 id="onboarding-title">
      {browserPreview ? "This tab cannot see the Muse CLI"
        : needsAuth ? "Connect your Muse account"
        : needsProject ? "Open a workspace"
        : "Welcome to Muse Code"}
    </h2>
    <p>
      {browserPreview ? "The browser preview never talks to your local Muse CLI, even if the CLI is installed. Use the Muse Code desktop window for live detection, or explore the interface here."
        : needsAuth ? "The Muse CLI is installed but has no credential yet. Use the Muse Code subscription you signed into with the CLI, or pay per token with an API key."
        : needsProject ? "The Muse CLI is connected. Open a workspace, then start a thread."
        : "This independent desktop client uses your installed Muse CLI. Install the Muse CLI or set a custom binary path in Settings."}
    </p>
    {needsAuth ? <div className="field"><label htmlFor="onboarding-api-key">Muse API key</label><div className="input-with-action"><input id="onboarding-api-key" type={showKey ? "text" : "password"} value={apiKey} placeholder="Paste API key" autoComplete="off" spellCheck={false} onChange={(event) => setApiKey(event.target.value)} /><button type="button" className="icon-btn input-action" aria-label={showKey ? "Hide API key" : "Show API key"} aria-pressed={showKey} title={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div><span className="field-help">Optional. Your key stays local and is only passed to Muse. Leave it empty if your subscription should pay.</span></div> : null}
    {needsAuth && !s.detection?.subscriptionAvailable ? <LoginPanel /> : null}
    {(error || s.error) && <p role="alert">{error || s.error}</p>}
    <div className="row" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
      {browserPreview ? (
        <button className="primary" onClick={s.enterPreview}>Explore the interface</button>
      ) : needsAuth ? (
        <>
          <button className="primary" disabled={checking} onClick={() => void connect({ museAuthMode: "subscription" })}>{checking ? "Connecting…" : "Use my subscription"}</button>
          <button className="chip" disabled={checking} onClick={() => void connectWithApiKey()}>Use an API key</button>
        </>
      ) : needsProject ? (
        <button className="primary" onClick={() => { setDismissed(true); void s.chooseProject(); }}>Open a workspace</button>
      ) : (
        <button className="primary" onClick={() => void openUrl("https://dev.meta.ai/docs/muse-code/").catch((cause) => setError(describeError("Could not continue", cause)))}>Install the Muse CLI</button>
      )}
      {noCli ? (
        <button className="chip" onClick={() => {
          const command = /^win/i.test(typeof navigator !== "undefined" ? navigator.platform ?? "" : "") ? "irm https://dev.meta.ai/install.ps1 | iex" : "curl -fsSL https://dev.meta.ai/install.sh | sh";
          void navigator.clipboard.writeText(command).then(() => {
            setCopiedInstall(true);
            window.setTimeout(() => setCopiedInstall(false), 2000);
          }).catch((cause) => setError(describeError("Could not continue", cause)));
        }}>{copiedInstall ? "Copied" : "Copy install command"}</button>
      ) : null}
      {!browserPreview && !needsProject ? (
        <button className="chip" disabled={checking} onClick={() => { setChecking(true); setError(""); void s.refreshDetection().catch((cause) => setError(describeError("Could not continue", cause))).finally(() => setChecking(false)); }}>{checking ? "Checking…" : "Recheck"}</button>
      ) : null}
      {!browserPreview && !needsAuth && !needsProject ? (
        <button className="chip" onClick={() => { setDismissed(true); s.setSettingsOpen(true); }}>Settings</button>
      ) : null}
      {!browserPreview ? (
        <button className="chip" onClick={s.enterPreview}>Explore the interface</button>
      ) : null}
      <button className="text-btn" onClick={() => setDismissed(true)}>Close</button>
    </div>
    <p className="muted" style={{ marginTop: 16, marginBottom: 0 }}>Not affiliated with Meta. Requires an installed Muse CLI for live work.</p>
  </dialog>;
}
