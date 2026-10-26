import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "../lib/store";
import { motionReduced } from "../lib/presence";
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

  it("holds a connection setting for an explicit restart and drops it on Cancel", () => {
    seedStore({ settingsTab: "Agents", museBin: "" });
    render(<SettingsModal />);
    expect(screen.getByRole("button", { name: "Restart connection" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Muse binary (optional)"), { target: { value: "/opt/muse" } });
    expect(screen.getByRole("button", { name: "Save & restart connection" })).toBeInTheDocument();
    expect(screen.getByText("Restart the connection to apply these changes")).toBeInTheDocument();
    expect(useAppStore.getState().museBin).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().settingsOpen).toBe(false);
    expect(useAppStore.getState().museBin).toBe("");
  });

  it("treats Contributor mode as an explicit host restart without changing the selected model", () => {
    seedStore({ settingsTab: "Agents", defaultModel: "muse-spark-1.3" });
    render(<SettingsModal />);
    fireEvent.click(screen.getByRole("button", { name: "Contributor mode" }));
    fireEvent.click(screen.getByRole("option", { name: /Standard mode/ }));
    expect(useAppStore.getState().contributorMode).toBeUndefined();
    expect(useAppStore.getState().defaultModel).toBe("muse-spark-1.3");
    expect(screen.getByRole("button", { name: "Save & restart connection" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useAppStore.getState().contributorMode).toBeUndefined();
  });

  it("loads the defaults catalog independently of a Grok conversation and labels a saved legacy model", async () => {
    const catalog = [
      { modelId: "muse-wonder-1.0", providerId: "meta" },
      { modelId: "muse-spark-1.3", providerId: "meta" },
      { modelId: "muse-spark-1.2", providerId: "meta" },
    ];
    const loadModelCatalog = vi.fn(async () => catalog);
    seedStore({ settingsTab: "Models", defaultModel: "muse-spark-1.3-contributor", models: [{ modelId: "grok-4.7", providerId: "grok" }], loadModelCatalog, agents: [{ id: "muse", name: "Muse", protocol: "msp", found: true, path: "/bin/muse", version: "1", verified: true, signIn: "", authenticated: true }] });
    render(<SettingsModal />);
    const model = screen.getByRole("button", { name: "Default model" });
    await vi.waitFor(() => expect(model).toBeEnabled());
    expect(loadModelCatalog).toHaveBeenCalledWith("muse");
    expect(screen.getByText(/This saved model is no longer listed/)).toBeInTheDocument();
    expect(useAppStore.getState().defaultModel).toBe("muse-spark-1.3-contributor");
    fireEvent.click(model);
    const list = screen.getByRole("listbox", { name: "Default model" });
    expect(within(list).getAllByRole("option")).toHaveLength(4);
    expect(within(list).queryByText("Grok 4.7")).toBeNull();
    expect(within(list).getByText("Saved selection · not in the current catalog")).toBeInTheDocument();
    fireEvent.click(within(list).getByText("Muse Wonder 1.0", { exact: true }));
    await vi.waitFor(() => expect(useAppStore.getState().defaultModel).toBe("muse-wonder-1.0"));
    expect(useAppStore.getState().models.map((item) => item.modelId)).toEqual(["grok-4.7"]);
    expect(useAppStore.getState().contributorMode).toBeUndefined();
  });

  it("shows a catalog error instead of presenting the saved model as the only available choice", async () => {
    seedStore({ settingsTab: "Models", defaultModel: "muse-spark-1.3-contributor", loadModelCatalog: vi.fn(async () => { throw new Error("Connection closed"); }) });
    render(<SettingsModal />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("Connection closed");
    expect(screen.getByRole("button", { name: "Default model" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh default models" })).toBeEnabled();
  });

  it("keeps Harness provider setup errors specific and skips unconsented CLI catalogs", async () => {
    const detail = "Harness has no model provider yet. Add an API key in Settings → Providers.";
    const peekModelCatalog = vi.fn(async () => []);
    seedStore({
      settingsTab: "Models",
      defaultAgentId: "harness",
      acpUnisolatedConsent: false,
      enabledAgents: { harness: true, grok: true },
      agents: [
        { id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true },
        { id: "grok", name: "Grok", protocol: "acp", found: true, path: "/bin/grok", version: "1", verified: true, signIn: "" },
      ],
      loadModelCatalog: vi.fn(async () => { throw new Error(detail); }),
      peekModelCatalog,
    });
    render(<SettingsModal />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`Could not load Harness models: ${detail}`);
    expect(alert).not.toHaveTextContent("Muse needs a sign-in");
    expect(alert).not.toHaveTextContent("Nothing was sent");
    await vi.waitFor(() => expect(peekModelCatalog).toHaveBeenCalledWith("harness"));
    expect(peekModelCatalog).not.toHaveBeenCalledWith("grok");
    expect(screen.queryByText("Grok")).toBeNull();
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

  it("enables Contributor routing only after an eligible subscriber explicitly saves and restarts", async () => {
    const startHost = vi.fn(async () => {});
    seedStore({
      settingsTab: "Agents", preview: false, hostInfo: {}, startHost,
      detection: { found: true, authenticated: true, path: "/bin/muse", version: "1.4.7", method: "subscription", subscriptionAvailable: true },
      defaultModel: "muse-spark-1.3",
    });
    render(<SettingsModal />);
    expect(useAppStore.getState().contributorMode).toBeUndefined();
    fireEvent.click(screen.getByRole("button", { name: "Contributor mode" }));
    fireEvent.click(screen.getByRole("option", { name: /^Contributor mode/ }));
    expect(useAppStore.getState().contributorMode).toBeUndefined();
    expect(startHost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save & restart connection" }));
    await vi.waitFor(() => expect(startHost).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().contributorMode).toBe("on");
    expect(useAppStore.getState().defaultModel).toBe("muse-spark-1.3");
    expect(useAppStore.getState().settingsOpen).toBe(false);
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
    expect(within(list).getAllByRole("option")).toHaveLength(6);
    const helvetica = within(list).getByRole("option", { name: /Helvetica/ });
    expect(helvetica.style.fontFamily).toContain("Helvetica Neue");
    fireEvent.click(helvetica);
    await vi.waitFor(() => expect(useAppStore.getState().uiFont).toBe("helvetica"));
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe('"Helvetica Neue", Helvetica, Arial, sans-serif');
    expect(screen.getByRole("button", { name: "Font" })).toHaveTextContent("Helvetica");
  });

  it("finds Appearance when searching for a font", () => {
    render(<SettingsModal />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "helvetica" } });
    fireEvent.click(screen.getByRole("button", { name: "Theme" }));
    expect(screen.getByRole("button", { name: "Font" })).toBeInTheDocument();
  });

  it("groups the pages under AI, Workspace, App and System, with Muse's connection under Agents", () => {
    render(<SettingsModal />);
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    expect(within(nav).getByText("AI")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Theme" })).toHaveTextContent("Appearance");
    expect(within(nav).getByRole("button", { name: "Shortcuts" })).toHaveTextContent("Commands & shortcuts");
    // There is no Account page: Muse is one agent among others.
    expect(within(nav).queryByRole("button", { name: "Account" })).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Search settings" }), { target: { value: "api key" } });
    expect(within(nav).getByRole("button", { name: "Agents" })).toBeInTheDocument();
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

  it("opts into smart suggestions, revealing the agent and model pickers", async () => {
    const loadModelCatalog = vi.fn(async () => [{ modelId: "muse-spark-1.3", providerId: "meta", cost: { input: "0.15", output: "0.60" } }]);
    seedStore({ settingsTab: "General", suggestionsEnabled: false, loadModelCatalog, agents: [{ id: "muse", name: "Muse", protocol: "msp", found: true, path: "/bin/muse", version: "1", verified: true, signIn: "", authenticated: true }] });
    render(<SettingsModal />);
    const toggle = screen.getByRole("switch", { name: "Smart suggestions" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Suggestion agent" })).toBeNull();
    fireEvent.click(toggle);
    await vi.waitFor(() => expect(useAppStore.getState().suggestionsEnabled).toBe(true));
    expect(screen.getByRole("button", { name: "Suggestion agent" })).toBeInTheDocument();
    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledWith("muse"));
    const modelPicker = screen.getByRole("button", { name: "Suggestion model" });
    await vi.waitFor(() => expect(modelPicker).toBeEnabled());
    fireEvent.click(modelPicker);
    const list = screen.getByRole("listbox", { name: "Suggestion model" });
    expect(within(list).getByRole("option", { name: /Cheapest available/ })).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("option", { name: /Muse Spark 1.3/ }));
    await vi.waitFor(() => expect(useAppStore.getState().suggestionsModelId).toBe("muse-spark-1.3"));
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
});
