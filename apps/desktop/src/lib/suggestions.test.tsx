import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSuggestionPrompt, cheapestModel, parseSuggestions, suggestionSignature } from "./suggestions";
import { bridge } from "./bridge";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "./store";
import type { GitSnapshot, Model, Workspace } from "./types";

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  return {
    ...actual,
    bridge: vi.fn((method: string, params: Record<string, unknown> = {}, options?: { timeoutMs?: number }) => actual.bridge(method, params, options)),
  };
});

const workspace: Workspace = { id: "w", path: "/repo", name: "repo", grantId: "g" } as Workspace;
const git = (files: Array<{ path: string; status: string }> = []): GitSnapshot => ({ repository: true, branch: "main", dirty: files.length > 0, files: files.map((file) => ({ ...file, added: 0, removed: 0 })), diff: "" });
const input = (over: Partial<Parameters<typeof suggestionSignature>[0]> = {}) => ({
  workspace,
  git: git([{ path: "src/app.ts", status: " M" }]),
  files: ["src/app.ts", "src/lib.ts", "package.json"],
  threads: [{ title: "Add login", updatedAt: "2026-01-01T00:00:00Z", lastOutcome: "completed" as const, percentComplete: 40 }],
  prompts: ["fix the header"],
  ...over,
});

describe("suggestionSignature", () => {
  it("is stable for identical state and changes when the state moves", () => {
    const a = input();
    assertStable();
    function assertStable() {
      expect(suggestionSignature(a)).toBe(suggestionSignature(input()));
      expect(suggestionSignature(a)).toBe(suggestionSignature({ ...a, prompts: ["different prompt entirely"] }));
      expect(suggestionSignature(a)).not.toBe(suggestionSignature({ ...a, threads: [{ ...a.threads[0], title: "Rename login" }] }));
      expect(suggestionSignature(a)).not.toBe(suggestionSignature({ ...a, git: git([{ path: "src/app.ts", status: " M" }, { path: "b.ts", status: "??" }]) }));
      expect(suggestionSignature(a)).not.toBe(suggestionSignature({ ...a, files: [...a.files, "new.ts"] }));
      expect(suggestionSignature(a)).not.toBe(suggestionSignature({ ...a, threads: [...a.threads, { title: "Second", updatedAt: "2026-01-02T00:00:00Z" }] }));
      expect(suggestionSignature(a)).not.toBe(suggestionSignature({ ...a, workspace: { ...workspace, id: "other" } }));
    }
  });
  it("does not depend on dirty-file order", () => {
    const left = input({ git: git([{ path: "a.ts", status: " M" }, { path: "b.ts", status: "??" }]) });
    const right = input({ git: git([{ path: "b.ts", status: "??" }, { path: "a.ts", status: " M" }]) });
    expect(suggestionSignature(left)).toBe(suggestionSignature(right));
  });
});

describe("buildSuggestionPrompt", () => {
  it("names the workspace, branch, dirty paths, and thread titles — never file contents", () => {
    const prompt = buildSuggestionPrompt(input());
    expect(prompt).toContain("Workspace: repo");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain(" M src/app.ts");
    expect(prompt).toContain('"Add login"');
    expect(prompt).not.toContain("completed");
    expect(prompt).not.toContain("40%");
    expect(prompt).not.toContain("/repo");
    expect(prompt).not.toContain("fix the header");
    expect(prompt).not.toContain("Recent prompts");
    expect(prompt).toContain("JSON array");
  });
  it("bounds the file list so huge workspaces stay a small prompt", () => {
    const files = Array.from({ length: 200 }, (_, index) => `src/file-${String(index).padStart(3, "0")}.ts`);
    const prompt = buildSuggestionPrompt(input({ files }));
    expect(prompt.match(/^ {2}src\//gm)).toHaveLength(120);
    expect(prompt).toContain("… 80 more");
    expect(prompt.length).toBeLessThan(10_000);
  });
  it("handles a workspace with no git, files, or threads", () => {
    const prompt = buildSuggestionPrompt({ workspace, git: null, files: [], threads: [], prompts: [] });
    expect(prompt).toContain("Workspace: repo");
    expect(prompt).not.toContain("Branch:");
  });
});

describe("parseSuggestions", () => {
  it("parses a clean array", () => {
    const items = parseSuggestions('[{"title":"Fix login","prompt":"Fix the login form"},{"title":"Add tests","prompt":"Cover auth.ts"}]');
    expect(items).toEqual([{ title: "Fix login", prompt: "Fix the login form" }, { title: "Add tests", prompt: "Cover auth.ts" }]);
  });
  it("unwraps prose and code fences around the array", () => {
    const fenced = 'Here are ideas:\n```json\n[{"title":"Tidy","prompt":"Clean dead code"}]\n```\nDone.';
    expect(parseSuggestions(fenced)).toEqual([{ title: "Tidy", prompt: "Clean dead code" }]);
  });
  it("rejects malformed, empty, and non-array replies", () => {
    expect(parseSuggestions("")).toEqual([]);
    expect(parseSuggestions("no brackets here")).toEqual([]);
    expect(parseSuggestions("{not json [")).toEqual([]);
    expect(parseSuggestions('{"title":"x"}')).toEqual([]);
    expect(parseSuggestions("[1,2,3]")).toEqual([]);
    expect(parseSuggestions('[{"title":"x"}]')).toEqual([]);
  });
  it("clips oversized fields and drops empty entries", () => {
    const items = parseSuggestions(JSON.stringify([
      { title: "", prompt: "skip me" },
      { title: "  ", prompt: "skip me too" },
      { title: "A".repeat(80), prompt: "B".repeat(400) },
    ]));
    expect(items).toHaveLength(1);
    expect(items[0].title.length).toBeLessThanOrEqual(42);
    expect(items[0].prompt.length).toBeLessThanOrEqual(240);
  });
  it("caps the count at four", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ title: `Idea ${index}`, prompt: `Do ${index}` }));
    expect(parseSuggestions(JSON.stringify(many))).toHaveLength(4);
  });
});

describe("cheapestModel", () => {
  const model = (modelId: string, inputCost?: string, extra: Partial<Model> = {}): Model => ({ modelId, cost: inputCost === undefined ? null : { input: inputCost, output: "5" }, ...extra });
  it("picks the lowest input price, default breaking ties", () => {
    expect(cheapestModel([model("a", "1.50"), model("b", "0.25"), model("c", "3.00")])?.modelId).toBe("b");
    expect(cheapestModel([model("a", "1.00"), model("b", "1.00", { isDefault: true })])?.modelId).toBe("b");
  });
  it("treats unpriced rows as most expensive and skips unavailable ones", () => {
    expect(cheapestModel([model("free-tier"), model("paid", "0.10")])?.modelId).toBe("paid");
    expect(cheapestModel([model("gone", "0.01", { unavailable: true }), model("ok", "2.00")])?.modelId).toBe("ok");
    expect(cheapestModel([])).toBeUndefined();
    expect(cheapestModel([model("gone", "0.01", { unavailable: true })])).toBeUndefined();
  });
});

describe("refreshSuggestions", () => {
  const muse = { id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "", authenticated: true } as const;
  beforeEach(() => {
    resetStore();
    seedStore({ workspaces: [workspace], selectedWorkspaceId: "w", selectedSessionId: null, threads: [], suggestionsEnabled: true, agents: [muse] });
  });
  it("is opt-in: nothing happens while disabled", async () => {
    seedStore({ suggestionsEnabled: false });
    await useAppStore.getState().refreshSuggestions();
    expect(useAppStore.getState().suggestions).toBeNull();
  });
  it("generates predicted starters from a mocked agent reply", async () => {
    seedStore({ fileIndex: { workspaceId: "w", paths: ["src/app.ts"], loadedAt: 1 }, gitLoading: false, git: git() });
    await useAppStore.getState().refreshSuggestions();
    const suggestions = useAppStore.getState().suggestions;
    expect(suggestions?.workspaceId).toBe("w");
    expect(suggestions?.items).toHaveLength(4);
    expect(suggestions?.items[0].title).toBeTruthy();
    // A repeat call with unchanged state serves the cache, not another run.
    const suggests = () => vi.mocked(bridge).mock.calls.filter((call) => call[0] === "suggest");
    const before = suggests().length;
    await useAppStore.getState().refreshSuggestions();
    expect(useAppStore.getState().suggestions?.items).toBe(suggestions?.items);
    expect(suggests()).toHaveLength(before);
  });
  it("asks again once git and the file index arrive, and does not send the workspace path or recent prompts", async () => {
    const calls = vi.mocked(bridge);
    const real = calls.getMockImplementation()!;
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let suggests = 0;
    calls.mockImplementation(async (method, params, options) => {
      if (method === "suggest") {
        suggests += 1;
        if (suggests === 1) await gate;
      }
      return real(method, params, options);
    });
    const suggestCalls = () => calls.mock.calls.filter((call) => call[0] === "suggest");
    try {
      seedStore({
        workspaces: [{ ...workspace, id: "follow", path: "/follow", name: "follow", grantId: "g-follow" }],
        selectedWorkspaceId: "follow",
        gitLoading: true,
        fileIndex: null,
        promptHistory: { follow: ["fix the header"] },
      });
      const first = useAppStore.getState().refreshSuggestions();
      await vi.waitFor(() => expect(suggests).toBe(1));
      const sent = suggestCalls()[0][1] as Record<string, unknown>;
      expect(sent.grantId).toBe("g-follow");
      expect(sent).not.toHaveProperty("workspaceRoot");
      expect(String(sent.prompt)).not.toContain("fix the header");
      expect(String(sent.prompt)).not.toContain("/follow");
      useAppStore.setState({
        gitLoading: false,
        git: git([{ path: "src/app.ts", status: " M" }]),
        fileIndex: { workspaceId: "follow", paths: ["src/app.ts"], loadedAt: 1 },
      });
      void useAppStore.getState().refreshSuggestions();
      openGate();
      await first;
      await vi.waitFor(() => expect(suggestCalls()).toHaveLength(2));
      const next = suggestCalls()[1][1] as Record<string, unknown>;
      expect(String(next.prompt)).toContain("Branch: main");
      expect(String(next.prompt)).toContain("src/app.ts");
      expect(String(next.prompt)).not.toContain("fix the header");
      expect(next).not.toHaveProperty("workspaceRoot");
      expect(next.grantId).toBe("g-follow");
    } finally {
      openGate();
      calls.mockImplementation(real);
    }
  });
  it("seeds canned starters in preview without an agent", () => {
    seedStore({ preview: true, agents: [], detection: null });
    void useAppStore.getState().refreshSuggestions();
    expect(useAppStore.getState().suggestions?.items).toHaveLength(4);
  });
});
