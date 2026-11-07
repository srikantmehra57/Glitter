import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExtensionsStore } from "./ExtensionsStore";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { CatalogEntry, Thread } from "../lib/types";

const entry = (partial: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: "code-review",
  kind: "skill",
  name: "Code review",
  summary: "Review a diff for correctness.",
  description: "Find the defects that matter, with a file and line.",
  tags: ["quality"],
  version: 1,
  skills: ["code-review"],
  servers: [],
  scope: "user",
  requiresWorkspace: false,
  commands: [],
  installed: false,
  installedParts: 0,
  totalParts: 1,
  ...partial,
});

const server = entry({ id: "filesystem", kind: "mcp", name: "Filesystem", summary: "Read and write files inside this workspace.", skills: [], servers: ["filesystem"], scope: "workspace", requiresWorkspace: true, commands: ["npx -y @modelcontextprotocol/server-filesystem ."] });
const bundle = entry({ id: "daily-driver", kind: "plugin", name: "Daily driver", summary: "Review, commit and open a PR.", skills: ["code-review", "commit-message"], servers: ["sequential-thinking"], totalParts: 3, installedParts: 1, commands: ["npx -y @modelcontextprotocol/server-sequential-thinking"] });

const thread: Thread = {
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "idle",
  unread: false,
  items: [],
  agentId: "harness",
};

function mount(entries: CatalogEntry[], extra: Partial<ReturnType<typeof useAppStore.getState>> = {}) {
  seedStore({
    threads: [thread],
    selectedSessionId: "s1",
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
    selectedWorkspaceId: "w",
    catalogEntries: entries,
    catalogSkillsRoot: "~/.agents/skills",
    refreshCatalog: vi.fn(async () => {}),
    installCatalogEntry: vi.fn(async () => ({ installedSkills: ["code-review"], installedServers: [], skipped: [], errors: [] })),
    removeCatalogEntry: vi.fn(async () => ({ removed: ["code-review"], skipped: [], errors: [] })),
    refreshSkills: vi.fn(async () => {}),
    refreshHarnessMcp: vi.fn(async () => {}),
    ...extra,
  });
  return render(<ExtensionsStore />);
}

describe("ExtensionsStore", () => {
  beforeEach(resetStore);

  it("reads the bundled catalog on mount and says where installs land", async () => {
    const refresh = vi.fn(async () => {});
    mount([entry(), server], { refreshCatalog: refresh });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const section = screen.getByRole("region", { name: "Store" });
    expect(within(section).getByText("Code review")).toBeInTheDocument();
    expect(within(section).getByText("Filesystem")).toBeInTheDocument();
    expect(within(section).getByText("npx -y @modelcontextprotocol/server-filesystem .")).toBeInTheDocument();
    const note = within(section).getByText(/Skills install to/);
    expect(note.textContent).toContain("~/.agents/skills");
    expect(note.textContent).toContain(".glitter/mcp.json");
  });

  it("filters by search and by kind", () => {
    mount([entry(), entry({ id: "test-first", name: "Test first", skills: ["test-first"] }), bundle]);
    fireEvent.change(screen.getByLabelText("Search the store"), { target: { value: "commit" } });
    expect(screen.queryByText("Test first")).toBeNull();
    expect(screen.getByText("Daily driver")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search the store"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("tab", { name: "Plugins" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Daily driver")).toBeInTheDocument();
  });

  it("installs a skill on one click, without a confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const install = vi.fn(async () => ({ installedSkills: ["code-review"], installedServers: [], skipped: [], errors: [] }));
    mount([entry()], { confirm, installCatalogEntry: install });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith("code-review", "s1"));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Installed code-review.");
  });

  it("names the servers and their file before installing one that writes MCP config", async () => {
    const asked: Array<{ title: string; body?: string }> = [];
    const confirm = vi.fn(async (options: { title: string; body?: string }) => { asked.push(options); return true; });
    mount([bundle], { confirm });
    fireEvent.click(screen.getByRole("button", { name: "Finish install" }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]?.title).toBe("Install Daily driver?");
    expect(asked[0]?.body).toContain("sequential-thinking");
    expect(asked[0]?.body).toContain(".glitter/mcp.json");
    expect(asked[0]?.body).toContain("permissions and grants");
    expect(asked[0]?.body).toContain("network download");
  });

  it("installs nothing when the confirmation is declined", async () => {
    const install = vi.fn(async () => ({ installedSkills: [], installedServers: [], skipped: [], errors: [] }));
    mount([bundle], { confirm: vi.fn(async () => false), installCatalogEntry: install });
    fireEvent.click(screen.getByRole("button", { name: "Finish install" }));
    await waitFor(() => expect(install).not.toHaveBeenCalled());
  });

  it("keeps a workspace-scoped server out of reach until a workspace is open", async () => {
    const install = vi.fn(async () => ({ installedSkills: [], installedServers: [], skipped: [], errors: [] }));
    mount([server], { installCatalogEntry: install, workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: null }], });
    expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
    expect(screen.getByText(/Open a workspace/)).toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();
  });

  it("removes only after a dangerous confirmation", async () => {
    const confirm = vi.fn(async () => true);
    const remove = vi.fn(async () => ({ removed: ["code-review"], skipped: [], errors: [] }));
    mount([entry({ installed: true, installedParts: 1 })], { confirm, removeCatalogEntry: remove });
    expect(screen.getByText("Installed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("code-review", "s1"));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Remove Code review?", danger: true }));
    expect(screen.getByRole("status")).toHaveTextContent("Removed code-review.");
  });

  it("reports a partial install rather than hiding the failure", async () => {
    const install = vi.fn(async () => ({ installedSkills: ["code-review"], installedServers: [], skipped: [], errors: ["code-review: the folder already exists and is not yours to change."] }));
    mount([entry()], { installCatalogEntry: install });
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not yours to change"));
    expect(screen.getByRole("status")).toHaveTextContent("Installed code-review.");
  });

  it("surfaces a catalog error instead of an empty store", () => {
    mount([], { catalogEntries: [], catalogError: "Could not read .glitter/mcp.json: it is not valid JSON." });
    expect(screen.getByRole("alert")).toHaveTextContent("not valid JSON");
    expect(screen.getByText(/store could not be read/)).toBeInTheDocument();
  });
});
