import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TerminalPane } from "./TerminalPane";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";

describe("TerminalPane", () => {
  beforeEach(() => {
    resetStore();
    seedStore({ workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }], selectedWorkspaceId: "w", preview: false });
  });

  it("renders nothing until it is opened, and closes from its header", () => {
    const view = render(<TerminalPane />);
    expect(screen.queryByRole("complementary", { name: "Terminal" })).toBeNull();
    seedStore({ terminalOpen: true });
    view.rerender(<TerminalPane />);
    expect(screen.getByRole("complementary", { name: "Terminal" })).toHaveTextContent("/repo");
    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(useAppStore.getState().terminalOpen).toBe(false);
  });

  it("stays off, with the reason, when there is no desktop shell", () => {
    seedStore({ terminalOpen: true });
    render(<TerminalPane />);
    // The test environment is a browser, not the desktop shell.
    expect(screen.getByRole("status")).toHaveTextContent("needs the desktop app");
    expect(document.querySelector(".terminal-host")).toBeNull();
  });

  it("keeps the terminal closed when the saved preference disables it", () => {
    seedStore({ terminalOpen: true, disableTerminal: true });
    render(<TerminalPane />);
    expect(screen.getByRole("status")).toHaveTextContent("disabled in Settings → Permissions");
    expect(document.querySelector(".terminal-host")).toBeNull();
  });
});
