import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BranchMenu } from "./BranchMenu";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";

const git = (dirty: boolean) => ({ repository: true, branch: "main", dirty, files: [], diff: "", truncated: false });

describe("BranchMenu", () => {
  beforeEach(() => {
    resetStore();
    seedStore({ git: git(false), branches: [{ name: "main", current: true }, { name: "dev", current: false, upstream: "origin/dev" }] });
  });

  it("switches to a listed branch and creates a new one", async () => {
    const user = userEvent.setup();
    const switchBranch = vi.fn(async () => {});
    useAppStore.setState({ switchBranch, refreshBranches: vi.fn(async () => {}) });
    render(<BranchMenu branch="main" worktree={false} locked={false} />);
    await user.click(screen.getByRole("button", { name: /Current branch: main/ }));
    expect(screen.getByRole("button", { name: "main" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "dev" }));
    expect(switchBranch).toHaveBeenLastCalledWith("dev", false);
    expect(screen.queryByRole("dialog", { name: "Branches" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Current branch: main/ }));
    await user.type(screen.getByRole("textbox", { name: "New branch name" }), "feature/x{Enter}");
    expect(switchBranch).toHaveBeenLastCalledWith("feature/x", true);
  });

  it("asks before switching with uncommitted changes and shows why a switch was refused", async () => {
    const user = userEvent.setup();
    const switchBranch = vi.fn(async () => { throw new Error("Your uncommitted changes would be overwritten on that branch."); });
    const confirm = vi.fn(async () => false);
    useAppStore.setState({ git: git(true), switchBranch, confirm, refreshBranches: vi.fn(async () => {}) });
    render(<BranchMenu branch="main" worktree={false} locked={false} />);
    await user.click(screen.getByRole("button", { name: /uncommitted changes/ }));
    await user.click(screen.getByRole("button", { name: "dev" }));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Switch to dev with uncommitted changes?" }));
    expect(switchBranch).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    await user.click(screen.getByRole("button", { name: "dev" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("would be overwritten");
    expect(screen.getByRole("dialog", { name: "Branches" })).toBeInTheDocument();
  });

  it("is a plain label without a repository and locked while a turn runs", () => {
    const view = render(<BranchMenu branch="main" worktree={false} locked />);
    expect(screen.getByRole("button", { name: /Current branch: main/ })).toBeDisabled();
    seedStore({ git: null });
    view.rerender(<BranchMenu branch="main" worktree={false} locked={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("main")).toBeInTheDocument();
  });
});
