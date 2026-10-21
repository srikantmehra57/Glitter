import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-syntax-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const { syntaxLanguage, parseSyntaxHtml, syntaxLines, segmentCode, syntaxSourceAllowed, loadSyntaxHighlighter, SYNTAX_SOURCE_CAP, SYNTAX_LINE_CAP } = await bundle('apps/desktop/src/lib/syntax.ts');

test('language resolution maps every alias and never infers unknown fences', () => {
  const roots = ['javascript', 'typescript', 'json', 'xml', 'css', 'bash', 'python', 'rust', 'go', 'yaml', 'sql', 'markdown', 'cpp', 'c', 'java', 'csharp', 'ruby', 'dockerfile', 'graphql', 'ini'];
  for (const root of roots) assert.equal(syntaxLanguage(root), root, `root ${root}`);
  for (const [alias, root] of [
    ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
    ['ts', 'typescript'], ['tsx', 'typescript'], ['mts', 'typescript'], ['cts', 'typescript'],
    ['html', 'xml'], ['htm', 'xml'], ['svg', 'xml'], ['vue', 'xml'], ['svelte', 'xml'],
    ['sh', 'bash'], ['zsh', 'bash'], ['shell', 'bash'],
    ['py', 'python'], ['rs', 'rust'], ['yml', 'yaml'], ['md', 'markdown'],
    ['h', 'cpp'], ['hpp', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'],
    ['cs', 'csharp'], ['rb', 'ruby'], ['toml', 'ini'], ['cfg', 'ini'], ['gql', 'graphql'],
  ]) assert.equal(syntaxLanguage(alias), root, `alias ${alias}`);
  // Case-insensitive fences and path-driven resolution.
  assert.equal(syntaxLanguage('TypeScript'), 'typescript');
  assert.equal(syntaxLanguage(undefined, 'src/app.tsx'), 'typescript');
  assert.equal(syntaxLanguage(undefined, '/repo/Dockerfile'), 'dockerfile');
  assert.equal(syntaxLanguage(undefined, '/home/u/.bashrc'), 'bash');
  assert.equal(syntaxLanguage(undefined, 'a/b.py?raw'), 'python');
  // Explicit unknown language never falls back or autodetects.
  assert.equal(syntaxLanguage('brainfuck'), undefined);
  assert.equal(syntaxLanguage('wolfram', 'file.py'), undefined);
  // No language and unusable/no path stays plain.
  assert.equal(syntaxLanguage(), undefined);
  assert.equal(syntaxLanguage(undefined, 'noext'), undefined);
  assert.equal(syntaxLanguage(undefined, '.hidden'), undefined);
  assert.equal(syntaxLanguage('', 'a.md'), 'markdown');
});

test('the adapter reproduces source identity and maps fixed token kinds', () => {
  const source = 'const s = "&lt;&amp;" \'q\';';
  const html = '<span class="hljs-keyword">const</span> s = <span class="hljs-string">&quot;&amp;lt;&amp;amp;&quot;</span> <span class="hljs-string">\'q\'</span>;';
  const spans = parseSyntaxHtml(source, html);
  assert.deepEqual(spans, [
    { start: 0, end: 5, kind: 'keyword' },
    { start: 10, end: 21, kind: 'string' },
    { start: 22, end: 25, kind: 'string' },
  ]);
  // One decode pass: `&amp;lt;` stays the literal `&lt;`.
  assert.equal(source.slice(10, 21), '"&lt;&amp;"');
  // Nested scopes flatten: innermost kind wins, adjacent same kinds merge.
  const nested = parseSyntaxHtml('let x=`${y}`', '<span class="hljs-keyword">let</span> x=<span class="hljs-string">`<span class="hljs-subst">${<span class="hljs-keyword">y</span>}</span>`</span>');
  assert.deepEqual(nested, [
    { start: 0, end: 3, kind: 'keyword' },
    { start: 6, end: 7, kind: 'string' },
    { start: 9, end: 10, kind: 'keyword' },
    { start: 11, end: 12, kind: 'string' },
  ]);
  // Bare (unprefixed) class spellings map too.
  assert.deepEqual(parseSyntaxHtml('n', '<span class="number">n</span>'), [{ start: 0, end: 1, kind: 'literal' }]);
  // Foreign markup, extra attributes, imbalance and text mismatches reject.
  assert.deepEqual(parseSyntaxHtml('x', '<span class="hljs-keyword" data-x="1">x</span>'), []);
  assert.deepEqual(parseSyntaxHtml('x', '<em>x</em>'), []);
  assert.deepEqual(parseSyntaxHtml('x', '<span class="hljs-keyword">x'), []);
  assert.deepEqual(parseSyntaxHtml('x', 'y'), []);
  assert.deepEqual(parseSyntaxHtml('x', '<span class="hljs-keyword bad<script>">x</span>'), []);
  assert.deepEqual(parseSyntaxHtml('x', '<span class="hljs-keyword">x</span></span>'), []);
  // Emoji, tabs and CRLF are ordinary text and roundtrip exactly.
  const emoji = 'const e = "🚀";\r\n\t// done';
  const emojiHtml = '<span class="hljs-keyword">const</span> e = <span class="hljs-string">&quot;🚀&quot;</span>;\r\n\t<span class="hljs-comment">// done</span>';
  const emojiSpans = parseSyntaxHtml(emoji, emojiHtml);
  assert.equal(emojiSpans.length, 3);
  assert.equal(emoji.slice(emojiSpans[1].start, emojiSpans[1].end), '"🚀"');
});

test('real grammars color keywords, strings, literals and comments', async () => {
  const at = (spans, source, kind) => spans.filter((span) => span.kind === kind).map((span) => source.slice(span.start, span.end));
  const js = await loadSyntaxHighlighter('javascript');
  const jsSrc = 'const n = 42; // ok\nconst s = "hi";';
  const jsSpans = js(jsSrc);
  assert.ok(at(jsSpans, jsSrc, 'keyword').includes('const'));
  assert.ok(at(jsSpans, jsSrc, 'literal').includes('42'));
  assert.ok(at(jsSpans, jsSrc, 'string').includes('"hi"'));
  assert.ok(at(jsSpans, jsSrc, 'comment').includes('// ok'));
  const ts = await loadSyntaxHighlighter('typescript');
  const tsSrc = 'interface A { b: string }\nconst n: number = 1;';
  assert.ok(at(ts(tsSrc), tsSrc, 'keyword').includes('interface'));
  const rs = await loadSyntaxHighlighter('rust');
  const rsSrc = 'fn main() { let x = "s"; }';
  const rsSpans = rs(rsSrc);
  assert.ok(at(rsSpans, rsSrc, 'keyword').includes('fn'));
  assert.ok(at(rsSpans, rsSrc, 'string').includes('"s"'));
  const py = await loadSyntaxHighlighter('python');
  const pySrc = 'def f():\n    return 1 # done';
  const pySpans = py(pySrc);
  assert.ok(at(pySpans, pySrc, 'keyword').includes('def'));
  assert.ok(at(pySpans, pySrc, 'comment').includes('# done'));
  const json = await loadSyntaxHighlighter('json');
  const jsonSrc = '{"k": 1}';
  const jsonSpans = json(jsonSrc);
  assert.ok(jsonSpans.length > 0);
  const xml = await loadSyntaxHighlighter('xml');
  const xmlSrc = '<div class="a">t</div>';
  assert.ok(xml(xmlSrc).length > 0);
  const css = await loadSyntaxHighlighter('css');
  assert.ok(css('a { color: red; }').length > 0);
  // All twenty roots resolve to working engines.
  const roots = ['javascript', 'typescript', 'json', 'xml', 'css', 'bash', 'python', 'rust', 'go', 'yaml', 'sql', 'markdown', 'cpp', 'c', 'java', 'csharp', 'ruby', 'dockerfile', 'graphql', 'ini'];
  for (const root of roots) assert.equal(typeof await loadSyntaxHighlighter(root), 'function', root);
});

test('isolated engines keep earlier tokens after other languages load', async () => {
  const js = await loadSyntaxHighlighter('javascript');
  const src = 'const n = 1;';
  const before = js(src);
  // Loading unrelated surfaces afterwards cannot change this engine's answer.
  for (const name of ['rust', 'python', 'sql', 'xml']) await loadSyntaxHighlighter(name);
  assert.deepEqual(js(src), before);
});

test('source bounds and the result cache hold', async () => {
  const js = await loadSyntaxHighlighter('javascript');
  // Exactly at the source cap with short lines is allowed; over either cap is not.
  let atCap = 'x'.repeat(100);
  while (atCap.length < SYNTAX_SOURCE_CAP) atCap += `\n${'x'.repeat(Math.min(100, Math.max(0, SYNTAX_SOURCE_CAP - atCap.length - 1)))}`;
  if (atCap.length > SYNTAX_SOURCE_CAP) atCap = atCap.slice(0, SYNTAX_SOURCE_CAP);
  assert.equal(atCap.length, SYNTAX_SOURCE_CAP);
  assert.equal(syntaxSourceAllowed(atCap), true);
  assert.equal(syntaxSourceAllowed('x'.repeat(SYNTAX_SOURCE_CAP + 1)), false);
  assert.equal(syntaxSourceAllowed(`ok\n${'y'.repeat(SYNTAX_LINE_CAP + 1)}`), false);
  // Oversized input renders plain — never throws or truncates text.
  assert.deepEqual(js('x'.repeat(SYNTAX_SOURCE_CAP + 1)), []);
  assert.deepEqual(js(`ok\n${'y'.repeat(SYNTAX_LINE_CAP + 1)}`), []);
  // A completed result is returned from the bounded cache identically.
  const src = 'let cached = true;';
  const first = js(src);
  const second = js(src);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
});

test('syntaxLines clips at LF, keeps CR, and yields a trailing empty line', () => {
  const spans = [{ start: 0, end: 8, kind: 'comment' }];
  const lines = syntaxLines('ab\r\ncd\n', spans);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], [{ start: 0, end: 3, kind: 'comment' }]); // includes the CR
  assert.deepEqual(lines[1], [{ start: 0, end: 2, kind: 'comment' }]);
  assert.deepEqual(lines[2], []);
  assert.deepEqual(syntaxLines('a', [{ start: 0, end: 1, kind: 'keyword' }]), [[{ start: 0, end: 1, kind: 'keyword' }]]);
});

test('segmentCode preserves text exactly across composed boundaries', () => {
  const text = 'let n = 42 and 7';
  const segs = segmentCode(text, [{ start: 0, end: 3, kind: 'keyword' }, { start: 8, end: 10, kind: 'literal' }], [{ start: 8, end: 10 }, { start: 15, end: 16 }]);
  assert.equal(segs.map((s) => s.text).join(''), text);
  const n42 = segs.find((s) => s.text === '42');
  assert.equal(n42.kind, 'literal');
  assert.equal(n42.changed, true);
  const seven = segs.find((s) => s.text === '7');
  assert.equal(seven.kind, undefined);
  assert.equal(seven.changed, true);
  // Empty input and no marks.
  assert.deepEqual(segmentCode('', [], []), []);
  assert.deepEqual(segmentCode('plain'), [{ text: 'plain', kind: undefined, changed: false }]);
  // Invalid ranges are dropped entirely — plain output, exact text.
  const safe = segmentCode(text, [{ start: -5, end: 3, kind: 'keyword' }, { start: 20, end: 30, kind: 'string' }], [{ start: 100, end: 200 }]);
  assert.equal(safe.map((s) => s.text).join(''), text);
  assert.ok(safe.every((s) => s.kind === undefined && s.changed === false), 'invalid ranges never color or mark');
  // Fractional and NaN endpoints are invalid too.
  const weird = segmentCode(text, [{ start: 0.5, end: 3, kind: 'keyword' }, { start: 0, end: Number.NaN, kind: 'string' }], [{ start: Number.POSITIVE_INFINITY, end: 4 }]);
  assert.equal(weird.map((s) => s.text).join(''), text);
  assert.ok(weird.every((s) => s.kind === undefined && s.changed === false));
  // Unknown kinds are not accepted as SyntaxKind values.
  const unknownKind = segmentCode('xx', [{ start: 0, end: 2, kind: 'notakind' }], []);
  assert.equal(unknownKind.map((s) => s.text).join(''), 'xx');
  assert.equal(unknownKind[0].kind, undefined);
  // A boundary that would split a surrogate pair invalidates the whole
  // range — the emoji is never bisected and nothing is colored/marked.
  const emoji = 'a🚀b';
  const splitSafe = segmentCode(emoji, [{ start: 0, end: 2, kind: 'keyword' }], []);
  assert.equal(splitSafe.map((s) => s.text).join(''), emoji);
  assert.equal(splitSafe.length, 1, 'the emoji stays inside one segment');
  assert.equal(splitSafe[0].kind, undefined, 'the invalid range drops rather than coloring the rest');
  const markSafe = segmentCode(emoji, [], [{ start: 0, end: 2 }]);
  assert.equal(markSafe.length, 1);
  assert.equal(markSafe[0].changed, false, 'the invalid mark drops rather than marking the rest');
  // Overlapping spans drop the offender; adjacent/overlapping marks union.
  const overlap = segmentCode('abcdef', [{ start: 0, end: 4, kind: 'keyword' }, { start: 2, end: 6, kind: 'string' }], [{ start: 0, end: 2 }, { start: 1, end: 3 }]);
  assert.equal(overlap.map((s) => s.text).join(''), 'abcdef');
  assert.deepEqual(overlap.map((s) => [s.text, s.kind, s.changed]), [
    ['abc', 'keyword', true], ['d', 'keyword', false], ['ef', undefined, false],
  ]);
  // A dense 5000-span input segments correctly (no timing assertion).
  const dense = Array.from({ length: 5000 }, (_, i) => ({ start: i * 2, end: i * 2 + 1, kind: 'keyword' }));
  const denseText = 'x '.repeat(5000);
  const denseOut = segmentCode(denseText, dense, []);
  assert.equal(denseOut.map((s) => s.text).join(''), denseText);
  assert.equal(denseOut.length, 10000, 'alternating colored x and plain space segments');
  assert.ok(denseOut.every((s, i) => i % 2 === 0 ? s.kind === 'keyword' && s.text === 'x' : s.kind === undefined && s.text === ' '));
});

test('language keys and lookups are prototype- and collision-safe', async () => {
  // Own-property lookups: prototype member names never resolve.
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(syntaxLanguage(name), undefined, name);
    assert.equal(syntaxLanguage(undefined, `file.${name}`), undefined, `path ${name}`);
  }
  // A prototype scope name inherits the parent (plain here), never a function.
  assert.deepEqual(parseSyntaxHtml('x', '<span class="hljs-constructor">x</span>'), []);
  // Unknown roots resolve a shared plain stub — no core, no cache growth.
  const stub = await loadSyntaxHighlighter('bogus');
  assert.deepEqual(stub('let x = 1'), []);
  assert.strictEqual(await loadSyntaxHighlighter('madeup'), stub);
});

test('the completed-result cache cannot collide on concatenated keys', async () => {
  const c = await loadSyntaxHighlighter('c');
  const css = await loadSyntaxHighlighter('css');
  const cssSrc = 'a { color: red; }';
  // Without a delimiter, 'c'+'ss'+src and 'css'+src share one cache key —
  // warm the C entry with exactly that prefix first.
  c(`ss${cssSrc}`); // warms the cache under the colliding concatenation
  const cssSpans = css(cssSrc);
  assert.ok(cssSpans.length > 0, 'css computes its own tokens');
  // A collided answer would be the C result (possibly plain). Cross-check
  // against a differently-keyed equivalent source — same tokens expected.
  const expected = css(`${cssSrc} `);
  assert.deepEqual(cssSpans, expected);
  assert.equal(cssSrc.slice(cssSpans[0].start, cssSpans[0].end), 'a');
  assert.equal(cssSpans[0].kind, 'keyword');
});

test('completed results are strict-identical on hit and evict past bounds', async () => {
  const js = await loadSyntaxHighlighter('javascript');
  const src = 'let hit = 1;';
  const first = js(src);
  assert.strictEqual(js(src), first, 'warm entry returns the same array');
  // More than 32 unique small sources evict the entry-count bound.
  for (let i = 0; i < 40; i += 1) js(`let v${i} = ${i};`);
  const again = js(src);
  assert.deepEqual(again, first);
  assert.notStrictEqual(again, first, 'evicted entry recomputes a fresh array');
  // 256Ki total source characters bound too: 30 ~10Ki sources > 256Ki.
  const big = await loadSyntaxHighlighter('javascript');
  const bigSrc = `let b0 = 1;\n${'x\n'.repeat(5000)}`;
  const bigFirst = big(bigSrc);
  for (let i = 1; i <= 30; i += 1) big(`let w${i} = ${i};\n${'x\n'.repeat(5000)}`);
  assert.notStrictEqual(big(bigSrc), bigFirst, 'char-bound eviction recomputes');
});

test('results exceeding the span cap degrade to plain', async () => {
  const js = await loadSyntaxHighlighter('javascript');
  // Each line colors 'let' plus three numbers — ~4 spans per line, 2000
  // lines => well past 5000 while the source stays under every other cap.
  const heavy = 'let a=1, b=2, c=3;\n'.repeat(2000);
  assert.ok(heavy.length < 64 * 1024);
  assert.deepEqual(js(heavy), []);
  // Just under the cap still colors.
  const light = 'let a=1, b=2, c=3;\n'.repeat(1000);
  const spans = js(light);
  assert.ok(spans.length > 0 && spans.length <= 5000);
});

test('isolated engines produce identical tokens for fresh sources', async () => {
  const js = await loadSyntaxHighlighter('javascript');
  const pairs = (src) => js(src).map((s) => [src.slice(s.start, s.end), s.kind]);
  const before = pairs('const n = 1;');
  for (const name of ['rust', 'python', 'sql', 'xml']) await loadSyntaxHighlighter(name);
  // A different-but-equivalent snippet avoids the result cache entirely —
  // the engine must still produce the same (text, kind) sequence.
  const after = pairs('const m = 1;');
  assert.deepEqual(after, before);
});

test('template substitutions and CRLF roundtrip through the real engine', async () => {
  const ts = await loadSyntaxHighlighter('typescript');
  const src = 'const t = `a ${name} c`;\r\nlet q = `x${1 + 2}y`;\r\n';
  const spans = ts(src);
  assert.ok(spans.length > 0, 'colored tokens exist');
  assert.ok(spans.some((s) => s.kind === 'string'));
  assert.ok(spans.some((s) => s.kind === 'keyword'));
  // Spans never straddle a character that does not exist in the source —
  // every span slice is real source text and \r is inside string spans only
  // where the source has it.
  for (const s of spans) assert.ok(s.start < s.end && s.end <= src.length);
  const text = spans.map((s) => src.slice(s.start, s.end)).join('');
  assert.ok(!text.includes('\ufffd'));
});
