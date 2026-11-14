import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "./store";

const bridgeMock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./bridge", async (original) => ({ ...(await original<typeof import("./bridge")>()), bridge: bridgeMock.call }));

describe("model listing", () => {
  beforeEach(() => {
    resetStore();
    bridgeMock.call.mockReset();
    seedStore({
      preview: false,
      workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
      selectedWorkspaceId: "w",
      threads: [{ sessionId: "s1", agentId: "harness", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [] }],
      selectedSessionId: "s1",
      agents: [{ id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true }],
    });
  });

  it("shows an empty library listing as-is, without probing again", async () => {
    // The library holds only what the user added, so an empty answer is meaningful.
    bridgeMock.call.mockImplementation(async (method: string) => method === "listModels" ? { models: [] } : {});
    await useAppStore.getState().refreshModels();
    expect(bridgeMock.call.mock.calls.filter(([method]) => method === "listModels")).toHaveLength(1);
    expect(useAppStore.getState().models).toEqual([]);
  });

  it("does not probe again when the listing has models", async () => {
    bridgeMock.call.mockImplementation(async (method: string) => method === "listModels" ? { models: [{ modelId: "xai/grok-4.6", providerId: "xai" }] } : {});
    await useAppStore.getState().refreshModels();
    expect(bridgeMock.call.mock.calls.filter(([method]) => method === "listModels")).toHaveLength(1);
  });
});
