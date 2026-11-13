import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'glitter-sandbox-integration-'));
const outdir = join(temporary, 'bundle');
await mkdir(outdir);
await build({
  entryPoints: {
    tools: resolve('packages/glitter-harness/src/harness/tools.ts'),
    mcp: resolve('packages/glitter-harness/src/harness/mcp.ts'),
    'mcp-config': resolve('packages/glitter-harness/src/harness/mcp-config.ts'),
    isolation: resolve('packages/glitter-harness/src/isolation.ts'),
  },
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'silent',
});
const [{ runTool }, { McpManager, mcpToolName }, { mcpConfigFingerprints }, { sandboxBackend }] = await Promise.all(
  ['tools', 'mcp', 'mcp-config', 'isolation'].map((name) => import(pathToFileURL(join(outdir, `${name}.js`)).href)),
);

/** Unsupported hosts skip explicitly; a real seatbelt failure is not a pass. */
function environmentSkip() {
  if (process.platform !== 'darwin') return 'macOS seatbelt integration requires darwin';
  if (!existsSync('/usr/bin/sandbox-exec')) return 'macOS sandbox-exec is unavailable';
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 8_000 });
  if (probe.status === 0) return null;
  const detail = `${probe.stderr ?? ''}`.split('\n').find(Boolean) ?? `exit ${probe.status}`;
  if (probe.error || /sandbox_apply: Operation not permitted/.test(detail)) return `macOS cannot apply a nested sandbox here: ${detail}`;
  throw new Error(`macOS seatbelt preflight failed: ${detail}`);
}

const integration = { skip: environmentSkip() ?? false, timeout: 20_000 };
const workspace = () => mkdtemp(join(temporary, 'workspace-'));

test('macOS seatbelt integration: the Harness shell runs as a sandbox process', integration, async () => {
  const root = await workspace();
  assert.equal(sandboxBackend(), 'seatbelt');
  const result = await runTool(root, 'bash', { command: 'printf shell-ok > shell-proof.txt && printf shell-ok' });
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /shell-ok/);
  assert.equal(await readFile(join(root, 'shell-proof.txt'), 'utf8'), 'shell-ok');
});

test('macOS seatbelt integration: a stdio MCP server starts and answers as a sandbox process', integration, async () => {
  const root = await workspace();
  const home = await mkdtemp(join(temporary, 'home-'));
  const marker = join(root, 'mcp-started.txt');
  const scriptPath = join(root, 'echo-server.mjs');
  await writeFile(scriptPath, `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync(${JSON.stringify(marker)}, 'started');
createInterface({ input: process.stdin }).on('line', (line) => {
  const body = JSON.parse(line);
  if (body.id == null) return;
  const result = body.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sandbox-echo', version: '1.0.0' } }
    : body.method === 'tools/list'
      ? { tools: [{ name: 'echo', description: 'Echo one value', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }
      : { content: [{ type: 'text', text: String(body.params?.arguments?.text ?? '') }], isError: false };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) + '\\n');
});
`);
  await mkdir(join(root, '.glitter'));
  await writeFile(join(root, '.glitter', 'mcp.json'), JSON.stringify({ mcpServers: {
    echo: { command: process.execPath, args: [scriptPath] },
  } }));
  const manager = new McpManager(home, () => {});
  const turn = { sessionId: 'sandbox-integration', turnId: 'turn-1', workspaceRoot: root, mode: 'build' };
  try {
    const authorization = { workspaceTrusted: true, ...await mcpConfigFingerprints(root, home) };
    await manager.ensure(root, authorization, turn.sessionId);
    assert.equal(sandboxBackend(), 'seatbelt');
    assert.deepEqual(manager.status(turn.sessionId), { servers: [{ name: 'echo', transport: 'stdio', tools: 1 }], error: null });
    assert.equal(await readFile(marker, 'utf8'), 'started');
    const generation = manager.acquire(turn);
    const row = generation?.byName.get(mcpToolName('echo', 'echo'));
    assert.ok(row);
    const produced = await row.definition.run(root, { text: 'mcp-sandbox-ok' });
    assert.equal(produced.value.kind, 'mcp');
    assert.match(produced.value.text, /mcp-sandbox-ok/);
  } finally {
    manager.release(turn);
    await manager.close();
  }
});
