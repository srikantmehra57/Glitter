#!/usr/bin/env node
// The packaged webview must not parse xterm or highlight.js at startup.
// Both are loaded on demand (the terminal pane, a highlighted code block).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dist = resolve('apps/desktop/dist');
const manifestPath = join(dist, '.vite/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const chunks = Object.values(manifest);
const entry = chunks.find((chunk) => chunk.isEntry);
assert.ok(entry, 'vite manifest has no entry chunk');

const byFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
const byKey = new Map(Object.entries(manifest));

function chunkFor(spec) {
  return byFile.get(spec) ?? byKey.get(spec);
}

function reachable(root) {
  const seen = new Set();
  const visit = (spec) => {
    const chunk = chunkFor(spec);
    const file = chunk?.file ?? spec;
    if (!file || seen.has(file)) return;
    seen.add(file);
    for (const next of chunk?.imports ?? []) visit(next);
  };
  visit(root);
  return seen;
}

const startup = reachable(entry.file);
for (const file of startup) {
  const chunk = byFile.get(file);
  const label = `${chunk?.name ?? ""} ${chunk?.src ?? ""} ${file}`;
  assert.ok(!/xterm|highlight/i.test(label), `startup graph includes ${label.trim()}`);
}

// A module inlined into the entry has no manifest record of its own, and the
// entry's src is index.html, so the walk above cannot see it. Core and xterm
// must be their own files. Grammars stay separate; merging them would load
// every language on the first highlight.
for (const chunk of chunks) {
  const label = `${chunk.name ?? ""} ${chunk.src ?? ""}`;
  if (/xterm|highlight/i.test(label)) {
    assert.notEqual(chunk.file, entry.file, `startup file contains ${label.trim()}`);
  }
}

function bytesOf(chunk) {
  return statSync(join(dist, chunk.file)).size;
}

const xterm = chunks.find((chunk) => chunk.name === "xterm" || (chunk.src ?? "").includes("@xterm/xterm"));
assert.ok(xterm, "missing xterm chunk");
const xtermBytes = bytesOf(xterm);
const highlightCore = chunks.find((chunk) => /highlight\.js\/(?:es|lib)\/core\.js$/.test((chunk.src ?? "").replaceAll("\\", "/")));
assert.ok(highlightCore, "highlight.js core was inlined into another chunk");
assert.ok(!startup.has(highlightCore.file), "startup graph includes highlight.js core");
const highlight = chunks.filter((chunk) => (chunk.src ?? "").includes("highlight.js"));
assert.ok(highlight.length > 1, "highlight.js grammars were merged into the core chunk");
const highlightBytes = highlight.reduce((sum, chunk) => sum + bytesOf(chunk), 0);
const entryBytes = bytesOf(entry);
assert.ok(xtermBytes > 100_000, `xterm chunk collapsed (${xtermBytes} bytes)`);
assert.ok(highlightBytes > 10_000, `highlight.js collapsed (${highlightBytes} bytes)`);
// Headroom over the measured entry. xterm alone is ~300 kB; a merge would blow this.
assert.ok(entryBytes < 1_050_000, `startup chunk is ${entryBytes} bytes; xterm or highlight.js may have been merged into it`);

const html = readFileSync(join(dist, 'index.html'), 'utf8');
assert.match(html, new RegExp(entry.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.doesNotMatch(html, /xterm|highlight/);

const stray = readdirSync(join(dist, 'assets')).filter((name) => name.startsWith('index-') && name.endsWith('.js'));
assert.equal(stray.length, 1, `expected one startup script, found ${stray.join(', ')}`);

console.log(`startup ${entry.file} ${(entryBytes / 1024).toFixed(0)} kB; xterm ${(xtermBytes / 1024).toFixed(0)} kB; highlight.js ${(highlightBytes / 1024).toFixed(0)} kB across ${highlight.length} chunks`);
