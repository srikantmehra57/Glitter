import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilesPanel } from "./FilesPanel";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";

const workspace = { id: "w", path: "/repo", name: "repo", grantId: "g" };

describe("FilesPanel", () => {
  beforeEach(() => {
    resetStore();
    seedStore({
      workspaces: [workspace], selectedWorkspaceId: "w", preview: false,
      fileIndex: { workspaceId: "w", paths: ["README.md", "src/app.ts", "src/lib/util.ts"], loadedAt: Date.now() },
      git: { repository: true, branch: "main", dirty: true, files: [{ path: "src/app.ts", status: " M", added: 1, removed: 0 }], diff: "", truncated: false },
    });
  });

  it("browses the tree, filters, and narrows to changed files with their status", async () => {
    const user = userEvent.setup();
    const openFile = vi.fn(async () => {});
    useAppStore.setState({ openFile });
    render(<FilesPanel workspace={workspace} />);
    expect(screen.getByRole("button", { name: "README.md" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /app\.ts/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByRole("button", { name: "src" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("git status M")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /app\.ts/ }));
    expect(openFile).toHaveBeenCalledWith("src/app.ts");

    await user.type(screen.getByRole("textbox", { name: "Filter files" }), "util");
    expect(screen.getByRole("button", { name: "src/lib/util.ts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "README.md" })).toBeNull();
    await user.clear(screen.getByRole("textbox", { name: "Filter files" }));

    await user.click(screen.getByRole("checkbox", { name: "Changed only" }));
    expect(screen.getByRole("button", { name: /app\.ts/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "README.md" })).toBeNull();
    expect(screen.queryByRole("button", { name: /util\.ts/ })).toBeNull();
  });

  it("shows a file read-only with its actions, and says when there is no preview", async () => {
    const user = userEvent.setup();
    seedStore({ fileView: { path: "src/app.ts", loading: false, file: { path: "src/app.ts", content: "export const a = 1;\n", size: 20, truncated: true } } });
    const view = render(<FilesPanel workspace={workspace} />);
    expect(screen.getByLabelText("Contents of src/app.ts")).toHaveTextContent("export const a = 1;");
    expect(screen.getByText(/Showing the first/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to thread" }));
    expect(useAppStore.getState().contextRefs.map((ref) => ref.path)).toEqual(["src/app.ts"]);
    await user.click(screen.getByRole("button", { name: "Back to files" }));
    expect(useAppStore.getState().fileView).toBeNull();

    seedStore({ fileView: { path: "logo.png", loading: false, file: { path: "logo.png", size: 900, truncated: false, skipped: "binary" } } });
    view.rerender(<FilesPanel workspace={workspace} />);
    expect(screen.getByText(/not text, so it has no preview/)).toBeInTheDocument();
    seedStore({ fileView: { path: "x.ts", loading: false, error: "Could not open the file: gone" } });
    view.rerender(<FilesPanel workspace={workspace} />);
    expect(screen.getByRole("alert")).toHaveTextContent("gone");
  });
});
