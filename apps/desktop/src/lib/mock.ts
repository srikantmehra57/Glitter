import type { AgentInfo, GithubPreview, InstalledPlugin, MarketplaceAnalysis, MarketplacePlugin, MarketplaceSource, Model, ModelCall, PluginAnalysis, PluginInstallOutcome, PluginLibrary, PluginOrigin } from "./types";
import type { GitGraph, GitReview, GitReviewRequest, GitSnapshot, Thread, ThreadWorktree, TranscriptItem, WorkspaceFile } from "./types";
import { parseUnifiedDiff } from "./diff";
import { dayKey, type UsageDay, type UsageLedger, type UsageTurn } from "./usageLedger";

const now = new Date().toISOString();

const inspectItems: TranscriptItem[] = [
  {
    itemId: "u1",
    kind: "userMessage",
    status: "completed",
    turnId: "turn-1",
    text: "Add a dark command-center layout for the desktop app.",
    refs: [{ id: "r1", kind: "file", path: "apps/desktop/src/App.tsx" }],
    recordedAt: now,
  },
  {
    itemId: "r1",
    kind: "reasoning",
    status: "completed",
    turnId: "turn-1",
    summary: ["Inspect the shell, then introduce a 319px sidebar, a conversation surface, and a review inspector."],
    text: "I'll inspect the authentication of the current chrome, then replace the chat layout with a workspace → thread → run model.",
  },
  {
    itemId: "t-search",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "codebase_search",
    args: '{"query":"sidebar conversation layout"}',
    durationMs: 840,
    visibleOutput: "apps/desktop/src/App.tsx\napps/desktop/src/components/Sidebar.tsx",
  },
  {
    itemId: "t1",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "read_file",
    args: '{"path":"apps/desktop/src/App.tsx"}',
    durationMs: 120,
    visibleOutput: "export function App() {\n  return <Shell />\n}",
  },
  {
    itemId: "a1-note",
    kind: "agentMessage",
    status: "completed",
    turnId: "turn-1",
    text: "The shell already has a clear state boundary. I’ll preserve it and keep the layout changes in the desktop components.",
  },
  {
    itemId: "t2",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "edit_file",
    args: '{"path":"apps/desktop/src/styles.css","old_string":".surface {\\n  color: var(--ink);\\n}","new_string":".surface {\\n  color: var(--ink);\\n  background: var(--surface-2);\\n}"}',
    durationMs: 640,
    visibleOutput: "Updated tokens for surface, ink, and accent.",
  },
  {
    itemId: "t-patch",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "apply_patch",
    args: `{"path":"src/widget.ts","patch":"diff --git a/src/widget.ts b/src/widget.ts\\n--- a/src/widget.ts\\n+++ b/src/widget.ts\\n@@ -1,3 +1,4 @@\\n export function widget() {\\n-  return null;\\n+  const label = \\"ready\\";\\n+  return label;\\n }\\ndiff --git a/scripts/check.py b/scripts/check.py\\n--- a/scripts/check.py\\n+++ b/scripts/check.py\\n@@ -1,2 +1,3 @@\\n def check():\\n-    pass\\n+    total = 42\\n+    return total\\n"}`,
    durationMs: 890,
    visibleOutput: "Applied patch to 2 files.",
  },
  {
    itemId: "t-cmd",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "bash",
    commandText: "npm test --silent",
    args: '{"command":"npm test --silent"}',
    exitCode: 0,
    durationMs: 2100,
    visibleOutput: "28 tests passed",
    truncated: true,
    presentation: { kind: "terminal", truncated: true, artifactPath: "output/test-results.txt" },
    outputRef: { id: "mock-ref-1", kind: "tool_output", uri: "mock:tool-output", availability: "available", byteLen: 2048, mediaType: "text/plain" },
  },
  {
    itemId: "a2",
    kind: "agentMessage",
    status: "completed",
    turnId: "turn-1",
    text: "Implemented the command-center shell: sidebar threads, an agent timeline, and a per-file review dock.\n\n## What changed\n\nThe layout now follows a **workspace → thread → run** model. `App.tsx` only composes the shell; state lives in `lib/store.ts` and streams from the bridge over NDJSON.\n\n### Layers\n\n- **UI** (`apps/desktop/src/components/`) — `Sidebar.tsx`, `ThreadView.tsx`, `AgentTimeline.tsx`, `Composer.tsx`, and `ReviewDock.tsx`. Each renders store state; none talk to the bridge directly.\n- **State** (`lib/store.ts`) — a zustand store holding workspaces, threads, the composer draft, and git status. Selectors like `currentThread` keep renders scoped.\n- **Bridge** (`packages/glitter-bridge/`) — hosts `@muse-code/sdk` over `muse serve` stdio and forwards session events as NDJSON lines.\n\n### Data flow\n\n1. The composer calls `sendPrompt`, which writes a `userMessage` item and opens a turn.\n2. Bridge events fold into `thread.items` — tool calls, reasoning, and agent messages stream in order.\n3. `AgentTimeline` groups items into runs and renders steps, plans, and the final reply.\n\n```ts\nconst thread = useAppStore(currentThread);\nconst send = useAppStore((s) => s.sendPrompt);\nawait send({ resetTaskState: true });\n```\n\n| Surface | File | Renders |\n|---|---|---|\n| Timeline | `AgentTimeline.tsx` | Steps, plans, receipts |\n| Composer | `Composer.tsx` | Draft, attachments, effort |\n| Review | `ReviewDock.tsx` | Changed files, diffs |\n\n> Threads persist across launches, and an interrupted run is labeled rather than silently dropped.\n\nNext up:\n\n- [ ] Streaming diffs in the review dock\n- [ ] Plan pinning during long runs",
  },
];

export const MOCK_THREADS: Thread[] = [
  {
    sessionId: "preview-1",
    workspacePath: "/Users/you/Glitter",
    title: "Command center layout",
    updatedAt: now,
    status: "idle",
    unread: false,
    lastOutcome: "completed",
    lastTurnId: "turn-1",
    historyExhausted: true,
    snapshots: { "turn-1": { snapshotId: "preview-snapshot-1", sessionId: "preview-1", turnId: "turn-1", state: "ready", files: ["apps/desktop/src/styles.css", "src/widget.ts", "scripts/check.py"], reason: null, createdAt: Date.now() / 1000 } },
    pinned: true,
    skills: [
      { selector: "review", displayName: "Review", description: "Review the working tree", source: "user" },
      { selector: "plan", displayName: "Plan", description: "Plan before coding", source: "user" },
    ],
    plan: [
      { id: "p1", text: "Inspect the shell", status: "completed" },
      { id: "p2", text: "Introduce the sidebar and review inspector", status: "completed" },
      { id: "p3", text: "Wire Muse sessions", status: "completed" },
    ],
    goal: { objective: "Ship a desktop command center", currentWork: "Reviewing the inspector", nextWork: "Persist threads" },
    context: { usedTokens: 18400, windowTokens: 128000, pressure: "ok" },
    usage: { promptTokens: 48210, totalTokens: 61004, outputTokens: 12794 },
    turnStats: { turnId: "turn-1", durationMs: 42000, inputTokens: 12040, outputTokens: 3120 },
    items: inspectItems,
  },
  {
    sessionId: "preview-2",
    workspacePath: "/Users/you/Glitter",
    title: "Wire muse serve",
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    status: "running",
    unread: true,
    activeTurnId: "turn-live",
    lastTurnId: "turn-live",
    pendingApproval: {
      approvalId: "appr-1",
      sessionId: "preview-2",
      turnId: "turn-live",
      toolName: "bash",
      rawArgs: '{"command":"muse serve --workspace ."}',
      availableChoices: [
        { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "allow-session", label: "Allow this command in this thread", decision: "approved", scope: "session", scopeLabel: "This exact command" },
        { choiceId: "allow-session-prefix", label: "Allow `muse serve …` in this thread", decision: "approved", scope: "session", scopeLabel: "muse serve …" },
        { choiceId: "allow-session-program", label: "Allow every `muse` command in this thread", decision: "approved", scope: "session", scopeLabel: "Any muse command" },
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
      ],
    },
    plan: [
      { id: "s1", text: "Start muse serve", status: "completed" },
      { id: "s2", text: "Fold live item events", status: "inProgress", activeForm: "Folding live item events" },
      { id: "s3", text: "Restore session facts", status: "pending" },
    ],
    goal: { objective: "Stream Muse turns into the thread", currentWork: "Opening the workspace session", nextWork: "Subscribe to item events" },
    items: [
      {
        itemId: "u2",
        kind: "userMessage",
        status: "completed",
        turnId: "turn-live",
        text: "Spawn muse serve and stream turn items into the thread.",
      },
      {
        itemId: "r2",
        kind: "reasoning",
        status: "completed",
        turnId: "turn-live",
        summary: ["Open a session on the workspace root, then fold live item events into the timeline."],
      },
      {
        itemId: "t-live-read",
        kind: "toolCall",
        status: "completed",
        turnId: "turn-live",
        tool: "read_file",
        args: '{"path":"packages/glitter-bridge/src/host.ts"}',
        durationMs: 90,
        visibleOutput: "export async function startHost() { … }",
      },
      {
        itemId: "live-note",
        kind: "agentMessage",
        status: "completed",
        turnId: "turn-live",
        text: "The session events arrive in order. I’m checking the child-agent lifecycle before wiring the final command.",
      },
      {
        itemId: "sub-live",
        kind: "subagent",
        status: "completed",
        turnId: "turn-live",
        subagentId: "mock-kid-1",
        childSessionId: "preview-child-1",
        controlStatus: "resultReady",
        role: "auditor",
        objective: "Audit the composer for focus traps",
        durationMs: 9400,
        result: { summary: "Two focus traps found and fixed.", text: "The palette and the preview dialog now trap focus while open.", artifactRefs: ["apps/desktop/src/components/CommandPalette.tsx"], evidenceRefs: [] },
      },
      {
        itemId: "t-bg",
        kind: "toolCall",
        status: "inProgress",
        turnId: "turn-live",
        tool: "bash",
        commandText: "npm run soak --silent",
        args: '{"command":"npm run soak --silent"}',
        background: true,
        backgroundInitiator: "user",
        visibleOutput: "soak 412/2000…",
      },
      {
        itemId: "w-live",
        kind: "workflow",
        status: "inProgress",
        turnId: "turn-live",
        entryId: "release-readiness",
        workflowRunId: "mock-run-1",
        children: [
          { childId: "ux", attempt: 1, status: "terminal", terminal: "completed", label: "Conversation UX", phase: "Reviewed edge states", durationMs: 18200, usage: { outputTokens: 840 } },
          { childId: "tests", attempt: 1, status: "started", label: "Reliability checks", phase: "Running cancellation tests" },
          { childId: "accessibility", attempt: 1, status: "accepted", label: "Accessibility pass", phase: "Queued" },
        ],
      },
      {
        itemId: "t-live",
        kind: "toolCall",
        status: "inProgress",
        turnId: "turn-live",
        tool: "bash",
        commandText: "muse serve --workspace .",
        args: '{"command":"muse serve --workspace ."}',
        visibleOutput: "listening on 127.0.0.1…",
      },
    ],
  },
  {
    sessionId: "preview-3",
    workspacePath: "/Users/you/Glitter",
    title: "Interrupted auth refresh",
    updatedAt: new Date(Date.now() - 7200_000).toISOString(),
    status: "error",
    unread: false,
    lastOutcome: "interrupted",
    lastTurnId: "turn-3",
    items: [
      {
        itemId: "u3",
        kind: "userMessage",
        status: "completed",
        turnId: "turn-3",
        text: "Find where sessions are persisted and fix silent token refresh failures.",
      },
      {
        itemId: "t3",
        kind: "toolCall",
        status: "completed",
        turnId: "turn-3",
        tool: "grep",
        args: '{"pattern":"refreshToken"}',
        durationMs: 210,
        visibleOutput: "src/lib/settingsPersistence.ts",
      },
      {
        itemId: "t3b",
        kind: "toolCall",
        status: "failed",
        turnId: "turn-3",
        tool: "bash",
        commandText: "npm test tests/auth.test.mjs",
        args: '{"command":"npm test tests/auth.test.mjs"}',
        exitCode: 1,
        durationMs: 1300,
        failureReason: "Test file not found. The run stopped when Muse disconnected.",
      },
    ],
  },
  {
    sessionId: "preview-4",
    agentId: "harness",
    workspacePath: "/Users/you/Glitter",
    title: "Orchestrator: narrow settings",
    updatedAt: new Date(Date.now() - 900_000).toISOString(),
    status: "idle",
    unread: false,
    lastOutcome: "completed",
    lastTurnId: "turn-orch",
    context: { usedTokens: 21400, windowTokens: 200000, pressure: "ok" },
    turnStats: { turnId: "turn-orch", durationMs: 38000, inputTokens: 16400, outputTokens: 2900 },
    routes: {
      "turn-orch": {
        routeId: "preview-orchestrator-1",
        policyVersion: "orchestrator-v2",
        goal: "balanced",
        shape: "lead-guided",
        executedShape: "lead-guided",
        reasonCodes: ["floor:mid-level"],
        roles: {
          lead: { providerId: "anthropic", modelId: "anthropic/claude-sonnet-5" },
          builder: { providerId: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
          small: { providerId: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
          router: { providerId: "anthropic", modelId: "anthropic/claude-haiku-4-5" },
        },
        stages: [
          { stage: "lead-plan", providerId: "anthropic", modelId: "anthropic/claude-sonnet-5", effectiveEffort: "high" },
          { stage: "builder", providerId: "anthropic", modelId: "anthropic/claude-haiku-4-5", effectiveEffort: "max" },
          { stage: "consult", providerId: "anthropic", modelId: "anthropic/claude-sonnet-5", effectiveEffort: "high" },
          { stage: "review", providerId: "anthropic", modelId: "anthropic/claude-sonnet-5", effectiveEffort: "high" },
        ],
        consultCount: 1,
        reviewCount: 1,
        fallbacks: [],
        takeovers: [],
        escalations: [],
        references: { plan: "orch-plan", buildReport: "orch-report", reviewNotes: "orch-review" },
      },
    },
    items: [
      {
        itemId: "orch-user",
        kind: "userMessage",
        status: "completed",
        turnId: "turn-orch",
        text: "Make the Settings dialog responsive down to 300px without moving the composer.",
      },
      {
        itemId: "orch-plan",
        kind: "orchestratorPlan",
        status: "completed",
        turnId: "turn-orch",
        text: "Goal: Make Settings usable at 300px without moving the composer.\nAcceptance: The nav stacks above the pane at 300px; the composer buffer stays 16px.\nFiles: apps/desktop/src/settings.css — narrow layout rules; apps/desktop/src/components/SettingsModal.tsx — collapse the nav below 480px.\nSteps: 1. Add the narrow layout rules (settings.css). 2. Keep the nav reachable above the pane (SettingsModal.tsx). 3. Check the 300px and 681px breakpoints.\nChecks: npm run test:ui -- src/components/SettingsModal.test.tsx",
      },
      {
        itemId: "orch-read",
        kind: "toolCall",
        status: "completed",
        turnId: "turn-orch",
        tool: "read_file",
        args: '{"path":"apps/desktop/src/settings.css"}',
        durationMs: 120,
        visibleOutput: ".settings { display: flex; }\n.settings-nav { width: 240px; }",
      },
      {
        itemId: "orch-ask",
        kind: "toolCall",
        status: "completed",
        turnId: "turn-orch",
        tool: "ask_lead",
        args: '{"question":"Should the narrow layout stack the nav above the pane?","excerpt":".settings-nav { width: 240px; }"}',
        durationMs: 2800,
        visibleOutput: "Stack it above the pane; keep the 16px composer buffer.",
      },
      {
        itemId: "orch-edit",
        kind: "toolCall",
        status: "completed",
        turnId: "turn-orch",
        tool: "edit_file",
        args: '{"path":"apps/desktop/src/settings.css"}',
        durationMs: 240,
        presentation: { kind: "diff", path: "apps/desktop/src/settings.css", oldText: ".settings-nav { width: 240px; }", newText: "@media (max-width: 480px) { .settings { display: block; } }" },
        visibleOutput: "Added the narrow layout rules.",
      },
      {
        itemId: "orch-report",
        kind: "orchestratorBuildReport",
        status: "completed",
        turnId: "turn-orch",
        text: "Settings now stack the nav above the pane below 480px and keep the composer buffer.\n1 file changed, +12/-3\nChecks: SettingsModal tests — passed",
      },
      {
        itemId: "orch-review",
        kind: "orchestratorReview",
        status: "completed",
        turnId: "turn-orch",
        text: "Review: pass",
      },
      {
        itemId: "orch-answer",
        kind: "agentMessage",
        status: "completed",
        turnId: "turn-orch",
        text: "Settings now stack the nav above the pane below 480px; the 16px composer buffer is untouched and the SettingsModal tests pass.",
      },
    ],
  },
  {
    // The preview rewrites the last demo thread as Grok, so another installed
    // agent stays represented while Orchestrator keeps its Harness thread.
    sessionId: "preview-5",
    workspacePath: "/Users/you/Glitter",
    title: "Tighten the reducer",
    updatedAt: new Date(Date.now() - 5400_000).toISOString(),
    status: "idle",
    unread: false,
    lastOutcome: "completed",
    lastTurnId: "turn-grok",
    items: [
      {
        itemId: "grok-user",
        kind: "userMessage",
        status: "completed",
        turnId: "turn-grok",
        text: "Tighten the reducer without changing behaviour.",
      },
      {
        itemId: "grok-answer",
        kind: "agentMessage",
        status: "completed",
        turnId: "turn-grok",
        text: "The reducer now derives the next state in one pass and keeps every branch identical.",
      },
    ],
  },
];

export function mockThreads(): Thread[] {
  return MOCK_THREADS.map((thread) => ({ ...thread, items: thread.items.map((item) => ({ ...item })) }));
}

export const MOCK_GIT_GRAPH: GitGraph = {
  graph: `* 8f21c4a Add Environment inspector view (HEAD -> main)
| * 42b90de Refresh review styling (origin/review-styling)
|/
* 8679625 Merge provider discovery fixes
* 93649b4 Refresh Glitter brand artwork
* e69e82f Fix provider discovery and consent-aware model setup
`,
  truncated: false,
};

export const MOCK_GIT: GitSnapshot = {
  repository: true,
  branch: "main",
  dirty: true,
  files: [
    { path: "apps/desktop/src/App.tsx", status: " M", added: 24, removed: 6 },
    { path: "apps/desktop/src/styles.css", status: "M ", added: 180, removed: 0 },
    { path: "packages/glitter-bridge/src/host.ts", status: "M ", added: 96, removed: 0 },
    { path: "docs/review-plan.md", status: "??", added: 4, removed: 0 },
    { path: "dist/bundle.bin", status: "??", added: 0, removed: 0, previewSkipped: "binary" },
  ],
  diff: `diff --git a/apps/desktop/src/App.tsx b/apps/desktop/src/App.tsx
--- a/apps/desktop/src/App.tsx
+++ b/apps/desktop/src/App.tsx
@@ -1,6 +1,18 @@
 export function App() {
-  const splash = buildShortMessage();
-  return <div>Muse</div>
-}
+  const splash = buildLaunchMessage({ width: window.innerWidth, density: "comfortable", announceReviewPane: true, fallbackCopy: "Changes dock ready" });
+  return (
+    <div className="shell">
+      <Sidebar />
+      <ThreadView />
+      <ReviewDock />
+    </div>
+  )
+}
@@ -40,4 +52,6 @@ function boot() {
   registerCommands();
-  mount();
+  mountApp();
   return true;
+}
diff --git a/docs/review-plan.md b/docs/review-plan.md
new file mode 100644
--- /dev/null
+++ b/docs/review-plan.md
@@ -0,0 +1,4 @@
+# Review plan
+- collect the changed files
+- draft the summary
+- flag anything risky
\\ No newline at end of file
`,
};

/** Demo file index: the changed files from `MOCK_GIT` plus a few neighbours. */
export const MOCK_FILES = ["README.md", "apps/desktop/src/App.tsx", "apps/desktop/src/styles.css", "apps/desktop/src/lib/store.ts", "apps/desktop/src/components/Composer.tsx", "package.json", "packages/glitter-bridge/src/host.ts", "packages/glitter-bridge/src/index.ts"];

/** Demo file contents for the viewer; nothing is read from disk. */
export function mockWorkspaceFile(path: string): WorkspaceFile {
  const content = path.endsWith(".md") ? `# ${path}\n\nDemo content. The browser preview never reads your files.\n`
    : path.endsWith(".json") ? `{\n  "name": "demo",\n  "private": true\n}\n`
    : path.endsWith(".css") ? `:root {\n  --accent: #6b8afd;\n}\n`
    : `// ${path}\n// Demo content. The browser preview never reads your files.\nexport const demo = true;\n`;
  return { path, content, size: content.length, truncated: false };
}

/** A demo worktree record; nothing is created on disk. */
export function mockWorktree(base: string): Omit<ThreadWorktree, "workspaceId"> & { warning?: string } {
  const name = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return { grantId: `preview-worktree-${name}`, path: `/Users/you/Library/Application Support/com.glitter.desktop/worktrees/${name}`, branch: `glitter/${name}`, base: base || MOCK_GIT.branch };
}

/** Each preview scope has distinct, explicitly demo data; no native reads. */
export function mockGitReview(request: GitReviewRequest): GitReview {
  if (request.scope === "all") return MOCK_GIT;
  if (request.scope === "unstaged") {
    const files = MOCK_GIT.files.filter((file) => file.status === "??" || file.status[1] !== " ");
    const paths = new Set(files.map((file) => file.path));
    return { files, diff: parseUnifiedDiff(MOCK_GIT.diff).files.filter((file) => paths.has(file.path)).map((file) => file.patch).join(""), truncated: false };
  }
  const patch = (path: string, before: string, after: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
  if (request.scope === "staged") return {
    files: [{ path: "apps/desktop/src/styles.css", status: "M", added: 1, removed: 1 }, { path: "packages/glitter-bridge/src/host.ts", status: "M", added: 1, removed: 1 }],
    diff: patch("apps/desktop/src/styles.css", ".surface { color: var(--ink); }", ".surface { color: var(--ink); background: var(--surface-2); }") + patch("packages/glitter-bridge/src/host.ts", "const history = [];", "const history = opening.items;"), truncated: false,
  };
  if (request.scope === "lastTurn") {
    const snapshot = Object.values(MOCK_THREADS.find((thread) => thread.sessionId === request.sessionId)?.snapshots ?? {}).find((item) => item.snapshotId === request.snapshotId);
    if (!snapshot) throw new Error("This preview thread has no saved file state.");
    return { files: snapshot.files.map((path) => ({ path, status: "M", added: 1, removed: 1 })), diff: patch("apps/desktop/src/styles.css", ".surface { color: var(--ink); }", ".surface { color: var(--ink); background: var(--surface-2); }") + patch("src/widget.ts", "export const label = null;", 'export const label = "ready";') + patch("scripts/check.py", "total = 0", "total = 42"), truncated: false };
  }
  if (!["main", "origin/main", "HEAD", "HEAD~1"].includes(request.base ?? "")) throw new Error("This preview supports main, origin/main, HEAD and HEAD~1 as demo bases.");
  return { files: request.base === "HEAD" ? [] : [{ path: "src/review.ts", status: "M", added: 1, removed: 1 }], diff: request.base === "HEAD" ? "" : patch("src/review.ts", "export const scope = 'all';", "export const scope = 'branch';"), truncated: false, baseCommit: "1111111111111111111111111111111111111111", headCommit: "2222222222222222222222222222222222222222" };
}

export const MOCK_MODELS: Model[] = [
  { modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3", isActive: true, contextLimit: 1007997, cost: { input: "1.25", output: "4.25", currency: "USD" }, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high", effortSource: "vocabulary" },
  { modelId: "muse-spark-1.3-contributor", displayLabel: "muse-spark-1.3-contributor", isDefault: true, contextLimit: 1007997, cost: { input: "0.10", output: "0.20", currency: "USD" }, description: "Discounted tokens: your content, including inter-session messages, may be used for product improvement.", reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high", effortSource: "vocabulary" },
  { modelId: "muse-spark-1.2", displayLabel: "muse-spark-1.2", isActive: false, contextLimit: 1007997, cost: { input: "1.25", output: "4.25", currency: "USD" }, reasoningEfforts: ["low", "medium", "high", "max"], defaultReasoningEffort: "medium", effortSource: "host" },
];

export const MOCK_AGENTS: AgentInfo[] = [
  { id: "harness", name: "Harness", protocol: "native", found: true, path: null, version: null, verified: true, signIn: "Add an API key for a model provider in Settings → Providers.", authenticated: true },
  { id: "muse", name: "Muse", protocol: "msp", found: true, path: "/usr/local/bin/muse", version: "1.3.0", verified: true, signIn: "", authenticated: true },
  { id: "opencode", name: "OpenCode", protocol: "acp", found: true, path: "/opt/homebrew/bin/opencode", version: "2.0.25", verified: true, signIn: "" },
  { id: "grok", name: "Grok", protocol: "acp", found: true, path: "~/.grok/bin/grok", version: "1.0.52", verified: true, signIn: "" },
  { id: "gemini", name: "Gemini CLI", protocol: "acp", found: false, path: null, version: null, verified: false, signIn: "" },
  { id: "qwen", name: "Qwen Code", protocol: "acp", found: false, path: null, version: null, verified: false, signIn: "" },
  { id: "goose", name: "Goose", protocol: "acp", found: false, path: null, version: null, verified: false, signIn: "" },
  { id: "cline", name: "Cline CLI", protocol: "acp", found: true, path: "/opt/homebrew/bin/cline", version: "3.0.73", verified: false, signIn: "" },
];

const zen = (id: string, name: string, input: string, output: string, efforts: Model["reasoningEfforts"] = [], context = 200000): Model =>
  ({ modelId: `opencode/${id}`, displayLabel: name, providerId: "opencode", contextLimit: context, cost: { input, output, currency: "USD" }, description: input === "0" && output === "0" ? "Free" : null, reasoningEfforts: efforts, effortSource: "host" });

export const MOCK_AGENT_MODELS: Record<string, Model[]> = {
  harness: [
    { modelId: "anthropic/claude-sonnet-5", displayLabel: "Claude Sonnet 5", providerId: "anthropic", description: "Anthropic", contextLimit: 200000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium", effortSource: "host", isDefault: true },
    { modelId: "anthropic/claude-haiku-4-5", displayLabel: "Claude Haiku 4.5", providerId: "anthropic", description: "Anthropic", contextLimit: 200000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium", effortSource: "host" },
    { modelId: "openai/gpt-5.5", displayLabel: "gpt-5.5", providerId: "openai", description: "OpenAI", contextLimit: 400000, reasoningEfforts: ["minimal", "low", "medium", "high"], defaultReasoningEffort: "medium", effortSource: "host" },
    { modelId: "nvidia/moonshotai/kimi-k2.6", displayLabel: "moonshotai/kimi-k2.6", providerId: "nvidia", description: "NVIDIA NIM", contextLimit: null, reasoningEfforts: ["none", "high"], defaultReasoningEffort: "high", effortSource: "host" },
    { modelId: "nvidia/openai/gpt-oss-120b", displayLabel: "openai/gpt-oss-120b", providerId: "nvidia", description: "NVIDIA NIM", contextLimit: null, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "medium", effortSource: "host" },
    { modelId: "cline/anthropic/claude-sonnet-5.5", displayLabel: "anthropic/claude-sonnet-5.5", providerId: "cline", description: "Cline API", contextLimit: 200000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", effortSource: "host" },
    { modelId: "kilo/anthropic/claude-sonnet-4.6", displayLabel: "anthropic/claude-sonnet-4.6", providerId: "kilo", description: "Kilo API", contextLimit: 200000, reasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", effortSource: "host" },
    { modelId: "ollama/qwen3-coder", displayLabel: "qwen3-coder", providerId: "ollama", description: "Ollama", contextLimit: null, reasoningEfforts: [], effortSource: "host" },
  ],
  opencode: [
    zen("claude-opus-5", "Claude Opus 5", "5", "25", ["low", "medium", "high", "xhigh", "max"], 1000000),
    zen("claude-sonnet-5", "Claude Sonnet 5", "3", "15", ["low", "medium", "high", "xhigh", "max"], 1000000),
    zen("claude-haiku-4-5", "Claude Haiku 4.5", "1", "5", ["high", "max"]),
    zen("gpt-5.5", "GPT-5.5", "1.25", "10", ["low", "medium", "high", "xhigh"], 400000),
    zen("gemini-3.5-flash", "Gemini 3.5 Flash", "0.3", "2.5", ["low", "medium", "high"], 1000000),
    zen("big-pickle", "Big Pickle", "0", "0"),
    zen("mimo-v2.5-free", "MiMo V2.5 (free)", "0", "0"),
    zen("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning (free)", "0", "0"),
    zen("muse-spark-1.3-contributor-free", "Muse Spark 1.3 Contributor (free)", "0", "0"),
    zen("glm-5.3", "GLM-5.3", "0.6", "2.2", [], 200000),
    { modelId: "openrouter/qwen/qwen3.8-27b:free", displayLabel: "Qwen3.8 27B (free)", providerId: "openrouter", reasoningEfforts: [], effortSource: "host", description: "Free" },
  ],
  cline: [
    ...[
      ["nvidia/nemotron-3.5-super", "Nemotron 3.5 Super", "NVIDIA’s latest mixture-of-experts reasoning model", true],
      ["upstage/solar-mini4", "Solar Mini 4", "Compact 35-billion parameter model", true],
      ["reflection/beam-1.0-501b-a23b", "Beam", null, true],
      ["nvidia/nemotron-3.5-lightning", "Nemotron 3.5 Lightning", null, true],
      ["poolside/laguna-s-2.1", "Laguna S 2.1", null, true],
      ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5", null, false],
      ["anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", null, false],
      ["openai/gpt-6.1-sol", "GPT-6.1 Sol", null, false],
      ["google/gemini-4-argon", "Gemini 4 Argon", null, false],
      ["z-ai/glm-5.3-prime", "GLM 5.3 Prime", null, false],
      ["meta/muse-spark-open", "Muse Spark Open", null, false],
    ].map(([modelId, displayLabel, description, free]): Model => ({ modelId: modelId as string, displayLabel: displayLabel as string, providerId: (modelId as string).split("/")[0], description: description as string | null, free: free as boolean, reasoningEfforts: ["none", "low", "medium", "high", "xhigh"], defaultReasoningEffort: "medium", effortSource: "host" })),
  ],
  grok: [
    { modelId: "grok-4.7", displayLabel: "Grok 4.7", providerId: "grok", contextLimit: 256000, isDefault: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "high", effortSource: "host" },
    { modelId: "grok-4.7-build-fast", displayLabel: "Grok 4.7 Fast", providerId: "grok", contextLimit: 256000, description: "Fast variant. 2x the price.", reasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "high", effortSource: "host" },
    { modelId: "grok-4.6", displayLabel: "Grok 4.6", providerId: "grok", contextLimit: 256000, reasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "high", effortSource: "host" },
    { modelId: "grok-4.5", displayLabel: "Grok 4.5", providerId: "grok", contextLimit: 256000, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", effortSource: "host" },
  ],
};

/** The preview's usage record: two weeks of turns and a year of daily totals, the same on every load. */
export function mockUsageLedger(at = Date.now()): UsageLedger {
  // `cached` is the share of the input served from the provider's prompt cache.
  const mixes: Array<Pick<UsageTurn, "agentId" | "providerId" | "modelId"> & { input: number; output: number; cached: number }> = [
    { agentId: "harness", providerId: "anthropic", modelId: "anthropic/claude-sonnet-5", input: 46_000, output: 3_800, cached: 0.7 },
    { agentId: "harness", providerId: "openai", modelId: "openai/gpt-5.5", input: 31_000, output: 2_600, cached: 0.4 },
    { agentId: "muse", providerId: "meta", modelId: "muse-spark-1.3-contributor", input: 28_000, output: 2_900, cached: 0 },
    { agentId: "harness", providerId: "anthropic", modelId: "anthropic/claude-haiku-4-5", input: 18_000, output: 1_400, cached: 0.6 },
    { agentId: "grok", providerId: "xai", modelId: "grok-4.7", input: 22_000, output: 2_100, cached: 0 },
    { agentId: "opencode", providerId: "opencode", modelId: "opencode/big-pickle", input: 15_000, output: 1_500, cached: 0 },
  ];
  // Earlier entries come up more often, so the breakdown has a clear order.
  const weights = [6, 4, 4, 2, 2, 1];
  const pick = (n: number) => {
    let roll = n % weights.reduce((sum, weight) => sum + weight, 0);
    return mixes[weights.findIndex((weight) => (roll -= weight) < 0)];
  };
  const noise = (n: number) => ((Math.imul(n + 1, 2654435761) >>> 0) % 1000) / 1000;
  const tools = ["bash", "read_file", "codebase_search", "edit_file", "grep"];
  const efforts = ["high", "medium", "xhigh", "high", "low"];
  const midnight = new Date(at);
  midnight.setHours(0, 0, 0, 0);
  const turns: UsageTurn[] = [];
  for (let day = 0; day < 14; day += 1) {
    const date = new Date(midnight.getTime() - day * 86_400_000);
    if (date.getDay() === 0 && day) continue;
    const count = 3 + Math.floor(noise(day * 7) * 9);
    for (let index = 0; index < count; index += 1) {
      const n = day * 31 + index;
      const when = date.getTime() + (9 + noise(n) * 13) * 3_600_000;
      if (when > at) continue;
      const mix = pick(Math.floor(noise(n + 3) * 1000));
      const scale = 0.45 + noise(n + 5) * 1.3;
      const used: Record<string, number> = {};
      for (let tool = 0; tool < 1 + Math.floor(noise(n + 9) * 4); tool += 1) used[tools[(n + tool) % tools.length]] = 1 + Math.floor(noise(n + tool) * 3);
      const entry: UsageTurn = { key: `preview:${n}`, at: when, agentId: mix.agentId, providerId: mix.providerId, modelId: mix.modelId, effort: efforts[n % efforts.length], inputTokens: Math.round(mix.input * scale), cachedTokens: Math.round(mix.input * scale * mix.cached), outputTokens: Math.round(mix.output * scale), estimated: false, durationMs: Math.round((40 + noise(n + 11) * 900) * 1000), threadId: `preview-thread-${n % 9}`, workspace: n % 3 ? "/Users/you/code/muse" : "/Users/you/code/site", tools: used };
      // Only the Harness reports its own calls, so only its turns carry a trajectory.
      if (entry.agentId === "harness") {
        // Preview routes cover every shape, so route labels and the by-role split
        // have data before live routing is wired. One turn in five stays manual.
        const shape = n % 5 === 0 ? "manual" : n % 11 === 0 ? "lead-only" : n % 4 === 0 ? "lead-guided" : n % 7 === 0 ? "small" : "direct-builder";
        const routed = shape !== "manual";
        const count = shape === "small" ? 1 : 1 + Math.floor(noise(n + 13) * 4);
        const calls: ModelCall[] = [];
        let elapsed = 0;
        for (let call = 0; call < count; call += 1) {
          // Later calls carry the whole history, so they are the expensive ones.
          const share = (call + 1) / ((count * (count + 1)) / 2);
          const durationMs = Math.round(entry.durationMs * share);
          const role = shape === "lead-guided" ? (call === 0 ? "lead" : "builder") : shape === "small" ? "small" : shape === "lead-only" ? "lead" : "builder";
          const stage = shape === "lead-guided" ? (call === 0 ? "lead-plan" : "builder") : shape === "small" ? "small" : shape === "lead-only" ? "takeover" : "builder";
          calls.push({
            ...(routed ? { routeId: `preview-route-${n}`, role, stage } : {}),
            at: when - entry.durationMs + elapsed,
            providerId: entry.providerId,
            modelId: entry.modelId ?? "",
            ...(entry.effort ? { effort: entry.effort } : {}),
            inputTokens: Math.round(entry.inputTokens * share),
            // The first call has no cache to read yet.
            cachedTokens: call ? Math.round(entry.cachedTokens * share) : 0,
            outputTokens: Math.round(entry.outputTokens * share),
            stopReason: call === count - 1 ? "end_turn" : "tool_use",
            durationMs,
            toolCalls: call === count - 1 ? 0 : 1 + Math.floor(noise(n + call) * 3),
          });
          elapsed += durationMs;
        }
        entry.calls = calls;
      }
      turns.push(entry);
    }
  }
  const days: UsageDay[] = [];
  for (let day = 15; day < 365; day += 1) {
    const date = new Date(midnight.getTime() - day * 86_400_000);
    const recent = day < 75 ? 1.6 : day < 180 ? 0.8 : 0.3;
    if (date.getDay() === 0 || noise(day * 13) > 0.42 * recent + 0.1) continue;
    const mix = pick(Math.floor(noise(day + 17) * 1000));
    const count = 2 + Math.floor(noise(day + 19) * 8 * recent);
    days.push({ day: dayKey(date.getTime() + 12 * 3_600_000), agentId: mix.agentId, providerId: mix.providerId, modelId: mix.modelId, turns: count, estimatedTurns: 0, inputTokens: mix.input * count, cachedTokens: Math.round(mix.input * count * mix.cached), outputTokens: mix.output * count, durationMs: count * 240_000, tools: { bash: count, read_file: Math.ceil(count / 2) } });
  }
  return { version: 1, turns, days: days.reverse() };
}

/*
 * The plugin library in the browser preview: GitHub fetches are simulated with
 * a short delay and canned repositories, and installs live in memory, so the
 * Add from GitHub flow, sources and the Installed list can all be exercised.
 */
const avatarSvg = (initials: string, hue: number) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="hsl(${hue} 42% 34%)"/><text x="48" y="60" font-family="-apple-system,Helvetica" font-size="38" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text></svg>`)}`;
const logoSvg = (color: string) =>
  `data:image/svg+xml;base64,${btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="22" fill="${color}"/><path d="M52 18 30 54h16l-4 24 24-38H50z" fill="#fff"/></svg>`)}`;

type MockRepo = { avatar: string; plugin?: PluginAnalysis & { icon?: string }; marketplace?: MarketplaceAnalysis; pluginsByName?: Record<string, PluginAnalysis> };
const analysis = (partial: Partial<PluginAnalysis> & { name: string }): PluginAnalysis => ({
  displayName: null, description: null, longDescription: null, version: null, author: null, homepage: null, license: null, category: null, keywords: [], brandColor: null,
  formats: ["Claude Code", "Agent Skills"], skills: [], commands: [], servers: [], agents: [], hooks: false, lsp: false, notes: [], ...partial,
});
const skill = (name: string, description: string) => ({ name, description, folder: `skills/${name}` });
const listing = (name: string, description: string, category: string, location = "This repository"): MarketplacePlugin => ({ name, description, version: null, category, author: null, homepage: null, keywords: [], location, supported: location !== "Not on GitHub" });

const MOCK_REPOS: Record<string, MockRepo> = {
  "obra/superpowers": {
    avatar: avatarSvg("JV", 32),
    plugin: {
      ...analysis({
        name: "superpowers", displayName: "Superpowers", version: "7.0.2", author: "Jesse Vincent", license: "MIT", category: "Developer Tools", brandColor: "#F59E0B",
        description: "Planning, TDD, debugging, and delivery workflows for coding agents",
        longDescription: "Guide agent work through brainstorming, implementation planning, test-driven development, systematic debugging, parallel execution, code review and finish-the-branch workflows.",
        formats: ["Claude Code", "Codex", "Agent Skills"], keywords: ["tdd", "debugging", "planning"], hooks: true,
        skills: [skill("brainstorming", "Turn a rough idea into a design before writing code."), skill("writing-plans", "Write a step-by-step implementation plan."), skill("test-driven-development", "Red, green, refactor for every change."), skill("systematic-debugging", "Four-phase root cause analysis."), skill("verification-before-completion", "Prove it works before saying it does."), skill("using-git-worktrees", "Isolate work in a git worktree.")],
      }),
      icon: logoSvg("#F59E0B"),
    },
  },
  "anthropics/claude-plugins-official": {
    avatar: avatarSvg("A", 18),
    marketplace: {
      name: "claude-plugins-official", owner: "Anthropic", description: "Directory of popular Claude Code extensions including development tools, productivity plugins, and MCP integrations",
      plugins: [
        listing("code-review", "Automated code review for pull requests using multiple specialized agents.", "development"),
        listing("commit-commands", "Commands for git commit workflows: commit, push, and create a PR.", "productivity"),
        listing("frontend-design", "Create distinctive, production-grade frontend interfaces.", "development"),
        listing("security-guidance", "Warns about potential security issues when editing files.", "security"),
        listing("playwright", "Browser automation and end-to-end testing.", "testing", "microsoft/playwright-mcp"),
        listing("sentry", "Error monitoring: inspect issues and fix production bugs.", "monitoring", "getsentry/sentry-mcp"),
        listing("supabase", "Manage your Supabase projects and query your database.", "database", "supabase-community/supabase-mcp"),
        listing("vercel", "Deploy and manage projects on Vercel.", "deployment", "vercel/vercel-plugin"),
        listing("figma", "Bring design context from Figma into code.", "design", "figma/mcp-server-guide"),
        listing("linear", "Linear issue tracking: create, update and search issues.", "productivity", "linear/linear-mcp"),
        listing("stripe", "Stripe development: payments, billing and webhooks.", "development", "stripe/ai"),
        listing("notion", "Search and update your Notion workspace.", "productivity", "makenotion/notion-mcp"),
        listing("pdf-tools", "Hosted outside GitHub.", "productivity", "Not on GitHub"),
      ],
    },
    pluginsByName: {
      "code-review": analysis({ name: "code-review", description: "Automated code review for pull requests using multiple specialized agents.", author: "Anthropic", category: "development", commands: [{ name: "code-review", description: "Review the current pull request", file: "commands/code-review.md" }], agents: ["reviewer", "security-auditor"] }),
      playwright: analysis({ name: "playwright", description: "Browser automation and end-to-end testing.", author: "Microsoft", category: "testing", formats: ["Claude Code", "MCP"], servers: [{ name: "playwright", transport: "stdio", display: "npx @playwright/mcp@latest", needsEnv: [] }] }),
      sentry: analysis({ name: "sentry", description: "Error monitoring: inspect issues and fix production bugs.", author: "Sentry", category: "monitoring", formats: ["Claude Code", "Agent Skills", "MCP"], skills: [skill("sentry-fix-issues", "Find and fix a Sentry issue.")], servers: [{ name: "sentry", transport: "http", display: "https://mcp.sentry.dev/mcp", needsEnv: [] }] }),
    },
  },
  "anthropics/skills": {
    avatar: avatarSvg("A", 18),
    marketplace: {
      name: "anthropic-agent-skills", owner: "Anthropic", description: "Anthropic example skills",
      plugins: [listing("document-skills", "Excel, Word, PowerPoint and PDF processing.", "productivity"), listing("example-skills", "Skill creation, MCP building, visual design, web testing and more.", "development")],
    },
    pluginsByName: {
      "document-skills": analysis({ name: "document-skills", description: "Excel, Word, PowerPoint and PDF processing.", author: "Anthropic", skills: [skill("xlsx", "Spreadsheets with formulas and charts."), skill("docx", "Word documents with tracked changes."), skill("pptx", "PowerPoint decks."), skill("pdf", "Read, fill and merge PDFs.")] }),
    },
  },
};

let mockLibrary: PluginLibrary = { plugins: [], marketplaces: [], pluginsRoot: "~/.glitter/plugins", problems: [] };
const mockStaged = new Map<string, { preview: GithubPreview; repo: string }>();
const SHA = "4f2c8e1a9b7d6c5e3f1a2b4c6d8e0f1a2b3c4d5e";

function mockRepoKey(source: string): string {
  const cleaned = source.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/^github\.com\//i, "").replace(/\.git$/, "");
  const [owner = "", repo = ""] = cleaned.split(/[/@:]/);
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) throw new Error("Name the repository as owner/repo.");
  return `${owner}/${repo}`.toLowerCase();
}

function mockOrigin(repoKey: string, plugin: string | null): PluginOrigin {
  const [owner, repo] = repoKey.split("/");
  return { owner, repo, ref: null, path: "", commit: SHA, plugin, spec: repoKey, url: `https://github.com/${repoKey}` };
}

export async function mockGithubInspect(source: string, plugin?: string | null): Promise<GithubPreview> {
  const key = mockRepoKey(source);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const repo = MOCK_REPOS[key];
  if (!repo) {
    if (key.endsWith("/nope")) throw new Error(`Could not reach ${key} on GitHub. Check the name; a private repository needs git credentials for github.com on this Mac.`);
    const name = key.split("/")[1];
    MOCK_REPOS[key] = { avatar: avatarSvg(key.slice(0, 1).toUpperCase(), 210), plugin: analysis({ name, description: `Skills from ${key}.`, formats: ["Agent Skills"], skills: [skill(`${name}-guide`, "A sample skill from this repository.")] }) };
  }
  const found = MOCK_REPOS[key];
  const token = Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32);
  let preview: GithubPreview;
  if (plugin) {
    const listed = found.pluginsByName?.[plugin] ?? analysis({ name: plugin, description: found.marketplace?.plugins.find((row) => row.name === plugin)?.description ?? null, skills: [skill(plugin, "The plugin's main skill.")] });
    preview = { token, kind: "plugin", origin: mockOrigin(key, plugin), plugin: listed, marketplace: null, icon: null, avatar: found.avatar, pluginId: listed.name, installed: mockLibrary.plugins.some((row) => row.id === listed.name), conflicts: [] };
  } else if (found.marketplace) {
    preview = { token, kind: "marketplace", origin: mockOrigin(key, null), plugin: null, marketplace: found.marketplace, icon: null, avatar: found.avatar, pluginId: null, installed: false, conflicts: [] };
  } else {
    const { icon, ...rest } = found.plugin!;
    preview = { token, kind: "plugin", origin: mockOrigin(key, null), plugin: rest, marketplace: null, icon: icon ?? null, avatar: found.avatar, pluginId: rest.name, installed: mockLibrary.plugins.some((row) => row.id === rest.name), conflicts: [] };
  }
  mockStaged.set(token, { preview, repo: key });
  return preview;
}

export async function mockGithubInstall(token: string, selected?: string[] | null): Promise<PluginInstallOutcome> {
  const staged = mockStaged.get(token);
  if (!staged?.preview.plugin) throw new Error("That preview has expired. Inspect the repository again.");
  await new Promise((resolve) => setTimeout(resolve, 450));
  const plugin = staged.preview.plugin;
  const wanted = (name: string) => !selected?.length || selected.includes(name);
  const skills = plugin.skills.map((row) => row.name).filter(wanted);
  const commands = plugin.commands.map((row) => row.name).filter(wanted);
  const servers = plugin.servers.map((row) => row.name).filter(wanted);
  const at = Date.now();
  const installed: InstalledPlugin = {
    ...plugin, id: plugin.name, icon: staged.preview.icon, avatar: staged.preview.avatar, origin: staged.preview.origin, enabled: true, installedAt: at, updatedAt: at,
    availableSkills: [...plugin.skills, ...plugin.commands.map((row) => ({ name: row.name, description: row.description, folder: row.file }))],
    skills, commands, servers, serverDetails: plugin.servers, notes: plugin.notes, folder: `~/.glitter/plugins/${plugin.name}`,
  };
  mockLibrary = { ...mockLibrary, plugins: [...mockLibrary.plugins.filter((row) => row.id !== installed.id), installed] };
  mockStaged.delete(token);
  return { id: installed.id, skills, commands, servers, problems: [] };
}

export function mockLibraryList(): PluginLibrary {
  return mockLibrary;
}

export function mockSetPluginEnabled(id: string, enabled: boolean): PluginInstallOutcome {
  const plugin = mockLibrary.plugins.find((row) => row.id === id);
  if (!plugin) throw new Error("That plugin is not installed.");
  mockLibrary = { ...mockLibrary, plugins: mockLibrary.plugins.map((row) => row.id === id ? { ...row, enabled } : row) };
  return { id, skills: enabled ? plugin.skills : [], commands: enabled ? plugin.commands : [], servers: enabled ? plugin.servers : [], problems: [] };
}

export function mockRemovePlugin(id: string): string[] {
  mockLibrary = { ...mockLibrary, plugins: mockLibrary.plugins.filter((row) => row.id !== id) };
  return [];
}

export function mockAddMarketplace(token: string): MarketplaceSource {
  const staged = mockStaged.get(token);
  if (!staged?.preview.marketplace) throw new Error("That preview is a plugin. Install it instead.");
  const market = staged.preview.marketplace;
  const source: MarketplaceSource = { id: market.name, name: market.name, description: market.description, owner: market.owner, origin: staged.preview.origin, addedAt: Date.now(), refreshedAt: Date.now(), avatar: staged.preview.avatar, plugins: market.plugins };
  mockLibrary = { ...mockLibrary, marketplaces: [...mockLibrary.marketplaces.filter((row) => row.id !== source.id), source] };
  mockStaged.delete(token);
  return source;
}

export function mockRemoveMarketplace(id: string) {
  mockLibrary = { ...mockLibrary, marketplaces: mockLibrary.marketplaces.filter((row) => row.id !== id) };
}

export function mockRefreshMarketplace(id: string): MarketplaceSource {
  const source = mockLibrary.marketplaces.find((row) => row.id === id);
  if (!source) throw new Error("That source is not added.");
  const refreshed = { ...source, refreshedAt: Date.now() };
  mockLibrary = { ...mockLibrary, marketplaces: mockLibrary.marketplaces.map((row) => row.id === id ? refreshed : row) };
  return refreshed;
}
