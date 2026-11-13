import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { Thread } from "../lib/types";

const thread = (sessionId: string, workspacePath: string, title: string): Thread => ({ sessionId, workspacePath, title, updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true });

function seed() {
  seedStore({
    workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }, { id: "o", path: "/other", name: "other", grantId: "g2" }],
    selectedWorkspaceId: "w",
    threads: [thread("s1", "/repo", "Fix login"), thread("s2", "/other", "Billing export")],
    selectedSessionId: "s1",
    fileIndex: { workspaceId: "w", paths: ["src/auth/login.ts", "README.md"], loadedAt: Date.now() },
    paletteOpen: true,
    preview: false,
  });
}
const headings = () => [...document.querySelectorAll(".palette-heading")].map((node) => node.textContent);

describe("CommandPalette", () => {
  beforeEach(() => { resetStore(); seed(); });

  it("groups commands into sections and keeps files and other workspaces for a search", async () => {
    const user = userEvent.setup();
    render(<CommandPalette />);
    expect(headings()).toEqual(["Actions", "Threads", "Settings"]);
    const box = screen.getByRole("combobox", { name: "Filter commands" });
    const listbox = screen.getByRole("listbox", { name: "Commands" });
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box).toHaveAttribute("aria-controls", listbox.id);
    expect(box).toHaveAttribute("aria-activedescendant", `${listbox.id}-0`);
    expect(document.getElementById(`${listbox.id}-0`)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: /Fix login/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Billing export/ })).toBeNull();
    expect(screen.getByRole("option", { name: "Settings · Diagnostics" })).toBeInTheDocument();

    await user.type(screen.getByRole("combobox", { name: "Filter commands" }), "billing");
    expect(headings()).toEqual(["Threads"]);
    expect(screen.getByRole("option", { name: "Billing export · other" })).toBeInTheDocument();

    await user.clear(screen.getByRole("combobox", { name: "Filter commands" }));
    await user.type(screen.getByRole("combobox", { name: "Filter commands" }), "login");
    expect(headings()).toEqual(["Threads", "Files"]);
    await user.click(screen.getByRole("option", { name: "Open file · src/auth/login.ts" }));
    await vi.waitFor(() => expect(useAppStore.getState().fileView?.path).toBe("src/auth/login.ts"));
    expect(useAppStore.getState().inspectorTab).toBe("files");
    expect(useAppStore.getState().paletteOpen).toBe(false);
    expect(useAppStore.getState().recentCommands, "files and threads are not commands").toEqual([]);
  });

  it("opens a settings tab, switches theme and remembers recent commands", async () => {
    const user = userEvent.setup();
    const commitSettings = vi.fn(async () => {});
    useAppStore.setState({ commitSettings, theme: "dark" });
    const view = render(<CommandPalette />);
    expect(screen.queryByRole("option", { name: "Use dark theme" })).toBeNull();
    await user.type(screen.getByRole("combobox", { name: "Filter commands" }), "mcp{Enter}");
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(useAppStore.getState().settingsTab).toBe("Extensions");

    useAppStore.setState({ paletteOpen: true, settingsOpen: false });
    view.rerender(<CommandPalette />);
    await user.click(screen.getByRole("option", { name: "Use light theme" }));
    expect(commitSettings).toHaveBeenCalledWith({ theme: "light" });
    expect(useAppStore.getState().recentCommands).toEqual(["theme-light", "settings-Extensions"]);

    useAppStore.setState({ paletteOpen: true });
    view.rerender(<CommandPalette />);
    expect(headings()[0]).toBe("Recent");
    const first = document.querySelectorAll(".palette li")[0] as HTMLElement;
    expect(within(first).getByRole("option")).toHaveTextContent("Use light theme");
  });

  it("offers thread commands only where they apply", () => {
    seedStore({ threads: [{ ...thread("s1", "/repo", "Fix login"), agentId: "harness" }] });
    render(<CommandPalette />);
    expect(screen.getByRole("option", { name: "Rename thread" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Fork thread" })).toBeNull();
    expect(screen.queryByRole("option", { name: /Export thread/ })).toBeNull();
    expect(screen.queryByRole("option", { name: "Change permissions" })).toBeNull();
  });
});
