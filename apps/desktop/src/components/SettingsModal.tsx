import { lazy, Suspense, useDeferredValue, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useModalDialog } from "../lib/dialogFocus";
import { describeError } from "../lib/errors";
import { useShallow } from "zustand/react/shallow";
import { Activity, ArchiveRestore, ArrowLeft, ChartNoAxesColumn, Check, Command, Cpu, FolderOpen, Info, Lock, MessagesSquare, Minus, Monitor, Moon, Palette, Plug, Plus, Puzzle, RefreshCw, Search, Settings2, ShieldAlert, ShieldCheck, Sun, Trash2, TriangleAlert, Workflow, X } from "lucide-react";
import { diagnosticsSnapshot, openLogFolder } from "../lib/bridge";
import { isMacPlatform, isTauri } from "../lib/format";
import { modelFor, VOCABULARY } from "../lib/effort";
import { selectableModels } from "../lib/modelVisibility";
import { APP_VERSION } from "../lib/version";
import { AgentMark, ModelIcon } from "./AgentPicker";
import { AGENT_LABELS, APPROVAL_DESCRIPTIONS, APPROVAL_LABELS, APPROVAL_ORDER, DARK_INTENSITIES, EDITOR_CHOICES, EDITOR_LABELS, EFFORT_LABELS, SIDEBAR_DENSITIES, THINKING_ORBS, UI_FONTS, type CustomCommand, type EditorChoice, type AccentColor, type AgentId, type ApprovalMode, type ReasoningEffort, type SettingsTab, type ThemeMode, type ThinkingOrbStyle, type DarkIntensity, type SidebarDensity, type Settings } from "../lib/types";
import { humanizeModelLabel, humanizeProvider, relativeTime, shortcutLabel, worktreeRemovalNote } from "../lib/format";
import { settingsFields } from "../lib/settingsPersistence";
import { SETTINGS_NAV_GROUPS, SETTINGS_TAB_COPY, SETTINGS_TAB_LABELS, settingsTabsMatching } from "../lib/settingsNav";
import { customCommandProblem } from "../lib/composerText";
import { customProviders, providerName } from "../lib/providers";
import { FIXED_SHORTCUTS, REMAPPABLE, SHORTCUT_IDS, bindingFor, bindingProblem, chordLabel, chordOf, type ShortcutId, type ShortcutOverrides } from "../lib/shortcuts";
import { UI_FONT_COPY, UI_FONT_STACKS } from "../lib/fonts";
import { ZOOM_LEVELS } from "../lib/zoom";
import { applyTheme, currentThread, currentWorkspace, hasWindowMaterial, useAppStore } from "../lib/store";
import type { Model } from "../lib/types";
const ExtensionsView = lazy(() => import("./ExtensionsView").then((module) => ({ default: module.ExtensionsView })));
const UsageView = lazy(() => import("./UsageView").then((module) => ({ default: module.UsageView })));
import { ModelLibrary } from "./ModelLibrary";
import { OrchestratorPanel } from "./OrchestratorPanel";
import { PermissionRulesCard } from "./PermissionRulesCard";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { Orb } from "./Orb";
import { ProvidersPanel } from "./ProvidersPanel";
import { SectionHead, SettingRow } from "./SettingsSection";

const EFFORTS = VOCABULARY;

const SHORTCUT_GROUPS = ["General", "Threads", "Composer", "Approvals"] as const;
/** "⇧] / ⇧[" becomes "⌘⇧] / ⌘⇧[": every alternative gets the platform modifier. */
const shortcutChord = (keys: string) => keys.split(" / ").map((key) => shortcutLabel(key)).join(" / ");
/** Pages with nothing to change; they show no saving hint. */
const READ_ONLY_TABS: SettingsTab[] = ["Extensions", "Threads", "Usage", "Diagnostics", "About"];

const ACCENTS: Array<{ id: AccentColor; label: string; hex: string }> = [
  { id: "ember", label: "Ember", hex: "#F5A524" },
  { id: "mono", label: "Monochrome", hex: "#E3E3E3" },
  { id: "blue", label: "Glacier Mist", hex: "#9DBCF4" },
  { id: "violet", label: "Lavender Fog", hex: "#C5B0E8" },
  { id: "pink", label: "Rosewater", hex: "#E9B3C8" },
  { id: "orange", label: "Peach Sorbet", hex: "#F0B78F" },
  { id: "yellow", label: "Buttercream", hex: "#E9D48F" },
  { id: "green", label: "Sage Leaf", hex: "#A8CEB0" },
  { id: "teal", label: "Sea Glass", hex: "#96CECA" },
];

const ORB_COPY: Record<ThinkingOrbStyle, { label: string; description: string }> = {
  auto: { label: "Automatic", description: "Working for most runs, Solving at the highest effort." },
  working: { label: "Working", description: "Particles travel along tilted orbits." },
  searching: { label: "Searching", description: "A meridian sweeps across a dotted globe." },
  solving: { label: "Solving", description: "Bands turn and settle into place." },
  listening: { label: "Listening", description: "A wave rolls through latitude rings." },
  connecting: { label: "Connecting", description: "A constellation connects its points." },
  weaving: { label: "Weaving", description: "Three strands wind around a sphere." },
  composing: { label: "Composing", description: "A flowing sash wraps around the orb." },
  breathing: { label: "Breathing", description: "A ring slowly changes shape." },
  shaping: { label: "Shaping", description: "An outline shifts between a circle, triangle and square." },
};
const ORB_OPTIONS: SelectMenuOption[] = THINKING_ORBS.map((value) => ({ value, ...ORB_COPY[value] }));

const DARK_INTENSITY_COPY: Record<DarkIntensity, { label: string; description: string }> = {
  subtle: { label: "Subtle", description: "Graphite — the softest dark." },
  mid: { label: "Mid", description: "Smoke — Glitter's default dark." },
  black: { label: "Pure black", description: "True black, at home on OLED." },
};
const DARK_INTENSITY_OPTIONS: SelectMenuOption[] = DARK_INTENSITIES.map((value) => ({ value, ...DARK_INTENSITY_COPY[value], ...(value === "mid" ? { tag: "Default" } : {}) }));
const FONT_OPTIONS: SelectMenuOption[] = UI_FONTS.map((value) => ({ value, ...UI_FONT_COPY[value], fontFamily: UI_FONT_STACKS[value], ...(value === "system" ? { tag: "Default" } : {}) }));
const SIDEBAR_DENSITY_COPY: Record<SidebarDensity, { label: string; description: string }> = {
  standard: { label: "Standard", description: "The current balanced row spacing." },
  comfortable: { label: "Comfortable", description: "More room between workspaces and threads." },
  compact: { label: "Compact", description: "Fit more workspaces and threads on screen." },
};
const SIDEBAR_DENSITY_OPTIONS: SelectMenuOption[] = SIDEBAR_DENSITIES.map((value) => ({ value, ...SIDEBAR_DENSITY_COPY[value], ...(value === "standard" ? { tag: "Default" } : {}) }));

function tabIcon(tab: SettingsTab) {
  const props = { size: 15, strokeWidth: 1.8, "aria-hidden": true } as const;
  if (tab === "Models") return <Cpu {...props} />;
  if (tab === "Orchestrator") return <Workflow {...props} />;
  if (tab === "Providers") return <Plug {...props} />;
  if (tab === "Extensions") return <Puzzle {...props} />;
  if (tab === "Permissions") return <ShieldCheck {...props} />;
  if (tab === "Threads") return <MessagesSquare {...props} />;
  if (tab === "General") return <Settings2 {...props} />;
  if (tab === "Theme") return <Palette {...props} />;
  if (tab === "Shortcuts") return <Command {...props} />;
  if (tab === "Usage") return <ChartNoAxesColumn {...props} />;
  if (tab === "Diagnostics") return <Activity {...props} />;
  return <Info {...props} />;
}

/**
 * The sidebar's translucency. Dragging repaints the window at once; the value
 * is saved when the gesture ends, so a drag is one write and not one per step.
 */
function TranslucencySlider({ id, value, disabled, onPreview, onCommit }: { id: string; value: number; disabled: boolean; onPreview: (value: number) => void; onCommit: (value: number) => void }) {
  const [live, setLive] = useState(value);
  const latest = useRef(value);
  useEffect(() => { latest.current = value; setLive(value); }, [value]);
  const commit = () => { if (latest.current !== value) onCommit(latest.current); };
  return <div className="slider-control">
    <input
      id={id}
      className="slider"
      type="range"
      min={0}
      max={100}
      step={1}
      value={live}
      disabled={disabled}
      aria-valuetext={live === 0 ? "Solid" : `${live}%`}
      style={{ "--fill": `${live}%` } as CSSProperties}
      onChange={(event) => { const next = Number(event.target.value); latest.current = next; setLive(next); onPreview(next); }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
    <output htmlFor={id}>{live === 0 ? "Solid" : `${live}%`}</output>
  </div>;
}

/** The one-word surface name the Dark tile shows, following the chosen intensity. */
const DARK_TILE_NAMES: Record<DarkIntensity, string> = { subtle: "Graphite", mid: "Smoke", black: "True black" };

function ThemePanel({ draft, onChange, zoom, onZoom }: { draft: Settings; onChange: (patch: Partial<Settings>) => void; zoom: number; onZoom: (direction: 1 | -1 | 0) => void }) {
  // Only where the window has a material to show: elsewhere there is nothing behind the sidebar.
  const translucent = hasWindowMaterial();
  const [reducedTransparency] = useState(() => translucent && window.matchMedia("(prefers-reduced-transparency: reduce)").matches);
  const thinkingOrb = draft.thinkingOrb ?? "auto";
  const previewState = thinkingOrb === "auto" ? "working" : thinkingOrb;
  const choices: Array<{ id: ThemeMode; label: string; description: string; icon: typeof Monitor }> = [
    { id: "system", label: "System", description: "Match your Mac", icon: Monitor },
    { id: "light", label: "Light", description: "Frost", icon: Sun },
    { id: "dark", label: "Dark", description: DARK_TILE_NAMES[draft.darkIntensity], icon: Moon },
  ];
  return <div className="theme-panel">
    <section className="theme-section" aria-labelledby="interface-mode-title">
      <SectionHead id="interface-mode-title" title="Interface theme" help="Follow your system, or keep Glitter light or dark." />
      <div className="theme-choice-grid" role="radiogroup" aria-label="Interface mode">
        {choices.map(({ id, label, description, icon: Icon }) => <button key={id} type="button" role="radio" aria-checked={draft.theme === id} className={`theme-choice ${draft.theme === id ? "selected" : ""}`} onClick={() => onChange({ theme: id })}>
          <span className={`theme-preview theme-preview-${id}${id === "dark" ? ` theme-preview-dark-${draft.darkIntensity}` : ""}`} aria-hidden="true"><span className="theme-preview-sidebar"><i /><i /><i /></span><span className="theme-preview-main"><i /><i /><span /><i /></span></span>
          <span className="theme-choice-label">
            <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="theme-choice-copy"><strong>{label}</strong><span>{description}</span></span>
            <span className="choice-check" aria-hidden="true"><Check size={11} strokeWidth={3} /></span>
          </span>
        </button>)}
      </div>
      <div className="settings-card">
        <SettingRow label={<label htmlFor="dark-intensity">Dark intensity</label>} help="How deep the dark theme goes, whenever Glitter is dark.">
          <SelectMenu id="dark-intensity" ariaLabel="Dark intensity" value={draft.darkIntensity} placeholder="Mid" options={DARK_INTENSITY_OPTIONS} onChange={(value) => {
            const level = DARK_INTENSITIES.find((candidate) => candidate === value);
            if (level) onChange({ darkIntensity: level });
          }} />
        </SettingRow>
      </div>
    </section>

    <section className="theme-section" aria-labelledby="display-title">
      <SectionHead id="display-title" title="Display & accessibility" help="Scale the desktop window and limit non-essential animation." />
      <div className="settings-card">
        <SettingRow label={<span className="setting-label">Interface zoom</span>} help="Scale the whole window. The View menu and its keyboard shortcuts still work.">
          <div className="zoom-stepper" role="group" aria-label="Interface zoom">
            <button type="button" className="icon-btn small" aria-label="Zoom out" disabled={zoom <= ZOOM_LEVELS[0]} onClick={() => onZoom(-1)}><Minus size={13} aria-hidden="true" /></button>
            <output aria-live="polite" aria-atomic="true">{Math.round(zoom * 100)}%</output>
            <button type="button" className="icon-btn small" aria-label="Zoom in" disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} onClick={() => onZoom(1)}><Plus size={13} aria-hidden="true" /></button>
            <button type="button" className="ghost-btn small" disabled={zoom === 1} onClick={() => onZoom(0)}>Reset</button>
          </div>
        </SettingRow>
        <button type="button" role="switch" aria-checked={draft.reduceMotion} className={`setting-row setting-switch ${draft.reduceMotion ? "selected" : ""}`} onClick={() => onChange({ reduceMotion: !draft.reduceMotion })}>
          <span className="setting-copy"><strong className="setting-label">Reduce interface motion</strong><span className="field-help">Limit animation throughout Glitter. Your Mac’s Reduce motion setting is always honored.</span></span>
          <span className="toggle" aria-hidden="true" aria-checked={draft.reduceMotion}><i /></span>
        </button>
      </div>
    </section>

    <section className="theme-section" aria-labelledby="font-title">
      <SectionHead id="font-title" title="Font" help="The face for the whole interface. Code, diffs and the terminal keep a monospace face." />
      <div className="settings-card">
        <SettingRow label={<label htmlFor="ui-font">Font</label>} help={UI_FONT_COPY[draft.uiFont].description}>
          <SelectMenu id="ui-font" ariaLabel="Font" value={draft.uiFont} placeholder="System" options={FONT_OPTIONS} onChange={(value) => {
            const font = UI_FONTS.find((candidate) => candidate === value);
            if (font) onChange({ uiFont: font });
          }} />
        </SettingRow>
      </div>
    </section>

    <section className="theme-section" aria-labelledby="accent-color-title">
      <SectionHead id="accent-color-title" title="Accent color" help="Selections and highlights, in both light and dark." />
      <div className="settings-card">
        <div className="setting-row">
          <div className="setting-copy"><span className="setting-label">Color</span><span className="field-help">{ACCENTS.find((accent) => accent.id === draft.accentColor)?.label}</span></div>
          <div className="accent-choice-grid" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((accent) => <button key={accent.id} type="button" role="radio" aria-checked={draft.accentColor === accent.id} aria-label={accent.label} title={accent.label} className={`accent-choice accent-${accent.id} ${draft.accentColor === accent.id ? "selected" : ""}`} onClick={() => onChange({ accentColor: accent.id })}>
              <span className="accent-swatch" style={{ backgroundColor: accent.hex }}><Check size={12} strokeWidth={3} aria-hidden="true" /></span>
            </button>)}
          </div>
        </div>
      </div>
    </section>

    <section className="theme-section" aria-labelledby="sidebar-title">
      <SectionHead id="sidebar-title" title="Sidebar" help="How the left navigation sits against your desktop and your accent." />
      <div className="settings-card">
        <SettingRow label={<label htmlFor="sidebar-density">Row density</label>} help="Choose how much vertical space workspaces and threads take.">
          <SelectMenu id="sidebar-density" ariaLabel="Sidebar row density" value={draft.sidebarDensity} placeholder="Standard" options={SIDEBAR_DENSITY_OPTIONS} onChange={(value) => {
            const density = SIDEBAR_DENSITIES.find((candidate) => candidate === value);
            if (density) onChange({ sidebarDensity: density });
          }} />
        </SettingRow>
        {translucent ? <SettingRow label={<label htmlFor="sidebar-translucency">Translucency</label>} help={reducedTransparency ? "Off while Reduce transparency is on in System Settings." : "Let your desktop show through the sidebar."}>
          <TranslucencySlider id="sidebar-translucency" value={draft.sidebarTranslucency} disabled={reducedTransparency} onPreview={(value) => applyTheme({ ...draft, sidebarTranslucency: value })} onCommit={(value) => onChange({ sidebarTranslucency: value })} />
        </SettingRow> : null}
        <button type="button" role="switch" aria-checked={draft.accentSidebar} className={`setting-row setting-switch ${draft.accentSidebar ? "selected" : ""}`} onClick={() => onChange({ accentSidebar: !draft.accentSidebar })}>
          <span className="setting-copy"><strong className="setting-label">Tint the sidebar</strong><span className="field-help">Use the accent color in the left navigation.</span></span>
          <span className="toggle" aria-hidden="true" aria-checked={draft.accentSidebar}><i /></span>
        </button>
      </div>
    </section>

    <section className="theme-section" aria-labelledby="thinking-orb-title">
      <SectionHead id="thinking-orb-title" title="Thinking orb" help="The animation shown while an agent works. It follows your accent color." />
      <div className="settings-card thinking-orb-controls">
        <div className="thinking-orb-preview" aria-label="Thinking orb preview">
          <Orb state={previewState} size={64} aria-hidden="true" />
          <span><Orb state={previewState} size={20} aria-hidden="true" /><span>Thinking…</span></span>
        </div>
        <SettingRow label={<label htmlFor="thinking-orb">Orb animation</label>} help={ORB_COPY[thinkingOrb].description}>
          <SelectMenu id="thinking-orb" ariaLabel="Orb animation" value={thinkingOrb} placeholder="Automatic" options={ORB_OPTIONS} onChange={(value) => {
            const style = THINKING_ORBS.find((orb) => orb === value);
            if (style) onChange({ thinkingOrb: style });
          }} />
        </SettingRow>
      </div>
    </section>
  </div>;
}

const PERMISSION_BADGES: Partial<Record<ApprovalMode, string>> = {
  onRequest: "Recommended",
  denyUnmatched: "Strict",
};

const PERMISSION_ICONS: Record<ApprovalMode, ReactNode> = {
  onRequest: <ShieldCheck size={15} aria-hidden="true" />,
  promptUnmatched: <ShieldCheck size={15} aria-hidden="true" />,
  guarded: <ShieldAlert size={15} aria-hidden="true" />,
  denyUnmatched: <Lock size={15} aria-hidden="true" />,
  allowAll: <TriangleAlert size={15} aria-hidden="true" />,
};

/** Prompt templates offered in the slash menu. Each change saves at once, like other preferences. */
function CustomCommandsCard({ commands, onChange }: { commands: CustomCommand[]; onChange: (commands: CustomCommand[]) => void }) {
  const [form, setForm] = useState<CustomCommand>({ name: "", description: "", body: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const add = () => {
    const next = { name: form.name.trim().replace(/^\//, ""), description: form.description.trim(), body: form.body };
    const issue = customCommandProblem(next, commands);
    setProblem(issue);
    if (issue) return;
    onChange([...commands, next]);
    setForm({ name: "", description: "", body: "" });
  };
  return <>
    <SectionHead title="Slash commands" help="Your own prompts in the composer’s slash menu. Put $ARGUMENTS where your input goes; the cursor lands there." />
    <section className="settings-card custom-commands" aria-label="Custom commands">
      {commands.length ? <ul>
        {commands.map((command) => <li key={command.name}>
          <span><strong>/{command.name}</strong>{command.description ? <span className="model-meta">{command.description}</span> : null}</span>
          <button type="button" className="ghost-btn small" aria-label={`Remove /${command.name}`} onClick={() => onChange(commands.filter((entry) => entry.name !== command.name))}>Remove</button>
        </li>)}
      </ul> : null}
      <form onSubmit={(event) => { event.preventDefault(); add(); }}>
        <div className="custom-command-fields">
          <div className="field"><label htmlFor="custom-command-name">Name</label><input id="custom-command-name" value={form.name} placeholder="standup" maxLength={33} spellCheck={false} onChange={(event) => setForm({ ...form, name: event.target.value })} /></div>
          <div className="field"><label htmlFor="custom-command-description">Description (optional)</label><input id="custom-command-description" value={form.description} placeholder="Summarize yesterday's work" maxLength={120} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
        </div>
        <div className="field"><label htmlFor="custom-command-body">Prompt</label><textarea id="custom-command-body" rows={3} value={form.body} placeholder="Summarize the commits since $ARGUMENTS as a standup update." maxLength={8000} onChange={(event) => setForm({ ...form, body: event.target.value })} /></div>
        <div className="custom-command-foot">
          {problem ? <p className="settings-note danger" role="alert">{problem}</p> : <span />}
          <button type="submit" className="secondary small">Add command</button>
        </div>
      </form>
    </section>
  </>;
}

/**
 * Every shortcut, grouped. Rebindable ones take a new chord on the next key
 * press after Change; the rest are listed for reference. A change saves at once.
 */
function ShortcutsPanel({ overrides, onChange }: { overrides: ShortcutOverrides; onChange: (overrides: ShortcutOverrides) => void }) {
  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const [problem, setProblem] = useState<{ id: ShortcutId; text: string } | null>(null);
  const mac = isMacPlatform();
  const bind = (id: ShortcutId, chord: string) => {
    const issue = chord === REMAPPABLE[id].chord ? null : bindingProblem(id, chord, overrides);
    if (issue) { setProblem({ id, text: issue }); return; }
    const next = { ...overrides };
    if (chord === REMAPPABLE[id].chord) delete next[id]; else next[id] = chord;
    onChange(next);
    setProblem(null);
    setCapturing(null);
  };
  const reset = (id: ShortcutId) => {
    // Going back to the default can collide with a chord another action was moved onto.
    const issue = bindingProblem(id, REMAPPABLE[id].chord, overrides);
    if (issue) { setProblem({ id, text: issue }); return; }
    const next = { ...overrides };
    delete next[id];
    onChange(next);
    setProblem(null);
  };
  return <>
    <SectionHead title="Keyboard shortcuts" help="Change a shortcut, then press the new keys. Text entry and approval keys stay fixed." action={Object.keys(overrides).length ? <button type="button" className="ghost-btn small" onClick={() => { onChange({}); setProblem(null); setCapturing(null); }}>Reset all</button> : undefined} />
    {SHORTCUT_GROUPS.map((group) => <section key={group} className="shortcut-group" aria-label={`${group} shortcuts`}>
      <h3>{group}</h3>
      <ul className="shortcut-list">
        {SHORTCUT_IDS.filter((id) => REMAPPABLE[id].group === group).map((id) => <li key={id} className="remappable">
          <span>{REMAPPABLE[id].label}{problem?.id === id ? <span className="shortcut-problem" role="alert">{problem.text}</span> : null}</span>
          {capturing === id
            ? <button type="button" className="shortcut-capture" autoFocus aria-label={`Press the new shortcut for ${REMAPPABLE[id].label}`} onBlur={() => setCapturing(null)} onKeyDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.key === "Escape") { setCapturing(null); setProblem(null); return; }
                const chord = chordOf(event.nativeEvent);
                if (chord) bind(id, chord);
              }}>Press keys…</button>
            : <>
                {overrides[id] ? <button type="button" className="text-btn" aria-label={`Reset ${REMAPPABLE[id].label} to its default`} onClick={() => reset(id)}>Reset</button> : null}
                <button type="button" className="text-btn" aria-label={`Change the shortcut for ${REMAPPABLE[id].label}`} onClick={() => { setProblem(null); setCapturing(id); }}>Change</button>
                <kbd>{chordLabel(bindingFor(id, overrides), mac)}</kbd>
              </>}
        </li>)}
        {FIXED_SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => <li key={`${shortcut.label}${shortcut.keys}`}><span>{shortcut.label}</span><kbd>{shortcut.plain ? shortcut.keys : shortcutChord(shortcut.keys)}</kbd></li>)}
      </ul>
    </section>)}
  </>;
}

function PermissionsPanel({ draft, onChange }: { draft: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const ruleProblems = useAppStore((state) => state.harnessRuleProblems);
  const rulesError = useAppStore((state) => state.harnessRulesError);
  const offered: ApprovalMode[] = draft.defaultApprovalMode === "denyUnmatched" ? ["denyUnmatched", ...APPROVAL_ORDER] : [...APPROVAL_ORDER];
  const modes = offered.filter((mode) => mode !== "allowAll");
  return <div className="permissions-panel">
    <SectionHead title="Approvals" help="How freely every agent works before it asks. The same choice for every model." />
    <div className="permission-options" role="radiogroup" aria-label="Default permissions for new threads">
      {modes.map((mode) => <button key={mode} type="button" role="radio" aria-checked={draft.defaultApprovalMode === mode} className={`permission-option ${draft.defaultApprovalMode === mode ? "selected" : ""}`} onClick={() => onChange({ defaultApprovalMode: mode })}>
        <span className="permission-radio" aria-hidden="true"><i /></span>
        <span className="permission-icon" aria-hidden="true">{PERMISSION_ICONS[mode]}</span>
        <span className="permission-copy"><span><strong>{APPROVAL_LABELS[mode]}</strong>{PERMISSION_BADGES[mode] ? <em>{PERMISSION_BADGES[mode]}</em> : null}</span><small>{APPROVAL_DESCRIPTIONS[mode]}</small></span>
      </button>)}
    </div>
    <p className="settings-note">The default for new threads. Full access is chosen on a thread, from the composer.</p>
    <SectionHead title="Terminal" />
    <section className="settings-card" aria-label="Terminal">
      <SettingRow label={<span id="disable-terminal-label" className="setting-label">Disable Terminal pane</span>} help="Keep the integrated terminal off. Agent commands still follow the permission rules above.">
        <button type="button" role="switch" aria-labelledby="disable-terminal-label" aria-checked={draft.disableTerminal === true} className="toggle" onClick={() => onChange({ disableTerminal: !draft.disableTerminal })}><i /></button>
      </SettingRow>
    </section>
    <PermissionRulesCard rules={draft.harnessRules ?? []} onChange={(harnessRules) => onChange({ harnessRules })} problems={ruleProblems} syncError={rulesError} onRetry={() => { void useAppStore.getState().applyHarnessRules(true).catch(() => {}); }} />
  </div>;
}

function modelKey(model: { modelId: string; providerId?: string }) {
  return JSON.stringify([model.providerId ?? "", model.modelId]);
}

/** A label and value in Diagnostics. */
function Fact({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return <p className="muted" title={title}><span className="diagnostic-label">{label}</span><span className="diagnostic-value">{children}</span></p>;
}

export function SettingsModal() {
  const s = useAppStore(useShallow((state) => ({
    // settingsFields(s) reads the whole Settings slice, so all of it is selected.
    theme: state.theme,
    uiFont: state.uiFont,
    darkIntensity: state.darkIntensity,
    accentColor: state.accentColor,
    accentSidebar: state.accentSidebar,
    sidebarTranslucency: state.sidebarTranslucency,
    sidebarDensity: state.sidebarDensity,
    reduceMotion: state.reduceMotion,
    thinkingOrb: state.thinkingOrb,
    defaultModel: state.defaultModel,
    defaultProviderId: state.defaultProviderId,
    defaultEffort: state.defaultEffort,
    defaultApprovalMode: state.defaultApprovalMode,
    disableTerminal: state.disableTerminal,
    notifications: state.notifications,
    hiddenModels: state.hiddenModels,
    hiddenProviders: state.hiddenProviders,
    workspaces: state.workspaces,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    settingsOpen: state.settingsOpen,
    settingsTab: state.settingsTab,
    preview: state.preview,
    hostInfo: state.hostInfo,
    providerStatus: state.providerStatus,
    models: state.models,
    loadModelCatalog: state.loadModelCatalog,
    peekModelCatalog: state.peekModelCatalog,
    testModel: state.testModel,
    agents: state.agents,
    listSince: state.listSince,
    commitSettings: state.commitSettings,
    refreshDetection: state.refreshDetection,
    setSettingsOpen: state.setSettingsOpen,
    zoom: state.zoom,
    zoomBy: state.zoomBy,
    untrustWorkspace: state.untrustWorkspace,
    openTrustDialog: state.openTrustDialog,
    setListSince: state.setListSince,
    selectWorkspace: state.selectWorkspace,
    archiveThread: state.archiveThread,
    deleteThread: state.deleteThread,
    confirm: state.confirm,
  })));
  const thread = currentThread(s);
  const workspace = currentWorkspace(s);
  const dialog = useRef<HTMLDialogElement>(null);
  const [notice, setNotice] = useState("");
  const [usageActionsHost, setUsageActionsHost] = useState<HTMLDivElement | null>(null);
  const tab = s.settingsTab;
  // The category highlight moves at once; the page it opens renders a beat later,
  // so a click on a heavy page (Models, Usage) never holds up the frame that answers it.
  const page = useDeferredValue(tab);
  const setTab = (next: SettingsTab) => s.setSettingsOpen(true, next);
  const navRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const defaultsAgentId: AgentId = "harness";
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [modelCatalog, setModelCatalog] = useState<{ agentId: AgentId; models: Model[]; loading: boolean; error: string | null }>({ agentId: defaultsAgentId, models: [], loading: true, error: null });
  useEffect(() => {
    if (!s.settingsOpen || tab !== "Models") return;
    let current = true;
    setModelCatalog((previous) => ({ agentId: defaultsAgentId, models: previous.agentId === defaultsAgentId ? previous.models : [], loading: true, error: null }));
    void s.loadModelCatalog(defaultsAgentId).then((models) => {
      if (current) setModelCatalog({ agentId: defaultsAgentId, models, loading: false, error: null });
    }).catch((error) => {
      if (current) setModelCatalog((previous) => ({ ...previous, loading: false, error: describeError(`Could not load ${AGENT_LABELS[defaultsAgentId]} models`, error) }));
    });
    return () => { current = false; };
  }, [s.settingsOpen, tab, defaultsAgentId, s.loadModelCatalog, s.preview, catalogRefresh]);
  const [draft, setDraft] = useState<Settings>(() => settingsFields(s));
  const edit = (patch: Partial<Settings>) => {
    setDraft((value) => ({ ...value, ...patch }));
    // Every setting is a preference and saves at once.
    void s.commitSettings(patch).catch((error) => setNotice(describeError("Could not save settings", error)));
  };
  const visibleTabs = settingsTabsMatching(search);
  useEffect(() => { bodyRef.current?.scrollTo(0, 0); setSearch(""); }, [tab]);
  useModalDialog(s.settingsOpen, dialog);
  // The app view steps back while Settings is open and returns as it closes. A
  // root attribute drives that, not an app-wide :has() selector, which the
  // engine would re-match on every change anywhere in the window.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.settings = s.settingsOpen ? "open" : "closing";
  }, [s.settingsOpen]);
  useEffect(() => () => { delete document.documentElement.dataset.settings; }, []);
  // Opening would otherwise hand focus to the first control, and a focused
  // control greets every opening with a lit ring. The page itself takes focus
  // instead, with no ring; Tab moves on to Back and the categories from there.
  useEffect(() => {
    if (s.settingsOpen) dialog.current?.focus();
  }, [s.settingsOpen]);
  useEffect(() => {
    if (s.settingsOpen) { setDraft(settingsFields(useAppStore.getState())); setNotice(""); setSearch(""); }
  }, [s.settingsOpen]);
  useEffect(() => {
    if (s.settingsOpen) navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [s.settingsOpen, tab, search]);
  const defaultModels = modelCatalog.agentId === defaultsAgentId ? modelCatalog.models : [];
  // The default model follows the same Settings → Models switches as the composer.
  const offeredDefaults = selectableModels(defaultModels, defaultsAgentId, draft.hiddenModels, draft.hiddenProviders);
  const modelOptions: SelectMenuOption[] = offeredDefaults.map((model) => ({
    value: modelKey(model),
    label: humanizeModelLabel(model.modelId, model.displayLabel),
    description: humanizeProvider(model.providerId),
    icon: <ModelIcon modelId={model.modelId} providerId={model.providerId} size={18} fallback={<AgentMark id={defaultsAgentId} size={18} />} />,
  }));
  const selectedDefault = modelFor(defaultModels, { modelId: draft.defaultModel, providerId: draft.defaultProviderId });
  const defaultModelValue = draft.defaultModel ? modelKey(selectedDefault ?? { modelId: draft.defaultModel, providerId: draft.defaultProviderId }) : undefined;
  const modelByKey = new Map(defaultModels.map((model) => [modelKey(model), model]));
  const savedUnlisted = Boolean(draft.defaultModel && !selectedDefault && !modelCatalog.loading && !modelCatalog.error && defaultModels.length);
  if (defaultModelValue && !modelOptions.some((option) => option.value === defaultModelValue)) {
    modelOptions.push({ value: defaultModelValue, label: humanizeModelLabel(draft.defaultModel), description: selectedDefault ? "Off in Settings → Models" : "Saved selection · not in the current catalog" });
  }
  // The smart-suggestions model picker (General page): the catalog feeds the
  // model list; "Cheapest" leaves the choice to the store.
  const suggestionAgentId = defaultsAgentId;
  const [suggestCatalog, setSuggestCatalog] = useState<{ agentId: AgentId; models: Model[]; loading: boolean; error: string | null }>({ agentId: suggestionAgentId, models: [], loading: true, error: null });
  useEffect(() => {
    if (!s.settingsOpen || tab !== "General" || !draft.suggestionsEnabled) return;
    let current = true;
    setSuggestCatalog((previous) => ({ agentId: suggestionAgentId, models: previous.agentId === suggestionAgentId ? previous.models : [], loading: true, error: null }));
    void s.loadModelCatalog(suggestionAgentId).then((models) => {
      if (current) setSuggestCatalog({ agentId: suggestionAgentId, models, loading: false, error: null });
    }).catch((error) => {
      if (current) setSuggestCatalog((previous) => ({ ...previous, loading: false, error: describeError(`Could not load ${AGENT_LABELS[suggestionAgentId]} models`, error) }));
    });
    return () => { current = false; };
  }, [s.settingsOpen, tab, suggestionAgentId, draft.suggestionsEnabled, s.loadModelCatalog]);
  const suggestModels = suggestCatalog.agentId === suggestionAgentId ? suggestCatalog.models : [];
  const offeredSuggest = selectableModels(suggestModels, suggestionAgentId, draft.hiddenModels, draft.hiddenProviders);
  const suggestModelOptions: SelectMenuOption[] = [
    { value: "", label: "Cheapest available", description: "The lowest-cost model the agent reports" },
    ...offeredSuggest.filter((model) => !model.unavailable).map((model) => ({
      value: modelKey(model),
      label: humanizeModelLabel(model.modelId, model.displayLabel),
      description: [humanizeProvider(model.providerId), model.cost?.input ? `${model.cost.input}/M in` : ""].filter(Boolean).join(" · "),
      icon: <ModelIcon modelId={model.modelId} providerId={model.providerId} size={18} fallback={<AgentMark id={suggestionAgentId} size={18} />} />,
    })),
  ];
  const selectedSuggest = modelFor(suggestModels, { modelId: draft.suggestionsModelId });
  const suggestModelValue = draft.suggestionsModelId ? modelKey(selectedSuggest ?? { modelId: draft.suggestionsModelId }) : "";
  const suggestByKey = new Map(suggestModels.map((model) => [modelKey(model), model]));
  if (suggestModelValue && !suggestModelOptions.some((option) => option.value === suggestModelValue)) {
    suggestModelOptions.push({ value: suggestModelValue, label: humanizeModelLabel(draft.suggestionsModelId ?? suggestModelValue), description: selectedSuggest ? "Off in Settings → Models" : "Saved selection · not in the current catalog" });
  }
  const discardAndClose = () => {
    setNotice("");
    s.setSettingsOpen(false);
  };
  const libraryAgents = s.agents.filter((agent) => agent.id === "harness");
  const copyDiagnostics = async () => {
    let snapshot: Awaited<ReturnType<typeof diagnosticsSnapshot>> | null = null;
    let snapshotError: string | null = null;
    try {
      snapshot = await diagnosticsSnapshot();
    } catch (error) {
      snapshotError = error instanceof Error ? error.message : String(error);
    }
    const lines = [
      `Glitter ${APP_VERSION}`,
      snapshot ? `OS: ${snapshot.os} ${snapshot.arch}` : "OS: unknown",
      `Agent: ${AGENT_LABELS[defaultsAgentId]}`,
      `Provider keys: ${s.agents.some((agent) => agent.authenticated) ? "configured" : "none"}`,
      `Workspace: ${workspace?.path ?? "none"}`,
      `Session: ${thread?.sessionId ?? "none"}`,
      `Thread state: ${thread?.status ?? "none"}`,
      `Threads in memory: ${s.threads.length}`,
      `Agent running: ${s.hostInfo ? "yes" : "no"}`,
      `Child environment: ${s.hostInfo?.isolation?.env ?? "minimal"}`,
      `OS sandbox: ${s.hostInfo?.isolation ? s.hostInfo.isolation.osSandbox : "unknown — not verifiable on this platform"}`,
    ];
    if (snapshot) lines.push("", `Recent log (last ${snapshot.logTail.length} lines, redacted):`, ...snapshot.logTail);
    else lines.push("", `Recent log: unavailable (${snapshotError ?? "unknown error"})`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setNotice("Diagnostics copied, including recent redacted log lines. Credentials are removed; review before sharing.");
    } catch (error) {
      setNotice(describeError("Could not copy the diagnostics", error));
    }
  };
  const saveHint = READ_ONLY_TABS.includes(tab) ? null : <span className="settings-save-status" role="status"><Check size={11} strokeWidth={2.5} aria-hidden="true" />Changes save as you make them</span>;
  return <dialog ref={dialog} className="settings-dialog" tabIndex={-1} aria-labelledby="settings-title" aria-hidden={!s.settingsOpen} onCancel={(event) => { event.preventDefault(); discardAndClose(); }} onClose={() => s.setSettingsOpen(false)}>
    <nav className="settings-nav" aria-label="Settings categories">
      <div className="settings-titlebar" data-tauri-drag-region>
        <button type="button" className="ghost-btn settings-back" aria-label="Back to Glitter" onClick={discardAndClose}><ArrowLeft size={14} aria-hidden="true" />Back</button>
      </div>
      <h2 id="settings-title">Settings</h2>
      <div className="search-field settings-search"><Search size={13} aria-hidden="true" /><input aria-label="Search settings" placeholder="Search settings" value={search} onChange={(event) => setSearch(event.target.value)} />{search ? <button type="button" className="search-clear" aria-label="Clear settings search" onClick={() => setSearch("")}><X size={12} /></button> : null}</div>
      <div ref={navRef} className="settings-nav-groups">
        {SETTINGS_NAV_GROUPS.map((group) => {
          const matches = group.tabs.filter((item) => visibleTabs.includes(item));
          return matches.length ? <div className="settings-nav-group" key={group.label}><span className="settings-nav-label">{group.label}</span>{matches.map((item) => <button key={item} type="button" title={SETTINGS_TAB_LABELS[item]} aria-label={item} aria-current={tab === item ? "page" : undefined} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{tabIcon(item)}<span>{SETTINGS_TAB_LABELS[item]}</span></button>)}</div> : null;
        })}
        {!visibleTabs.length ? <p className="settings-search-empty" role="status">No settings match. Try “theme”, “model” or “key”.</p> : null}
      </div>
      <div className="settings-version"><img src="/spark.svg" alt="" width="16" height="16" /><span>Glitter {APP_VERSION}</span></div>
    </nav>
    <div className="settings-main">
      <div className="settings-main-bar" data-tauri-drag-region>
        {saveHint}
        <button type="button" className="icon-btn settings-close" aria-label="Close settings" data-tooltip-align="end" data-tooltip="Close  Esc" onClick={discardAndClose}><X size={16} /></button>
      </div>
      <fieldset className="settings-fields settings-content">
        <div ref={bodyRef} className={`settings-section-body settings-page-${page.toLowerCase()}`} role="region" aria-labelledby="settings-page-title" tabIndex={0}>
          <div key={page} className="settings-column settings-page">
            <header className={`settings-section-head${page === "Usage" ? " is-usage" : ""}`}>
              {page === "Usage" ? (
                <div className="usage-page-head">
                  <div className="usage-page-title">
                    <h3 id="settings-page-title">Usage stats</h3>
                    <span className="usage-scope">App usage</span>
                  </div>
                  <div className="usage-page-actions" ref={setUsageActionsHost} />
                </div>
              ) : (
                <>
                  <h3 id="settings-page-title">{SETTINGS_TAB_LABELS[page]}</h3>
                  <p>{SETTINGS_TAB_COPY[page]}</p>
                </>
              )}
            </header>
        {page === "Models" ? <>
          <SectionHead title="New thread defaults" help="The composer can change both for any thread." action={<button type="button" className="ghost-btn small" aria-label="Refresh default models" disabled={modelCatalog.loading} onClick={() => setCatalogRefresh((value) => value + 1)}><RefreshCw size={11} className={modelCatalog.loading ? "spin" : ""} aria-hidden="true" />Refresh</button>} />
          {modelCatalog.error ? <p className="settings-note" role="alert">{modelCatalog.error} Refresh the list, or check your keys under Providers.</p> : modelCatalog.loading ? <p className="settings-note" role="status">Loading {AGENT_LABELS[defaultsAgentId]} models…</p> : !defaultModels.length ? <p className="settings-note" role="status">{AGENT_LABELS[defaultsAgentId]} did not report any models.</p> : null}
          <section className="settings-card" aria-label="New thread defaults">
          <SettingRow label={<label htmlFor="default-model">Default model</label>} help={<>{savedUnlisted ? <span>This saved model is no longer listed. Choose a current model. </span> : null}{draft.defaultModel ? <button className="text-btn" type="button" onClick={() => edit({ defaultModel: "", defaultProviderId: undefined })}>Use the agent’s default</button> : "New threads start on the agent’s own default."}</>}><SelectMenu id="default-model" ariaLabel="Default model" icon={draft.defaultModel && selectedDefault ? <ModelIcon modelId={selectedDefault.modelId} providerId={selectedDefault.providerId} size={15} hostName={providerName(selectedDefault.providerId, customProviders(s.providerStatus ?? []))} fallback={<AgentMark id={defaultsAgentId} size={15} />} /> : undefined} value={defaultModelValue} placeholder={modelCatalog.loading ? "Loading models…" : defaultModels.length ? "Agent default" : "Connect to load models"} options={modelOptions} disabled={modelCatalog.loading || !defaultModels.length} onChange={(value) => { const model = modelByKey.get(value); if (model) edit({ defaultModel: model.modelId, defaultProviderId: model.providerId }); }} /></SettingRow>
          <SettingRow label={<label htmlFor="default-effort">Default reasoning effort</label>} help="More effort gives the model longer on hard problems; less suits quick edits and questions."><SelectMenu id="default-effort" ariaLabel="Default reasoning effort" value={draft.defaultEffort} placeholder="Agent default" options={EFFORTS.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))} onChange={(value) => edit({ defaultEffort: value as ReasoningEffort })} /></SettingRow>
          </section>
          <SectionHead title="Model library" help="Switch a provider or a single model off to keep it out of the composer’s picker. Test sends one word and times the reply, so a busy or retired model shows up before you rely on it." />
          <ModelLibrary agents={libraryAgents} customProviders={customProviders(s.providerStatus ?? [])} hidden={draft.hiddenModels ?? []} onHiddenChange={(hiddenModels) => edit({ hiddenModels })} hiddenProviders={draft.hiddenProviders ?? []} onHiddenProvidersChange={(hiddenProviders) => edit({ hiddenProviders })} loadCatalog={s.peekModelCatalog} testModel={s.testModel} onManageProviders={() => setTab("Providers")} />
        </> : null}
        {page === "Orchestrator" ? <OrchestratorPanel draft={draft} onChange={edit} customProviders={customProviders(s.providerStatus ?? [])} onManageProviders={() => setTab("Providers")} /> : null}
        {page === "Providers" ? <ProvidersPanel onChanged={() => { void s.refreshDetection().then(() => useAppStore.getState().refreshModels(true)); }} /> : null}
        {page === "Extensions" ? <Suspense fallback={null}><ExtensionsView embedded /></Suspense> : null}
        {page === "Permissions" ? <PermissionsPanel draft={draft} onChange={edit} /> : null}
        {page === "Threads" ? <div className="archive-panel">
          <SectionHead title="Thread list" />
          <section className="settings-card" aria-label="Thread list">
          <SettingRow label={<label htmlFor="list-since">Show threads updated within</label>} help="A narrower window lists fewer threads per workspace, which keeps very large histories quick to load.">
            <SelectMenu
              id="list-since"
              ariaLabel="Show threads updated within"
              value={s.listSince ?? "all"}
              placeholder="All time"
              options={[
                { value: "all", label: "All time" },
                { value: "day", label: "Last day" },
                { value: "week", label: "Last week" },
                { value: "month", label: "Last month" },
              ]}
              onChange={(value) => {
                s.setListSince(value === "all" ? null : value as "day" | "week" | "month");
                if (workspace) void s.selectWorkspace(workspace.id);
              }}
            />
          </SettingRow>
          </section>
          <SectionHead title="Archived threads" help="Hidden from the sidebar. Restore them, or delete them from Glitter." action={s.threads.some((thread) => thread.archived) ? (
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => {
                const count = s.threads.filter((thread) => thread.archived).length;
                void s.confirm({ title: `Delete ${count} archived thread${count === 1 ? "" : "s"} from Glitter?`, body: ["They are removed from Glitter and cannot be brought back into this list.", worktreeRemovalNote(s.threads, s.threads.filter((thread) => thread.archived).map((thread) => thread.sessionId))].filter(Boolean).join(" "), confirmLabel: "Delete all", danger: true }).then((ok) => {
                  if (!ok) return;
                  for (const thread of s.threads.filter((item) => item.archived)) s.deleteThread(thread.sessionId);
                });
              }}
            >
              <Trash2 size={11} />Delete all
            </button>
          ) : undefined} />
          <ul className="archive-list">
            {s.threads.filter((thread) => thread.archived).slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map((thread) => {
              const workspace = s.workspaces.find((item) => item.path === thread.workspacePath);
              return (
                <li key={thread.sessionId}>
                  <AgentMark size={22} />
                  <span className="model-copy">
                    <span className="model-name">{thread.title}</span>
                    <span className="model-meta">{workspace?.name ?? thread.workspacePath} · {relativeTime(thread.updatedAt)}</span>
                  </span>
                  <button type="button" className="ghost-btn small" onClick={() => s.archiveThread(thread.sessionId, false)}><ArchiveRestore size={11} />Restore</button>
                  <button
                    type="button"
                    className="ghost-btn small"
                    onClick={() => {
                      void s.confirm({ title: `Delete “${thread.title}” from Glitter?`, body: worktreeRemovalNote(s.threads, [thread.sessionId]) || undefined, confirmLabel: "Delete", danger: true }).then((ok) => { if (ok) s.deleteThread(thread.sessionId); });
                    }}
                  >
                    <Trash2 size={11} />Delete
                  </button>
                </li>
              );
            })}
            {!s.threads.some((thread) => thread.archived) ? <li className="missing"><ArchiveRestore size={22} aria-hidden="true" /><span><strong>Nothing archived</strong><span className="model-meta">Archived threads appear here. Your active threads are in the sidebar.</span></span></li> : null}
          </ul>
        </div> : null}
        {page === "General" ? <>
          <SectionHead title="Workspace" />
          <section className="settings-card" aria-label="General">
            <SettingRow label={<label htmlFor="editor-choice">Open files in</label>} help="Used by Open file in Changes, Files and the task monitor. An editor that is not installed reports an error instead of opening.">
              <SelectMenu id="editor-choice" ariaLabel="Open files in" value={draft.editor ?? "default"} placeholder="System default" options={EDITOR_CHOICES.map((id) => ({ value: id, label: EDITOR_LABELS[id] }))} onChange={(value) => edit({ editor: value as EditorChoice })} />
            </SettingRow>
            <SettingRow label={<span id="notifications-label" className="setting-label">Notifications</span>} help="Notify when a turn finishes or needs approval while you’re elsewhere.">
              <button type="button" role="switch" aria-labelledby="notifications-label" aria-checked={s.notifications !== false} className="toggle" onClick={() => void s.commitSettings({ notifications: !(s.notifications !== false) })}><i /></button>
            </SettingRow>
          </section>
          <SectionHead title="Suggestions" />
          <section className="settings-card" aria-label="Suggestions">
            <SettingRow label={<span id="suggestions-label" className="setting-label">Smart suggestions</span>} help="On a new thread, the agent predicts what to do next from file names, branch and thread titles — file contents are never sent. At most once a minute per workspace, on the provider’s normal usage.">
              <button type="button" role="switch" aria-labelledby="suggestions-label" aria-checked={draft.suggestionsEnabled === true} className="toggle" onClick={() => edit({ suggestionsEnabled: !draft.suggestionsEnabled })}><i /></button>
            </SettingRow>
            {draft.suggestionsEnabled ? <>
              <SettingRow label={<label htmlFor="suggestions-model">Suggestion model</label>} help={suggestCatalog.error ?? undefined}>
                <SelectMenu id="suggestions-model" ariaLabel="Suggestion model" icon={draft.suggestionsModelId && selectedSuggest ? <ModelIcon modelId={selectedSuggest.modelId} providerId={selectedSuggest.providerId} size={15} fallback={<AgentMark id={suggestionAgentId} size={15} />} /> : undefined} value={suggestModelValue} placeholder={suggestCatalog.loading ? "Loading models…" : "Cheapest available"} options={suggestModelOptions} disabled={suggestCatalog.loading} onChange={(value) => { const model = suggestByKey.get(value); if (model) edit({ suggestionsModelId: model.modelId }); else if (!value) edit({ suggestionsModelId: undefined }); }} />
              </SettingRow>
            </> : null}
          </section>
        </> : null}
        {page === "Theme" ? <ThemePanel draft={draft} onChange={edit} zoom={s.zoom} onZoom={s.zoomBy} /> : null}
        {page === "Shortcuts" ? <>
          <CustomCommandsCard commands={draft.customCommands ?? []} onChange={(customCommands) => edit({ customCommands })} />
          <ShortcutsPanel overrides={draft.shortcutOverrides ?? {}} onChange={(shortcutOverrides) => edit({ shortcutOverrides })} />
        </> : null}
        {page === "Usage" ? <Suspense fallback={null}><UsageView embedded actionsHost={usageActionsHost} /></Suspense> : null}
        {page === "Diagnostics" ? <>
          <SectionHead title="This app" action={<span className="row diagnostics-actions">
            <button type="button" className="ghost-btn small" onClick={() => void copyDiagnostics()}>Copy diagnostics</button>
            {isTauri() ? <button type="button" className="ghost-btn small" onClick={() => void openLogFolder().then((path) => setNotice(`Opened logs. Current file: ${path}`)).catch((error) => setNotice(describeError("Could not open the log folder", error)))}><FolderOpen size={11} />Open logs</button> : null}
          </span>} />
          <div className="diagnostics">
            <Fact label="Glitter">{APP_VERSION}{s.preview ? " · preview mode, commands unavailable" : ""}</Fact>
            <Fact label="Agent" title={thread?.sessionId}>{thread ? `${AGENT_LABELS.harness} · ${thread.title} · ${thread.status}` : `${AGENT_LABELS[defaultsAgentId]} (no thread open)`}</Fact>
            <Fact label="Workspace" title={workspace?.path}>{workspace?.name ?? "none open"}</Fact>
            <Fact label="Workspace trust" title="Trusted workspaces load their skills and rules">{!workspace?.grantId ? "—" : workspace.trusted ? "trusted — skills and rules load" : "untrusted — skills and rules do not load"}{workspace?.grantId ? <>{" · "}<button type="button" className="text-btn" onClick={() => { if (workspace.trusted) { void s.confirm({ title: `Stop trusting ${workspace.name}?`, body: "Its skills and rules will no longer load.", confirmLabel: "Stop trusting", danger: true }).then((ok) => { if (ok) void s.untrustWorkspace(workspace.id); }); } else { void s.openTrustDialog(workspace.id); } }}>{workspace.trusted ? "untrust" : "trust this workspace"}</button></> : null}</Fact>
            <Fact label="Workspaces">{s.workspaces.length}</Fact>
            <Fact label="Threads in memory">{s.threads.length}</Fact>
            <Fact label="Agent process">{s.hostInfo ? "running" : "not started"}</Fact>
            <Fact label="Command sandbox" title={s.hostInfo?.isolation?.cwd}>{s.hostInfo?.isolation ? `${s.hostInfo.isolation.osSandbox} (${s.hostInfo.isolation.platform}) · ${s.hostInfo.isolation.env} environment` : "unknown until the agent starts"}</Fact>
          </div>
        </> : null}
        {page === "About" ? <div className="about">
          <div className="settings-card">
            <div className="about-identity"><span className="about-mark"><img src="/spark.svg" alt="" /></span><div><h4>Glitter</h4><span className="about-version">Version {APP_VERSION}</span></div></div>
          </div>
          <SectionHead title="What Glitter is" />
          <p>An independent agent harness. Its agent runs on this Mac and calls the model providers you connect, with your own keys. The same agent runs in the terminal as <code>glitter</code>. Not affiliated with any model provider.</p>
          <SectionHead title="Privacy and your data" />
          <p>Prompts and the workspace context the agent reads go only to the provider that thread uses, under that provider’s data policy. Keys stay in your Mac’s keychain. Threads, usage and logs are kept on this Mac.</p>
        </div> : null}
          </div>
        </div>
      </fieldset>
      {notice ? <p className="settings-notice" role="status">{notice}</p> : null}
    </div>
  </dialog>;
}
