import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InstalledPlugins, PluginSources } from "./PluginLibrary";
import { resetStore, seedStore } from "../test/store";
import type { InstalledPlugin, MarketplaceSource, PluginLibrary } from "../lib/types";

const origin = { owner: "obra", repo: "superpowers", ref: null, path: "", commit: "0123456789abcdef0123456789abcdef01234567", plugin: null, spec: "obra/superpowers", url: "https://github.com/obra/superpowers" };
const plugin = (partial: Partial<InstalledPlugin> = {}): InstalledPlugin => ({
  id: "superpowers", name: "superpowers", displayName: "Superpowers", description: "Planning and TDD.", longDescription: null, version: "7.0.2", author: "Jesse Vincent", homepage: null, license: "MIT", category: null, keywords: [], brandColor: null,
  formats: ["Claude Code", "Agent Skills"], icon: null, avatar: null, origin, enabled: true, installedAt: Date.now(), updatedAt: Date.now(),
  availableSkills: [{ name: "brainstorming", description: "Ideas", folder: "skills/brainstorming" }, { name: "writing-plans", description: "Plans", folder: "skills/writing-plans" }],
  skills: ["brainstorming", "writing-plans"], commands: [], servers: [], serverDetails: [], agents: [], hooks: true, lsp: false, notes: [], folder: "~/.glitter/plugins/superpowers",
  ...partial,
});
const source = (partial: Partial<MarketplaceSource> = {}): MarketplaceSource => ({
  id: "claude-plugins-official", name: "claude-plugins-official", description: "Directory", owner: "Anthropic",
  origin: { ...origin, owner: "anthropics", repo: "claude-plugins-official", spec: "anthropics/claude-plugins-official" },
  addedAt: Date.now(), refreshedAt: Date.now(), avatar: null, plugins: [{ name: "lint", description: null, version: null, category: null, author: null, homepage: null, keywords: [], location: "This repository", supported: true }],
  ...partial,
});
const library = (partial: Partial<PluginLibrary> = {}): PluginLibrary => ({ plugins: [plugin()], marketplaces: [], pluginsRoot: "~/.glitter/plugins", problems: [], ...partial });

describe("InstalledPlugins", () => {
  beforeEach(resetStore);

  it("lists a plugin with its source and parts, and shows what it holds when opened", () => {
    seedStore({ library: library() });
    render(<InstalledPlugins onOpen={() => {}} />);
    expect(screen.getByText("Superpowers")).toBeInTheDocument();
    expect(screen.getByText("obra/superpowers")).toBeInTheDocument();
    expect(screen.getByText("2 skills")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Superpowers/ }));
    expect(screen.getByText("writing-plans")).toBeInTheDocument();
    expect(screen.getByText(/Its hooks are for Claude Code/)).toBeInTheDocument();
    expect(screen.getByText("0123456")).toBeInTheDocument();
  });

  it("turns a plugin off without removing it", async () => {
    const setEnabled = vi.fn(async () => ({ id: "superpowers", skills: [], commands: [], servers: [], problems: [] }));
    seedStore({ library: library(), setLibraryPluginEnabled: setEnabled });
    render(<InstalledPlugins onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Turn off Superpowers" }));
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith("superpowers", false, undefined));
    expect(await screen.findByRole("status")).toHaveTextContent("Its files stay");
  });

  it("removes only after a dangerous confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const remove = vi.fn(async () => []);
    seedStore({ library: library(), confirm, removeLibraryPlugin: remove });
    render(<InstalledPlugins onOpen={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Superpowers/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("superpowers", undefined));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Remove Superpowers?", danger: true }));
  });

  it("offers an update that keeps a partial choice of skills", () => {
    const open = vi.fn();
    seedStore({ library: library({ plugins: [plugin({ skills: ["brainstorming"] })] }), libraryUpdates: [{ id: "superpowers", kind: "plugin", commit: "a", latest: "b" }] });
    render(<InstalledPlugins onOpen={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(open).toHaveBeenCalledWith({ source: "obra/superpowers", plugin: null, selected: ["brainstorming"], update: true });
  });

  it("says how to add the first plugin", () => {
    seedStore({ library: library({ plugins: [] }) });
    render(<InstalledPlugins onOpen={() => {}} />);
    expect(screen.getByText(/No plugins from GitHub yet/)).toBeInTheDocument();
  });
});

describe("PluginSources", () => {
  beforeEach(resetStore);

  it("lists added sources and marks featured ones already added", () => {
    const browse = vi.fn();
    seedStore({ library: library({ marketplaces: [source()] }) });
    render(<PluginSources onOpen={() => {}} onBrowse={browse} />);
    expect(screen.getByText("Claude plugins official")).toBeInTheDocument();
    expect(screen.getByText("1 plugin")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(browse).toHaveBeenCalledWith("claude-plugins-official");
  });

  it("refreshes and removes a source", async () => {
    const refresh = vi.fn(async () => source());
    const remove = vi.fn(async () => {});
    seedStore({ library: library({ marketplaces: [source()] }), refreshMarketplace: refresh, removeMarketplace: remove, confirm: vi.fn(async () => true) });
    render(<PluginSources onOpen={() => {}} onBrowse={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh Claude plugins official" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith("claude-plugins-official"));
    fireEvent.click(screen.getByRole("button", { name: "Remove Claude plugins official" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("claude-plugins-official"));
  });
});
