import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ExtensionsView } from "./ExtensionsView";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";
import type { Thread } from "../lib/types";

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

function mount(partial: Partial<Thread>) {
  // The view refreshes the CLI inventories on mount; these tests are about the session catalog.
  seedStore({ threads: [thread(partial)], selectedSessionId: "s1", refreshManagedSkills: vi.fn(async () => {}), refreshPlugins: vi.fn(async () => {}), refreshMcpServers: vi.fn(async () => {}) });
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
    expect(screen.getByText(/No skills yet\. Add a folder with a SKILL\.md/)).toBeInTheDocument();
  });

  it("names the agents that have skills when the thread runs on another one", () => {
    mount({ agentId: "opencode" });
    expect(screen.getByText("Skills work with Muse and Harness; this thread runs on another agent.")).toBeInTheDocument();
    expect(screen.queryByText(/Harness loads skills from/)).toBeNull();
  });
});
