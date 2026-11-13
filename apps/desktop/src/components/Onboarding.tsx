import { useRef, useState } from "react";
import { describeError } from "../lib/errors";
import { useShallow } from "zustand/react/shallow";
import { isTauri } from "../lib/format";
import { useModalDialog } from "../lib/dialogFocus";
import { usePresence } from "../lib/presence";
import { readyAgents, useAppStore } from "../lib/store";
import { EmberTiles } from "./EmberTiles";

export function Onboarding() {
  const s = useAppStore(useShallow((state) => ({
    detectionChecked: state.detectionChecked,
    agents: state.agents,
    workspaces: state.workspaces,
    preview: state.preview,
    settingsOpen: state.settingsOpen,
    error: state.error,
    refreshDetection: state.refreshDetection,
    chooseProject: state.chooseProject,
    enterPreview: state.enterPreview,
    setSettingsOpen: state.setSettingsOpen,
  })));
  const dialog = useRef<HTMLDialogElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const browserPreview = !isTauri();
  // The agent is ready once a model provider has a key.
  const ready = readyAgents(s).length > 0;
  // The window opens before detection finishes. Until it has, "no key" is not
  // a fact yet, so none of these welcome states may show.
  const settled = s.detectionChecked;
  const needsSetup = Boolean(!browserPreview && settled && !ready);
  const needsProject = Boolean(!browserPreview && settled && !s.workspaces.length && ready);
  const show = !dismissed && !s.preview && !s.settingsOpen && (browserPreview || needsSetup || checking || Boolean(error) || needsProject);
  // The dialog stays mounted for one exit after it is dismissed, so it can animate out.
  const { mounted } = usePresence(show);
  useModalDialog(show, dialog);
  const openProviders = () => { setDismissed(true); s.setSettingsOpen(true, "Providers"); };
  if (!mounted) return null;
  return <dialog ref={dialog} className="hero" aria-labelledby="onboarding-title" onCancel={(event) => { event.preventDefault(); setDismissed(true); }}>
    <EmberTiles />
    <div className="brand" style={{ paddingLeft: 0 }}><img src="/spark.svg" alt="" /><span>Glitter</span></div>
    <h2 id="onboarding-title">
      {browserPreview ? "This tab cannot reach your agent"
        : needsSetup ? "Connect a model to start"
        : needsProject ? "Open a workspace"
        : "Welcome to Glitter"}
    </h2>
    <p>
      {browserPreview ? "The browser preview never calls a model provider. Use the Glitter desktop window to work for real, or explore the interface here."
        : needsSetup ? "Glitter’s agent runs on this Mac and calls the model provider you choose — Anthropic, OpenAI, OpenRouter and more — with your own API key. Keys stay in your Mac’s keychain."
        : needsProject ? "Your agent is ready. Open a workspace, then start a thread."
        : "Glitter is an agent harness for your code. Connect a model provider to start."}
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
    <p className="muted" style={{ marginTop: 16, marginBottom: 0 }}>Independent. Not affiliated with any model provider.</p>
  </dialog>;
}
