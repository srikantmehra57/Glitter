import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ExtensionsView } from "./ExtensionsView";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { HarnessMcpConfig, Thread } from "../lib/types";

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
  // The view refreshes the CLI inventories on mount; these tests are about the session catalog.
  seedStore({
    threads: [thread(partial)],
    selectedSessionId: "s1",
    refreshManagedSkills: vi.fn(async () => {}),
    refreshPlugins: vi.fn(async () => {}),
    refreshMcpServers: vi.fn(async () => {}),
    refreshHarnessMcp: vi.fn(async () => {}),
    refreshHarnessMcpConfig: vi.fn(async () => {}),
    addHarnessMcpServer: vi.fn(async () => {}),
    removeHarnessMcpServer: vi.fn(async () => {}),
    ...extra,
  });
  return render(<ExtensionsView embedded />);
}

describe("ExtensionsView skills", () => {
  beforeEach(resetStore);

  it("lists a Harness thread's skills, says where they load from, and Use fills the composer", () => {
    mount({ agentId: "harness", skills: [{ selector: "review", description: "Reviews a diff for bugs.", source: "project" }] });
    expect(screen.getByText("/review")).toBeInTheDocument();
    expect(screen.getByText("Reviews a diff for bugs.")).toBeInTheDocument();
    expect(screen.getByText(/Harness loads skills from/)).toHaveTextContent(".glitter/skills and .agents/skills, in the workspace and in your home folder");
    const section = screen.getByRole("region", { name: "Skills" });
    expect(within(section).getByRole("button", { name: /^Refresh$/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(useAppStore.getState().composer).toBe("/review ");
  });

  it("tells a Harness thread with no skills how to add one", () => {
    mount({ agentId: "harness", skills: [] });
    expect(screen.getByText(/No skills yet\..*SKILL\.md/)).toBeInTheDocument();
  });

  it("names the agents that have skills when the thread runs on another one", () => {
    mount({ agentId: "opencode" });
    expect(screen.getByText("Skills work with Muse and Harness; this thread runs on another agent.")).toBeInTheDocument();
    expect(screen.queryByText(/Harness loads skills from/)).toBeNull();
  });
});

describe("ExtensionsView MCP servers", () => {
  beforeEach(resetStore);

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

  it("offers the CLI list, not the add form, on a thread that is not the Harness", () => {
    mount({ agentId: "opencode" });
    expect(screen.queryByRole("button", { name: "Add server" })).toBeNull();
    expect(screen.getByText(/Servers configured for the Muse CLI/)).toBeInTheDocument();
  });
});
