import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Activity, Check, KeyRound, LoaderCircle, TriangleAlert } from "lucide-react";
import { describeError } from "../lib/errors";
import { humanizeModelLabel } from "../lib/format";
import {
  ORCHESTRATOR_GOAL_COPY,
  ORCHESTRATOR_ROLE_LABELS,
  effectiveOrchestratorAssignments,
  normalizeOrchestratorGoal,
  orchestratorDisclosure,
  orchestratorReady,
  storedOrchestratorModel,
} from "../lib/orchestrator";
import { PROVIDERS, providerName, type ProviderEntry } from "../lib/providers";
import { selectableModels } from "../lib/modelVisibility";
import { useAppStore } from "../lib/store";
import { ORCHESTRATOR_GOALS, type Model, type OrchestratorAssignments, type OrchestratorModel, type OrchestratorRole, type Settings } from "../lib/types";
import { AgentMark, ModelIcon } from "./AgentPicker";
import { modelKey } from "./ModelPicker";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { SectionHead, SettingRow } from "./SettingsSection";

const ROLE_HELP: Record<OrchestratorRole, string> = {
  lead: "Diagnoses, plans and reviews. A frontier reasoning model makes the most of the role.",
  builder: "Follows the plan through the long tool loop. A cheap, capable coding model keeps the cost down.",
  small: "Handles trivial edits, copy and plain questions without involving the Lead.",
  router: "Judges each prompt with one short call and no tools. Any reliable JSON model will do.",
};

type ProbeView = { key: string; status: "checking" | "passed" | "failed"; detail: string };
type RoleTarget = { probeRole: OrchestratorRole; model: OrchestratorModel; inherits?: "builder" };

const targetKey = (role: OrchestratorRole, model: OrchestratorModel) => `${role}\u0000${model.providerId ?? ""}\u0000${model.modelId}`;
const sameModel = (left?: OrchestratorModel, right?: OrchestratorModel) => Boolean(left && right && left.modelId === right.modelId && (left.providerId ?? "") === (right.providerId ?? ""));

/**
 * Settings → Orchestrator: which models take the Lead, Builder, Small-task and
 * Router roles for built-in agent threads, the goal that decides how often the
 * Lead is involved, and who receives the user's prompts and code.
 */
export function OrchestratorPanel({ draft, onChange, customProviders: customs = [], onManageProviders }: {
  draft: Settings;
  onChange: (patch: Partial<Settings>) => void;
  customProviders?: ProviderEntry[];
  onManageProviders: () => void;
}) {
  const loadModelCatalog = useAppStore((state) => state.loadModelCatalog);
  const probeOrchestratorRole = useAppStore((state) => state.probeOrchestratorRole);
  const [catalog, setCatalog] = useState<{ models: Model[]; loading: boolean; error: string | null }>({ models: [], loading: true, error: null });
  const [probes, setProbes] = useState<Partial<Record<OrchestratorRole, ProbeView>>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setCatalog((previous) => ({ models: previous.models, loading: true, error: null }));
    void loadModelCatalog("harness").then(
      (models) => { if (live) setCatalog({ models, loading: false, error: null }); },
      (error) => { if (live) setCatalog({ models: [], loading: false, error: describeError("Could not load the built-in agent’s models", error) }); },
    );
    return () => { live = false; };
  }, [loadModelCatalog]);

  const assignments = draft.orchestratorModels ?? {};
  const goal = normalizeOrchestratorGoal(draft.orchestratorGoal);
  const effective = effectiveOrchestratorAssignments(assignments);
  const ready = orchestratorReady(assignments);
  const enabled = draft.orchestratorEnabled === true;
  const modelLabel = (role: OrchestratorRole) => {
    const model = effective[role];
    return model ? humanizeModelLabel(model.modelId) : null;
  };

  // Small-task reuses a Builder check only when it runs the same model; Router
  // always has its own JSON check, and waits for Advanced to open so a check
  // the user never sees does not spend tokens.
  const targets: Partial<Record<OrchestratorRole, RoleTarget>> = {};
  if (effective.lead) targets.lead = { probeRole: "lead", model: effective.lead };
  if (effective.builder) targets.builder = { probeRole: "builder", model: effective.builder };
  if (effective.small) targets.small = sameModel(effective.small, effective.builder)
    ? { probeRole: "builder", model: effective.small, inherits: "builder" }
    : { probeRole: "small", model: effective.small };
  if (effective.router && advancedOpen) targets.router = { probeRole: "router", model: effective.router };

  const runProbe = useCallback(async (role: OrchestratorRole, target: RoleTarget, refresh: boolean) => {
    const key = targetKey(target.probeRole, target.model);
    setProbes((all) => ({ ...all, [role]: { key, status: "checking", detail: "" } }));
    try {
      const result = await probeOrchestratorRole(target.probeRole, target.model, refresh ? { refresh: true } : undefined);
      setProbes((all) => all[role]?.key === key ? { ...all, [role]: { key, status: result.status, detail: result.detail } } : all);
    } catch (error) {
      setProbes((all) => all[role]?.key === key ? { ...all, [role]: { key, status: "failed", detail: describeError("The check could not run", error) } } : all);
    }
  }, [probeOrchestratorRole]);

  const targetsSignature = (Object.entries(targets) as Array<[OrchestratorRole, RoleTarget]>)
    .map(([role, target]) => `${role}:${target.probeRole}:${targetKey(target.probeRole, target.model)}:${target.inherits ?? ""}`)
    .sort()
    .join("|");

  useEffect(() => {
    for (const [role, target] of Object.entries(targets) as Array<[OrchestratorRole, RoleTarget]>) {
      if (target.inherits) continue;
      // A result for this exact assignment is already shown; only a change pays for a check.
      if (probes[role]?.key === targetKey(target.probeRole, target.model)) continue;
      void runProbe(role, target, false);
    }
    // `probes` is read to skip answered assignments; the signature gates new work.
  }, [targetsSignature, probes, runProbe]);

  const probeView = (role: OrchestratorRole): ProbeView | undefined => {
    const target = targets[role];
    if (!target) return undefined;
    const source = target.inherits ? probes.builder : probes[role];
    return source?.key === targetKey(target.probeRole, target.model) ? source : undefined;
  };

  const roleControl = (role: OrchestratorRole, select: ReactNode) => {
    const target = targets[role];
    const view = probeView(role);
    const label = ORCHESTRATOR_ROLE_LABELS[role];
    return (
      <div className="orchestrator-role-control">
        <div className="orchestrator-role-line">
          {select}
          {target && !target.inherits ? (
            <button type="button" className="icon-btn small" aria-label={`Check the ${label} model`} data-tooltip={view?.status === "checking" ? "Checking…" : view ? "Check again" : "Run the capability check"} disabled={view?.status === "checking"} onClick={() => void runProbe(role, target, true)}>
              {view?.status === "checking" ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Activity size={14} aria-hidden="true" />}
            </button>
          ) : null}
        </div>
        {target && view ? (
          <span className="orchestrator-probe" role="status" title={view.detail}>
            <span className="orchestrator-probe-line">
              {view.status === "checking" ? <span className="test-chip"><LoaderCircle size={10} className="spin" aria-hidden="true" />Checking…</span>
                : view.status === "passed" ? <span className="test-chip ok"><Check size={10} strokeWidth={3} aria-hidden="true" />Ready</span>
                : <span className="test-chip failed"><TriangleAlert size={10} aria-hidden="true" />Not supported</span>}
              {target.inherits ? <span className="orchestrator-probe-note">Builder’s check</span> : null}
            </span>
            {view.status === "failed" && view.detail ? <span className="orchestrator-probe-detail">{view.detail}</span> : null}
          </span>
        ) : null}
      </div>
    );
  };

  const setRole = (role: OrchestratorRole, value: string) => {
    const next: OrchestratorAssignments = { ...assignments };
    if (!value) delete next[role];
    else {
      const model = catalog.models.find((item) => modelKey(item) === value);
      if (!model) return;
      next[role] = { modelId: model.modelId, ...(model.providerId ? { providerId: model.providerId } : {}) };
    }
    onChange({ orchestratorModels: next });
  };

  const roleOptions = (role: OrchestratorRole, inherit?: { label: string; description: string }): SelectMenuOption[] => {
    const options: SelectMenuOption[] = inherit ? [{ value: "", label: inherit.label, description: inherit.description }] : [];
    // A model or provider switched off in Settings → Models is not offered here either.
    const listed = selectableModels(catalog.models, "harness", draft.hiddenModels, draft.hiddenProviders);
    const saved = storedOrchestratorModel(assignments, role);
    if (saved) {
      const savedKey = modelKey(saved);
      if (!listed.some((model) => modelKey(model) === savedKey && !model.unavailable)) {
        const known = catalog.models.find((model) => modelKey(model) === savedKey);
        options.push({ value: savedKey, label: humanizeModelLabel(saved.modelId), description: !known ? "Saved selection · not in the current catalog" : known.unavailable ? "Unavailable on this account" : "Off in Settings → Models" });
      }
    }
    for (const model of listed) {
      if (model.unavailable) continue;
      options.push({
        value: modelKey(model),
        label: humanizeModelLabel(model.modelId, model.displayLabel),
        description: providerName(model.providerId, customs),
        icon: <ModelIcon modelId={model.modelId} providerId={model.providerId} size={18} hostName={providerName(model.providerId, customs)} fallback={<AgentMark id="harness" size={18} />} />,
      });
    }
    return options;
  };

  const roleValue = (role: OrchestratorRole) => {
    const model = storedOrchestratorModel(assignments, role);
    return model ? modelKey(model) : "";
  };

  const disclosure = orchestratorDisclosure(assignments).map(({ providerId, roles }) => {
    const local = PROVIDERS.find((provider) => provider.id === providerId)?.local;
    return `${providerName(providerId, customs)}${local ? " on this Mac" : ""} (${roles.map((role) => ORCHESTRATOR_ROLE_LABELS[role]).join(", ")})`;
  });

  return <>
    <SectionHead title="New threads" help="Split a new thread between the roles below." />
    <section className="settings-card" aria-label="New threads">
      <SettingRow label={<span id="orchestrator-enabled-label" className="setting-label">Use Orchestrator for new threads</span>} help={<>Off by default.</>}>
        <button type="button" role="switch" aria-labelledby="orchestrator-enabled-label" aria-checked={enabled} className="toggle" onClick={() => onChange({ orchestratorEnabled: !enabled })}><i /></button>
      </SettingRow>
    </section>

    <SectionHead title="Goal" help={ORCHESTRATOR_GOAL_COPY[goal].summary} />
    <section className="settings-card" aria-label="Goal">
      <SettingRow label={<label htmlFor="orchestrator-goal">Default goal</label>} help="The goal decides how often the Lead plans, reviews and is consulted. It never changes permissions or approvals.">
        <SelectMenu
          id="orchestrator-goal"
          ariaLabel="Orchestrator goal"
          value={goal}
          placeholder="Balanced"
          options={ORCHESTRATOR_GOALS.map((value) => ({ value, label: ORCHESTRATOR_GOAL_COPY[value].label, description: ORCHESTRATOR_GOAL_COPY[value].summary }))}
          onChange={(value) => onChange({ orchestratorGoal: normalizeOrchestratorGoal(value) })}
        />
      </SettingRow>
    </section>

    <SectionHead title="Roles" help="Every role can use any provider you connect. Small-task follows the Builder, and Router follows Small-task, until you choose their own models." />
    <section className="settings-card" aria-label="Roles">
      <SettingRow label={<label htmlFor="orchestrator-lead">Lead model</label>} help={ROLE_HELP.lead}>
        {roleControl("lead", <SelectMenu id="orchestrator-lead" ariaLabel="Lead model" value={roleValue("lead")} placeholder={catalog.loading ? "Loading models…" : "Choose a model"} options={roleOptions("lead")} disabled={catalog.loading} onChange={(value) => setRole("lead", value)} />)}
      </SettingRow>
      <SettingRow label={<label htmlFor="orchestrator-builder">Builder model</label>} help={ROLE_HELP.builder}>
        {roleControl("builder", <SelectMenu id="orchestrator-builder" ariaLabel="Builder model" value={roleValue("builder")} placeholder={catalog.loading ? "Loading models…" : "Choose a model"} options={roleOptions("builder")} disabled={catalog.loading} onChange={(value) => setRole("builder", value)} />)}
      </SettingRow>
      <SettingRow label={<label htmlFor="orchestrator-small">Small-task model</label>} help={ROLE_HELP.small}>
        {roleControl("small", <SelectMenu id="orchestrator-small" ariaLabel="Small-task model" value={roleValue("small")} placeholder={catalog.loading ? "Loading models…" : "Choose a model"} options={roleOptions("small", { label: "Same as Builder", description: modelLabel("small") ? `Uses ${modelLabel("small")}` : "Choose a Builder first" })} disabled={catalog.loading} onChange={(value) => setRole("small", value)} />)}
      </SettingRow>
    </section>
    <details className="settings-card orchestrator-advanced" onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
      <summary>Advanced</summary>
      <SettingRow label={<label htmlFor="orchestrator-router">Router model</label>} help={ROLE_HELP.router}>
        {roleControl("router", <SelectMenu id="orchestrator-router" ariaLabel="Router model" value={roleValue("router")} placeholder={catalog.loading ? "Loading models…" : "Choose a model"} options={roleOptions("router", { label: "Same as Small-task", description: modelLabel("router") ? `Uses ${modelLabel("router")}` : "Choose a Small-task model first" })} disabled={catalog.loading} onChange={(value) => setRole("router", value)} />)}
      </SettingRow>
    </details>

    {catalog.error ? <p className="settings-note" role="alert">{catalog.error} Add a provider key, then reopen this page.</p> : null}
    {!catalog.loading && !catalog.error && !catalog.models.length ? (
      <div className="settings-empty">
        <KeyRound size={18} aria-hidden="true" />
        <div><strong>No providers connected</strong><span>The built-in agent’s roles need a provider key before they can run.</span></div>
        <button type="button" className="secondary small" onClick={onManageProviders}>Add a provider</button>
      </div>
    ) : null}
    {enabled && !ready ? <p className="settings-note" role="status">Choose a Lead and a Builder. Until both are set, Orchestrator cannot start a new thread.</p> : null}

    <SectionHead title="Data disclosure" help="Every role uses the providers you assigned. Nothing here changes permissions or approvals." />
    <section className="settings-card" aria-label="Data disclosure">
      <p className="orchestrator-disclosure">
        {disclosure.length ? `Your prompts and code are sent to: ${disclosure.join(", ")}.` : "Assign role models to see which providers receive your prompts and code."}
        {" "}Nothing is sent until a built-in agent thread runs, and keys stay in your Mac’s keychain.
      </p>
    </section>
  </>;
}
