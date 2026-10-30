import { describe, expect, it } from "vitest";
import {
  effectiveOrchestratorAssignments,
  normalizeOrchestratorGoal,
  normalizeOrchestratorModels,
  orchestratorDisclosure,
  orchestratorModelName,
  orchestratorReady,
  orchestratorRouteCallFact,
  orchestratorRouteExecution,
  orchestratorRouteFacts,
  orchestratorRouteLabel,
  orchestratorRouteNote,
  orchestratorRouteTitle,
  orchestratorStart,
} from "./orchestrator";
import type { ModelCall, OrchestratorRoute } from "./types";

const lead = { modelId: "anthropic/claude-opus-5", providerId: "anthropic" };
const builder = { modelId: "deepseek/deepseek-v4", providerId: "deepseek" };

describe("normalizeOrchestratorModels", () => {
  it("reads known roles, trims ids and drops malformed entries", () => {
    expect(normalizeOrchestratorModels({
      lead: { modelId: "  anthropic/claude-opus-5  ", providerId: " anthropic " },
      builder,
      small: { modelId: "" },
      router: "nope",
      scout: { modelId: "x" },
    })).toEqual({ lead: { modelId: "anthropic/claude-opus-5", providerId: "anthropic" }, builder });
  });

  it("keeps a model without a provider, and trusts nothing that is not an object", () => {
    expect(normalizeOrchestratorModels({ builder: { modelId: "gpt-5.5" } })).toEqual({ builder: { modelId: "gpt-5.5" } });
    expect(normalizeOrchestratorModels(null)).toEqual({});
    expect(normalizeOrchestratorModels([])).toEqual({});
    expect(normalizeOrchestratorModels({ lead: { modelId: "x".repeat(601) } })).toEqual({});
  });
});

describe("normalizeOrchestratorGoal", () => {
  it("keeps a known goal and falls back to balanced", () => {
    expect(normalizeOrchestratorGoal("cost")).toBe("cost");
    expect(normalizeOrchestratorGoal("output")).toBe("output");
    expect(normalizeOrchestratorGoal("fastest")).toBe("balanced");
    expect(normalizeOrchestratorGoal(undefined)).toBe("balanced");
  });
});

describe("effectiveOrchestratorAssignments", () => {
  it("gives Small-task the Builder and Router the Small-task", () => {
    expect(effectiveOrchestratorAssignments({ lead, builder })).toEqual({ lead, builder, small: builder, router: builder });
  });

  it("keeps explicit roles, and resolves an explicit small for the router", () => {
    const small = { modelId: "qwen/qwen4-small", providerId: "openrouter" };
    expect(effectiveOrchestratorAssignments({ lead, builder, small })).toEqual({ lead, builder, small, router: small });
    expect(effectiveOrchestratorAssignments({ lead, builder, small, router: { modelId: "local/qwen4" } })).toMatchObject({ router: { modelId: "local/qwen4" } });
  });

  it("invents nothing without a Builder", () => {
    expect(effectiveOrchestratorAssignments({ lead })).toEqual({ lead });
  });
});

describe("orchestratorReady", () => {
  it("needs a Lead and a Builder, not the fallback roles", () => {
    expect(orchestratorReady({})).toBe(false);
    expect(orchestratorReady({ lead })).toBe(false);
    expect(orchestratorReady({ builder })).toBe(false);
    expect(orchestratorReady({ lead, builder })).toBe(true);
  });
});

describe("orchestratorStart", () => {
  it("starts a session only while enabled and both required roles are assigned", () => {
    expect(orchestratorStart({ orchestratorEnabled: false, orchestratorGoal: "cost", orchestratorModels: { lead, builder } })).toBeUndefined();
    expect(orchestratorStart({ orchestratorEnabled: true, orchestratorModels: { lead } })).toBeUndefined();
    expect(orchestratorStart({ orchestratorEnabled: true, orchestratorModels: { lead, builder } })).toEqual({
      goal: "balanced",
      models: { lead, builder, small: builder, router: builder },
    });
    expect(orchestratorStart({ orchestratorEnabled: true, orchestratorGoal: "output", orchestratorModels: { lead, builder } })?.goal).toBe("output");
  });
});

describe("orchestratorDisclosure", () => {
  it("groups the effective providers in role order", () => {
    expect(orchestratorDisclosure({ lead, builder })).toEqual([
      { providerId: "anthropic", roles: ["lead"] },
      { providerId: "deepseek", roles: ["builder", "small", "router"] },
    ]);
  });

  it("keeps a distinct router provider visible, and skips roles with no provider", () => {
    expect(orchestratorDisclosure({ lead, builder, router: { modelId: "x", providerId: "ollama" } })).toEqual([
      { providerId: "anthropic", roles: ["lead"] },
      { providerId: "deepseek", roles: ["builder", "small"] },
      { providerId: "ollama", roles: ["router"] },
    ]);
    expect(orchestratorDisclosure({ lead, builder: { modelId: "unprefixed" } })).toEqual([{ providerId: "anthropic", roles: ["lead"] }]);
  });
});

const route = (partial: Partial<OrchestratorRoute> = {}): OrchestratorRoute => ({
  routeId: "r-1",
  policyVersion: "orchestrator-v2",
  goal: "balanced",
  shape: "lead-guided",
  reasonCodes: [],
  roles: {
    lead: { modelId: "anthropic/claude-opus-5", providerId: "anthropic" },
    builder: { modelId: "deepseek/deepseek-v4", providerId: "deepseek" },
    small: { modelId: "deepseek/deepseek-v4", providerId: "deepseek" },
    router: { modelId: "deepseek/deepseek-v4", providerId: "deepseek" },
  },
  stages: [],
  consultCount: 0,
  reviewCount: 0,
  fallbacks: [],
  takeovers: [],
  escalations: [],
  references: {},
  ...partial,
});

const call = (partial: Partial<ModelCall>): ModelCall => ({
  at: 1,
  providerId: "deepseek",
  modelId: "deepseek/deepseek-v4",
  inputTokens: 10,
  cachedTokens: 0,
  outputTokens: 2,
  durationMs: 5,
  toolCalls: 0,
  ...partial,
});

describe("route facts", () => {
  it("names the decided shape and the model its last execution stage ran", () => {
    const recorded = route({
      shape: "lead-guided",
      executedShape: "lead-only",
      executionFallback: "lead-single-stage",
      stages: [
        { stage: "router", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
        { stage: "lead", providerId: "anthropic", modelId: "anthropic/claude-opus-5", effectiveEffort: "high" },
      ],
    });
    expect(orchestratorRouteLabel(recorded)).toBe("Lead-guided");
    expect(orchestratorRouteExecution(recorded)).toEqual({ role: "lead", providerId: "anthropic", modelId: "anthropic/claude-opus-5" });
    expect(orchestratorRouteExecution(route({ shape: "direct-builder", executedShape: "direct-builder" }))).toEqual({
      role: "builder",
      providerId: "deepseek",
      modelId: "deepseek/deepseek-v4",
    });
  });

  it("explains router and single-stage fallbacks, and stays quiet on a clean route", () => {
    const recorded = route({
      shape: "lead-guided",
      executedShape: "lead-only",
      executionFallback: "lead-single-stage",
      reasonCodes: ["router-invalid-json-fallback"],
    });
    expect(orchestratorRouteNote(recorded)).toMatch(/Router reply was invalid/);
    expect(orchestratorRouteNote(recorded)).toMatch(/Lead alone/);
    expect(orchestratorRouteTitle(recorded)).toMatch(/^Routed as Lead-guided \(balanced\)\./);
    expect(orchestratorRouteNote(route())).toBeUndefined();
    expect(orchestratorRouteTitle(route())).toBe("Routed as Lead-guided (balanced)");
    expect(orchestratorRouteNote(route({ shape: "lead-guided", executedShape: "lead-only", executionFallback: "plan-invalid" }))).toMatch(/rejected twice/);
  });

  it("names the Builder as the executor when a staged Lead-guided turn was reviewed", () => {
    const recorded = route({
      shape: "lead-guided",
      executedShape: "lead-guided",
      stages: [
        { stage: "lead-plan", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        { stage: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4", effectiveEffort: "high" },
        { stage: "review", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      ],
      reviewCount: 1,
    });
    expect(orchestratorRouteExecution(recorded)).toEqual({ role: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" });
    expect(orchestratorRouteNote(recorded)).toBeUndefined();
  });

  it("names the Lead when it took over or repaired after a review", () => {
    const takenOver = route({
      shape: "lead-guided",
      executedShape: "lead-guided",
      stages: [
        { stage: "lead-plan", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        { stage: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
        { stage: "takeover", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      ],
    });
    expect(orchestratorRouteExecution(takenOver)).toEqual({ role: "lead", providerId: "anthropic", modelId: "anthropic/claude-opus-5" });
    const repaired = route({
      shape: "lead-guided",
      executedShape: "lead-guided",
      stages: [
        { stage: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
        { stage: "repair", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
        { stage: "review", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      ],
    });
    expect(orchestratorRouteExecution(repaired)).toEqual({ role: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" });
  });

  it("says when a floor raised the per-message shape, and stays quiet when it ran or Auto decided", () => {
    const raised = route({ requestedShape: "direct-small", shape: "lead-guided", reasonCodes: ["forced-shape", "floor:high-risk"] });
    expect(orchestratorRouteNote(raised)).toBe("A floor raised this message from Small to Lead-guided.");
    expect(orchestratorRouteTitle(raised)).toBe("You asked for Small; routed as Lead-guided (balanced). A floor raised this message from Small to Lead-guided.");
    const kept = route({ requestedShape: "direct-builder", shape: "direct-builder" });
    expect(orchestratorRouteNote(kept)).toBeUndefined();
    expect(orchestratorRouteTitle(kept)).toBe("Routed as Builder (balanced)");
    expect(orchestratorRouteNote(route({ shape: "direct-small" }))).toBeUndefined();
  });

  it("counts only the calls belonging to that route", () => {
    const calls = [
      call({ routeId: "r-1" }),
      call({ routeId: "r-1", providerId: "anthropic", modelId: "anthropic/claude-opus-5" }),
      call({ routeId: "r-2" }),
      call({}),
    ];
    expect(orchestratorRouteCallFact(calls, "r-1")).toBe("2 calls · 2 models");
    expect(orchestratorRouteCallFact([call({ routeId: "r-1" })], "r-1")).toBe("1 call · 1 model");
    expect(orchestratorRouteCallFact(calls, "r-3")).toBeUndefined();
    expect(orchestratorRouteCallFact(undefined, "r-1")).toBeUndefined();
  });

  it("states the staged pipeline's plan, consults, takeover and review in order", () => {
    const staged = route({
      stages: [
        { stage: "lead-plan", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        { stage: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
        { stage: "consult", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        { stage: "review", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      ],
      consultCount: 1,
      reviewCount: 2,
    });
    expect(orchestratorRouteFacts(staged)).toEqual([
      "Lead plan · claude-opus-5 → Builder · deepseek-v4",
      "Builder asked the Lead · 1 of 2",
      "Reviewed by claude-opus-5 · 2 reviews",
    ]);
    expect(orchestratorRouteTitle(staged)).toContain("Lead plan · claude-opus-5 → Builder · deepseek-v4");

    const takenOver = route({
      stages: [
        { stage: "lead-plan", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        { stage: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
        { stage: "takeover", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      ],
      takeovers: ["builder:tests kept failing"],
    });
    expect(orchestratorRouteFacts(takenOver)).toContain("Lead took over · tests kept failing");

    const planReview = route({
      stages: [
        { stage: "lead-plan", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      ],
      reasonCodes: ["execution:plan-review"],
    });
    expect(orchestratorRouteFacts(planReview)).toEqual(["Lead plan · claude-opus-5"]);

    const approved = route({
      stages: [
        { stage: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
      ],
      reasonCodes: ["execution:approved-plan"],
    });
    expect(orchestratorRouteFacts(approved)).toEqual(["Approved plan · claude-opus-5 → Builder · deepseek-v4"]);

    const resumed = route({
      stages: [
        { stage: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
      ],
      reasonCodes: ["execution:resumed-builder"],
    });
    expect(orchestratorRouteFacts(resumed)).toEqual(["Builder resumed · deepseek-v4"]);

    const tuned = route({ consultBudget: 3, consultCount: 1 });
    expect(orchestratorRouteFacts(tuned)).toContain("Builder asked the Lead · 1 of 3");

    const scouted = route({
      stages: [
        { stage: "scout", providerId: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        { stage: "lead-plan", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        { stage: "builder", providerId: "deepseek", modelId: "deepseek/deepseek-v4" },
      ],
    });
    expect(orchestratorRouteFacts(scouted)).toEqual([
      "Scout · claude-haiku-4-5",
      "Lead plan · claude-opus-5 → Builder · deepseek-v4",
    ]);
    expect(orchestratorRouteNote(route({ reasonCodes: ["scout:invalid"] }))).toMatch(/Scouting did not produce/);
    expect(orchestratorRouteNote(route({ reasonCodes: ["lead-read:unavailable"] }))).toMatch(/planned from the brief/);
  });

  it("leaves single-role turns to the receipt's own model fact", () => {
    expect(orchestratorRouteFacts(route({ shape: "direct-small", executedShape: "direct-small" }))).toEqual([]);
    expect(orchestratorRouteFacts(route({ shape: "direct-builder", executedShape: "direct-builder" }))).toEqual([]);
    expect(orchestratorRouteFacts(route({ shape: "lead-only", executedShape: "lead-only" }))).toEqual([]);
    expect(orchestratorRouteFacts(route({
      executedShape: "lead-only",
      executionFallback: "plan-invalid",
      stages: [
        { stage: "lead-plan", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
        { stage: "lead", providerId: "anthropic", modelId: "anthropic/claude-opus-5" },
      ],
    }))).toEqual([]);
    expect(orchestratorModelName("anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(orchestratorModelName("openrouter/anthropic/claude-opus-5")).toBe("claude-opus-5");
    expect(orchestratorModelName("local")).toBe("local");
  });
});
