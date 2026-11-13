import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { GithubInstallDialog } from "./GithubInstallDialog";
import { resetStore, seedStore } from "../test/store";
import type { GithubPreview, PluginAnalysis } from "../lib/types";

const native = vi.hoisted(() => ({ inspect: vi.fn(), discard: vi.fn(async () => {}) }));
vi.mock("../lib/bridge", async (original) => ({
  ...(await original<typeof import("../lib/bridge")>()),
  githubInspect: native.inspect,
  githubDiscard: native.discard,
}));

const origin = { owner: "acme", repo: "kit", ref: null, path: "", commit: "0123456789abcdef0123456789abcdef01234567", plugin: null, spec: "acme/kit", url: "https://github.com/acme/kit" };
const analysis = (partial: Partial<PluginAnalysis> = {}): PluginAnalysis => ({
  name: "review-kit", displayName: "Review Kit", description: "Reviews diffs.", longDescription: null, version: "1.2.0", author: "Ada", homepage: null, license: "MIT", category: null, keywords: [], brandColor: null,
  formats: ["Claude Code", "Agent Skills", "MCP"],
  skills: [{ name: "review", description: "Review a diff", folder: "skills/review" }, { name: "triage", description: "Sort findings", folder: "skills/triage" }],
  commands: [{ name: "ship", description: "Ship it", file: "commands/ship.md" }],
  servers: [{ name: "docs", transport: "stdio", display: "npx docs-server", needsEnv: ["DOCS_TOKEN"] }],
  agents: ["helper"], hooks: true, lsp: false, notes: [],
  ...partial,
});
const pluginPreview = (partial: Partial<GithubPreview> = {}): GithubPreview => ({ token: "a".repeat(32), kind: "plugin", origin, plugin: analysis(), marketplace: null, icon: null, avatar: null, pluginId: "review-kit", installed: false, conflicts: [], ...partial });

describe("GithubInstallDialog", () => {
  beforeEach(() => {
    resetStore();
    native.inspect.mockReset();
    native.discard.mockClear();
  });

  it("fetches a pasted repository, shows every part, and installs only what stays checked", async () => {
    native.inspect.mockResolvedValue(pluginPreview({ conflicts: ["A skill called ship is already in ~/.agents/skills; this plugin's copy is skipped."] }));
    const install = vi.fn(async () => ({ id: "review-kit", skills: ["review"], commands: ["ship"], servers: ["docs"], problems: [] }));
    seedStore({ installLibraryPlugin: install });
    render(<GithubInstallDialog request={{ id: 1 }} onClose={() => {}} />);
    const field = screen.getByLabelText("GitHub repository");
    fireEvent.change(field, { target: { value: "gitlab.com/a/b" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Only github.com");
    expect(screen.getByRole("button", { name: "Fetch" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "https://github.com/acme/kit" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByText("Review Kit");
    expect(native.inspect).toHaveBeenCalledWith("https://github.com/acme/kit", undefined);
    expect(screen.getByText("2 skills · 1 command · 1 MCP server")).toBeInTheDocument();
    expect(screen.getByText("npx docs-server")).toBeInTheDocument();
    expect(screen.getByText("Needs DOCS_TOKEN")).toBeInTheDocument();
    expect(screen.getByText(/Its 1 agent and hooks are for Claude Code/)).toBeInTheDocument();
    expect(screen.getByText(/ship is already in/)).toBeInTheDocument();
    expect(screen.getByText("0123456")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /triage/ }));
    fireEvent.click(screen.getByRole("button", { name: "Install 3" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("a".repeat(32), ["review", "ship", "docs"], undefined));
    expect(await screen.findByText("Review Kit is installed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("installs everything with no selection when every part stays checked", async () => {
    native.inspect.mockResolvedValue(pluginPreview());
    const install = vi.fn(async () => ({ id: "review-kit", skills: [], commands: [], servers: [], problems: [] }));
    seedStore({ installLibraryPlugin: install });
    render(<GithubInstallDialog request={{ id: 1, source: "acme/kit" }} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("a".repeat(32), null, undefined));
  });

  it("adds a marketplace as a source instead of installing it", async () => {
    native.inspect.mockResolvedValue(pluginPreview({ kind: "marketplace", plugin: null, pluginId: null, marketplace: { name: "team-tools", description: "Our plugins", owner: "Team", plugins: [{ name: "lint", description: "Lints", version: null, category: "development", author: null, homepage: null, keywords: [], location: "This repository", supported: true }] } }));
    const add = vi.fn(async () => ({ id: "team-tools" }));
    const added = vi.fn();
    const closed = vi.fn();
    seedStore({ addMarketplace: add as never });
    render(<GithubInstallDialog request={{ id: 1, source: "acme/market" }} onClose={closed} onAddedSource={added} />);
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Team tools")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Install/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add source" }));
    await waitFor(() => expect(added).toHaveBeenCalledWith("team-tools"));
    expect(closed).toHaveBeenCalled();
    expect(native.discard).not.toHaveBeenCalled();
  });

  it("explains a repository it could not read and discards a preview left behind", async () => {
    native.inspect.mockRejectedValueOnce(new Error("Could not reach acme/nope on GitHub."));
    const closed = vi.fn();
    const { rerender } = render(<GithubInstallDialog request={{ id: 1, source: "acme/nope" }} onClose={closed} />);
    expect(await screen.findByText(/Could not reach acme\/nope/)).toBeInTheDocument();
    native.inspect.mockResolvedValue(pluginPreview());
    rerender(<GithubInstallDialog request={{ id: 2, source: "acme/kit", plugin: "review-kit" }} onClose={closed} />);
    await screen.findByText("Review Kit");
    expect(screen.queryByLabelText("GitHub repository")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(native.discard).toHaveBeenCalledWith("a".repeat(32));
    expect(closed).toHaveBeenCalled();
  });
});
