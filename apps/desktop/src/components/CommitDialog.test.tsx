import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CommitDialog, type CommitDialogRequest } from "./CommitDialog";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "../lib/store";

const commitGit = vi.fn(async (_message: string, _includeUnstaged?: boolean) => {});
const pushBranch = vi.fn(async () => ({ branch: "main", remote: "origin" }));
const draftCommitMessage = vi.fn(async (_includeUnstaged?: boolean) => {});

function renderDialog(request: CommitDialogRequest = { id: 1 }) {
  const onClose = vi.fn();
  const onNotice = vi.fn();
  render(<CommitDialog request={request} onClose={onClose} onNotice={onNotice} />);
  return { onClose, onNotice };
}

beforeEach(() => {
  commitGit.mockReset().mockResolvedValue(undefined);
  pushBranch.mockReset().mockResolvedValue({ branch: "main", remote: "origin" });
  draftCommitMessage.mockReset().mockResolvedValue(undefined);
  resetStore();
  seedStore({
    preview: true,
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
    selectedWorkspaceId: "w",
    selectedSessionId: "thread-1",
    threads: [{ sessionId: "thread-1", agentId: "harness", workspacePath: "/repo", title: "Work", updatedAt: "now", status: "idle", unread: false, items: [] }],
    git: {
      repository: true,
      branch: "main",
      dirty: true,
      diff: "",
      files: [
        { path: "src/App.tsx", status: " M", added: 2, removed: 1 },
        { path: "tests/App.tsx", status: "M ", added: 1, removed: 0 },
      ],
    },
    commitGit,
    pushBranch,
    draftCommitMessage,
  });
});

it("commits once with the trimmed multiline message and included unstaged changes", async () => {
  let finish!: () => void;
  commitGit.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { onClose, onNotice } = renderDialog();

  expect(screen.getByRole("dialog", { name: "Commit or push" })).toBeInTheDocument();
  expect(screen.getByText("main")).toBeInTheDocument();
  expect(screen.getByText("+3")).toBeInTheDocument();
  expect(screen.getByText("−1")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Include unstaged changes" })).toBeChecked();
  fireEvent.change(screen.getByPlaceholderText("Commit message (leave blank to auto-generate)..."), { target: { value: "  Add environment Git actions\n\nWire the shared dialog.  " } });
  const continueButton = screen.getByRole("button", { name: "Continue" });
  fireEvent.click(continueButton);
  expect(continueButton).toBeDisabled();
  fireEvent.click(continueButton);
  expect(commitGit).toHaveBeenCalledTimes(1);
  expect(commitGit).toHaveBeenCalledWith("Add environment Git actions\n\nWire the shared dialog.", true);
  finish();
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onNotice).toHaveBeenCalledWith("Committed main.");
  expect(pushBranch).not.toHaveBeenCalled();
});

it("can keep unstaged edits out of a staged-only commit", async () => {
  renderDialog();
  fireEvent.click(screen.getByRole("checkbox", { name: "Include unstaged changes" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Commit only staged files" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(commitGit).toHaveBeenCalledWith("Commit only staged files", false));
});

it("commits before pushing when Commit and push is selected", async () => {
  const { onClose, onNotice } = renderDialog({ id: 1, operation: "commit-push" });
  fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Ship Git graph" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(commitGit).toHaveBeenCalledWith("Ship Git graph", true);
  expect(pushBranch).toHaveBeenCalledTimes(1);
  expect(commitGit.mock.invocationCallOrder[0]).toBeLessThan(pushBranch.mock.invocationCallOrder[0]);
  expect(onNotice).toHaveBeenCalledWith("Committed and pushed main to origin.");
});

it("retries only Push after the commit succeeds and the remote fails", async () => {
  pushBranch.mockRejectedValueOnce(new Error("credentials missing")).mockResolvedValueOnce({ branch: "main", remote: "origin" });
  renderDialog({ id: 1, operation: "commit-push" });
  fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Ship once" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Committed, but could not push");
  expect(commitGit).toHaveBeenCalledTimes(1);
  expect(pushBranch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("radio", { name: "Push", checked: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(pushBranch).toHaveBeenCalledTimes(2));
  expect(commitGit).toHaveBeenCalledTimes(1);
});

it("drafts a blank message and then performs the selected commit", async () => {
  draftCommitMessage.mockImplementation(async () => { useAppStore.setState({ commitDrafting: "thread-1" }); });
  const { onClose } = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(draftCommitMessage).toHaveBeenCalledWith(true));
  expect(commitGit).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Drafting a commit message");

  act(() => useAppStore.setState({ commitDrafting: null, commitDraft: { text: "Add Git actions", seq: 1, sessionId: "thread-1" } }));
  await waitFor(() => expect(commitGit).toHaveBeenCalledWith("Add Git actions", true));
  expect(onClose).toHaveBeenCalled();
});

it("does not commit a draft after the dialog is closed", async () => {
  draftCommitMessage.mockImplementation(async () => { useAppStore.setState({ commitDrafting: "thread-1" }); });
  const { onClose } = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(draftCommitMessage).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Close commit or push dialog" }));
  expect(onClose).toHaveBeenCalled();

  act(() => useAppStore.setState({ commitDrafting: null, commitDraft: { text: "Too late", seq: 1, sessionId: "thread-1" } }));
  await act(async () => { await Promise.resolve(); });
  expect(commitGit).not.toHaveBeenCalled();
});

it("cancels an automatic draft commit when the workspace changes", async () => {
  draftCommitMessage.mockImplementation(async () => { useAppStore.setState({ commitDrafting: "thread-1" }); });
  const { onClose } = renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(draftCommitMessage).toHaveBeenCalled());
  act(() => seedStore({
    workspaces: [...useAppStore.getState().workspaces, { id: "other", path: "/other", name: "other", grantId: "g2" }],
    selectedWorkspaceId: "other",
  }));
  expect(onClose).toHaveBeenCalled();

  act(() => useAppStore.setState({ commitDrafting: null, commitDraft: { text: "Wrong workspace", seq: 1, sessionId: "thread-1" } }));
  await act(async () => { await Promise.resolve(); });
  expect(commitGit).not.toHaveBeenCalled();
});

it("Escape cancels without committing or pushing", () => {
  const { onClose } = renderDialog();
  fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "Do not commit" } });
  fireEvent(screen.getByRole("dialog", { name: "Commit or push" }), new Event("cancel", { cancelable: true }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(commitGit).not.toHaveBeenCalled();
  expect(pushBranch).not.toHaveBeenCalled();
});
