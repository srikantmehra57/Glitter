import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EnvironmentPanel } from "./EnvironmentPanel";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "../lib/store";

const refreshHarnessMcp = vi.fn(async () => {});
const refreshHarnessMcpConfig = vi.fn(async () => {});

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  seedStore({
    preview: true,
    workspaces: [{ id: "w", path: "/repo", name: "Portfolio", grantId: "g" }],
    selectedWorkspaceId: "w",
    selectedSessionId: "thread-1",
    threads: [{
      sessionId: "thread-1",
      agentId: "harness",
      workspacePath: "/repo",
      title: "Build the portfolio",
      updatedAt: new Date(0).toISOString(),
      status: "idle",
      unread: false,
      context: { usedTokens: 4900, windowTokens: 10000 },
      items: [
        { itemId: "one", kind: "toolCall", status: "completed", presentation: { kind: "terminal", artifactPath: "outputs/resume.html" } },
        { itemId: "two", kind: "toolCall", status: "completed", presentation: { kind: "terminal", artifactPath: "outputs/SrikantMehra_ProductDesigner.pdf" } },
        { itemId: "duplicate", kind: "toolCall", status: "completed", presentation: { kind: "terminal", artifactPath: "outputs/resume.html" } },
      ],
    }],
    harnessMcpConfig: { servers: [{ name: "docs", source: "workspace", transport: "http", url: "http://localhost:4000/mcp", args: 0, envKeys: [], headerKeys: [] }], error: null },
    harnessMcp: { servers: [{ name: "docs", transport: "http", tools: 4 }], error: null },
    browserState: { status: "ready", url: "http://localhost:5191/", title: "mehra", viewport: { width: 1100, height: 760 } },
    refreshHarnessMcp,
    refreshHarnessMcpConfig,
  });
});

it("shows workspace and context facts and manages real MCP connectors", async () => {
  render(<EnvironmentPanel />);

  expect(screen.getByText("This computer")).toBeInTheDocument();
  expect(screen.getByText("Portfolio")).toBeInTheDocument();
  expect(screen.getByText("Remote Control")).toBeInTheDocument();
  expect(screen.getByText("Local only")).toBeInTheDocument();
  await waitFor(() => {
    expect(refreshHarnessMcp).toHaveBeenCalledWith("thread-1");
    expect(refreshHarnessMcpConfig).toHaveBeenCalledWith("thread-1");
  });

  const context = screen.getByRole("button", { name: /^Context/ });
  expect(context).toHaveTextContent("49%");
  expect(screen.queryByText("Context window used")).toBeNull();
  fireEvent.click(context);
  expect(screen.getByText("Context window used")).toBeInTheDocument();
  expect(screen.getByText("4.9K / 10K")).toBeInTheDocument();
  expect(screen.getByText("5.1K tokens")).toBeInTheDocument();

  expect(screen.queryByText("docs")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Connectors/ }));
  expect(screen.getByText("docs")).toBeInTheDocument();
  expect(screen.getByText("4 tools")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Manage connectors" }));
  expect(useAppStore.getState().settingsOpen).toBe(true);
  expect(useAppStore.getState().settingsTab).toBe("Extensions");

  fireEvent.click(screen.getByRole("button", { name: /Portfolio/ }));
  expect(useAppStore.getState().inspectorTab).toBe("files");
});

it("opens deduplicated saved outputs and the current local Browser server", () => {
  const openFile = vi.fn(async () => {});
  seedStore({ openFile });
  render(<EnvironmentPanel />);

  expect(screen.getAllByText("resume.html")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "resume.html" }));
  expect(openFile).toHaveBeenCalledWith("outputs/resume.html");
  fireEvent.click(screen.getByRole("button", { name: "SrikantMehra_ProductDesigner.pdf" }));
  expect(openFile).toHaveBeenCalledWith("outputs/SrikantMehra_ProductDesigner.pdf");

  expect(screen.getByText("localhost:5191")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open mehra in Browser" }));
  expect(useAppStore.getState().browserOpen).toBe(true);
});

it("keeps empty and unavailable states honest", () => {
  seedStore({
    selectedSessionId: null,
    threads: [],
    harnessMcp: null,
    harnessMcpConfig: null,
    browserState: { status: "ready", url: "https://example.com/", title: "Example", viewport: { width: 1100, height: 760 } },
  });
  render(<EnvironmentPanel />);

  expect(screen.getByRole("button", { name: /^Context/ })).toHaveTextContent("Not reported");
  expect(screen.getByRole("button", { name: /^Connectors/ })).toHaveTextContent("No thread");
  expect(screen.getByText("Saved tool outputs from this thread will appear here.")).toBeInTheDocument();
  expect(screen.getByText("Local servers opened in Browser will appear here.")).toBeInTheDocument();
  expect(screen.queryByText("Example")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});
