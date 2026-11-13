import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetStore, seedStore } from "../test/store";
import { bindBridgeEvents, useAppStore } from "./store";
import type { PermissionRule, Thread } from "./types";

const bridgeMock = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }));
vi.mock("./bridge", async (original) => ({ ...(await original<typeof import("./bridge")>()), bridge: bridgeMock.call, onBridgeEvent: bridgeMock.subscribe }));

const oldRules: PermissionRule[] = [{ effect: "deny", rule: "Edit(old.txt)" }];
const newRules: PermissionRule[] = [{ effect: "deny", rule: "Edit(new.txt)" }];

describe("persistent permission rules", () => {
  beforeEach(() => {
    resetStore();
    bridgeMock.call.mockReset();
    bridgeMock.subscribe.mockReset();
    seedStore({ preview: false, harnessRules: oldRules });
  });

  it("does not cache an acknowledgement from a bridge that has exited", async () => {
    let receive!: (event: string, payload: unknown) => void;
    bridgeMock.subscribe.mockImplementation((callback) => { receive = callback; return () => {}; });
    const unbind = bindBridgeEvents();
    let release!: (value: { problems: string[] }) => void;
    const firstResponse = new Promise<{ problems: string[] }>((resolve) => { release = resolve; });
    bridgeMock.call.mockReturnValueOnce(firstResponse).mockResolvedValue({ problems: [] });
    const first = useAppStore.getState().applyHarnessRules(true);
    await vi.waitFor(() => expect(bridgeMock.call).toHaveBeenCalledTimes(1));
    receive("bridgeExit", { kind: "crash" });
    release({ problems: [] });
    await expect(first).rejects.toThrow(/connection restarted/);
    await useAppStore.getState().applyHarnessRules();
    expect(bridgeMock.call).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().harnessRulesError).toBeNull();
    unbind();
  });

  it("serializes overlapping updates and leaves the latest rules installed", async () => {
    let release!: (value: { problems: string[] }) => void;
    const firstResponse = new Promise<{ problems: string[] }>((resolve) => { release = resolve; });
    bridgeMock.call.mockReturnValueOnce(firstResponse).mockResolvedValue({ problems: [] });
    const first = useAppStore.getState().applyHarnessRules(true);
    await vi.waitFor(() => expect(bridgeMock.call).toHaveBeenCalledTimes(1));
    seedStore({ harnessRules: newRules });
    const second = useAppStore.getState().applyHarnessRules(true);
    await Promise.resolve();
    expect(bridgeMock.call).toHaveBeenCalledTimes(1);
    release({ problems: [] });
    await Promise.all([first, second]);
    expect(bridgeMock.call.mock.calls.map(([, params]) => params.rules)).toEqual([oldRules, newRules]);
  });

  it("keeps a draft unsent when the current rules cannot be applied", async () => {
    bridgeMock.call.mockRejectedValue(new Error("bridge unavailable"));
    const thread: Thread = { sessionId: "s1", agentId: "harness", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "idle", unread: false, items: [], opened: true };
    seedStore({
      workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
      selectedWorkspaceId: "w", selectedSessionId: "s1", threads: [thread], composer: "keep this draft",
    });
    const sent = await useAppStore.getState().sendPrompt();
    expect(sent).toBe(false);
    expect(useAppStore.getState().composer).toBe("keep this draft");
    expect(bridgeMock.call.mock.calls.some(([method]) => method === "sendTurn")).toBe(false);
    expect(bridgeMock.call.mock.calls.some(([method]) => method === "harnessRules")).toBe(true);
  });

  it("can still deny an approval when applying the current rules fails", async () => {
    bridgeMock.call.mockImplementation(async (method: string) => {
      if (method === "harnessRules") throw new Error("bridge unavailable");
      return {};
    });
    const thread: Thread = {
      sessionId: "s1", agentId: "harness", workspacePath: "/repo", title: "Work", updatedAt: new Date().toISOString(), status: "running", unread: false, items: [], opened: true,
      pendingApproval: { approvalId: "a1", sessionId: "s1", turnId: "t1", toolName: "bash", rawArgs: "{}", availableChoices: [
        { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
      ] },
    };
    seedStore({ threads: [thread] });
    await expect(useAppStore.getState().applyHarnessRules(true)).rejects.toThrow();
    await useAppStore.getState().decide("a1", "allow-once");
    expect(bridgeMock.call.mock.calls.some(([method]) => method === "decideApproval")).toBe(false);
    await useAppStore.getState().decide("a1", "deny", "Use a safer approach");
    expect(bridgeMock.call.mock.calls.some(([method]) => method === "decideApproval")).toBe(true);
    expect(useAppStore.getState().threads[0].pendingApproval).toBeNull();
    expect(bridgeMock.call.mock.calls.some(([method]) => method === "steerTurn" || method === "sendTurn")).toBe(false);
    expect(useAppStore.getState().threads[0].approvalFeedback?.[0]).toMatchObject({ text: "Use a safer approach", state: "failed" });
  });
});
