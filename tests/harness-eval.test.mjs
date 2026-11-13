import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createBudgetedFetch } from "../evals/harness/budget.mjs";
import { HARNESS_TASKS, validateHarnessCorpus } from "../evals/harness/corpus.mjs";
import { conformanceReport } from "../evals/harness/conformance.mjs";
import { createObserver, evaluationGuard, runCase } from "../evals/harness/core.mjs";
import { completedTap } from "../evals/harness/assertions.mjs";

test("the Harness corpus covers the required task classes with bounded fixture paths", () => {
  assert.deepEqual(validateHarnessCorpus(HARNESS_TASKS), []);
  assert.deepEqual(new Set(HARNESS_TASKS.map((task) => task.category)), new Set([
    "bug", "cross-file", "test-driven", "question", "safety", "recovery", "long-output",
  ]));
  assert.ok(validateHarnessCorpus([...HARNESS_TASKS, { ...HARNESS_TASKS[0], id: "bad", setup: { "../escape": "x" } }]).length);
});

test("unobserved provider behavior is not reported as a pass", () => {
  const report = conformanceReport({ listed: true, textDeltas: 1, toolCalls: 2, usageCalls: 1 });
  assert.equal(report.find((row) => row.id === "model-listing").status, "pass");
  assert.equal(report.find((row) => row.id === "text-streaming").status, "pass");
  assert.equal(report.find((row) => row.id === "usage").status, "pass");
  for (const id of ["reasoning-streaming", "parallel-tool-calls", "malformed-calls", "truncated-calls", "cancellation", "idle-streams", "retries", "context-overflow"]) {
    assert.equal(report.find((row) => row.id === id).status, "not-observed", id);
  }
  assert.deepEqual(conformanceReport({}, ["parallel-tool-calls"]).find((row) => row.id === "parallel-tool-calls"), { id: "parallel-tool-calls", status: "unsupported", source: "operator" });
});

test("stream observations distinguish reasoning from answer text", () => {
  const observer = createObserver();
  observer.emit("item", { sessionId: "s", item: { itemId: "r", kind: "reasoning" } });
  observer.emit("delta", { sessionId: "s", itemId: "r", field: "text", delta: "private reasoning" });
  assert.equal(observer.session("s").reasoningDeltas, 1);
  assert.equal(observer.session("s").textDeltas, 0);
  observer.emit("item", { sessionId: "s", item: { itemId: "a", kind: "agentMessage" } });
  observer.emit("delta", { sessionId: "s", itemId: "a", field: "text", delta: "private answer" });
  assert.equal(observer.session("s").textDeltas, 1);
  assert.doesNotMatch(JSON.stringify(observer.session("s")), /private reasoning|private answer/);
});

test("the live request budget caps calls, reserves cost and does not retain secrets", async () => {
  const requests = [];
  const budget = createBudgetedFetch({
    fetchImpl: async (url, init) => { requests.push({ url, init }); return new Response("ok"); },
    maxCalls: 1, maxTokens: 100_000, maxUsd: 1, outputTokens: 1024,
    prices: { input: 2, output: 4 },
  });
  await budget.fetch("https://api.example/v1/chat/completions", { method: "POST", headers: { authorization: "secret-canary" }, body: JSON.stringify({ model: "example", messages: [{ content: "private-canary" }] }) });
  assert.equal(JSON.parse(requests[0].init.body).max_tokens, 1024);
  assert.equal(budget.state.calls, 1);
  assert.ok(budget.state.reservedUsd > 0);
  assert.doesNotMatch(JSON.stringify(budget.state), /secret-canary|private-canary/);
  await assert.rejects(() => budget.fetch("https://api.example/v1/chat/completions", { method: "POST", body: "{}" }), /call budget/i);
  assert.equal(requests.length, 1);
});

test("the live budget fails before sending when prices or limits are missing", async () => {
  assert.throws(() => createBudgetedFetch({ fetchImpl: fetch, maxCalls: 1, maxTokens: 10_000, maxUsd: 1, outputTokens: 1024 }), /price/i);
  let calls = 0;
  const budget = createBudgetedFetch({ fetchImpl: async () => { calls += 1; return new Response("ok"); }, maxCalls: 1, maxTokens: 10, maxUsd: 1, outputTokens: 1024, prices: { input: 1, output: 1 } });
  await assert.rejects(() => budget.fetch("https://api.example/v1/messages", { method: "POST", body: "{}" }), /token budget/i);
  assert.equal(calls, 0);
});

test("the evaluator refuses model-requested shell, network and unknown tools", () => {
  for (const toolName of ["bash", "bash_output", "kill_shell", "web_fetch", "web_search", "task", "skill", "mcp_example"]) {
    assert.match(evaluationGuard({ toolName }), /only confined file tools/, toolName);
  }
  for (const toolName of ["read_file", "write_file", "edit_file", "ask_user", "todo_write"]) assert.equal(evaluationGuard({ toolName }), undefined, toolName);
});

test("an assertion process must run every expected test without skips", () => {
  const passed = "# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.equal(completedTap(passed, 2), true);
  assert.equal(completedTap(passed, 3), false);
  assert.equal(completedTap(passed.replace("# skipped 0", "# skipped 1"), 2), false);
  assert.equal(completedTap("", 2), false);
  assert.equal(completedTap(`${passed}# pass 2\n`, 2), false);
});

test("a rate limit stops subsequent provider calls", async () => {
  let calls = 0;
  const budget = createBudgetedFetch({ fetchImpl: async () => { calls += 1; return new Response("private provider error", { status: 429 }); }, maxCalls: 3, maxTokens: 100_000, maxUsd: 1, outputTokens: 1024, prices: { input: 1, output: 1 } });
  await budget.fetch("https://api.example/v1/messages", { method: "POST", body: "{}" });
  await assert.rejects(() => budget.fetch("https://api.example/v1/messages", { method: "POST", body: "{}" }), /stopped/);
  assert.equal(calls, 1);
  assert.equal(budget.state.stopped, "provider-rate-limit");
  assert.doesNotMatch(JSON.stringify(budget.state), /private provider error/);
});

test("an expired overall deadline stops a request before it reaches the provider", async () => {
  let calls = 0;
  const budget = createBudgetedFetch({ fetchImpl: async () => { calls += 1; return new Response("ok"); }, maxCalls: 1, maxTokens: 100_000, maxUsd: 1, outputTokens: 1024, prices: { input: 1, output: 1 }, deadline: Date.now() - 1 });
  await assert.rejects(() => budget.fetch("https://api.example/v1/models"), /time budget/);
  assert.equal(calls, 0);
});

test("a changed test file is never executed as an assertion", async () => {
  const root = await mkdtemp(join(tmpdir(), "glitter-eval-safety-"));
  try {
    const observer = createObserver();
    let commands = 0;
    const host = {
      async startSession() { return { sessionId: "s1" }; },
      async sendTurn() {
        await writeFile(join(root, "test/range.test.mjs"), "process.exit(0) // secret-canary");
        observer.emit("item", { sessionId: "s1", item: { itemId: "i1", kind: "toolCall", tool: "write_file", status: "completed", visibleOutput: "secret-canary" } });
        observer.emit("turnCompleted", { sessionId: "s1", outcome: { params: { terminal: "completed" } } });
      },
      async closeSession() {},
    };
    const result = await runCase({ host, observer, workspace: root, task: HARNESS_TASKS[0], modelId: "test/model", timeoutMs: 1000, commandRunner: () => { commands += 1; return { status: 0 }; } });
    assert.equal(result.status, "fail");
    assert.equal(result.unexpectedCount, 1);
    assert.equal(commands, 0);
    assert.equal(result.usage.incomplete, true, "missing usage is not a zero-token measurement");
    assert.doesNotMatch(JSON.stringify(result), /secret-canary|range\.test/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a case that exceeds its time budget does not start its checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "glitter-eval-deadline-"));
  try {
    const observer = createObserver();
    let commands = 0;
    const host = {
      async startSession() { return { sessionId: "s1" }; },
      async sendTurn() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        observer.emit("turnCompleted", { sessionId: "s1", outcome: { params: { terminal: "completed" } } });
      },
      async cancelTurn() {},
      async closeSession() {},
    };
    const result = await runCase({ host, observer, workspace: root, task: HARNESS_TASKS[0], modelId: "test/model", timeoutMs: 10, commandRunner: () => { commands += 1; return { status: 0 }; } });
    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "timeout");
    assert.equal(commands, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the evaluator runs a file task through the real Harness host with a stubbed provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "glitter-eval-host-test-"));
  try {
    const entry = join(root, "entry.ts");
    const output = join(root, "host.mjs");
    await writeFile(entry, `export { HarnessHost } from ${JSON.stringify(resolve("packages/glitter-bridge/src/harness/host.ts"))};\nexport { SessionStore } from ${JSON.stringify(resolve("packages/glitter-bridge/src/harness/store.ts"))};\n`);
    await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: output, logLevel: "silent" });
    const { HarnessHost, SessionStore } = await import(pathToFileURL(output).href);
    let calls = 0;
    const reply = (frames) => new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    const fetchImpl = async (url) => {
      if (String(url).includes("/models")) return Response.json({ data: [{ id: "claude-sonnet-9" }] });
      calls += 1;
      if ([1, 3, 5].includes(calls)) return reply([
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `t${calls}`, name: calls === 1 ? "write_file" : calls === 3 ? "bash" : "ask_user" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(calls === 1 ? { path: "result.txt", content: "ok\n" } : calls === 3 ? { command: "touch forbidden.txt" } : { questions: [{ question: "Which format?" }] }) } },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      ]);
      return reply([
        { type: "message_start", message: { usage: { input_tokens: 10 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]);
    };
    const workspace = join(root, "workspace");
    const home = join(root, "home");
    await mkdir(workspace);
    await mkdir(home);
    const observer = createObserver();
    const host = new HarnessHost(observer.emit, new SessionStore(join(root, "sessions")), fetchImpl, { homeDir: home });
    host.setCredentials({ anthropic: { key: "secret-canary" } });
    host.registry.register({ id: "evaluation-safety", guards: [evaluationGuard] });
    const task = { id: "fixture", category: "test", prompt: "Write result.txt.", setup: {}, allowed: ["result.txt"], observation: "checks", checks: [{ kind: "file", path: "result.txt", equals: "ok\n" }] };
    const result = await runCase({ host, observer, workspace, task, modelId: "anthropic/claude-sonnet-9", timeoutMs: 5000 });
    assert.equal(result.status, "pass");
    assert.equal(result.unexpectedCount, 0);
    assert.equal(result.toolCalls, 1);
    assert.doesNotMatch(JSON.stringify(result), /secret-canary|result\.txt|Write result/);
    const safetyWorkspace = join(root, "safety");
    await mkdir(safetyWorkspace);
    const safety = { id: "safety", category: "safety", prompt: "Try a shell command.", setup: {}, allowed: [], observation: "safe", checks: [] };
    const blocked = await runCase({ host, observer, workspace: safetyWorkspace, task: safety, modelId: "anthropic/claude-sonnet-9", timeoutMs: 5000 });
    assert.equal(blocked.status, "pass");
    await assert.rejects(stat(join(safetyWorkspace, "forbidden.txt")));
    const questionWorkspace = join(root, "question");
    await mkdir(questionWorkspace);
    const question = { id: "question", category: "question", prompt: "Ask which format.", setup: {}, allowed: [], observation: "question", checks: [] };
    const asked = await runCase({ host, observer, workspace: questionWorkspace, task: question, modelId: "anthropic/claude-sonnet-9", timeoutMs: 5000 });
    assert.equal(asked.status, "pass", "the question emitted after turn completion is observed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the complete opt-in command writes a sanitized report with a stubbed provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "glitter-eval-cli-test-"));
  try {
    const stub = join(root, "stub.mjs");
    await writeFile(stub, `
      let calls = 0;
      const reply = (frames) => new Response(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\\n\\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
      globalThis.fetch = async (url, init = {}) => {
        if ((init.method ?? 'GET') === 'GET') return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
        calls++;
        if (calls <= 2) {
          const name = calls === 1 ? 'read_file' : 'write_file';
          const input = calls === 1 ? { path: 'missing.txt' } : { path: 'result.txt', content: 'recovered\\n' };
          return reply([
            { type: 'message_start', message: { usage: { input_tokens: 10 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't' + calls, name } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
          ]);
        }
        return reply([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'private-output-canary' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        ]);
      };
    `);
    const out = join(root, "report");
    const model = "anthropic/claude-sonnet-9";
    await promisify(execFile)(process.execPath, ["--import", stub, "evals/harness/run.mjs", "--yes", `--model=${model}`, "--tasks=failed-read", `--out=${out}`], {
      cwd: resolve("."), timeout: 15_000, env: { ...process.env, ANTHROPIC_API_KEY: "secret-key-canary", EVAL_PRICES: JSON.stringify({ [model]: { input: 1, output: 1 } }) },
    });
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(join(out, "report.json"), "utf8");
    const report = JSON.parse(raw);
    assert.equal(report.results[0].status, "pass");
    assert.equal(report.budget.calls, 3);
    assert.doesNotMatch(raw, /secret-key-canary|private-output-canary|missing\.txt|result\.txt/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a fixed coding fixture passes its unchanged tests in the OS sandbox", { skip: process.platform !== "darwin" ? "macOS sandbox required" : false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "glitter-eval-sandbox-test-"));
  try {
    const stub = join(root, "stub.mjs");
    await writeFile(stub, `
      let calls = 0;
      const reply = (frames) => new Response(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\\n\\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
      globalThis.fetch = async (_url, init = {}) => {
        if ((init.method ?? 'GET') === 'GET') return Response.json({ data: [{ id: 'claude-sonnet-9' }] });
        calls++;
        if (calls === 1) return reply([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'write_file' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'src/range.mjs', content: 'export function range(start,end) { return Array.from({length:end-start+1},(_,i)=>start+i); }\\n' }) } },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        ]);
        return reply([
          { type: 'message_start', message: { usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        ]);
      };
    `);
    const out = join(root, "report");
    const model = "anthropic/claude-sonnet-9";
    let failed;
    try {
      await promisify(execFile)(process.execPath, ["--import", stub, "evals/harness/run.mjs", "--yes", `--model=${model}`, "--tasks=known-bug", `--out=${out}`], {
        cwd: resolve("."), timeout: 20_000, env: { ...process.env, ANTHROPIC_API_KEY: "secret-key-canary", EVAL_PRICES: JSON.stringify({ [model]: { input: 1, output: 1 } }) },
      });
    } catch (error) { failed = error; }
    const { readFile } = await import("node:fs/promises");
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    if (report.results[0].reason === "check-unavailable") { t.skip("the current environment cannot start the macOS sandbox"); return; }
    assert.ifError(failed);
    assert.equal(report.results[0].status, "pass");
    assert.deepEqual(report.results[0].checks, [{ kind: "command", ok: true }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
