import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "../lib/store";
import { motionReduced } from "../lib/presence";
import { ORCHESTRATOR_GOAL_COPY } from "../lib/orchestrator";
import desktopPackage from "../../package.json";

vi.mock("./Orb", () => ({ Orb: ({ state, size }: { state: string; size: number }) => <span data-testid={`orb-${size}`} data-state={state} /> }));
const diagnostics = vi.hoisted(() => ({ snapshot: vi.fn() }));
vi.mock("../lib/bridge", async (original) => ({ ...(await original<typeof import("../lib/bridge")>()), diagnosticsSnapshot: diagnostics.snapshot }));
// jsdom is not the desktop window; a test turns the window material on to see the controls that depend on it.
const material = vi.hoisted(() => ({ on: false }));
vi.mock("../lib/store", async (original) => ({ ...(await original<typeof import("../lib/store")>()), hasWindowMaterial: () => material.on }));

describe("settings navigation", () => {
  beforeEach(() => {
    resetStore();
    delete document.documentElement.dataset.motion;
    delete document.documentElement.dataset.sidebarDensity;
    Element.prototype.scrollTo = vi.fn();
    material.on = false;
    diagnostics.snapshot.mockReset();
    vi.unstubAllGlobals();
    seedStore({ settingsOpen: true, preview: true, theme: "light" });
  });

  it("titles the usage page Usage stats, with the app scope beside it", () => {
    seedStore({ settingsTab: "Usage" });
    render(<SettingsModal />);
    expect(screen.getByRole("heading", { name: "Usage stats" })).toBeInTheDocument();
    expect(screen.getByText("App usage")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Usage stats" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usage" })).toHaveAttribute("aria-current", "page");
  });

  it("puts the usage actions beside the page heading, not at the foot", async () => {
    seedStore({ settingsTab: "Usage" });
    render(<SettingsModal />);
    const refreshUsage = await screen.findByRole("button", { name: "Refresh usage" });
    const clearHistory = screen.getByRole("button", { name: "Clear history" });
    expect(refreshUsage.parentElement).toHaveClass("usage-page-actions");
    expect(clearHistory.parentElement).toHaveClass("usage-page-actions");
    expect(refreshUsage.closest(".settings-section-head")).not.toBeNull();
    expect(refreshUsage.closest(".usage-scroll")).toBeNull();
  });

  it("remembers the last tab after closing and remounting, with explicit links taking precedence", () => {
    const view = render(<SettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: "About" }));
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(useAppStore.getState().settingsOpen).toBe(false);
    view.unmount();
    act(() => useAppStore.getState().setSettingsOpen(true));
    render(<SettingsModal />);
    expect(screen.getByRole("region", { name: "About" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "about" } });
    act(() => useAppStore.getState().setSettingsOpen(true, "Threads"));
    expect(screen.getByRole("region", { name: "Threads" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Threads" })).toHaveAttribute("aria-current", "page");
  });

  it("copies app version, platform, and recent redacted log lines with diagnostics", async () => {
    seedStore({ settingsTab: "Diagnostics" });
    diagnostics.snapshot.mockResolvedValue({ os: "macOS", arch: "arm64", logTail: ["100\tinfo\tbridge.stderr\tconnected", "101\twarn\tgit.push\tfailed"] });
    let copied = "";
    const writeText = vi.fn(async (text: string) => { copied = text; });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<SettingsModal />);

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    expect(copied.startsWith(`Glitter ${desktopPackage.version}\nOS: macOS arm64\n`)).toBe(true);
    expect(copied).toContain("Recent log (last 2 lines, redacted):");
    expect(copied).toContain("100\tinfo\tbridge.stderr\tconnected");
    expect(copied).toContain("101\twarn\tgit.push\tfailed");
    expect(await screen.findByText("Diagnostics copied, including recent redacted log lines. Credentials are removed; review before sharing.")).toBeInTheDocument();
  });

  it("still copies the non-log diagnostics when the native snapshot fails", async () => {
    seedStore({ settingsTab: "Diagnostics" });
    diagnostics.snapshot.mockRejectedValue(new Error("log read failed"));
    let copied = "";
    const writeText = vi.fn(async (text: string) => { copied = text; });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<SettingsModal />);

    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    expect(copied).toContain("OS: unknown");
    expect(copied).toContain("Recent log: unavailable (log read failed)");
  });

  it("saves a preference at once and keeps it after the dialog closes", async () => {
    seedStore({ settingsTab: "Theme", theme: "light" });
    const view = render(<SettingsModal />);
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    await vi.waitFor(() => expect(useAppStore.getState().theme).toBe("dark"));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByText("Changes save as you make them")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    view.unmount();
    expect(useAppStore.getState().theme).toBe("dark");
  });

  it("adds and removes a built-in agent rule from Permissions", async () => {
    seedStore({ settingsTab: "Permissions", harnessRules: [] });
    render(<SettingsModal />);
    fireEvent.change(screen.getByRole("textbox", { name: "Add a rule to Never allow" }), { target: { value: "Edit(.env)" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule to Never allow" }));
    await vi.waitFor(() => expect(useAppStore.getState().harnessRules).toEqual([{ effect: "deny", rule: "Edit(.env)" }]));
    fireEvent.click(screen.getByRole("button", { name: "Remove Edit(.env) from Never allow" }));
    await vi.waitFor(() => expect(useAppStore.getState().harnessRules).toEqual([]));
  });

  it("lets the user turn the Terminal pane off without changing agent permissions", () => {
    seedStore({ settingsTab: "Permissions", disableTerminal: false, defaultApprovalMode: "onRequest" });
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("switch", { name: "Disable Terminal pane" }));
    expect(useAppStore.getState().disableTerminal).toBe(true);
    expect(useAppStore.getState().defaultApprovalMode).toBe("onRequest");
  });



  it("loads the defaults catalog independently of the open thread and labels a saved legacy model", async () => {
    const catalog = [
      { modelId: "anthropic/claude-opus-5", providerId: "anthropic", displayLabel: "Claude Opus 5" },
      { modelId: "anthropic/claude-sonnet-5", providerId: "anthropic", displayLabel: "Claude Sonnet 5" },
      { modelId: "anthropic/claude-haiku-4-5", providerId: "anthropic", displayLabel: "Claude Haiku 4.5" },
    ];
    const loadModelCatalog = vi.fn(async () => catalog);
    seedStore({ settingsTab: "Models", defaultModel: "anthropic/claude-sonnet-3", models: [{ modelId: "xai/grok-4.7", providerId: "xai" }], loadModelCatalog, agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }] });
    render(<SettingsModal />);
    const model = screen.getByRole("button", { name: "Default model" });
    await vi.waitFor(() => expect(model).toBeEnabled());
    expect(loadModelCatalog).toHaveBeenCalledWith("harness");
    expect(screen.getByText(/This saved model is no longer listed/)).toBeInTheDocument();
    expect(useAppStore.getState().defaultModel).toBe("anthropic/claude-sonnet-3");
    fireEvent.click(model);
    const list = screen.getByRole("listbox", { name: "Default model" });
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    expect(within(list).queryByText("grok-4.7")).toBeNull();
    expect(within(list).getByText("Saved selection · not in the current catalog")).toBeInTheDocument();
    fireEvent.click(within(list).getByText("Claude Opus 5", { exact: true }));
    await vi.waitFor(() => expect(useAppStore.getState().defaultModel).toBe("anthropic/claude-opus-5"));
    expect(useAppStore.getState().models.map((item) => item.modelId)).toEqual(["xai/grok-4.7"]);
  });

  it("keeps providers and models switched off in the library out of the default model list", async () => {
    seedStore({
      settingsTab: "Models",
      agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }],
      hiddenModels: ["harness|anthropic|anthropic/claude-haiku-4-5"],
      hiddenProviders: ["harness:kilo"],
    });
    render(<SettingsModal />);
    const model = screen.getByRole("button", { name: "Default model" });
    await vi.waitFor(() => expect(model).toBeEnabled());
    fireEvent.click(model);
    const list = within(screen.getByRole("listbox", { name: "Default model" }));
    expect(list.getByText("Claude Sonnet 5", { exact: true })).toBeInTheDocument();
    expect(list.queryByText("Claude Haiku 4.5")).toBeNull();
    expect(list.queryByText("anthropic/claude-sonnet-4.6")).toBeNull();
  });

  it("shows a catalog error instead of presenting the saved model as the only available choice", async () => {
    seedStore({ settingsTab: "Models", defaultModel: "anthropic/claude-sonnet-3", loadModelCatalog: vi.fn(async () => { throw new Error("Connection closed"); }) });
    render(<SettingsModal />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Connection closed");
    expect(screen.getByRole("button", { name: "Default model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh default models" })).toBeEnabled();
  });

  it("keeps Harness provider setup errors specific", async () => {
    const detail = "Harness has no model provider yet. Add an API key in Settings → Providers.";
    const peekModelCatalog = vi.fn(async () => []);
    seedStore({
      settingsTab: "Models",
      agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }],
      loadModelCatalog: vi.fn(async () => { throw new Error(detail); }),
      peekModelCatalog,
    });
    render(<SettingsModal />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Could not load Harness models: ${detail}`);
    expect(alert).not.toHaveTextContent("Nothing was sent");
    await vi.waitFor(() => expect(peekModelCatalog).toHaveBeenCalledWith("harness"));
  });

  it("saves the default reasoning effort at once without a restart", async () => {
    seedStore({ settingsTab: "Models", defaultEffort: "high" });
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: "Default reasoning effort" }));
    const list = screen.getByRole("listbox", { name: "Default reasoning effort" });
    fireEvent.click(within(list).getByRole("option", { name: "Max" }));
    await vi.waitFor(() => expect(useAppStore.getState().defaultEffort).toBe("max"));
    expect(screen.getByText("Changes save as you make them")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save & restart connection" })).toBeNull();
  });


  it("previews and immediately saves the thinking orb, retaining it when reopened", async () => {
    seedStore({ settingsTab: "Theme", thinkingOrb: "auto" });
    const view = render(<SettingsModal />);
    expect(screen.getByTestId("orb-64")).toHaveAttribute("data-state", "working");
    fireEvent.click(screen.getByRole("button", { name: "Orb animation" }));
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(10);
    fireEvent.click(screen.getByRole("option", { name: /Weaving/ }));
    await vi.waitFor(() => expect(useAppStore.getState().thinkingOrb).toBe("weaving"));
    expect(screen.getByTestId("orb-64")).toHaveAttribute("data-state", "weaving");
    expect(screen.getByTestId("orb-20")).toHaveAttribute("data-state", "weaving");
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    view.unmount();
    act(() => useAppStore.getState().setSettingsOpen(true));
    render(<SettingsModal />);
    expect(screen.getByTestId("orb-64")).toHaveAttribute("data-state", "weaving");
    fireEvent.click(screen.getByRole("button", { name: "Orb animation" }));
    fireEvent.click(screen.getByRole("option", { name: /Automatic/ }));
    await vi.waitFor(() => expect(useAppStore.getState().thinkingOrb).toBe("auto"));
    expect(screen.getByTestId("orb-20")).toHaveAttribute("data-state", "working");
  });

  it("groups Appearance into theme, display, font, accent, sidebar and thinking orb sections", () => {
    seedStore({ settingsTab: "Theme" });
    render(<SettingsModal />);
    expect(within(screen.getByRole("region", { name: "Interface theme" })).getByRole("radiogroup", { name: "Interface mode" })).toBeInTheDocument();
    const display = screen.getByRole("region", { name: "Display & accessibility" });
    expect(within(display).getByRole("group", { name: "Interface zoom" })).toBeInTheDocument();
    expect(within(display).getByRole("switch", { name: /Reduce interface motion/ })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Font" })).getByRole("button", { name: "Font" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Accent color" })).getByRole("radiogroup", { name: "Accent color" })).toBeInTheDocument();
    const sidebar = screen.getByRole("region", { name: "Sidebar" });
    expect(within(sidebar).getByRole("button", { name: "Sidebar row density" })).toBeInTheDocument();
    expect(within(sidebar).getByRole("switch", { name: /Tint the sidebar/ })).toBeInTheDocument();
    // Nothing is behind the sidebar here, so there is no translucency to offer.
    expect(within(sidebar).queryByRole("slider")).toBeNull();
    const orb = screen.getByRole("region", { name: "Thinking orb" });
    expect(within(orb).getByRole("button", { name: "Orb animation" })).toBeInTheDocument();
    expect(within(orb).getByLabelText("Thinking orb preview")).toBeInTheDocument();
  });

  it("steps and resets native interface zoom from Appearance", async () => {
    seedStore({ settingsTab: "Theme", zoom: 1 });
    render(<SettingsModal />);
    const group = screen.getByRole("group", { name: "Interface zoom" });
    expect(within(group).getByText("100%")).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Reset" })).toBeDisabled();
    fireEvent.click(within(group).getByRole("button", { name: "Zoom in" }));
    await vi.waitFor(() => expect(useAppStore.getState().zoom).toBe(1.1));
    expect(within(group).getByText("110%")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Zoom in" }));
    await vi.waitFor(() => expect(useAppStore.getState().zoom).toBe(1.25));
    expect(within(group).getByText("125%")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Reset" }));
    await vi.waitFor(() => expect(useAppStore.getState().zoom).toBe(1));
    expect(within(group).getByText("100%")).toBeInTheDocument();
  });

  it("saves sidebar density and reduces motion without overriding the OS preference", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    seedStore({ settingsTab: "Theme", sidebarDensity: "standard", reduceMotion: false });
    render(<SettingsModal />);
    expect(motionReduced()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Sidebar row density" }));
    const list = screen.getByRole("listbox", { name: "Sidebar row density" });
    expect(within(list).getAllByRole("option")).toHaveLength(3);
    fireEvent.click(within(list).getByRole("option", { name: /Compact/ }));
    await vi.waitFor(() => expect(useAppStore.getState().sidebarDensity).toBe("compact"));
    expect(document.documentElement.dataset.sidebarDensity).toBe("compact");

    const motion = screen.getByRole("switch", { name: /Reduce interface motion/ });
    fireEvent.click(motion);
    await vi.waitFor(() => expect(useAppStore.getState().reduceMotion).toBe(true));
    expect(document.documentElement.dataset.motion).toBe("reduce");
    expect(motionReduced()).toBe(true);
    fireEvent.click(motion);
    await vi.waitFor(() => expect(useAppStore.getState().reduceMotion).toBe(false));
    expect(document.documentElement.dataset.motion).toBe("system");
    expect(motionReduced()).toBe(false);
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    expect(motionReduced()).toBe(true);
  });

  it("previews the sidebar's translucency while dragging and saves it once the drag ends", async () => {
    material.on = true;
    // jsdom has no matchMedia; the panel asks it whether the OS wants reduced transparency.
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    seedStore({ settingsTab: "Theme", sidebarTranslucency: 50 });
    render(<SettingsModal />);
    const slider = within(screen.getByRole("region", { name: "Sidebar" })).getByRole("slider", { name: "Translucency" });
    expect(slider).toHaveValue("50");
    fireEvent.change(slider, { target: { value: "80" } });
    expect(slider).toHaveAttribute("aria-valuetext", "80%");
    expect(useAppStore.getState().sidebarTranslucency).toBe(50);
    fireEvent.pointerUp(slider);
    await vi.waitFor(() => expect(useAppStore.getState().sidebarTranslucency).toBe(80));
    fireEvent.change(slider, { target: { value: "0" } });
    expect(slider).toHaveAttribute("aria-valuetext", "Solid");
    fireEvent.blur(slider);
    await vi.waitFor(() => expect(useAppStore.getState().sidebarTranslucency).toBe(0));
  });

  it("finds Appearance when searching for the thinking orb", () => {
    render(<SettingsModal />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "orb" } });
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));
    expect(screen.getByRole("button", { name: "Orb animation" })).toBeInTheDocument();
  });

  it("applies a font across the app as soon as it is chosen", async () => {
    seedStore({ settingsTab: "Theme", uiFont: "system" });
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: "Font" }));
    const list = screen.getByRole("listbox", { name: "Font" });
    expect(within(list).getAllByRole("option")).toHaveLength(7);
    expect(within(list).queryByRole("option", { name: /New York/ })).toBeNull();
    const googleSans = within(list).getByRole("option", { name: /Google Sans/ });
    expect(googleSans.style.fontFamily).toContain("Google Sans Variable");
    const inter = within(list).getByRole("option", { name: /Inter/ });
    expect(inter.style.fontFamily).toContain("Inter Variable");
    fireEvent.click(inter);
    await vi.waitFor(() => expect(useAppStore.getState().uiFont).toBe("inter"));
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe('"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif');
    expect(screen.getByRole("button", { name: "Font" })).toHaveTextContent("Inter");
  });

  it("finds Appearance when searching for a font", () => {
    render(<SettingsModal />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "helvetica" } });
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));
    expect(screen.getByRole("button", { name: "Font" })).toBeInTheDocument();
  });

  it("groups the pages under AI, Workspace, App and System, with keys under Providers", () => {
    render(<SettingsModal />);
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    expect(within(nav).getByText("AI")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Theme" })).toHaveTextContent("Appearance");
    expect(within(nav).getByRole("button", { name: "Shortcuts" })).toHaveTextContent("Commands & shortcuts");
    // There is no Account or Agents page: the agent is set up under Providers.
    expect(within(nav).queryByRole("button", { name: "Account" })).toBeNull();
    expect(within(nav).queryByRole("button", { name: "Agents" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "api key" } });
    expect(within(nav).getByRole("button", { name: "Providers" })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: "Theme" })).toBeNull();
  });

  it("switches a model out of the picker and back, and tests a Harness model's reply", async () => {
    const models = [
      { modelId: "anthropic/claude-sonnet-5", providerId: "anthropic", displayLabel: "Claude Sonnet 5" },
      { modelId: "anthropic/claude-haiku-4-5", providerId: "anthropic", displayLabel: "Claude Haiku 4.5" },
    ];
    const testModel = vi.fn(async () => ({ latencyMs: 820, firstTokenMs: 400, reply: "ready" }));
    seedStore({
      settingsTab: "Models", hiddenModels: [], testModel,
      peekModelCatalog: vi.fn(async () => models),
      agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }],
    });
    render(<SettingsModal />);
    const group = await screen.findByRole("region", { name: "Anthropic" });
    const haiku = await within(group).findByRole("switch", { name: "Show Claude Haiku 4.5 in the model picker" });
    expect(haiku).toHaveAttribute("aria-checked", "true");
    fireEvent.click(haiku);
    await vi.waitFor(() => expect(useAppStore.getState().hiddenModels).toEqual(["harness|anthropic|anthropic/claude-haiku-4-5"]));
    expect(within(group).getByText("1 of 2 in the picker")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Test Claude Sonnet 5" }));
    expect(testModel).toHaveBeenCalledWith("harness", models[0]);
    expect(await within(group).findByText("820 ms")).toBeInTheDocument();
    fireEvent.click(within(group).getByRole("button", { name: "Show all" }));
    await vi.waitFor(() => expect(useAppStore.getState().hiddenModels).toEqual([]));
  });

  it("switches a whole provider off and back on, folding its list while it is off", async () => {
    seedStore({
      settingsTab: "Models", hiddenModels: [], hiddenProviders: [],
      peekModelCatalog: vi.fn(async () => [{ modelId: "openai/gpt-5", providerId: "openai", displayLabel: "GPT-5" }]),
      agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }],
    });
    render(<SettingsModal />);
    const group = await screen.findByRole("region", { name: "OpenAI" });
    await within(group).findByRole("switch", { name: "Show GPT-5 in the model picker" });
    fireEvent.click(within(group).getByRole("switch", { name: "Use OpenAI in the model picker" }));
    await vi.waitFor(() => expect(useAppStore.getState().hiddenProviders).toEqual(["harness:openai"]));
    expect(within(group).getByText("Off — not in the model picker")).toBeInTheDocument();
    await vi.waitFor(() => expect(within(group).queryByRole("switch", { name: "Show GPT-5 in the model picker" })).toBeNull());
    fireEvent.click(within(group).getByRole("switch", { name: "Use OpenAI in the model picker" }));
    await vi.waitFor(() => expect(useAppStore.getState().hiddenProviders).toEqual([]));
  });

  it("keeps notifications on a General tab, saved on toggle", async () => {
    seedStore({ settingsTab: "General", notifications: true });
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("switch", { name: "Notifications" }));
    await vi.waitFor(() => expect(useAppStore.getState().notifications).toBe(false));
  });

  it("adds and removes custom commands, saving each change, and refuses a built-in name", async () => {
    seedStore({ settingsTab: "Shortcuts", customCommands: [] });
    render(<SettingsModal />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "compact" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Do it" } });
    fireEvent.click(screen.getByRole("button", { name: "Add command" }));
    expect(screen.getByRole("alert")).toHaveTextContent("built-in command");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "standup" } });
    fireEvent.click(screen.getByRole("button", { name: "Add command" }));
    await vi.waitFor(() => expect(useAppStore.getState().customCommands).toEqual([{ name: "standup", description: "", body: "Do it" }]));
    fireEvent.click(screen.getByRole("button", { name: "Remove /standup" }));
    await vi.waitFor(() => expect(useAppStore.getState().customCommands).toEqual([]));
  });

  it("offers the editor used to open files", async () => {
    seedStore({ settingsTab: "General", editor: "default" });
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: "Open files in" }));
    fireEvent.click(screen.getByRole("option", { name: "Zed" }));
    await vi.waitFor(() => expect(useAppStore.getState().editor).toBe("zed"));
  });

  it("rebinds a shortcut on the next key press, refuses a taken one, and resets", async () => {
    seedStore({ settingsTab: "Shortcuts", shortcutOverrides: {} });
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: "Change the shortcut for Find in thread" }));
    const capture = screen.getByRole("button", { name: "Press the new shortcut for Find in thread" });
    fireEvent.keyDown(capture, { key: "k", code: "KeyK", metaKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("already used by Command palette");
    expect(useAppStore.getState().shortcutOverrides).toEqual({});
    fireEvent.keyDown(capture, { key: "u", code: "KeyU", metaKey: true });
    await vi.waitFor(() => expect(useAppStore.getState().shortcutOverrides).toEqual({ find: "mod+KeyU" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset Find in thread to its default" }));
    await vi.waitFor(() => expect(useAppStore.getState().shortcutOverrides).toEqual({}));

    fireEvent.click(screen.getByRole("button", { name: "Change the shortcut for Find in thread" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Press the new shortcut for Find in thread" }), { key: "Escape", code: "Escape" });
    expect(screen.getByRole("button", { name: "Change the shortcut for Find in thread" })).toBeInTheDocument();
    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it("opts into smart suggestions, revealing the model picker", async () => {
    const loadModelCatalog = vi.fn(async () => [{ modelId: "deepseek/deepseek-chat", providerId: "deepseek", displayLabel: "DeepSeek Chat", cost: { input: "0.15", output: "0.60" } }]);
    seedStore({ settingsTab: "General", suggestionsEnabled: false, loadModelCatalog, agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }] });
    render(<SettingsModal />);
    const toggle = screen.getByRole("switch", { name: "Smart suggestions" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Suggestion model" })).toBeNull();
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(useAppStore.getState().suggestionsEnabled).toBe(true));
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledWith("harness"));
    const modelPicker = screen.getByRole("button", { name: "Suggestion model" });
    await vi.waitFor(() => expect(modelPicker).toBeEnabled());
    fireEvent.click(modelPicker);
    const list = screen.getByRole("listbox", { name: "Suggestion model" });
    expect(within(list).getByRole("option", { name: /Cheapest available/ })).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("option", { name: /DeepSeek Chat/ }));
    await vi.waitFor(() => expect(useAppStore.getState().suggestionsModelId).toBe("deepseek/deepseek-chat"));
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(useAppStore.getState().suggestionsEnabled).toBe(false));
  });

  it("keeps a saved suggestion model that left the catalog when its row is chosen", async () => {
    const loadModelCatalog = vi.fn(async () => [{ modelId: "muse-spark-1.3", providerId: "meta" }]);
    seedStore({ settingsTab: "General", suggestionsEnabled: true, suggestionsModelId: "muse-legacy-0.9", loadModelCatalog });
    render(<SettingsModal />);
    const picker = screen.getByRole("button", { name: "Suggestion model" });
    await vi.waitFor(() => expect(picker).toBeEnabled());
    fireEvent.click(picker);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Suggestion model" })).getByText("Saved selection · not in the current catalog"));
    expect(useAppStore.getState().suggestionsModelId).toBe("muse-legacy-0.9");
    // "Cheapest available" still clears the saved pick.
    fireEvent.click(picker);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Suggestion model" })).getByRole("option", { name: /Cheapest available/ }));
    await vi.waitFor(() => expect(useAppStore.getState().suggestionsModelId).toBeUndefined());
  });

  it("saves the Orchestrator toggle, goal and role models as they are chosen", async () => {
    seedStore({ settingsTab: "Orchestrator", orchestratorEnabled: false, orchestratorGoal: "balanced", orchestratorModels: {} });
    render(<SettingsModal />);
    expect(screen.getByRole("region", { name: "Orchestrator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Orchestrator" })).toHaveAttribute("aria-current", "page");
    const toggle = screen.getByRole("switch", { name: "Use Orchestrator for new threads" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(useAppStore.getState().orchestratorEnabled).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Orchestrator goal" }));
    const goals = within(screen.getByRole("listbox", { name: "Orchestrator goal" }));
    for (const { label, summary } of Object.values(ORCHESTRATOR_GOAL_COPY)) {
      expect(within(goals.getByRole("option", { name: new RegExp(label) })).getByText(summary)).toBeVisible();
    }
    fireEvent.click(goals.getByRole("option", { name: /Optimize for output/ }));
    await vi.waitFor(() => expect(useAppStore.getState().orchestratorGoal).toBe("output"));

    const lead = screen.getByRole("button", { name: "Lead model" });
    await vi.waitFor(() => expect(lead).toBeEnabled());
    fireEvent.click(lead);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Lead model" })).getByRole("option", { name: /Claude Sonnet 5/ }));
    await vi.waitFor(() => expect(useAppStore.getState().orchestratorModels).toEqual({ lead: { modelId: "anthropic/claude-sonnet-5", providerId: "anthropic" } }));
    expect(screen.getByText("Changes save as you make them")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save & restart connection" })).toBeNull();
  });

  it("keeps providers and models switched off in the library out of the Orchestrator role lists", async () => {
    seedStore({
      settingsTab: "Orchestrator",
      orchestratorEnabled: true,
      orchestratorModels: { lead: { modelId: "anthropic/claude-haiku-4-5", providerId: "anthropic" } },
      hiddenModels: ["harness|anthropic|anthropic/claude-haiku-4-5"],
      hiddenProviders: ["harness:kilo"],
    });
    render(<SettingsModal />);
    const lead = screen.getByRole("button", { name: "Lead model" });
    await vi.waitFor(() => expect(lead).toBeEnabled());
    fireEvent.click(lead);
    const list = within(screen.getByRole("listbox", { name: "Lead model" }));
    expect(list.getByText("Claude Sonnet 5", { exact: true })).toBeInTheDocument();
    expect(list.queryByText("Claude Haiku 4.5")).toBeNull();
    expect(list.queryByText("anthropic/claude-sonnet-4.6")).toBeNull();
    // The saved Lead is switched off, so it stays visible as the current choice.
    expect(list.getByText("Off in Settings → Models")).toBeInTheDocument();
  });

  it("asks for both required roles and discloses every provider that receives the prompt", async () => {
    seedStore({ settingsTab: "Orchestrator", orchestratorEnabled: true, orchestratorModels: {} });
    render(<SettingsModal />);
    const lead = screen.getByRole("button", { name: "Lead model" });
    const builder = screen.getByRole("button", { name: "Builder model" });
    await vi.waitFor(() => expect(builder).toBeEnabled());
    expect(screen.getByText(/Choose a Lead and a Builder/)).toBeInTheDocument();
    expect(screen.getByText(/Assign role models to see which providers/)).toBeInTheDocument();

    fireEvent.click(lead);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Lead model" })).getByRole("option", { name: /Claude Sonnet 5/ }));
    fireEvent.click(builder);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Builder model" })).getByRole("option", { name: /Claude Haiku 4.5/ }));
    await vi.waitFor(() => expect(screen.queryByText(/Choose a Lead and a Builder/)).toBeNull());
    expect(screen.getByText(/Your prompts and code are sent to:/)).toHaveTextContent("Anthropic (Lead, Builder, Small-task, Router)");
  });

  it("lets Small-task and Router inherit their models from the role before them", async () => {
    seedStore({
      settingsTab: "Orchestrator",
      orchestratorModels: {
        builder: { modelId: "anthropic/claude-haiku-4-5", providerId: "anthropic" },
        small: { modelId: "anthropic/claude-sonnet-5", providerId: "anthropic" },
      },
    });
    render(<SettingsModal />);
    const small = screen.getByRole("button", { name: "Small-task model" });
    await vi.waitFor(() => expect(small).toBeEnabled());
    expect(small).toHaveTextContent("Claude Sonnet 5");
    fireEvent.click(small);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Small-task model" })).getByRole("option", { name: /Same as Builder/ }));
    await vi.waitFor(() => expect(useAppStore.getState().orchestratorModels).toEqual({ builder: { modelId: "anthropic/claude-haiku-4-5", providerId: "anthropic" } }));

    fireEvent.click(screen.getByText("Advanced"));
    const router = screen.getByRole("button", { name: "Router model" });
    expect(router).toHaveTextContent("Same as Small-task");
    fireEvent.click(router);
    fireEvent.click(within(screen.getByRole("listbox", { name: "Router model" })).getByRole("option", { name: /gpt-5.5/ }));
    await vi.waitFor(() => expect(useAppStore.getState().orchestratorModels?.router).toEqual({ modelId: "openai/gpt-5.5", providerId: "openai" }));
  });

  it("checks an assigned role's model and shows the result under its picker", async () => {
    const probe = vi.spyOn(useAppStore.getState(), "probeOrchestratorRole");
    seedStore({
      settingsTab: "Orchestrator",
      orchestratorModels: { builder: { modelId: "anthropic/claude-haiku-4-5", providerId: "anthropic" } },
    });
    render(<SettingsModal />);
    const row = screen.getByRole("button", { name: "Builder model" }).closest(".setting-row") as HTMLElement;
    expect(await within(row).findByText("Ready", undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(probe).toHaveBeenCalledWith("builder", { modelId: "anthropic/claude-haiku-4-5", providerId: "anthropic" }, undefined);
    // One assignment, one check: the page never re-runs a result it already holds.
    expect(probe.mock.calls.filter(([role]) => role === "builder")).toHaveLength(1);
    probe.mockRestore();
  });

  it("shows why a role's check failed and runs it again on demand", async () => {
    seedStore({
      settingsTab: "Orchestrator",
      orchestratorModels: { builder: { modelId: "nvidia/moonshotai/kimi-k2.6", providerId: "nvidia" } },
    });
    render(<SettingsModal />);
    const row = screen.getByRole("button", { name: "Builder model" }).closest(".setting-row") as HTMLElement;
    expect(await within(row).findByText("Not supported", undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(within(row).getByText(/did not return the format/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Check the Builder model" }));
    expect(await within(row).findByText("Not supported", undefined, { timeout: 4000 })).toBeInTheDocument();
  });

  it("reuses the Builder's check for an inherited Small-task and gives the Router its own", async () => {
    const probe = vi.spyOn(useAppStore.getState(), "probeOrchestratorRole");
    seedStore({
      settingsTab: "Orchestrator",
      orchestratorModels: { builder: { modelId: "anthropic/claude-haiku-4-5", providerId: "anthropic" } },
    });
    render(<SettingsModal />);
    const builderRow = screen.getByRole("button", { name: "Builder model" }).closest(".setting-row") as HTMLElement;
    expect(await within(builderRow).findByText("Ready", undefined, { timeout: 4000 })).toBeInTheDocument();
    const smallRow = screen.getByRole("button", { name: "Small-task model" }).closest(".setting-row") as HTMLElement;
    expect(within(smallRow).getByText("Builder’s check")).toBeInTheDocument();
    expect(within(smallRow).getByText("Ready")).toBeInTheDocument();
    expect(probe.mock.calls.filter(([role]) => role === "small")).toHaveLength(0);

    fireEvent.click(screen.getByText("Advanced"));
    const routerRow = screen.getByRole("button", { name: "Router model" }).closest(".setting-row") as HTMLElement;
    expect(await within(routerRow).findByText("Ready", undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(probe.mock.calls.filter(([role]) => role === "router")).toHaveLength(1);
    probe.mockRestore();
  });

  it("sends an Orchestrator page with no connected providers to Providers", async () => {
    seedStore({ settingsTab: "Orchestrator", loadModelCatalog: vi.fn(async () => []) });
    render(<SettingsModal />);
    expect(await screen.findByText("No providers connected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a provider" }));
    expect(useAppStore.getState().settingsTab).toBe("Providers");
  });
});
