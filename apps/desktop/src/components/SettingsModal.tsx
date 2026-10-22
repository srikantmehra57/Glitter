import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useModalDialog } from "../lib/dialogFocus";
import { describeError } from "../lib/errors";
import { useShallow } from "zustand/react/shallow";
import { Activity, ArchiveRestore, Bot, Plug, ChartNoAxesColumn, Check, Command, Cpu, Eye, EyeOff, FilePlus, FolderOpen, Info, KeyRound, Lock, MessagesSquare, Monitor, Moon, Palette, Puzzle, RefreshCw, Search, ShieldCheck, Sun, Trash2, TriangleAlert, X } from "lucide-react";
import { diagnosticsSnapshot, openLogFolder } from "../lib/bridge";
import { isMacPlatform, isTauri } from "../lib/format";
import { modelFor, VOCABULARY } from "../lib/effort";
import { APP_VERSION } from "../lib/version";
import { AgentMark } from "./AgentPicker";
import { AGENT_IDS, AGENT_LABELS, APPROVAL_DESCRIPTIONS, APPROVAL_LABELS, APPROVAL_ORDER, AUTH_MODE_DESCRIPTIONS, AUTH_MODE_LABELS, AUTH_MODE_ORDER, AUTH_SOURCE_LABELS, AUTH_SOURCE_SHORT, DEFAULT_ENABLED_AGENTS, EDITOR_CHOICES, EDITOR_LABELS, EFFORT_LABELS, SETTINGS_TABS, THINKING_ORBS, agentEnabled, type CustomCommand, type EditorChoice, type AccentColor, type AgentId, type AgentInfo, type CliApprovalMode, type AuthMode, type CliUpdateOutcome, type CliUpdateStatus, type Detection, type HostPosture, type ReasoningEffort, type SandboxNetwork, type SettingsTab, type ThemeMode, type ThinkingOrbStyle, type Settings } from "../lib/types";
import { humanizeModelLabel, humanizeProvider, relativeTime, shortCliVersion, shortHash, shortcutLabel, worktreeRemovalNote } from "../lib/format";
import { settingsFields } from "../lib/settingsPersistence";
import { customCommandProblem } from "../lib/composerText";
import { FIXED_SHORTCUTS, REMAPPABLE, SHORTCUT_IDS, bindingFor, bindingProblem, chordLabel, chordOf, type ShortcutId, type ShortcutOverrides } from "../lib/shortcuts";
import { applyTheme, currentThread, currentWorkspace, hasWindowMaterial, preferredAgent, useAppStore } from "../lib/store";
import type { Model } from "../lib/types";
const ExtensionsView = lazy(() => import("./ExtensionsView").then((module) => ({ default: module.ExtensionsView })));
const UsageView = lazy(() => import("./UsageView").then((module) => ({ default: module.UsageView })));
import { LoginPanel } from "./LoginPanel";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import { Orb } from "./Orb";
import { ProvidersPanel } from "./ProvidersPanel";

const EFFORTS = VOCABULARY;
const TABS = SETTINGS_TABS;
const NAV_GROUPS: Array<{ label: string; tabs: SettingsTab[] }> = [
  { label: "Workspace", tabs: ["Models", "Providers", "Agents", "Extensions", "Threads"] },
  { label: "Preferences", tabs: ["General", "Theme", "Permissions", "Shortcuts"] },
  { label: "Your account", tabs: ["Account", "Usage"] },
  { label: "Application", tabs: ["Diagnostics", "About"] },
];
const TAB_LABELS: Partial<Record<SettingsTab, string>> = { Theme: "Appearance", Models: "Models & reasoning", Permissions: "Permissions & safety", Shortcuts: "Keyboard shortcuts" };
const SEARCH_TERMS: Partial<Record<SettingsTab, string>> = {
  General: "notifications alerts editor vscode cursor zed intellij custom commands slash macros",
  Agents: "opencode grok gemini qwen goose cline third-party sandbox isolation binary harness",
  Providers: "api key byok bring your own anthropic claude openai gpt google gemini openrouter cline xai grok deepseek groq mistral nvidia nim ollama lm studio local custom endpoint",
  Theme: "light dark system accent color sidebar tint translucent translucency transparency thinking orb animation", Models: "default effort model provider reasoning contributor subscription", Account: "sign in out subscription api key credential binary path connection",
  Permissions: "approval sandbox network shell file writes ephemeral read only ask auto review unrestricted", Threads: "archive restore delete history", Extensions: "skills mcp servers plugins import",
  Shortcuts: "keybindings hotkeys remap",
  Diagnostics: "logs health enterprise",
  About: "version update cli privacy",
};

const SHORTCUT_GROUPS = ["General", "Threads", "Composer", "Approvals"] as const;
/** "⇧] / ⇧[" becomes "⌘⇧] / ⌘⇧[": every alternative gets the platform modifier. */
const shortcutChord = (keys: string) => keys.split(" / ").map((key) => shortcutLabel(key)).join(" / ");
/**
 * Settings the Muse host is built with. Changing one means restarting the
 * connection, so these wait for an explicit "Save & restart connection".
 * Every other setting is a preference and saves as it is changed.
 */
const RESTART_KEYS = ["ephemeralSessions", "disableWrite", "disableShell", "sandboxNetwork", "museAuthMode", "museApiKey", "museBin", "contributorMode"] as const satisfies ReadonlyArray<keyof Settings>;
const ACCOUNT_KEYS: ReadonlyArray<keyof Settings> = ["museAuthMode", "museApiKey", "museBin"];
const needsRestart = (key: string): key is (typeof RESTART_KEYS)[number] => (RESTART_KEYS as readonly string[]).includes(key);
const settled = (value: unknown) => typeof value === "string" ? value.trim() : value;
/** Tabs with nothing to change; they show no saving hint. */
const READ_ONLY_TABS: SettingsTab[] = ["Extensions", "Threads", "Usage", "Diagnostics", "About"];

const TAB_COPY: Record<SettingsTab, string> = {
  General: "Preferences that apply across the app.",
  Agents: "Choose which local coding agents are available in Glitter.",
  Providers: "Add your own keys for model providers. The built-in Harness agent uses them directly.",
  Extensions: "Skills, MCP servers, and plugins available to Muse.",
  Threads: "Choose how far back the sidebar lists, and clean up archived threads.",
  Theme: "Choose the theme, accent color, sidebar and thinking orb used in Glitter.",
  Models: "Set the model and reasoning defaults for new threads.",
  Account: "Choose which Muse credential pays for your sessions.",
  Permissions: "Choose how Muse works, and how locked down its host runs.",
  Usage: "Tokens across every agent and provider, kept on this Mac.",
  Shortcuts: "Move around Glitter without leaving the keyboard.",
  Diagnostics: "A quick look at the health of this local app.",
  About: "Version and privacy details for Glitter.",
};

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

function tabIcon(tab: SettingsTab) {
  const props = { size: 15, strokeWidth: 1.8, "aria-hidden": true } as const;
  if (tab === "Agents") return <Bot {...props} />;
  if (tab === "Providers") return <Plug {...props} />;
  if (tab === "Extensions") return <Puzzle {...props} />;
  if (tab === "Threads") return <MessagesSquare {...props} />;
  if (tab === "Usage") return <ChartNoAxesColumn {...props} />;
  if (tab === "Theme") return <Palette {...props} />;
  if (tab === "Models") return <Cpu {...props} />;
  if (tab === "Account") return <KeyRound {...props} />;
  if (tab === "Permissions") return <ShieldCheck {...props} />;
  if (tab === "Shortcuts") return <Command {...props} />;
  if (tab === "Diagnostics") return <Activity {...props} />;
  return <Info {...props} />;
}

/** One setting: its name and help on the left, its control on the right. */
function SettingRow({ label, help, children }: { label: ReactNode; help?: ReactNode; children?: ReactNode }) {
  return <div className="setting-row">
    <div className="setting-copy">{label}{help ? <span className="field-help">{help}</span> : null}</div>
    {children ? <div className="setting-control">{children}</div> : null}
  </div>;
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

function ThemePanel({ draft, onChange }: { draft: Settings; onChange: (patch: Partial<Settings>) => void }) {
  // Only where the window has a material to show: elsewhere there is nothing behind the sidebar.
  const translucent = hasWindowMaterial();
  const [reducedTransparency] = useState(() => translucent && window.matchMedia("(prefers-reduced-transparency: reduce)").matches);
  const thinkingOrb = draft.thinkingOrb ?? "auto";
  const previewState = thinkingOrb === "auto" ? "working" : thinkingOrb;
  const choices: Array<{ id: ThemeMode; label: string; description: string; icon: typeof Monitor }> = [
    { id: "system", label: "System", description: "Match your system", icon: Monitor },
    { id: "light", label: "Light", description: "Bright and crisp", icon: Sun },
    { id: "dark", label: "Dark", description: "Easy on the eyes", icon: Moon },
  ];
  return <div className="theme-panel">
    <section className="theme-section" aria-labelledby="interface-mode-title">
      <div className="settings-card-heading"><h4 id="interface-mode-title">Interface theme</h4><p>Follow your system, or keep Glitter light or dark.</p></div>
      <div className="theme-choice-grid" role="radiogroup" aria-label="Interface mode">
        {choices.map(({ id, label, description, icon: Icon }) => <button key={id} type="button" role="radio" aria-checked={draft.theme === id} className={`theme-choice ${draft.theme === id ? "selected" : ""}`} onClick={() => onChange({ theme: id })}>
          <span className={`theme-preview theme-preview-${id}`} aria-hidden="true"><span className="theme-preview-sidebar"><i /><i /><i /></span><span className="theme-preview-main"><i /><i /><span /><i /></span></span>
          <span className="theme-choice-label">
            <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="theme-choice-copy"><strong>{label}</strong><span>{description}</span></span>
            <span className="choice-check" aria-hidden="true"><Check size={11} strokeWidth={3} /></span>
          </span>
        </button>)}
      </div>
    </section>

    <section className="theme-section" aria-labelledby="accent-color-title">
      <div className="settings-card-heading"><h4 id="accent-color-title">Accent color</h4><p>Used for selections and highlights in both light and dark mode.</p></div>
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
      <div className="settings-card-heading"><h4 id="sidebar-title">Sidebar</h4><p>How the left navigation sits against your desktop and your accent.</p></div>
      <div className="settings-card">
        {translucent ? <SettingRow label={<label htmlFor="sidebar-translucency">Translucency</label>} help={reducedTransparency ? "Off while Reduce transparency is on in System Settings." : "Let your desktop show through the sidebar."}>
          <TranslucencySlider id="sidebar-translucency" value={draft.sidebarTranslucency} disabled={reducedTransparency} onPreview={(value) => applyTheme({ ...draft, sidebarTranslucency: value })} onCommit={(value) => onChange({ sidebarTranslucency: value })} />
        </SettingRow> : null}
        <button type="button" role="switch" aria-checked={draft.accentSidebar} className={`setting-row sidebar-accent-option ${draft.accentSidebar ? "selected" : ""}`} onClick={() => onChange({ accentSidebar: !draft.accentSidebar })}>
          <span className="setting-copy"><strong className="setting-label">Tint the sidebar</strong><span className="field-help">Use the accent color in the left navigation.</span></span>
          <span className="toggle" aria-hidden="true" aria-checked={draft.accentSidebar}><i /></span>
        </button>
      </div>
    </section>

    <section className="theme-section" aria-labelledby="thinking-orb-title">
      <div className="settings-card-heading"><h4 id="thinking-orb-title">Thinking orb</h4><p>Choose the animation shown while Muse thinks. It follows your accent color.</p></div>
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

const PERMISSION_BADGES: Record<CliApprovalMode, string> = {
  onRequest: "Recommended",
  promptUnmatched: "More review",
  denyUnmatched: "Strict",
  allowAll: "No prompts",
};

const PERMISSION_ICONS: Record<CliApprovalMode, ReactNode> = {
  onRequest: <ShieldCheck size={15} aria-hidden="true" />,
  promptUnmatched: <ShieldCheck size={15} aria-hidden="true" />,
  denyUnmatched: <Lock size={15} aria-hidden="true" />,
  allowAll: <TriangleAlert size={15} aria-hidden="true" />,
};

const POSTURE_TOGGLES: Array<{ key: "ephemeralSessions" | "disableWrite" | "disableShell"; label: string; help: string }> = [
  { key: "ephemeralSessions", label: "Ephemeral sessions", help: "Memory-only sessions; nothing persists to the session log." },
  { key: "disableWrite", label: "Disable file writes", help: "Block non-shell workspace filesystem writes." },
  { key: "disableShell", label: "Disable shell execution", help: "Block workspace shell execution, including user shells." },
];

const SANDBOX_NETWORKS: Array<{ value: SandboxNetwork; label: string; description: string }> = [
  { value: "proxy-only", label: "Proxy only", description: "Sandboxed network access through the proxy (CLI default)." },
  { value: "restricted", label: "Restricted", description: "Tighter sandbox network limits." },
  { value: "enabled", label: "Enabled", description: "Full sandbox network access." },
];

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
    <div className="settings-card-heading"><h4>Custom commands</h4><p>Your own prompts in the slash menu. Put $ARGUMENTS where your input goes; the cursor lands there.</p></div>
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
    {Object.keys(overrides).length ? <p className="shortcut-reset-all"><button type="button" className="ghost-btn small" onClick={() => { onChange({}); setProblem(null); setCapturing(null); }}>Reset all shortcuts</button></p> : null}
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
  return <div className="permissions-panel">
    <div className="settings-card-heading"><h4>How should Muse work?</h4><p>Read only, ask first, or auto-review eligible actions — the same choices as the CLI.</p></div>
    <div className="permission-options" role="radiogroup" aria-label="Default permissions for Muse">
      {APPROVAL_ORDER.filter((mode) => mode !== "allowAll").map((mode) => <button key={mode} type="button" role="radio" aria-checked={draft.defaultApprovalMode === mode} className={`permission-option ${draft.defaultApprovalMode === mode ? "selected" : ""}`} onClick={() => onChange({ defaultApprovalMode: mode })}>
        <span className="permission-radio" aria-hidden="true"><i /></span>
        <span className="permission-icon" aria-hidden="true">{PERMISSION_ICONS[mode]}</span>
        <span className="permission-copy"><span><strong>{APPROVAL_LABELS[mode]}</strong><em>{PERMISSION_BADGES[mode]}</em></span><small>{APPROVAL_DESCRIPTIONS[mode]}</small></span>
      </button>)}
    </div>
    <p className="settings-note">This is the default for new threads. Change it per thread from the composer's approval menu, where Unrestricted is also available.</p>
    <div className="settings-card-heading"><h4>How locked down is the host?</h4><p>Posture applies when the connection starts; saving a change restarts it.</p></div>
    <div className="settings-card posture-list">
      {POSTURE_TOGGLES.map((item) => (
        <SettingRow key={item.key} label={<span className="setting-label">{item.label}</span>} help={item.help}>
          <button type="button" role="switch" aria-checked={draft[item.key]} aria-label={item.label} className="toggle" onClick={() => onChange({ [item.key]: !draft[item.key] } as Partial<Settings>)}><i /></button>
        </SettingRow>
      ))}
      <SettingRow label={<label htmlFor="sandbox-network">Sandbox network</label>} help={SANDBOX_NETWORKS.find((item) => item.value === draft.sandboxNetwork)?.description}>
        <SelectMenu id="sandbox-network" ariaLabel="Sandbox network mode" value={draft.sandboxNetwork} placeholder="Network mode" options={SANDBOX_NETWORKS} onChange={(value) => onChange({ sandboxNetwork: value as SandboxNetwork })} />
      </SettingRow>
    </div>
    {draft.ephemeralSessions ? <p className="settings-note" role="status">Ephemeral sessions live in memory only: restarting the connection or closing the app loses them.</p> : null}
  </div>;
}

function postureSummary(posture: HostPosture | null | undefined): string {
  if (!posture) return "—";
  const parts: string[] = [];
  if (posture.ephemeralSessions) parts.push("ephemeral sessions");
  if (posture.disableWrite) parts.push("file writes off");
  if (posture.disableShell) parts.push("shell off");
  if (posture.sandboxNetwork !== "proxy-only") parts.push(`network ${posture.sandboxNetwork}`);
  return parts.length ? parts.join(", ") : "default";
}

function connectionSummary(detection: Detection | null): string {
  if (!detection?.found) return "Muse CLI not detected";
  const version = shortCliVersion(detection.version);
  const prefix = version ? `Muse ${version} · ` : "Muse CLI · ";
  if (!detection.authenticated) return `${prefix}sign in needed`;
  return `${prefix}${detection.activeAuth ? AUTH_SOURCE_SHORT[detection.activeAuth] : "signed in"}`;
}

function cliUpdateSummary(state: { detection: Detection | null; cliUpdate: CliUpdateStatus | null; cliUpdateError: string | null; cliUpdateResult: CliUpdateOutcome | null }): string {
  if (!state.detection?.found) return "Install the Muse CLI to check for updates.";
  if (state.cliUpdateResult?.updated) return `Updated to ${shortCliVersion(state.cliUpdateResult.to)} — reconnect to run on it.`;
  if (state.cliUpdateError) return state.cliUpdateError;
  if (!state.cliUpdate) return "Not checked yet.";
  if (state.cliUpdate.available) {
    return `${shortCliVersion(state.cliUpdate.current) || "unknown"} → ${shortCliVersion(state.cliUpdate.latest)} ready to install.${state.cliUpdate.urgency === "must_download" ? " Required." : ""}`;
  }
  return `Up to date at ${shortCliVersion(state.cliUpdate.current) || shortCliVersion(state.detection.version)}.`;
}

function AuthModePanel({ value, detection, onChange }: { value: AuthMode; detection: Detection | null; onChange: (mode: AuthMode) => void }) {
  const ready: Record<AuthMode, boolean> = {
    auto: Boolean(detection?.subscriptionAvailable || detection?.apiKeyAvailable),
    subscription: Boolean(detection?.subscriptionAvailable),
    apiKey: Boolean(detection?.apiKeyAvailable),
  };
  const status = (mode: AuthMode) => {
    if (mode === "auto") return detection?.activeAuth ? `Using your ${AUTH_SOURCE_LABELS[detection.activeAuth].toLowerCase()}` : "No credential found yet";
    if (ready[mode]) return "Ready";
    return mode === "subscription" ? "Not signed in" : "No key saved";
  };
  return <div className="permission-options" role="radiogroup" aria-label="Muse credential">
    {AUTH_MODE_ORDER.map((mode) => <button key={mode} type="button" role="radio" aria-checked={value === mode} className={`permission-option ${value === mode ? "selected" : ""}`} onClick={() => onChange(mode)}>
      <span className="permission-radio" aria-hidden="true"><i /></span>
      <span className="permission-copy"><span><strong>{AUTH_MODE_LABELS[mode]}</strong><em>{status(mode)}</em></span><small>{AUTH_MODE_DESCRIPTIONS[mode]}</small></span>
    </button>)}
  </div>;
}

function modelKey(model: { modelId: string; providerId?: string }) {
  return JSON.stringify([model.providerId ?? "", model.modelId]);
}

export function SettingsModal() {
  const s = useAppStore(useShallow((state) => ({
    // settingsFields(s) reads the whole Settings slice, so all of it is selected.
    museBin: state.museBin,
    museApiKey: state.museApiKey,
    museAuthMode: state.museAuthMode,
    contributorMode: state.contributorMode,
    ephemeralSessions: state.ephemeralSessions,
    disableWrite: state.disableWrite,
    disableShell: state.disableShell,
    sandboxNetwork: state.sandboxNetwork,
    theme: state.theme,
    accentColor: state.accentColor,
    accentSidebar: state.accentSidebar,
    sidebarTranslucency: state.sidebarTranslucency,
    thinkingOrb: state.thinkingOrb,
    defaultModel: state.defaultModel,
    defaultProviderId: state.defaultProviderId,
    defaultEffort: state.defaultEffort,
    defaultApprovalMode: state.defaultApprovalMode,
    defaultAgentId: state.defaultAgentId,
    enabledAgents: state.enabledAgents,
    acpUnisolatedConsent: state.acpUnisolatedConsent,
    hideAgentCapabilities: state.hideAgentCapabilities,
    notifications: state.notifications,
    workspaces: state.workspaces,
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    selectedWorkspaceId: state.selectedWorkspaceId,
    settingsOpen: state.settingsOpen,
    settingsTab: state.settingsTab,
    preview: state.preview,
    detection: state.detection,
    cliUpdate: state.cliUpdate,
    cliUpdateLoading: state.cliUpdateLoading,
    cliUpdateError: state.cliUpdateError,
    cliUpdating: state.cliUpdating,
    cliUpdateResult: state.cliUpdateResult,
    hostInfo: state.hostInfo,
    hostTrust: state.hostTrust,
    models: state.models,
    loadModelCatalog: state.loadModelCatalog,
    agents: state.agents,
    agentIdentities: state.agentIdentities,
    enterprise: state.enterprise,
    enterpriseLoading: state.enterpriseLoading,
    enterpriseError: state.enterpriseError,
    listSince: state.listSince,
    commitSettings: state.commitSettings,
    refreshDetection: state.refreshDetection,
    refreshCliUpdate: state.refreshCliUpdate,
    updateCli: state.updateCli,
    startHost: state.startHost,
    signOut: state.signOut,
    setSettingsOpen: state.setSettingsOpen,
    refreshAgentIdentities: state.refreshAgentIdentities,
    refreshEnterprise: state.refreshEnterprise,
    confirmAgentBin: state.confirmAgentBin,
    openInitDialog: state.openInitDialog,
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
  const [connecting, setConnecting] = useState(false);
  const [notice, setNotice] = useState("");
  const tab = s.settingsTab;
  const setTab = (next: SettingsTab) => s.setSettingsOpen(true, next);
  const navRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scanning, setScanning] = useState(false);
  const defaultsAgentId = preferredAgent(s);
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
    // Preferences save at once. Host settings stay in the draft until the restart is confirmed.
    const now = Object.fromEntries(Object.entries(patch).filter(([key]) => !needsRestart(key))) as Partial<Settings>;
    if (Object.keys(now).length) void s.commitSettings(now).catch((error) => setNotice(describeError("Could not save settings", error)));
  };
  const changed = (keys: ReadonlyArray<keyof Settings>) => keys.some((key) => settled(draft[key]) !== settled(s[key as keyof typeof s]));
  const dirty = changed(RESTART_KEYS);
  const accountDirty = changed(ACCOUNT_KEYS);
  const visibleTabs = TABS.filter((item) => `${item} ${TAB_LABELS[item] ?? ""} ${TAB_COPY[item]} ${SEARCH_TERMS[item] ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => { bodyRef.current?.scrollTo(0, 0); setSearch(""); }, [tab]);
  const [showKey, setShowKey] = useState(false);
  useModalDialog(s.settingsOpen, dialog);
  // The dialog would otherwise hand focus to its first field, the search box,
  // and greet every opening with a lit text field. The current category is where
  // a keyboard user starts anyway; a mouse user sees no ring on it.
  useEffect(() => {
    if (s.settingsOpen) navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }, [s.settingsOpen]);
  useEffect(() => {
    if (s.settingsOpen) { setDraft(settingsFields(useAppStore.getState())); setNotice(""); setShowKey(false); setSearch(""); }
  }, [s.settingsOpen]);
  useEffect(() => {
    if (s.settingsOpen) navRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [s.settingsOpen, tab, search]);
  const [confirming, setConfirming] = useState<AgentId | null>(null);
  useEffect(() => {
    if (s.settingsOpen && tab === "Agents") void s.refreshAgentIdentities();
    if (s.settingsOpen && tab === "Diagnostics" && !s.preview) void s.refreshEnterprise();
  }, [s.settingsOpen, tab]);
  const defaultModels = modelCatalog.agentId === defaultsAgentId ? modelCatalog.models : [];
  const modelOptions: SelectMenuOption[] = defaultModels.map((model) => ({
    value: modelKey(model),
    label: humanizeModelLabel(model.modelId, model.displayLabel),
    description: humanizeProvider(model.providerId),
  }));
  const selectedDefault = modelFor(defaultModels, { modelId: draft.defaultModel, providerId: draft.defaultProviderId });
  const defaultModelValue = draft.defaultModel ? modelKey(selectedDefault ?? { modelId: draft.defaultModel, providerId: draft.defaultProviderId }) : undefined;
  const modelByKey = new Map(defaultModels.map((model) => [modelKey(model), model]));
  const savedUnlisted = Boolean(draft.defaultModel && !selectedDefault && !modelCatalog.loading && !modelCatalog.error && defaultModels.length);
  if (defaultModelValue && !modelByKey.has(defaultModelValue)) {
    modelOptions.push({ value: defaultModelValue, label: humanizeModelLabel(draft.defaultModel), description: "Saved selection · not in the current catalog" });
  }
  // Smart-suggestions pickers (General tab): the chosen agent's catalog feeds
  // the model list; "Automatic"/"Cheapest" leave the choice to the store.
  const suggestionAgentId = draft.suggestionsAgentId ?? defaultsAgentId;
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
  const suggestModelOptions: SelectMenuOption[] = [
    { value: "", label: "Cheapest available", description: "The lowest-cost model the agent reports" },
    ...suggestModels.filter((model) => !model.unavailable).map((model) => ({
      value: modelKey(model),
      label: humanizeModelLabel(model.modelId, model.displayLabel),
      description: [humanizeProvider(model.providerId), model.cost?.input ? `${model.cost.input}/M in` : ""].filter(Boolean).join(" · "),
    })),
  ];
  const selectedSuggest = modelFor(suggestModels, { modelId: draft.suggestionsModelId });
  const suggestModelValue = draft.suggestionsModelId ? modelKey(selectedSuggest ?? { modelId: draft.suggestionsModelId }) : "";
  const suggestByKey = new Map(suggestModels.map((model) => [modelKey(model), model]));
  if (suggestModelValue && !suggestByKey.has(suggestModelValue)) {
    suggestModelOptions.push({ value: suggestModelValue, label: humanizeModelLabel(draft.suggestionsModelId ?? suggestModelValue), description: "Saved selection · not in the current catalog" });
  }
  const settingsPatch = (): Partial<Settings> => Object.fromEntries(RESTART_KEYS.map((key) => [key, settled(draft[key])]));
  const saveAndClose = async () => {
    setConnecting(true); setNotice("");
    try {
      const before = useAppStore.getState();
      const had = [before.ephemeralSessions, before.disableWrite, before.disableShell, before.sandboxNetwork, before.contributorMode] as const;
      await s.commitSettings(settingsPatch());
      const after = useAppStore.getState();
      // Posture is host-construction: a changed posture restarts the
      // connection so the settings always describe the running host.
      const postureChanged = had[0] !== after.ephemeralSessions || had[1] !== after.disableWrite || had[2] !== after.disableShell || had[3] !== after.sandboxNetwork || had[4] !== after.contributorMode;
      if (postureChanged && !after.preview && after.hostInfo) await after.startHost();
      s.setSettingsOpen(false);
    } catch (error) { setNotice(describeError("Could not save settings", error)); }
    finally { setConnecting(false); }
  };
  const discardAndClose = () => {
    if (connecting) return;
    setNotice("");
    s.setSettingsOpen(false);
  };
  const reconnect = async () => {
    if (s.preview) { setNotice("Preview mode — no live connection. Exit preview in the sidebar to use a real workspace."); return; }
    setConnecting(true); setNotice("");
    try {
      await s.commitSettings(settingsPatch());
      await s.refreshDetection();
      const detection = useAppStore.getState().detection;
      if (!detection?.found) throw new Error("Muse CLI was not found. Install it or set a custom binary path above.");
      if (!detection.authenticated) {
        throw new Error(draft.museAuthMode === "subscription"
          ? "No Muse Code sign-in was found. Use Sign in with Meta above, then try again."
          : draft.museAuthMode === "apiKey"
            ? "No Muse API key was found. Paste one above and try again."
            : "No Muse credential was found. Sign in above, or paste an API key.");
      }
      await s.startHost(true);
      s.setSettingsOpen(false);
    } catch (error) { setNotice(describeError("Could not connect to Muse", error)); }
    finally { setConnecting(false); }
  };
  const allAgents = s.agents.length ? s.agents : AGENT_IDS.map((id): AgentInfo => ({ id, name: AGENT_LABELS[id], protocol: id === "muse" ? "msp" : "acp", found: false, path: null, version: null, verified: id === "muse" || id === "opencode" || id === "grok", signIn: "" }));
  const installedAgents = allAgents.filter((agent) => agent.found);
  const unavailableAgents = allAgents.filter((agent) => !agent.found);
  const readyAgents = installedAgents.filter((agent) => agentEnabled(draft, agent.id) && (agent.id !== "muse" || agent.authenticated));
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
      `Muse CLI: ${s.detection?.version ?? "unknown"}`,
      `CLI path: ${s.detection?.path ?? "not detected"}`,
      `Host running: ${s.detection?.running ? "yes" : "no"}`,
      `Protocol: ${s.hostInfo?.compat ? `${s.hostInfo.compat.state} (SDK ${s.hostInfo.compat.sdk}; served ${s.hostInfo.compat.served ?? "none"})` : "unknown"}`,
      `Granted: ${s.hostInfo?.compat?.granted.join(", ") || "none"}`,
      `Durability: ${s.hostInfo?.durability ?? "unknown"}`,
      `Posture: ${postureSummary(s.hostInfo?.posture)}`,
      `Credential: ${s.detection?.activeAuth ? AUTH_SOURCE_LABELS[s.detection.activeAuth] : "none detected"}`,
      `Workspace: ${workspace?.path ?? "none"}`,
      `Session: ${thread?.sessionId ?? "none"}`,
      `Agent: ${thread?.agentId ?? "muse"}`,
      `Thread state: ${thread?.status ?? "none"}`,
      `Threads in memory: ${s.threads.length}`,
      `Child environment: ${s.hostInfo?.isolation?.env ?? "minimal"}`,
      `OS sandbox: ${s.hostInfo?.isolation ? s.hostInfo.isolation.osSandbox : "unknown — not verifiable on this platform"}`,
      `ACP isolation consent: ${s.acpUnisolatedConsent ? "yes" : "no"}`,
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
  return <dialog ref={dialog} className="modal settings-dialog" aria-labelledby="settings-title" aria-hidden={!s.settingsOpen} onCancel={(event) => { event.preventDefault(); discardAndClose(); }} onClose={() => s.setSettingsOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) discardAndClose(); } }}>
    <nav className="settings-nav" aria-label="Settings categories">
      <div className="settings-brand"><img src="/spark.svg" alt="" width="24" height="24" /><span>Glitter</span></div>
      <h2 id="settings-title">Settings</h2>
      <div className="search-field settings-search"><Search size={13} aria-hidden="true" /><input aria-label="Search settings" placeholder="Find a setting…" value={search} onChange={(event) => setSearch(event.target.value)} />{search ? <button type="button" className="search-clear" aria-label="Clear settings search" onClick={() => setSearch("")}><X size={12} /></button> : null}</div>
      <div ref={navRef} className="settings-nav-groups">
        {NAV_GROUPS.map((group) => {
          const matches = group.tabs.filter((item) => visibleTabs.includes(item));
          return matches.length ? <div className="settings-nav-group" key={group.label}><span className="settings-nav-label">{group.label}</span>{matches.map((item) => <button key={item} type="button" title={TAB_LABELS[item] ?? item} aria-label={item} aria-current={tab === item ? "page" : undefined} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{tabIcon(item)}<span>{TAB_LABELS[item] ?? item}</span></button>)}</div> : null;
        })}
        {!visibleTabs.length ? <p className="settings-search-empty" role="status">No settings found. Try “theme” or “model”.</p> : null}
      </div>
      <div className="settings-version"><span>Glitter</span><span>Desktop {APP_VERSION}</span></div>
    </nav>
    <div className="settings-main">
      <button type="button" className="icon-btn settings-close" aria-label="Close settings" data-tooltip-align="end" data-tooltip="Close" onClick={discardAndClose}><X size={16} /></button>
        <fieldset disabled={connecting} className="settings-fields settings-content">
          <div className="settings-section-head"><div className="settings-column"><h3 id="settings-page-title">{TAB_LABELS[tab] ?? tab}</h3><p>{TAB_COPY[tab]}</p></div></div>
          <div ref={bodyRef} className={`settings-section-body settings-page-${tab.toLowerCase()}`} role="region" aria-labelledby="settings-page-title" tabIndex={0}>
          <div key={tab} className="settings-column settings-page">
        {tab === "Account" ? <>
          <div className="settings-card-heading"><h4>How you connect</h4><p>Choose the credential Muse uses for your sessions.</p></div>
          <AuthModePanel value={draft.museAuthMode} detection={s.detection} onChange={(mode) => edit({ museAuthMode: mode })} />
          {draft.museAuthMode === "subscription" && s.detection?.found && !s.detection.subscriptionAvailable
            ? <><p className="settings-note" role="status">No Muse Code sign-in found. Sign in below, then choose Save &amp; restart connection.</p><LoginPanel /></>
            : <p className="settings-note">Subscription sessions use the sign-in stored by the Muse CLI. Choosing it clears <code>META_API_KEY</code> for the local Muse process so your plan is billed instead of the API.</p>}
          <div className="settings-callout"><RefreshCw size={14} aria-hidden="true" /><div><strong>When is a connection restart needed?</strong><span>After changing the credential, the API key, the binary path, Contributor mode under Models, or the sandbox settings under Permissions. Other preferences save as you change them. Save &amp; restart connection briefly restarts the local Muse process so it uses these values. It does not restart the app or delete threads.</span></div></div>
          <div className="settings-card-heading"><h4>Connection details</h4><p>Manage your API key and local Muse installation.</p></div>
          <section className="settings-card" aria-label="Connection details">
          <SettingRow label={<label htmlFor="muse-api-key">Muse API key</label>} help="Saved in your system credential store. A saved key appears as dots and is never returned to the interface. Replace the dots to change it, or clear the field to remove it."><div className="input-with-action"><input id="muse-api-key" type={showKey ? "text" : "password"} value={draft.museApiKey} placeholder="Paste API key to connect" autoComplete="off" spellCheck={false} onFocus={(event) => event.currentTarget.select()} onChange={(event) => edit({ museApiKey: event.target.value })} /><button type="button" className="icon-btn input-action" aria-label={showKey ? "Hide API key" : "Show API key"} aria-pressed={showKey} title={showKey ? "Hide API key" : "Show API key"} onClick={() => setShowKey(!showKey)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></SettingRow>
          <SettingRow label={<label htmlFor="muse-bin">Muse binary (optional)</label>} help="Full path to a muse executable. Temporary directories are rejected."><input id="muse-bin" value={draft.museBin} placeholder="Auto-detect from PATH" spellCheck={false} onChange={(event) => edit({ museBin: event.target.value })} /></SettingRow>
          {s.detection?.authenticated ? <SettingRow label={<span className="setting-label">Sign out</span>} help="Removes the CLI credential and the API key stored on this device, and closes open sessions."><button type="button" className="secondary small danger" disabled={connecting} onClick={() => { void s.confirm({ title: "Sign out of Muse on this device?", body: "The saved credential and API key are removed and open sessions close.", confirmLabel: "Sign out", danger: true }).then((ok) => { if (ok) { setConnecting(true); setNotice(""); void s.signOut().then(() => { setDraft((prev) => ({ ...prev, museApiKey: "" })); setNotice("Signed out. Sign in again to reconnect."); }).catch((error) => setNotice(describeError("Could not sign out", error))).finally(() => setConnecting(false)); } }); }}>Sign out of Muse</button></SettingRow> : null}
          </section>
        </> : null}
        {tab === "General" ? <section className="settings-card" aria-label="General">
          <SettingRow label={<label htmlFor="editor-choice">Open files in</label>} help="Used by Open file in Changes, Files and the task monitor. An editor that is not installed reports an error instead of opening.">
            <SelectMenu id="editor-choice" ariaLabel="Open files in" value={draft.editor ?? "default"} placeholder="System default" options={EDITOR_CHOICES.map((id) => ({ value: id, label: EDITOR_LABELS[id] }))} onChange={(value) => edit({ editor: value as EditorChoice })} />
          </SettingRow>
          <SettingRow label={<span id="notifications-label" className="setting-label">Notifications</span>} help="Notify when a turn finishes or needs approval while you're elsewhere.">
            <button type="button" role="switch" aria-labelledby="notifications-label" aria-checked={s.notifications !== false} className="toggle" onClick={() => void s.commitSettings({ notifications: !(s.notifications !== false) })}><i /></button>
          </SettingRow>
          <SettingRow label={<span id="suggestions-label" className="setting-label">Smart suggestions</span>} help="On a new thread's empty state, the chosen agent predicts what to do next from file names, branch, and thread titles — file contents are never sent. It runs at most once a minute per workspace, on the provider's normal usage.">
            <button type="button" role="switch" aria-labelledby="suggestions-label" aria-checked={draft.suggestionsEnabled === true} className="toggle" onClick={() => edit({ suggestionsEnabled: !draft.suggestionsEnabled })}><i /></button>
          </SettingRow>
          {draft.suggestionsEnabled ? <>
            <SettingRow label={<label htmlFor="suggestions-agent">Suggestion agent</label>}>
              <SelectMenu id="suggestions-agent" ariaLabel="Suggestion agent" value={draft.suggestionsAgentId ?? ""} placeholder="Automatic" options={[
                { value: "", label: "Automatic", description: "Your default ready agent" },
                ...readyAgents.map((agent) => ({ value: agent.id, label: agent.name })),
              ]} onChange={(value) => edit({ suggestionsAgentId: (value || undefined) as AgentId | undefined, suggestionsModelId: undefined })} />
            </SettingRow>
            <SettingRow label={<label htmlFor="suggestions-model">Suggestion model</label>} help={suggestCatalog.error ?? undefined}>
              <SelectMenu id="suggestions-model" ariaLabel="Suggestion model" value={suggestModelValue} placeholder={suggestCatalog.loading ? "Loading models…" : "Cheapest available"} options={suggestModelOptions} disabled={suggestCatalog.loading} onChange={(value) => { const model = suggestByKey.get(value); if (model) edit({ suggestionsModelId: model.modelId }); else if (!value) edit({ suggestionsModelId: undefined }); }} />
            </SettingRow>
          </> : null}
        </section> : null}
        {tab === "General" ? <CustomCommandsCard commands={draft.customCommands ?? []} onChange={(customCommands) => edit({ customCommands })} /> : null}
        {tab === "Theme" ? <ThemePanel draft={draft} onChange={edit} /> : null}
        {tab === "Models" ? <>
          <div className="settings-card-heading with-action"><div><h4>New thread defaults</h4><p>Models from {AGENT_LABELS[defaultsAgentId]} for new threads. You can adjust these in the composer.</p></div><button type="button" className="ghost-btn small" aria-label="Refresh default models" disabled={modelCatalog.loading} onClick={() => setCatalogRefresh((value) => value + 1)}><RefreshCw size={11} className={modelCatalog.loading ? "spin" : ""} aria-hidden="true" />Refresh</button></div>
          {modelCatalog.error ? <p className="settings-note" role="alert">{modelCatalog.error} Refresh the list or check the connection under Account.</p> : modelCatalog.loading ? <p className="settings-note" role="status">Loading {AGENT_LABELS[defaultsAgentId]} models…</p> : !defaultModels.length ? <p className="settings-note" role="status">{AGENT_LABELS[defaultsAgentId]} did not report any models.</p> : null}
          <section className="settings-card" aria-label="New thread defaults">
          <SettingRow label={<label htmlFor="default-model">Default model</label>} help={<>{savedUnlisted ? <span>This saved model is no longer listed. Choose a current model; subscriber Contributor mode applies separately. </span> : null}{draft.defaultModel ? <button className="text-btn" type="button" onClick={() => edit({ defaultModel: "", defaultProviderId: undefined })}>Use host default</button> : "New threads start on the host's default model."}</>}><SelectMenu id="default-model" ariaLabel="Default model" value={defaultModelValue} placeholder={modelCatalog.loading ? "Loading models…" : defaultModels.length ? "Use host default" : "Connect to load models"} options={modelOptions} disabled={modelCatalog.loading || !defaultModels.length} onChange={(value) => { const model = modelByKey.get(value); if (model) edit({ defaultModel: model.modelId, defaultProviderId: model.providerId }); }} /></SettingRow>
          <SettingRow label={<label htmlFor="default-effort">Default reasoning effort</label>} help="Higher effort gives the model more time on complex tasks. Lower effort suits quick edits and everyday questions."><SelectMenu id="default-effort" ariaLabel="Default reasoning effort" value={draft.defaultEffort} placeholder="Use host default" options={EFFORTS.map((effort) => ({ value: effort, label: EFFORT_LABELS[effort] }))} onChange={(value) => edit({ defaultEffort: value as ReasoningEffort })} /></SettingRow>
          </section>
          <div className="settings-card-heading"><h4>Muse subscription</h4><p>Contributor mode is a setting, separate from the model you choose.</p></div>
          <section className="settings-card" aria-label="Muse subscription model routing">
            <SettingRow label={<label htmlFor="contributor-mode">Contributor mode</label>} help="Eligible subscribers get more usage when Meta may use their content to train models. Standard mode turns this off. Save & restart connection to apply; leaving the CLI preference selected preserves your existing choice.">
              <SelectMenu id="contributor-mode" ariaLabel="Contributor mode" value={draft.contributorMode ?? "default"} placeholder="Use Muse CLI preference" options={[
                { value: "default", label: "Use Muse CLI preference", description: "Preserve the setting in Muse Code" },
                { value: "off", label: "Standard mode", description: "Turn Contributor routing off for this app" },
                { value: "on", label: "Contributor mode", description: "More subscription usage; content may be used to train models", disabled: draft.museAuthMode === "apiKey" || !s.detection?.subscriptionAvailable },
              ]} onChange={(value) => edit({ contributorMode: value === "on" || value === "off" ? value : undefined })} />
            </SettingRow>
          </section>
        </> : null}
        {tab === "Agents" ? <div className="agents-panel">
          <div className="settings-card-heading with-action"><div><h4>Installed agents</h4><p>Shown agents appear in the composer. Hiding an agent also hides its threads in the sidebar — an open thread stays open — and they return when you show the agent again. At least one ready agent stays enabled.</p></div><button type="button" className="ghost-btn small" disabled={scanning} onClick={() => { setScanning(true); void s.refreshDetection().finally(() => setScanning(false)); }}><RefreshCw size={11} className={scanning ? "spin" : ""} />{scanning ? "Scanning…" : "Rescan"}</button></div>
          <label className="settings-callout isolation-consent">
            <input type="checkbox" checked={draft.acpUnisolatedConsent === true} onChange={(event) => {
              const acpUnisolatedConsent = event.target.checked;
              const enabledAgents = acpUnisolatedConsent ? draft.enabledAgents : { ...DEFAULT_ENABLED_AGENTS, ...draft.enabledAgents, opencode: false, grok: false, gemini: false, qwen: false, goose: false, cline: false };
              edit({ acpUnisolatedConsent, enabledAgents, ...(acpUnisolatedConsent || draft.defaultAgentId === "muse" || !draft.defaultAgentId ? {} : { defaultAgentId: undefined }) });
            }} />
            <span>Third-party agents are <strong>not OS-sandboxed</strong>. They inherit a minimal environment and the selected workspace, but can still read this account. I understand and want to enable them.</span>
          </label>
          <ul className="agent-list">
            {installedAgents.map((agent) => {
              const on = agentEnabled(draft, agent.id);
              const ready = (agent.id !== "muse" && agent.id !== "harness") || agent.authenticated;
              const lastOn = on && ready && readyAgents.length <= 1;
              // The built-in harness is the app's own code: only third-party CLIs need the isolation consent.
              const needsConsent = agent.protocol === "acp" && !on && !draft.acpUnisolatedConsent;
              const locked = lastOn || needsConsent;
              const gated = needsConsent ? "Accept the isolation notice above to show this agent" : lastOn ? "Keep at least one ready agent enabled" : null;
              const identity = agent.id === "muse" ? undefined : s.agentIdentities.find((item) => item.agentId === agent.id);
              return <li key={agent.id} className={on ? "" : "off"}>
                <AgentMark id={agent.id} size={26} />
                <span className="model-copy">
                  <span className="model-name">{agent.name}{agent.version ? <span className="picker-tag">v{agent.version}</span> : null}{!agent.verified ? <span className="picker-tag">Experimental</span> : null}{identity?.changed ? <span className="picker-tag warm">Binary changed</span> : null}</span>
                  <span className="model-meta">{ready ? needsConsent ? "Hidden — accept the isolation notice above to enable" : on ? "Available in the composer" : "Hidden — its threads are hidden too" : agent.signIn || "Sign in required"}</span>
                  {identity?.path ? <span className="model-meta identity-path" title={identity.path}>{identity.path}</span> : null}
                  {identity?.changed ? <span className="model-meta identity-changed">This binary moved or changed since it was trusted. Review the path, then <button type="button" className="text-btn" disabled={confirming === agent.id} onClick={() => { setConfirming(agent.id); setNotice(""); void s.confirmAgentBin(agent.id).then(() => setNotice(`${agent.name} binary trusted.`)).catch((error) => setNotice(describeError(`Could not trust the ${agent.name} binary`, error))).finally(() => setConfirming(null)); }}>{confirming === agent.id ? "Trusting…" : "trust this binary"}</button>.</span> : null}
                </span>
                <span className={`agent-state ${!ready ? "warn" : on ? "on" : "off"}`}>{!ready ? agent.id === "harness" ? "Needs a key" : "Sign in" : on ? "Ready" : "Hidden"}</span>
                <span className="toggle-anchor" title={gated ?? (on ? `Hide ${agent.name} and its threads` : `Show ${agent.name} and its threads`)}>
                  <button type="button" role="switch" aria-checked={on} aria-label={`${on ? "Hide" : "Show"} ${agent.name} and its threads`} className="toggle" disabled={locked} onClick={() => {
                    const enabledAgents = { ...DEFAULT_ENABLED_AGENTS, ...draft.enabledAgents, [agent.id]: !on };
                    edit({ enabledAgents, ...(on && draft.defaultAgentId === agent.id ? { defaultAgentId: undefined } : {}) });
                  }}><i /></button>
                </span>
              </li>;
            })}
            {!installedAgents.length ? <li className="missing"><span className="model-meta">No supported coding agents found</span></li> : null}
          </ul>
          <div className="settings-card-heading"><h4>Defaults</h4></div>
          <div className="settings-card">
          <section className="agent-default-section" aria-labelledby="default-agent-title"><div><h4 id="default-agent-title">Default for new threads</h4><p>Automatic uses the first ready agent.</p></div><div className="agent-default-options" role="radiogroup" aria-label="Default agent for new threads"><button type="button" role="radio" aria-checked={!draft.defaultAgentId} className={!draft.defaultAgentId ? "selected" : ""} onClick={() => edit({ defaultAgentId: undefined })}>Automatic</button>{readyAgents.map((agent) => <button key={agent.id} type="button" role="radio" aria-checked={draft.defaultAgentId === agent.id} className={draft.defaultAgentId === agent.id ? "selected" : ""} onClick={() => edit({ defaultAgentId: agent.id as AgentId })}><AgentMark id={agent.id} size={16} />{agent.name}</button>)}</div></section>
          <section className="agent-default-section" aria-labelledby="workspace-config-title">
            <div><h4 id="workspace-config-title">Workspace agent config</h4><p>{workspace ? `Create or refresh AGENTS.md in ${workspace.name}.` : "Open a workspace to set up its AGENTS.md."}</p></div>
            <button type="button" className="ghost-btn small" disabled={!workspace?.grantId} title={workspace?.grantId ? "Preview and write AGENTS.md" : "This workspace has no access grant"} onClick={() => { s.setSettingsOpen(false); if (workspace) void s.openInitDialog(workspace.id); }}>
              <FilePlus size={11} />Set up AGENTS.md
            </button>
          </section>
          </div>
          {unavailableAgents.length ? <details className="unavailable-agents"><summary>Not installed ({unavailableAgents.length})</summary><ul>{unavailableAgents.map((agent) => <li key={agent.id}><AgentMark id={agent.id} size={20} /><span>{agent.name}</span>{!agent.verified ? <span className="picker-tag">Experimental</span> : null}</li>)}</ul></details> : null}
        </div> : null}
        {tab === "Threads" ? <div className="archive-panel">
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
          <div className="settings-card-heading with-action">
            <div><h4>Archived threads</h4><p>Hidden from the sidebar. Restore them here, or delete them from this app. Deleting does not erase the session on the agent CLI.</p></div>
            {s.threads.some((thread) => thread.archived) ? (
              <button
                type="button"
                className="ghost-btn small"
                onClick={() => {
                  const count = s.threads.filter((thread) => thread.archived).length;
                  void s.confirm({ title: `Delete ${count} archived thread${count === 1 ? "" : "s"} from Glitter?`, body: ["They are removed from Glitter. The sessions stay on the agent CLI and cannot be brought back into this list.", worktreeRemovalNote(s.threads, s.threads.filter((thread) => thread.archived).map((thread) => thread.sessionId))].filter(Boolean).join(" "), confirmLabel: "Delete all", danger: true }).then((ok) => {
                    if (!ok) return;
                    for (const thread of s.threads.filter((item) => item.archived)) s.deleteThread(thread.sessionId);
                  });
                }}
              >
                <Trash2 size={11} />Delete all
              </button>
            ) : null}
          </div>
          <ul className="archive-list">
            {s.threads.filter((thread) => thread.archived).slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map((thread) => {
              const workspace = s.workspaces.find((item) => item.path === thread.workspacePath);
              return (
                <li key={thread.sessionId}>
                  {thread.agentId ? <AgentMark id={thread.agentId} size={22} /> : <AgentMark id="muse" size={22} />}
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
            {!s.threads.some((thread) => thread.archived) ? <li className="missing"><ArchiveRestore size={25} aria-hidden="true" /><span><strong>All caught up</strong><span className="model-meta">Archived threads will appear here. Your active threads are in the sidebar.</span></span></li> : null}
          </ul>
        </div> : null}
        {tab === "Providers" ? <ProvidersPanel onChanged={() => { void s.refreshDetection().then(() => useAppStore.getState().refreshModels(true)); }} /> : null}
        {tab === "Extensions" ? <Suspense fallback={null}><ExtensionsView embedded /></Suspense> : null}
        {tab === "Usage" ? <Suspense fallback={null}><UsageView embedded /></Suspense> : null}
        {tab === "Permissions" ? <PermissionsPanel draft={draft} onChange={edit} /> : null}
        {tab === "Shortcuts" ? <ShortcutsPanel overrides={draft.shortcutOverrides ?? {}} onChange={(shortcutOverrides) => edit({ shortcutOverrides })} /> : null}
        {tab === "Diagnostics" ? <div className="diagnostics">
          <p className="muted" title={s.detection?.path ?? undefined}>{s.preview ? "Preview mode — commands unavailable" : connectionSummary(s.detection)}</p>
          <p className="muted"><span className="diagnostic-label">Muse CLI</span><span className="diagnostic-value">{s.detection?.version ?? "unknown"}{s.detection?.path ? ` (${s.detection.path})` : ""}</span></p>
          <p className="muted"><span className="diagnostic-label">Host running</span><span className="diagnostic-value">{s.detection?.running ? "yes" : "no"}</span></p>
          <p className="muted" title={s.hostInfo?.compat ? `SDK pins ${s.hostInfo.compat.pinned}; host served ${s.hostInfo.compat.served ?? "no fingerprint"}` : undefined}><span className="diagnostic-label">Protocol</span><span className="diagnostic-value">{s.hostInfo?.compat ? s.hostInfo.compat.state === "match" ? `match (SDK ${s.hostInfo.compat.sdk})` : s.hostInfo.compat.state === "mismatch" ? `mismatch — host print differs from SDK ${s.hostInfo.compat.sdk} pin` : "unknown — host sent no fingerprint" : "unknown — start the host to check"}</span></p>
          <p className="muted"><span className="diagnostic-label">Granted</span><span className="diagnostic-value">{s.hostInfo?.compat ? (s.hostInfo.compat.granted.length ? s.hostInfo.compat.granted.join(", ") : "none") : "—"}</span></p>
          <p className="muted"><span className="diagnostic-label">Durability</span><span className="diagnostic-value">{s.hostInfo?.durability ?? "—"}</span></p>
          <p className="muted" title="Host-construction flags: ephemeral sessions, write/shell hardening, sandbox network mode"><span className="diagnostic-label">Posture</span><span className="diagnostic-value">{postureSummary(s.hostInfo?.posture)}</span></p>
          <p className="muted" title={s.enterprise?.generation ?? undefined}><span className="diagnostic-label">Enterprise</span><span className="diagnostic-value">{s.enterpriseLoading ? "reading…" : s.enterpriseError ? `unavailable — ${s.enterpriseError}` : s.enterprise?.generation ? `generation ${shortHash(s.enterprise.generation)}` : "no managed configuration"}{s.enterprise && !s.enterpriseLoading && !s.enterpriseError ? ` · ${s.enterprise.sources.filter((source) => source.state !== "absent").length} of ${s.enterprise.sources.length} planes active` : ""}</span></p>
          {s.enterprise && !s.enterpriseLoading && !s.enterpriseError && s.enterprise.sources.some((source) => source.state !== "absent") ? <p className="muted"><span className="diagnostic-label">Active planes</span><span className="diagnostic-value">{s.enterprise.sources.filter((source) => source.state !== "absent").map((source) => `${source.plane}/${source.sourceClass}`).join(", ")}</span></p> : null}
          <p className="muted" title="Trusted hosts load the selected workspace's skills and rules"><span className="diagnostic-label">Workspace trust</span><span className="diagnostic-value">{s.hostInfo == null ? (workspace?.grantId ? "" : "—") : (s.hostTrust ?? s.hostInfo.trustWorkspace) ? "trusted — skills and rules load" : "untrusted — skills and rules do not load"}{workspace?.grantId ? <>{s.hostInfo == null ? null : " · "}<button type="button" className="text-btn" onClick={() => { if (workspace.trusted) { void s.confirm({ title: `Stop trusting ${workspace.name}?`, body: "Its skills and rules will no longer load.", confirmLabel: "Stop trusting", danger: true }).then((ok) => { if (ok) void s.untrustWorkspace(workspace.id); }); } else { void s.openTrustDialog(workspace.id); } }}>{workspace.trusted ? "untrust" : "trust this workspace"}</button></> : null}</span></p>
          <p className="muted" title={workspace?.path}><span className="diagnostic-label">Workspace</span><span className="diagnostic-value">{workspace?.name ?? "none open"}</span></p>
          <p className="muted" title={thread?.sessionId}><span className="diagnostic-label">Session</span><span className="diagnostic-value">{thread ? `${thread.title} · ${thread.status}` : "none open"}</span></p>
          <p className="muted"><span className="diagnostic-label">Agent</span><span className="diagnostic-value">{thread ? AGENT_LABELS[thread.agentId ?? "muse"] : "none"}</span></p>
          <p className="muted" title={s.hostInfo?.isolation?.cwd}><span className="diagnostic-label">Child environment</span><span className="diagnostic-value">{s.hostInfo?.isolation?.env ?? "minimal"} · OS sandbox: {s.hostInfo?.isolation ? `${s.hostInfo.isolation.osSandbox} (${s.hostInfo.isolation.platform})` : "unknown — not verifiable until the host starts"}</span></p>
          <p className="muted"><span className="diagnostic-label">ACP isolation consent</span><span className="diagnostic-value">{s.acpUnisolatedConsent ? "yes — third-party agents may start" : "no — third-party agents stay off"}</span></p>
          <p className="muted"><span className="diagnostic-label">Workspaces</span><span className="diagnostic-value">{s.workspaces.length}</span></p>
          <p className="muted"><span className="diagnostic-label">Threads in memory</span><span className="diagnostic-value">{s.threads.length}</span></p>
          <div className="row">
            <button type="button" className="ghost-btn small" onClick={() => void copyDiagnostics()}>Copy diagnostics</button>
            {isTauri() ? <button type="button" className="ghost-btn small" onClick={() => void openLogFolder().then((path) => setNotice(`Opened logs. Current file: ${path}`)).catch((error) => setNotice(describeError("Could not open the log folder", error)))}><FolderOpen size={11} />Open logs</button> : null}
          </div>
        </div> : null}
        {tab === "About" ? <div className="about">
            <div className="settings-card">
              <div className="about-identity"><span className="about-mark"><img src="/spark.svg" alt="" /></span><div><h4>Glitter</h4><span className="about-version" title={s.detection?.path ?? undefined}>Desktop {APP_VERSION} · Muse CLI {s.detection?.version ? shortCliVersion(s.detection.version) : "not detected"}</span></div></div>
              <SettingRow label={<span className="setting-label">CLI updates</span>} help={cliUpdateSummary(s)}>
                {s.cliUpdate?.available ? <button type="button" className="primary accent" disabled={s.cliUpdating || s.cliUpdateLoading} onClick={() => void s.updateCli()}>{s.cliUpdating ? "Updating…" : `Update to ${shortCliVersion(s.cliUpdate.latest)}`}</button> : null}
              <button type="button" className="ghost-btn small" disabled={s.cliUpdateLoading || s.cliUpdating || !s.detection?.found} onClick={() => void s.refreshCliUpdate(true)}>{s.cliUpdateLoading ? "Checking…" : "Check for updates"}</button>
              </SettingRow>
            </div>
            <div className="settings-card-heading"><h4>Your local coding companion</h4></div>
            <p>Independent local command center for coding agents. Not affiliated with Meta.</p>
            <div className="settings-card-heading"><h4>Privacy &amp; your data</h4></div>
            <p>Muse stays the engine. This app is a GUI over your installed CLI: it sends prompts and workspace context to the local Muse process, which in turn uses its configured model service under that provider&apos;s data policy.</p>
          </div> : null}
          </div>
          </div>
        </fieldset>
        {notice ? <p className="settings-notice" role="status">{notice}</p> : null}
        <footer className="settings-footer">
          <span className="settings-connection" title={s.detection?.path ?? undefined}><i className={s.detection?.found ? "connected" : ""} />{s.preview ? "Preview mode" : connectionSummary(s.detection)}</span>
          <div className="row">
            <span className="settings-save-status" role="status">{dirty ? "Restart the connection to apply these changes" : READ_ONLY_TABS.includes(tab) ? "" : "Changes save as you make them"}</span>
            {dirty ? <button className="ghost-btn" disabled={connecting} onClick={discardAndClose}>Cancel</button> : null}
            {/* Done stays the primary button on every tab; a restart with nothing
                to save is an extra, secondary action on Account. */}
            {!dirty && tab === "Account" ? <button className="secondary" disabled={connecting} onClick={() => void reconnect()}>{connecting ? "Restarting…" : "Restart connection"}</button> : null}
            {accountDirty || (dirty && tab === "Account")
              ? <button className="primary accent" disabled={connecting} onClick={() => void reconnect()}>{connecting ? "Restarting…" : dirty ? "Save & restart connection" : "Restart connection"}</button>
              : dirty ? <button className="primary accent" disabled={connecting} onClick={() => void saveAndClose()}>{connecting ? "Restarting…" : "Save & restart connection"}</button>
              : <button className="primary accent" disabled={connecting} onClick={discardAndClose}>Done</button>}
          </div>
        </footer>
      </div>
  </dialog>;
}
