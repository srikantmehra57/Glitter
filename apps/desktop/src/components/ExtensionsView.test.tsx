import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExtensionsView } from "./ExtensionsView";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { HarnessMcpConfig, HarnessMcpReview, Thread } from "../lib/types";

const native = vi.hoisted(() => ({ review: vi.fn(), consent: vi.fn() }));
vi.mock("../lib/bridge", async (original) => ({
  ...(await original<typeof import("../lib/bridge")>()),
  reviewMcp: native.review,
  consentMcp: native.consent,
}));

const review = (partial: Partial<HarnessMcpReview> = {}): HarnessMcpReview => ({
  trusted: false,
  current: false,
  hasWorkspaceConfig: true,
  configurationDigest: "digest-one",
  ...partial,
});

const grantState = {
  workspaces: [{ id: "workspace-1", path: "/repo", name: "Repo", grantId: "wg-workspace" }],
  selectedWorkspaceId: "workspace-1",
};

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "idle",
  unread: false,
  items: [],
  ...partial,
});

function mount(partial: Partial<Thread>, extra: Partial<ReturnType<typeof useAppStore.getState>> = {}) {
  seedStore({
    threads: [thread(partial)],
    selectedSessionId: "s1",
    refreshHarnessMcp: vi.fn(async () => {}),
    refreshHarnessMcpConfig: vi.fn(async () => {}),
    addHarnessMcpServer: vi.fn(async () => {}),
    removeHarnessMcpServer: vi.fn(async () => {}),
    refreshLibrary: vi.fn(async () => {}),
    refreshCatalog: vi.fn(async () => {}),
    ...extra,
  });
  const view = render(<ExtensionsView embedded />);
  // Skills and MCP servers are managed under Installed; Discover opens first.
  fireEvent.click(screen.getByRole("tab", { name: /^Installed/ }));
  return view;
}

describe("ExtensionsView skills", () => {
  beforeEach(resetStore);

  it("lists a Harness thread's skills, says where they load from, and Use fills the composer", () => {
    mount({ agentId: "harness", skills: [{ selector: "review", description: "Reviews a diff for bugs.", source: "project" }] });
    expect(screen.getByText("/review")).toBeInTheDocument();
    expect(screen.getByText("Reviews a diff for bugs.")).toBeInTheDocument();
    expect(screen.getByText(/The agent loads skills from/)).toHaveTextContent(".glitter/skills and .agents/skills, in the workspace and in your home folder");
    const section = screen.getByRole("region", { name: "Skills" });
    expect(within(section).getByRole("button", { name: /^Refresh$/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(useAppStore.getState().composer).toBe("/review ");
  });

  it("tells a Harness thread with no skills how to add one", () => {
    mount({ agentId: "harness", skills: [] });
    expect(screen.getByText(/No skills yet\..*SKILL\.md/)).toBeInTheDocument();
  });

});

describe("ExtensionsView MCP servers", () => {
  beforeEach(() => {
    resetStore();
    native.review.mockReset();
    native.consent.mockReset();
    native.review.mockResolvedValue(review());
    native.consent.mockResolvedValue(undefined);
  });

  const config: HarnessMcpConfig = {
    servers: [
      { name: "docs", source: "workspace", transport: "stdio", command: "npx", args: 2, envKeys: ["DOCS_TOKEN"], headerKeys: [] },
      { name: "search", source: "home", transport: "http", url: "https://example.test/mcp", args: 0, envKeys: [], headerKeys: ["Authorization"] },
      { name: "broken", source: "workspace", transport: "stdio", args: 0, envKeys: [], headerKeys: [], error: ".glitter/mcp.json: broken.command is required." },
    ],
    error: null,
  };

  it("lists each server's file, transport and key names without values", () => {
    mount({ agentId: "harness" }, {
      harnessMcpConfig: config,
      harnessMcp: { servers: [{ name: "docs", transport: "stdio", tools: 3 }], error: null },
    });
    const section = screen.getByRole("region", { name: "MCP servers" });
    expect(within(section).getByText("docs")).toBeInTheDocument();
    expect(within(section).getAllByText("Workspace")).toHaveLength(2);
    expect(within(section).getByText("Home")).toBeInTheDocument();
    expect(within(section).getByText("npx · 2 arguments · 1 env")).toBeInTheDocument();
    expect(within(section).getByText("https://example.test/mcp · 1 header")).toBeInTheDocument();
    expect(within(section).getByText("3 tools")).toBeInTheDocument();
    expect(within(section).getByText("Needs attention")).toBeInTheDocument();
    expect(within(section).getByText(/broken.command is required/)).toBeInTheDocument();
    expect(within(section).queryByText(/DOCS_TOKEN/)).toBeNull();
    expect(within(section).queryByText(/Authorization/)).toBeNull();
  });

  it("does not enable approval before the redacted configuration is readable", async () => {
    mount({ agentId: "harness" }, { ...grantState, harnessMcpConfig: null, harnessMcpConfigLoading: "s1" });
    const approve = await screen.findByRole("button", { name: "Approve startup" });
    expect(approve).toBeDisabled();
    seedStore({ harnessMcpConfig: config, harnessMcpConfigLoading: null });
    await waitFor(() => expect(approve).toBeEnabled());
  });

  it("approves the exact reviewed digest with the thread worktree's grant", async () => {
    const refresh = vi.fn(async () => {});
    native.review.mockResolvedValueOnce(review()).mockResolvedValueOnce(review({ trusted: true, current: true }));
    mount({ agentId: "harness", worktree: { grantId: "wg-tree", path: "/repo-tree", branch: "thread", base: "main", workspaceId: "workspace-1" } }, {
      ...grantState,
      harnessMcpConfig: config,
      refreshHarnessMcp: refresh,
    });
    expect(await screen.findByText("MCP startup approval needed")).toBeInTheDocument();
    expect(screen.getByText("docs")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve startup" }));
    await waitFor(() => expect(native.consent).toHaveBeenCalledWith("wg-tree", true, "digest-one"));
    expect(await screen.findByText("MCP startup approved")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledWith("s1", true);
  });

  it("keeps startup disabled when the review is rejected", async () => {
    mount({ agentId: "harness" }, { ...grantState, harnessMcpConfig: config });
    fireEvent.click(await screen.findByRole("button", { name: "Keep disabled" }));
    await waitFor(() => expect(native.consent).toHaveBeenCalledWith("wg-workspace", false, undefined));
    expect(await screen.findByText("MCP startup approval needed")).toBeInTheDocument();
  });

  it("revokes an approved configuration without needing a digest", async () => {
    native.review.mockResolvedValueOnce(review({ trusted: true, current: true })).mockResolvedValueOnce(review());
    mount({ agentId: "harness" }, { ...grantState, harnessMcpConfig: config });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke approval" }));
    await waitFor(() => expect(native.consent).toHaveBeenCalledWith("wg-workspace", false, undefined));
    expect(await screen.findByText("MCP startup approval needed")).toBeInTheDocument();
  });

  it("reloads the review instead of refreshing tools after a stale-digest rejection", async () => {
    const refresh = vi.fn(async () => {});
    native.review.mockResolvedValueOnce(review()).mockResolvedValueOnce(review({ configurationDigest: "digest-two" }));
    native.consent.mockRejectedValueOnce(new Error("The MCP configuration changed. Review it again before approving."));
    mount({ agentId: "harness" }, { ...grantState, harnessMcpConfig: config, refreshHarnessMcp: refresh });
    fireEvent.click(await screen.findByRole("button", { name: "Approve startup" }));
    await waitFor(() => expect(native.review).toHaveBeenCalledTimes(2));
    expect(refresh).not.toHaveBeenCalledWith("s1", true);
    expect(await screen.findByText("MCP startup approval needed")).toBeInTheDocument();
  });

  it("does not ask for workspace approval when only home servers are configured", async () => {
    native.review.mockResolvedValue(review({ trusted: true, current: true, hasWorkspaceConfig: false }));
    mount({ agentId: "harness" }, { ...grantState, harnessMcpConfig: { servers: [config.servers[1]], error: null } });
    await waitFor(() => expect(native.review).toHaveBeenCalledWith("wg-workspace"));
    expect(screen.queryByRole("button", { name: "Approve startup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke approval" })).toBeNull();
  });

  it("adds a stdio server with parsed arguments and environment names", async () => {
    const add = vi.fn(async () => {});
    mount({ agentId: "harness" }, { addHarnessMcpServer: add, harnessMcpConfig: { servers: [], error: null } });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "docs" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.change(screen.getByLabelText("Arguments"), { target: { value: '-y "server folder" .' } });
    fireEvent.change(screen.getByLabelText("Environment (optional)"), { target: { value: "TOKEN=secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(add).toHaveBeenCalledWith("s1", "workspace", {
      name: "docs",
      transport: "stdio",
      command: "npx",
      args: ["-y", "server folder", "."],
      env: { TOKEN: "secret" },
    }));
  });

  it("refuses a name the config parser would reject, before writing anything", () => {
    const add = vi.fn(async () => {});
    mount({ agentId: "harness" }, { addHarnessMcpServer: add, harnessMcpConfig: { servers: [], error: null } });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "two words" } });
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "npx" } });
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/letters, digits, dots/);
    expect(add).not.toHaveBeenCalled();
  });

  it("removes a server from the file that defines it after confirmation", async () => {
    const remove = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    mount({ agentId: "harness" }, { confirm, removeHarnessMcpServer: remove, harnessMcpConfig: config });
    fireEvent.click(screen.getByTitle("Remove broken"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("s1", "workspace", "broken"));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Remove broken?", danger: true }));
  });

});
