import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, seedStore } from "../test/store";
import { reconcileRunningThreads } from "./store";
import type { Thread } from "./types";

const bridgeMock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./bridge", async (original) => ({ ...(await original<typeof import("./bridge")>()), bridge: bridgeMock.call }));

describe("reconcileRunningThreads", () => {
  beforeEach(() => {
    resetStore();
    bridgeMock.call.mockReset();
    seedStore({
      preview: false,
      workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
      threads: [{
        sessionId: "session",
        workspacePath: "/repo",
        title: "Running thread",
        updatedAt: new Date(Date.now() - 60_000).toISOString(),
        status: "running",
        unread: false,
        items: [],
      } satisfies Thread],
    });
  });

  it("shares an in-flight pass and allows a new pass after it settles", async () => {
    let resolveList!: (value: { sessions: never[] }) => void;
    const pending = new Promise<{ sessions: never[] }>((resolve) => { resolveList = resolve; });
    bridgeMock.call.mockReturnValue(pending);

    const first = reconcileRunningThreads();
    const second = reconcileRunningThreads();

    expect(bridgeMock.call).toHaveBeenCalledTimes(1);
    resolveList({ sessions: [] });
    await Promise.all([first, second]);

    bridgeMock.call.mockResolvedValue({ sessions: [] });
    await reconcileRunningThreads();
    expect(bridgeMock.call).toHaveBeenCalledTimes(2);
  });
});
