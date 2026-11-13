import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyAppLogPath, copySessionId, copyThreadLogPath, copyThreadPath, openAppConfig, openThreadFolder, reportThreadIssue, threadIssueUrl, threadRootPath } from "./threadActions";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "./store";
import type { Thread } from "./types";

const native = vi.hoisted(() => ({ openPath: vi.fn(), supportPaths: vi.fn(), openConfigFile: vi.fn(), openUrl: vi.fn() }));
vi.mock("./bridge", async (original) => ({ ...(await original<typeof import("./bridge")>()), openPath: native.openPath, supportPaths: native.supportPaths, openConfigFile: native.openConfigFile, openUrl: native.openUrl }));

const thread = (partial: Partial<Thread> = {}): Thread => ({
  sessionId: "h-thread-123",
  agentId: "harness",
  workspacePath: "/repo",
  title: "Fix the composer",
  updatedAt: new Date().toISOString(),
  status: "idle",
  unread: false,
  items: [],
  ...partial,
});

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  native.supportPaths.mockResolvedValue({ appLogPath: "/logs/glitter.log", sessionLogPath: "/data/harness/sessions/h-thread-123.jsonl" });
  seedStore({
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
    selectedWorkspaceId: "w",
    threads: [thread()],
  });
});

describe("thread support actions", () => {
  it("uses the worktree root and grant for Finder and copied paths", async () => {
    seedStore({ threads: [thread({ worktree: { grantId: "g-wt", path: "/worktrees/one", branch: "glitter/one", base: "main", workspaceId: "w" } })] });
    const current = useAppStore.getState().threads[0];
    expect(threadRootPath(current)).toBe("/worktrees/one");
    await openThreadFolder(current.sessionId);
    expect(native.openPath).toHaveBeenCalledWith("/worktrees/one", "g-wt", "default");
    await copyThreadPath(current.sessionId);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/worktrees/one");
  });

  it("copies the session ID and the Harness task log path", async () => {
    await copySessionId("h-thread-123");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("h-thread-123");
    await copyThreadLogPath("h-thread-123");
    expect(native.supportPaths).toHaveBeenCalledWith("h-thread-123");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/data/harness/sessions/h-thread-123.jsonl");
  });

  it("reports a missing Harness log instead of copying a guessed path", async () => {
    native.supportPaths.mockResolvedValue({ appLogPath: "/logs/glitter.log", sessionLogPath: null });
    await copyThreadLogPath("h-thread-123");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(useAppStore.getState().error).toContain("no saved session log");
  });

  it("copies the app log and opens the native config", async () => {
    await copyAppLogPath();
    expect(native.supportPaths).toHaveBeenCalledWith();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/logs/glitter.log");
    await openAppConfig();
    expect(native.openConfigFile).toHaveBeenCalledTimes(1);
  });

  it("opens a pre-filled issue draft without exposing the workspace path", async () => {
    const current = useAppStore.getState().threads[0];
    const url = new URL(threadIssueUrl(current));
    expect(url.origin + url.pathname).toBe("https://github.com/srikantmehra57/Glitter/issues/new");
    expect(url.searchParams.get("title")).toBe("Thread issue: Fix the composer");
    expect(url.searchParams.get("body")).toContain("Session ID: h-thread-123");
    expect(url.searchParams.get("body")).toContain("Agent: Harness");
    expect(url.searchParams.get("body")).not.toContain("/repo");
    await reportThreadIssue(current.sessionId);
    expect(native.openUrl).toHaveBeenCalledWith(url.toString());
  });
});
