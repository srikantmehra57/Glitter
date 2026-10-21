import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ReviewDock } from "./ReviewDock";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "../lib/store";
import { clampDockWidth, dockWidthBounds, sidebarWidthFor } from "../lib/reviewLayout";
import type { GitSnapshot } from "../lib/types";
import { reviewTarget } from "../lib/diff";
import { MOCK_THREADS } from "../lib/mock";

const git = (partial: Partial<GitSnapshot> = {}): GitSnapshot => ({
  repository: true, branch: "main", dirty: true, diff: "", truncated: false, files: [], ...partial,
});

beforeEach(() => {
  resetStore();
  seedStore({ preview: true, dockOpen: true, inspectorTab: "changes", workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w", git: {
    repository: true, branch: "main", dirty: true, diff: "", files: [
      { path: "src/App.tsx", status: " M", added: 2, removed: 1 },
      { path: "tests/App.tsx", status: "M ", added: 1, removed: 0 },
    ],
  } });
});

it("switches scope from the keyboard and keeps scoped diffs read-only", async () => {
  seedStore({ inspectorTab: "diff" });
  render(<ReviewDock />);
  const scope = screen.getByRole("button", { name: "Review scope" });
  fireEvent.keyDown(scope, { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("option", { name: "All changes" }), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("option", { name: "Last turn" }), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("option", { name: "Staged" }), { key: "Enter" });
  await waitFor(() => expect(screen.getByRole("log", { name: "Staged diff" })).toHaveTextContent("background: var(--surface-2)"));
  expect(scope).toHaveFocus();
  expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Copy patch" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export patch" })).toBeInTheDocument();
});

it("reviews saved Last turn changes after Undo in a folder without Git", async () => {
  const original = MOCK_THREADS[0];
  const snapshots = Object.fromEntries(Object.entries(original.snapshots ?? {}).map(([id, snapshot]) => [id, { ...snapshot, state: "undone" as const }]));
  seedStore({ inspectorTab: "diff", reviewScope: "lastTurn", git: git({ repository: false, dirty: false }), selectedSessionId: original.sessionId, threads: [{ ...original, workspacePath: "/repo", snapshots }] });
  render(<ReviewDock />);
  await waitFor(() => expect(screen.getByRole("log", { name: "Last turn diff" })).toHaveTextContent("background: var(--surface-2)"));
  expect(screen.queryByRole("button", { name: "Initialize repository" })).toBeNull();
  expect(screen.getByText(/Saved changes during the last finished run/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
});

it("shows the missing Last turn state without leaking the All changes patch", async () => {
  seedStore({ inspectorTab: "diff", reviewScope: "lastTurn", selectedSessionId: "s", threads: [{ sessionId: "s", workspacePath: "/repo", title: "Work", updatedAt: "now", status: "idle", unread: false, lastTurnId: "t", items: [] }], git: git({ diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+unrelated patch\n" }) });
  render(<ReviewDock />);
  expect(screen.getByText(/last turn has no saved file state/)).toBeInTheDocument();
  expect(screen.getByRole("log", { name: "Last turn diff" })).not.toHaveTextContent("unrelated patch");
  expect(screen.queryByRole("button", { name: "Copy patch" })).toBeNull();
});

it("requires a base for Branch and clears the previous patch when a comparison fails", async () => {
  seedStore({ inspectorTab: "diff", reviewScope: "branch" });
  render(<ReviewDock />);
  expect(screen.getByText(/Choose a base branch or commit/)).toBeInTheDocument();
  const input = screen.getByRole("textbox", { name: "Base branch or commit" });
  fireEvent.change(input, { target: { value: "main" } });
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  await waitFor(() => expect(screen.getByRole("log", { name: "Branch diff" })).toHaveTextContent("scope = 'branch'"));
  expect(screen.getByText(/common ancestor with main/)).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "missing" } });
  fireEvent.click(screen.getByRole("button", { name: "Compare" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("preview supports");
  expect(screen.getByRole("log", { name: "Branch diff" })).not.toHaveTextContent("scope = 'branch'");
  expect(screen.queryByRole("button", { name: "Copy patch" })).toBeNull();
});

it("lets a scoped file chooser reopen a closed file without returning to All changes", async () => {
  seedStore({ inspectorTab: "diff", reviewScope: "staged" });
  render(<ReviewDock />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "host.ts" })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Close packages/glitter-bridge/src/host.ts" }));
  expect(screen.queryByRole("tab", { name: "host.ts" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review file" }));
  fireEvent.click(screen.getByRole("option", { name: "packages/glitter-bridge/src/host.ts" }));
  expect(useAppStore.getState().reviewScope).toBe("staged");
  expect(screen.getByRole("tab", { name: "host.ts" })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("log", { name: "Staged diff" })).toHaveTextContent("history = opening.items");
});

it("masks an old workspace's scoped data while the new workspace loads", async () => {
  seedStore({ inspectorTab: "diff", reviewScope: "staged", refreshReview: vi.fn(async () => {}) });
  const key = reviewTarget(useAppStore.getState()).key;
  seedStore({ review: { key, data: { files: [{ path: "private.txt", status: "M", added: 1, removed: 1 }], diff: "diff --git a/private.txt b/private.txt\n--- a/private.txt\n+++ b/private.txt\n@@ -1 +1 @@\n-old\n+private old workspace\n" } } });
  render(<ReviewDock />);
  expect(screen.getByRole("log", { name: "Staged diff" })).toHaveTextContent("private old workspace");
  act(() => seedStore({ workspaces: [...useAppStore.getState().workspaces, { id: "other", path: "/other", name: "other", grantId: "g2" }], selectedWorkspaceId: "other" }));
  expect(screen.getByRole("log", { name: "Staged diff" })).not.toHaveTextContent("private old workspace");
  expect(screen.queryByRole("button", { name: "Copy patch" })).toBeNull();
});

it("shows file mode changes even when the scoped patch has no text hunks", () => {
  seedStore({ inspectorTab: "diff", reviewScope: "staged", refreshReview: vi.fn(async () => {}) });
  const key = reviewTarget(useAppStore.getState()).key;
  seedStore({ review: { key, data: { files: [{ path: "run.sh", status: "M", added: 0, removed: 0 }], diff: "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n" } } });
  render(<ReviewDock />);
  const diff = screen.getByRole("log", { name: "Staged diff" });
  expect(within(diff).getByText(/old mode 100644 · new mode 100755/)).toBeInTheDocument();
  expect(within(diff).getByText("File mode changed.")).toBeInTheDocument();
});

it("distinguishes matching filenames by directory and stages the exact path using checked state", async () => {
  const stage = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn();
  seedStore({ stageGitFiles: stage, openFileDiff: open });
  render(<ReviewDock />);
  const source = screen.getByRole("button", { name: "Open changes for src/App.tsx" });
  expect(source.querySelector(".file-name")).toHaveTextContent("App.tsx");
  expect(source.querySelector(".file-directory")).toHaveTextContent("src");
  fireEvent.click(source);
  expect(open).toHaveBeenCalledWith("src/App.tsx");
  const unstaged = screen.getByRole("checkbox", { name: "Stage src/App.tsx" });
  const staged = screen.getByRole("checkbox", { name: "Stage tests/App.tsx" });
  expect(unstaged).not.toBeChecked();
  expect(staged).toBeChecked();
  fireEvent.click(unstaged);
  await waitFor(() => expect(unstaged).not.toBeDisabled());
  expect(stage).toHaveBeenLastCalledWith(["src/App.tsx"], true);
  fireEvent.click(staged);
  await waitFor(() => expect(staged).not.toBeDisabled());
  expect(stage).toHaveBeenLastCalledWith(["tests/App.tsx"], false);
});

it("resizes from the keyboard within live bounds", () => {
  const setWidth = vi.fn();
  seedStore({ dockWidth: 360, setDockWidth: setWidth });
  render(<ReviewDock />);
  const handle = screen.getByRole("separator", { name: "Resize Changes pane" });
  expect(handle).toHaveAttribute("aria-orientation", "vertical");
  const { min, max } = dockWidthBounds(window.innerWidth, sidebarWidthFor(window.innerWidth, false));
  expect(handle).toHaveAttribute("aria-valuemin", String(min));
  expect(handle).toHaveAttribute("aria-valuemax", String(max));
  expect(handle).toHaveAttribute("aria-valuenow", String(clampDockWidth(360, window.innerWidth, sidebarWidthFor(window.innerWidth, false))));
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  expect(setWidth).toHaveBeenLastCalledWith(384);
  fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
  expect(setWidth).toHaveBeenLastCalledWith(300);
  fireEvent.keyDown(handle, { key: "End" });
  expect(setWidth).toHaveBeenLastCalledWith(max);
});

it("expands and restores the dock with pressed state", () => {
  const setExpanded = vi.fn();
  seedStore({ dockExpanded: false, setDockExpanded: setExpanded });
  const { rerender } = render(<ReviewDock />);
  const expand = screen.getByRole("button", { name: "Expand changes" });
  expect(expand).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(expand);
  expect(setExpanded).toHaveBeenLastCalledWith(true);
  seedStore({ dockExpanded: true });
  rerender(<ReviewDock />);
  const restore = screen.getByRole("button", { name: "Restore split view" });
  expect(restore).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(restore);
  expect(setExpanded).toHaveBeenLastCalledWith(false);
});

it("offers repository init for a plain folder but keeps real failures as errors", async () => {
  const init = vi.fn().mockResolvedValue(undefined);
  const confirm = vi.fn().mockResolvedValue(false);
  seedStore({ git: git({ repository: false, dirty: false }), initializeGit: init, confirm });
  render(<ReviewDock />);
  const button = screen.getByRole("button", { name: "Initialize repository" });
  fireEvent.click(button);
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  // Cancelling the confirmation must not call the native init at all.
  expect(init).not.toHaveBeenCalled();
  expect(confirm.mock.calls[0][0].title).toContain("repo");

  confirm.mockResolvedValue(true);
  fireEvent.click(button);
  await waitFor(() => expect(init).toHaveBeenCalledTimes(1));
});

it("shows a genuine git error instead of the init offer", () => {
  seedStore({ git: null, gitError: "git status failed: index file corrupt" });
  render(<ReviewDock />);
  expect(screen.getByRole("alert")).toHaveTextContent("index file corrupt");
  expect(screen.queryByRole("button", { name: "Initialize repository" })).toBeNull();
});

it("opens a new text file by its exact path and renders its synthetic diff", async () => {
  const open = vi.fn();
  seedStore({
    openFileDiff: open,
    inspectorTab: "changes",
    git: git({
      files: [{ path: "docs/new file.md", status: "??", added: 2, removed: 0 }],
      diff: "diff --git a/docs/new file.md b/docs/new file.md\nnew file mode 100644\n--- /dev/null\n+++ b/docs/new file.md\n@@ -0,0 +1,2 @@\n+one\n+two\n",
    }),
  });
  render(<ReviewDock />);
  fireEvent.click(screen.getByRole("button", { name: /Show 1 untracked file/ }));
  fireEvent.click(screen.getByRole("button", { name: "Open changes for docs/new file.md" }));
  expect(open).toHaveBeenCalledWith("docs/new file.md");
  await act(async () => useAppStore.setState({ inspectorTab: "diff", diffTabs: ["docs/new file.md"], diffActive: "docs/new file.md" }));
  const added = document.querySelector(".dl-add .dl-code");
  expect(added?.textContent).toBe("one");
  // Hunk discard is tracked-only: a synthetic new-file diff never offers it.
  expect(screen.queryByRole("button", { name: /Discard hunk/ })).toBeNull();
});

it("explains honestly why a new file has no preview", () => {
  seedStore({
    inspectorTab: "diff",
    diffTabs: ["blob.bin"],
    git: git({ files: [{ path: "blob.bin", status: "??", added: 0, removed: 0, previewSkipped: "binary" }] }),
  });
  render(<ReviewDock />);
  expect(screen.getByText(/binary file — no preview/)).toBeInTheDocument();
});

it("a skipped-file tab shows only its own reason, not a neighbour's patch", () => {
  seedStore({
    inspectorTab: "diff",
    diffTabs: ["a.txt", "blob.bin"],
    diffActive: "blob.bin",
    git: git({
      files: [
        { path: "a.txt", status: " M", added: 1, removed: 1 },
        { path: "blob.bin", status: "??", added: 0, removed: 0, previewSkipped: "binary" },
      ],
      diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
    }),
  });
  render(<ReviewDock />);
  // The active tab is blob.bin: its path, its reason, no a.txt patch.
  expect(document.querySelector(".diff-toolbar .path")?.textContent).toBe("blob.bin");
  expect(screen.getByText(/binary file — no preview/)).toBeInTheDocument();
  expect(document.querySelector(".dl-add")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy patch" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Export patch" })).toBeNull();
  // File-level discard still works — it deletes the new file, not a patch.
  expect(screen.getByRole("button", { name: "Discard changes to blob.bin" })).toBeInTheDocument();
});

it("an empty new file says so and still exports its header patch", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  seedStore({
    inspectorTab: "diff",
    diffTabs: ["empty.txt"],
    diffActive: "empty.txt",
    git: git({
      files: [{ path: "empty.txt", status: "??", added: 0, removed: 0 }],
      diff: "diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n--- /dev/null\n+++ b/empty.txt\n",
    }),
  });
  render(<ReviewDock />);
  expect(screen.getByText("This new file is empty.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Copy patch" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n--- /dev/null\n+++ b/empty.txt\n"));
});

it("a workspace switch during the init confirmation never calls git_init", async () => {
  const init = vi.fn().mockResolvedValue(undefined);
  const confirm = vi.fn().mockImplementation(async () => {
    // Selection moves to another workspace while the dialog is open.
    useAppStore.setState({ selectedWorkspaceId: "other" });
    return true;
  });
  seedStore({
    workspaces: [
      { id: "w", path: "/repo", name: "repo", grantId: "g" },
      { id: "other", path: "/other", name: "other", grantId: "g2" },
    ],
    git: git({ repository: false, dirty: false }),
    initializeGit: init,
    confirm,
  });
  render(<ReviewDock />);
  fireEvent.click(screen.getByRole("button", { name: "Initialize repository" }));
  await waitFor(() => expect(confirm).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  expect(init).not.toHaveBeenCalled();
});

it("offers split only when wide enough, and marks one changed word", async () => {
  let notify: ((width: number) => void) | undefined;
  globalThis.ResizeObserver = class {
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) { notify = (width: number) => callback([{ contentRect: { width } }]); }
    observe() { notify?.(400); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  seedStore({
    inspectorTab: "diff",
    diffTabs: ["a.txt"],
    diffActive: "a.txt",
    git: git({
      files: [{ path: "a.txt", status: " M", added: 1, removed: 1 }],
      diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-const v = 1;\n+const v = 2;\n",
    }),
  });
  const { container } = render(<ReviewDock />);
  // Unified by default: numbered gutter, ordered rows, word mark on "2"/"1".
  expect(container.querySelectorAll(".dl-no").length).toBeGreaterThan(0);
  expect(container.querySelector(".dl-pair")).toBeNull();
  const mark = container.querySelector(".dl-add .dl-code mark");
  expect(mark?.textContent).toBe("2");
  // Preferring split below 640px falls back to unified with a hint.
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  await waitFor(() => expect(screen.getByText("Widen Changes to use split view")).toBeInTheDocument());
  expect(container.querySelector(".dl-pair")).toBeNull();
  // Widening past the threshold makes the preference take effect.
  act(() => notify?.(800));
  await waitFor(() => expect(container.querySelectorAll(".dl-pair").length).toBeGreaterThan(0));
  const del = container.querySelector(".dl-pair .dl-del .dl-code");
  expect(del?.textContent).toBe("const v = 1;");
});

it("hunk discard keeps the native index for the second block", async () => {
  const discard = vi.fn().mockResolvedValue(undefined);
  const confirm = vi.fn().mockResolvedValue(true);
  seedStore({
    inspectorTab: "diff",
    diffTabs: ["a.txt"],
    diffActive: "a.txt",
    discardGitHunk: discard,
    confirm,
    git: git({
      files: [{ path: "a.txt", status: " M", added: 2, removed: 2 }],
      diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n@@ -10 +10 @@\n-c\n+d\n",
    }),
  });
  render(<ReviewDock />);
  fireEvent.click(screen.getByRole("button", { name: "Discard hunk 2 of a.txt" }));
  await waitFor(() => expect(discard).toHaveBeenCalledWith("a.txt", 1));
});

it("pointercancel restores the body's prior styles", () => {
  document.body.style.userSelect = "text";
  document.body.style.cursor = "wait";
  const handle = render(<ReviewDock />).container.querySelector(".dock-resize") as HTMLElement;
  fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 500 });
  expect(document.body.style.userSelect).toBe("none");
  fireEvent(handle, Object.assign(new Event("pointercancel"), { pointerId: 7 }));
  expect(document.body.style.userSelect).toBe("text");
  expect(document.body.style.cursor).toBe("wait");
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});

it("rebinds the width observer on every reopen so split still applies", async () => {
  let notify: ((width: number) => void) | undefined;
  let observations = 0;
  globalThis.ResizeObserver = class {
    constructor(callback: (entries: { contentRect: { width: number } }[]) => void) { notify = (width: number) => callback([{ contentRect: { width } }]); }
    observe() { observations += 1; notify?.(800); }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  seedStore({
    dockOpen: false,
    inspectorTab: "diff",
    diffTabs: ["a.txt"],
    diffActive: "a.txt",
    git: git({
      files: [{ path: "a.txt", status: " M", added: 1, removed: 1 }],
      diff: "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n",
    }),
  });
  const { container } = render(<ReviewDock />);
  expect(container.querySelector("aside.dock")).toBeNull();
  expect(observations).toBe(0);
  // Open → observe → prefer split → effective.
  act(() => useAppStore.setState({ dockOpen: true }));
  await waitFor(() => expect(container.querySelector("aside.dock")).not.toBeNull());
  expect(observations).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Split" }));
  await waitFor(() => expect(container.querySelectorAll(".dl-pair").length).toBeGreaterThan(0));
  // Close → reopen: a fresh observation and the preference still applies.
  act(() => useAppStore.setState({ dockOpen: false }));
  act(() => useAppStore.setState({ dockOpen: true }));
  await waitFor(() => expect(container.querySelectorAll(".dl-pair").length).toBeGreaterThan(0));
  expect(observations).toBeGreaterThanOrEqual(2);
});

it("closing the dock mid-drag restores the body's prior styles", async () => {
  document.body.style.userSelect = "text";
  document.body.style.cursor = "wait";
  seedStore({ dockOpen: true });
  const { container } = render(<ReviewDock />);
  const handle = container.querySelector(".dock-resize") as HTMLElement;
  fireEvent.pointerDown(handle, { button: 0, pointerId: 9, clientX: 500 });
  expect(document.body.style.userSelect).toBe("none");
  act(() => useAppStore.setState({ dockOpen: false }));
  expect(document.body.style.userSelect).toBe("text");
  expect(document.body.style.cursor).toBe("wait");
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});
