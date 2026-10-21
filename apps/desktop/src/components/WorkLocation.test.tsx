import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkLocation } from "./WorkLocation";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";

describe("WorkLocation", () => {
  beforeEach(() => {
    resetStore();
    // A signed-in Muse is the ready agent: worktrees are a Muse capability.
    seedStore({ workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w", threads: [], selectedSessionId: null, preview: false, agents: [{ id: "muse", name: "Muse", protocol: "msp", found: true, path: "/bin/muse", version: "1", verified: true, signIn: "", authenticated: true }] });
  });

  it("lets a new Muse thread choose a worktree and its base", async () => {
    const user = userEvent.setup();
    render(<WorkLocation />);
    expect(screen.queryByRole("textbox", { name: "Base branch or commit" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Where this thread works" }));
    expect(screen.getByText("Its own copy and branch")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: /Worktree/ }));
    expect(useAppStore.getState().drafts["project:w"].worktree).toEqual({ base: "" });
    expect(screen.getByRole("textbox", { name: "Base branch or commit" })).toHaveAttribute("title", expect.stringContaining("last commit"));
    await user.type(screen.getByRole("textbox", { name: "Base branch or commit" }), "release");
    expect(useAppStore.getState().drafts["project:w"].worktree).toEqual({ base: "release" });
    await user.click(screen.getByRole("button", { name: "Where this thread works" }));
    await user.click(screen.getByRole("option", { name: /^Local/ }));
    expect(useAppStore.getState().drafts["project:w"].worktree).toBeUndefined();
  });

  it("is unavailable outside a repository, and absent for other agents and for existing threads", async () => {
    seedStore({ git: { repository: false, branch: "", dirty: false, files: [], diff: "", truncated: false } });
    const user = userEvent.setup();
    const view = render(<WorkLocation />);
    await user.click(screen.getByRole("button", { name: "Where this thread works" }));
    expect(screen.getByRole("option", { name: /Worktree/ })).toBeDisabled();
    expect(screen.getByText("Needs a Git repository")).toBeInTheDocument();
    view.unmount();
    seedStore({ drafts: { "project:w": { text: "", images: [], config: { agentId: "opencode" } } }, enabledAgents: { opencode: true }, agents: [{ id: "opencode", name: "OpenCode", protocol: "acp", found: true, path: "/bin/opencode", version: "1", verified: true, signIn: "" }] });
    const other = render(<WorkLocation />);
    expect(screen.queryByRole("button", { name: "Where this thread works" })).toBeNull();
    other.unmount();
    seedStore({ drafts: {}, selectedSessionId: "s1", threads: [{ sessionId: "s1", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true }] });
    render(<WorkLocation />);
    expect(screen.queryByRole("button", { name: "Where this thread works" })).toBeNull();
  });
});
