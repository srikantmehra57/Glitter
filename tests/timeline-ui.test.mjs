import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-timeline-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { planAnchorFor, showTerminalReceipt, groupAgentRuns, hasVisibleReply, estimateTurnTokens, trailingWork, describeLive, stepFromItem: toStep, agentCounts, backgroundAgents, describeAgents, computeVirtualWindow, estimateRunHeight, stabilizeRuns, editedPaths, activitySummary, activityTitle } = await bundle('apps/desktop/src/lib/agent.ts');
const { formatTokens, formatDuration, formatBytes } = await bundle('apps/desktop/src/lib/format.ts');

const items = (...ids) => ids.map((itemId) => ({ itemId, kind: 'toolCall', status: 'completed' }));
const plan = (...texts) => texts.map((text, index) => ({ id: String(index), text, status: 'pending' }));

test('a new plan anchors at the latest transcript item', () => {
  assert.equal(planAnchorFor({ items: items('a', 'b') }, plan('one', 'two')), 'b');
});

test('status-only plan updates keep the original anchor', () => {
  const thread = { items: items('a', 'b', 'c', 'd'), plan: plan('one', 'two'), planAnchor: 'b' };
  const next = plan('one', 'two').map((item, index) => ({ ...item, status: index ? 'inProgress' : 'completed' }));
  assert.equal(planAnchorFor(thread, next), 'b');
});

test('a rewritten plan moves to where it was rewritten', () => {
  const thread = { items: items('a', 'b', 'c'), plan: plan('one', 'two'), planAnchor: 'a' };
  assert.equal(planAnchorFor(thread, plan('one', 'three')), 'c');
});

test('terminal receipts show only for the latest idle run', () => {
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    assert.equal(showTerminalReceipt(status, true, false), true);
    assert.equal(showTerminalReceipt(status, false, false), false);
    assert.equal(showTerminalReceipt(status, true, true), false);
  }
  for (const status of ['completed', 'running', 'waiting']) {
    assert.equal(showTerminalReceipt(status, true, false), false);
  }
});

test('reminder children are hidden from runs and run status', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Hi', turnId: 't1' },
    { itemId: 'r1', kind: 'reminderChild', status: 'completed', fallbackText: 'Reminder child session', turnId: 't1' },
    { itemId: 'r2', kind: 'reminderChild', status: 'failed', fallbackText: 'Reminder child session', turnId: 't1' },
    { itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'Done', turnId: 't1' },
  ]);
  assert.equal(runs.length, 1);
  assert.ok(runs[0].steps.every((step) => step.kind !== 'reminder'));
  assert.equal(runs[0].status, 'completed');
});

test('a running reminder alone does not keep the run live', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Hi', turnId: 't1' },
    { itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'Done', turnId: 't1' },
    { itemId: 'r', kind: 'reminderChild', status: 'running', fallbackText: 'Reminder child session', turnId: 't1' },
  ]);
  assert.equal(runs[0].status, 'completed');
});

test('a completed turn stays completed when a mid-turn step failed and recovered', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Fix it', turnId: 't1' },
    { itemId: 't', kind: 'toolCall', status: 'failed', tool: 'bash', failureReason: 'exit 1', turnId: 't1' },
    { itemId: 'a', kind: 'agentMessage', status: 'completed', text: 'Fixed', turnId: 't1' },
  ], { lastTurnId: 't1', lastOutcome: 'completed' });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].steps[1].status, 'failed');
  assert.equal(runs[0].status, 'completed');
});

test('a failed step still fails the run without an authoritative outcome', () => {
  const runs = groupAgentRuns([
    { itemId: 'u', kind: 'userMessage', status: 'completed', text: 'Fix it', turnId: 't1' },
    { itemId: 't', kind: 'toolCall', status: 'failed', tool: 'bash', failureReason: 'exit 1', turnId: 't1' },
  ]);
  assert.equal(runs[0].status, 'failed');
});

test('the thinking row yields only when visible reply content reaches the current turn', () => {
  const oldReply = { itemId: 'a1', kind: 'agentMessage', status: 'completed', text: 'Old answer' };
  const prompt = { itemId: 'u2', kind: 'userMessage', status: 'completed', text: 'Next question' };
  const emptyReply = { itemId: 'a2', kind: 'agentMessage', status: 'inProgress', text: '' };
  const visibleReply = { ...emptyReply, text: 'The answer starts here' };
  const reminder = { itemId: 'r2', kind: 'reminderChild', status: 'running' };
  const resumedWork = { itemId: 't2', kind: 'toolCall', status: 'inProgress', tool: 'bash' };
  assert.equal(hasVisibleReply([oldReply, prompt]), false);
  assert.equal(hasVisibleReply([oldReply, prompt, emptyReply]), false);
  assert.equal(hasVisibleReply([oldReply, prompt, visibleReply]), true);
  assert.equal(hasVisibleReply([oldReply, prompt, visibleReply, reminder]), true);
  assert.equal(hasVisibleReply([oldReply, prompt, visibleReply, resumedWork]), false);
});

test('token counts are compact and locale-neutral', () => {
  assert.equal(formatTokens(912), '912');
  assert.equal(formatTokens(20448), '20.4K');
  assert.equal(formatTokens(987549), '988K');
  assert.equal(formatTokens(1007997), '1M');
  assert.equal(formatTokens(1250000), '1.3M');
});

test('elapsed turn time reads as seconds, minutes, then hours', () => {
  assert.equal(formatDuration(8400), '8s');
  assert.equal(formatDuration(72000), '1m 12s');
  assert.equal(formatDuration(3840000), '1h 4m');
  assert.equal(formatDuration(-5), '0s');
});

test('live status covers only the current turn', () => {
  const items = [
    { itemId: 'u1', kind: 'userMessage', status: 'completed', text: 'first' },
    { itemId: 'r1', kind: 'reasoning', status: 'inProgress', text: 'x'.repeat(400) },
    { itemId: 'u2', kind: 'userMessage', status: 'completed', text: 'second' },
    { itemId: 'r2', kind: 'reasoning', status: 'inProgress', text: 'y'.repeat(80) },
    { itemId: 'm2', kind: 'reminderChild', status: 'inProgress' },
    { itemId: 't2', kind: 'toolCall', status: 'completed', tool: 'bash', args: 'z'.repeat(40) },
  ];
  assert.equal(estimateTurnTokens(items), 30);
});

test('live status holds only the work after the last message, in order', () => {
  const items = [
    { itemId: 'u1', kind: 'userMessage', status: 'completed', text: 'go' },
    { itemId: 't1', kind: 'toolCall', status: 'completed', tool: 'read' },
    { itemId: 'a1', kind: 'agentMessage', status: 'completed', text: 'Found it.' },
    { itemId: 't2', kind: 'toolCall', status: 'completed', tool: 'bash' },
    { itemId: 'm1', kind: 'reminderChild', status: 'inProgress' },
    { itemId: 'r1', kind: 'reasoning', status: 'inProgress', text: 'hmm' },
  ];
  assert.deepEqual(trailingWork(items).map((step) => step.id), ['t2', 'r1']);
});

test('live status says what the agent is doing', () => {
  const step = (item) => toStep({ itemId: 'x', status: 'inProgress', ...item });
  assert.equal(describeLive([step({ kind: 'toolCall', tool: 'read_file', args: JSON.stringify({ path: 'apps/desktop/src/lib/store.ts' }) })]), 'Reading store.ts');
  assert.equal(describeLive([step({ kind: 'toolCall', tool: 'bash', commandText: 'npm test' })]), 'Running npm test');
  assert.equal(describeLive([step({ kind: 'reasoning', text: '**Tracing the resume path**\nmore' })]), 'Tracing the resume path');
  assert.equal(describeLive([step({ kind: 'reasoning' })]), undefined);
  assert.equal(describeLive([{ ...step({ kind: 'toolCall', tool: 'bash', commandText: 'ls' }), status: 'completed' }]), undefined);
});

test('the activity summary counts what a run did, by kind', () => {
  const steps = [
    toStep({ itemId: 'r1', kind: 'reasoning', status: 'completed', text: 'hmm' }),
    toStep({ itemId: 'r2', kind: 'reasoning', status: 'completed', text: 'hmm again' }),
    toStep({ itemId: 'e1', kind: 'toolCall', status: 'completed', tool: 'edit_file', args: '{"path":"src/a.ts"}', durationMs: 1200 }),
    toStep({ itemId: 'd1', kind: 'toolCall', status: 'completed', tool: 'read_file', args: '{"path":"src/a.ts"}', durationMs: 300 }),
    toStep({ itemId: 'c1', kind: 'toolCall', status: 'completed', tool: 'bash', commandText: 'npm test', durationMs: 9000 }),
    toStep({ itemId: 'g1', kind: 'toolCall', status: 'completed', tool: 'grep', args: '{"pattern":"foo"}' }),
    toStep({ itemId: 'f1', kind: 'toolCall', status: 'completed', tool: 'bash', commandText: 'boom', failureReason: 'exit 1' }),
  ];
  const summary = activitySummary(steps);
  assert.equal(summary.steps, 7);
  assert.equal(summary.thoughts, 2);
  assert.equal(summary.edits, 1);
  assert.equal(summary.files, 1, 'the same path read and edited is one file');
  assert.equal(summary.commands, 2);
  assert.equal(summary.failures, 1);
  assert.equal(summary.durationMs, 10500);
  assert.deepEqual(summary.shares, { thinking: 2, files: 2, commands: 2, other: 1 });
});

test('a folded group says what ran in as few honest words as possible', () => {
  const tool = (id) => toStep({ itemId: id, kind: 'toolCall', status: 'completed', tool: 'bash', commandText: 'npm test' });
  const thought = toStep({ itemId: 'r', kind: 'reasoning', status: 'completed', text: 'hmm' });
  assert.equal(activityTitle([tool('a')]), 'Ran 1 tool');
  assert.equal(activityTitle([tool('a'), tool('b')]), 'Ran 2 tools');
  assert.equal(activityTitle([tool('a'), thought]), '2 steps', 'a group with thoughts is steps, not tools');
  assert.equal(activityTitle([tool('a'), tool('b')], true), 'Running');
});

test('workflow agents count from the host vocabulary, and a finished workflow has none running', () => {
  const done = { childId: 'a', attempt: 1, status: 'terminal', terminal: 'completed', durationMs: 108011 };
  const live = { childId: 'b', attempt: 1, status: 'started' };
  const running = { itemId: 'w', kind: 'workflow', status: 'inProgress', children: [done, done, live] };
  assert.deepEqual({ ...agentCounts(running), states: undefined }, { total: 3, running: 1, pending: 0, completed: 2, failed: 0, cancelled: 0, states: undefined });
  const failed = { ...running, status: 'failed', reason: 'incomplete' };
  assert.equal(agentCounts(failed).running, 0);
  assert.equal(agentCounts(failed).cancelled, 1);
  assert.deepEqual(backgroundAgents([running, failed]).map((item) => item.status), ['inProgress']);
  assert.equal(describeAgents([running]), 'Waiting on 3 agents · 2 done');
  assert.equal(describeAgents([{ itemId: 's', kind: 'subagent', status: 'inProgress', objective: 'Audit security' }]), 'Waiting on agent: Audit security');
});

test('stored output bytes format compactly', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(20480), '20 KB');
  assert.equal(formatBytes(6 * 1024 * 1024), '6 MB');
  assert.equal(formatBytes(-1), '0 B');
});

test('older history prepends with held items winning', async () => {
  const { mergeHistoryItems } = await bundle('apps/desktop/src/lib/agent.ts');
  const held = { itemId: 'b', kind: 'toolCall', status: 'completed', text: 'new' };
  assert.deepEqual(
    mergeHistoryItems([held], [{ itemId: 'a', kind: 'userMessage', status: 'completed' }, { itemId: 'b', kind: 'toolCall', status: 'completed', text: 'stale' }]),
    [{ itemId: 'a', kind: 'userMessage', status: 'completed' }, held],
  );
});

test('session-list time filters cut off at day, week, and month', async () => {
  const { timeFilterCutoff } = await bundle('apps/desktop/src/lib/format.ts');
  const now = Date.parse('2026-09-20T12:00:00Z');
  assert.equal(timeFilterCutoff('day', now), '2026-09-19T12:00:00.000Z');
  assert.equal(timeFilterCutoff('week', now), '2026-09-13T12:00:00.000Z');
  assert.equal(timeFilterCutoff('month', now), '2026-08-21T12:00:00.000Z');
});

test('timeline virtualization keeps all runs on short threads', () => {
  const shortRuns = [
    { id: 'r1', status: 'completed', steps: [] },
    { id: 'r2', status: 'completed', steps: [] },
    { id: 'r3', status: 'completed', steps: [] },
  ];
  const window = computeVirtualWindow(shortRuns, 0, 800, () => 120);
  assert.equal(window.isVirtualized, false);
  assert.equal(window.startIndex, 0);
  assert.equal(window.endIndex, 2);
  assert.equal(window.totalHeight, 360);
});

test('timeline virtualization slices 100+ message threads with stable overscan', () => {
  // Generate a long conversation: 30 runs, each with 4 transcript items (120 items total).
  const allItems = [];
  for (let r = 0; r < 30; r++) {
    allItems.push(
      { itemId: `u-${r}`, turnId: `t-${r}`, kind: 'userMessage', status: 'completed', text: `Prompt ${r}` },
      { itemId: `th-${r}`, turnId: `t-${r}`, kind: 'reasoning', status: 'completed', text: `Thought for turn ${r}` },
      { itemId: `tc-${r}`, turnId: `t-${r}`, kind: 'toolCall', status: 'completed', tool: 'bash', commandText: `cmd-${r}` },
      { itemId: `a-${r}`, turnId: `t-${r}`, kind: 'agentMessage', status: 'completed', text: `Response ${r}` },
    );
  }
  assert.equal(allItems.length, 120);
  const runs = groupAgentRuns(allItems);
  assert.equal(runs.length, 30);

  // Each run has a positive estimated height
  for (const run of runs) {
    assert.ok(estimateRunHeight(run) >= 90);
  }

  // Scrolled at top: startIndex is 0, endIndex covers top visible runs plus overscan
  const topWindow = computeVirtualWindow(runs, 0, 800, estimateRunHeight, 4);
  assert.equal(topWindow.isVirtualized, true);
  assert.equal(topWindow.startIndex, 0);
  assert.ok(topWindow.endIndex < 20);
  assert.ok(topWindow.totalHeight > 3000);

  // Scrolled to bottom: startIndex is near the end, endIndex includes the latest run
  const bottomWindow = computeVirtualWindow(runs, topWindow.totalHeight - 800, 800, estimateRunHeight, 4);
  assert.equal(bottomWindow.isVirtualized, true);
  assert.ok(bottomWindow.startIndex > 15);
  assert.equal(bottomWindow.endIndex, 29);
});

test('a 500-run thread windows in under 100ms and stays bounded', () => {
  const runs = Array.from({ length: 500 }, (_, index) => ({ id: `r${index}`, status: 'completed', steps: [] }));
  const started = performance.now();
  const window = computeVirtualWindow(runs, 40_000, 800, () => 120, 4, 10);
  const elapsed = performance.now() - started;
  assert.equal(window.isVirtualized, true);
  assert.ok(window.endIndex - window.startIndex < 20, `window span ${window.endIndex - window.startIndex}`);
  assert.ok(elapsed < 100, `virtual window took ${elapsed.toFixed(1)}ms`);
});


// ─── stable steps and runs: what lets memoized rows skip a stream frame ───────

const turn = (n, extra = []) => [
  { itemId: `u${n}`, kind: 'userMessage', status: 'completed', text: `question ${n}`, turnId: `t${n}` },
  { itemId: `c${n}`, kind: 'toolCall', status: 'completed', tool: 'edit_file', args: JSON.stringify({ path: `src/f${n}.ts` }), turnId: `t${n}` },
  { itemId: `a${n}`, kind: 'agentMessage', status: 'completed', text: `answer ${n}`, turnId: `t${n}` },
  ...extra,
];

test('a step is built once per item and shared by every later grouping', () => {
  const [user, tool] = turn(1);
  assert.equal(toStep(tool), toStep(tool), 'the same item yields the very same step');
  assert.notEqual(toStep(tool), toStep({ ...tool }), 'a replaced item is a new step, so a change is never hidden');
  const first = groupAgentRuns([user, tool]);
  const second = groupAgentRuns([user, tool]);
  assert.equal(first[0].steps[1], second[0].steps[1], 'regrouping reuses the steps');
  assert.equal(first[0].steps[1].path, 'src/f1.ts');
});

test('a step reflects an edited item once the item is replaced', () => {
  const item = { itemId: 'm', kind: 'agentMessage', status: 'inProgress', text: 'Hel', turnId: 't' };
  const before = toStep(item);
  const grown = { ...item, text: 'Hello there' };
  assert.equal(before.detail, 'Hel');
  assert.equal(toStep(grown).detail, 'Hello there');
});

test('stabilizeRuns hands back the identical run for every run a stream frame did not touch', () => {
  const items = [...turn(1), ...turn(2), ...turn(3)];
  const options = { threadRunning: true, activeTurnId: 't3' };
  const before = groupAgentRuns(items, options);
  // One streamed token later: only the last message item was replaced.
  const streamed = items.map((item) => item.itemId === 'a3' ? { ...item, text: 'answer 3, and more' } : item);
  const after = stabilizeRuns(before, groupAgentRuns(streamed, options));
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.notEqual(after[2], before[2], 'the run that changed is new');
  assert.equal(after[2].steps[2].detail, 'answer 3, and more');
});

test('stabilizeRuns does not reuse a run whose status, turn or step list changed', () => {
  const items = [...turn(1), ...turn(2)];
  const before = groupAgentRuns(items, { threadRunning: true, activeTurnId: 't2' });
  const finished = stabilizeRuns(before, groupAgentRuns(items, { threadRunning: false, lastOutcome: 'completed' }));
  assert.equal(before[1].status, 'running');
  assert.equal(finished[1].status, 'completed');
  assert.notEqual(finished[1], before[1], 'a status change must re-render the run');
  const grown = stabilizeRuns(before, groupAgentRuns([...items, { itemId: 'x', kind: 'toolCall', status: 'inProgress', tool: 'bash', turnId: 't2' }], { threadRunning: true, activeTurnId: 't2' }));
  assert.notEqual(grown[1], before[1], 'a new step must re-render the run');
  assert.equal(grown[0], before[0]);
  assert.deepEqual(stabilizeRuns([], before), before);
  assert.deepEqual(stabilizeRuns(before, []), []);
});

test('edited paths are read once per item and still follow the transcript', () => {
  const items = [...turn(1), ...turn(2)];
  assert.deepEqual(editedPaths(items, '/repo'), ['src/f1.ts', 'src/f2.ts']);
  assert.deepEqual(editedPaths(items.slice(0, 3), '/repo'), ['src/f1.ts']);
  assert.deepEqual(editedPaths([{ itemId: 'r', kind: 'toolCall', status: 'completed', tool: 'read_file', args: '{"path":"a.ts"}' }], '/repo'), [], 'reads are not edits');
  assert.deepEqual(editedPaths([{ itemId: 'w', kind: 'toolCall', status: 'completed', tool: 'write_file', args: '{"path":"/repo/x/y.ts"}' }], '/repo'), ['x/y.ts']);
  assert.deepEqual(editedPaths(items, '/repo'), ['src/f1.ts', 'src/f2.ts'], 'a second read of cached items agrees');
});
