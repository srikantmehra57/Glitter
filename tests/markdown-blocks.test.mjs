import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-markdown-'));
after(() => rm(temporary, { recursive: true, force: true }));

// The real renderer (react-markdown + remark-gfm), server-rendered, so "the same
// elements" means exactly what the desktop would produce.
const outfile = join(temporary, 'markdown.mjs');
await build({
  stdin: {
    resolveDir: resolve('.'),
    loader: 'tsx',
    contents: `
      import { createElement } from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import ReactMarkdown from 'react-markdown';
      import remarkGfm from 'remark-gfm';
      import { splitMarkdownBlocks } from './apps/desktop/src/lib/markdownBlocks';
      const html = (source) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, source));
      // Two artifacts of server rendering, neither of which exists in the browser DOM:
      // newline text nodes between sibling blocks (invisible in layout), and React 19's
      // hoisting of <link rel="preload"> for images to the front of each rendered root.
      const flat = (markup) => markup.replace(/<link rel="preload"[^>]*\\/>/g, '').replace(/\\s*\\n\\s*(?=<)/g, '').replace(/(?<=>)\\s*\\n\\s*/g, '');
      export const whole = (source) => flat(html(source));
      export const byBlock = (source) => flat(splitMarkdownBlocks(source).map(html).join(''));
      export { splitMarkdownBlocks };
    `,
  },
  bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
  // react-dom/server is CommonJS and requires Node built-ins; give the ESM bundle a `require`.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const { whole, byBlock, splitMarkdownBlocks } = await import(pathToFileURL(outfile).href);

const SAMPLES = {
  paragraphs: 'First paragraph.\n\nSecond paragraph with **bold** and `code`.\n\nThird one.\n',
  headings: '# Title\n\nIntro text.\n\n## Section\n\nBody.\n\n### Deeper\n\nMore.\n',
  tightList: 'Intro\n\n- one\n- two\n- three\n\nOutro\n',
  looseList: 'Intro\n\n- one\n\n- two\n\n- three\n\nOutro\n',
  orderedLoose: '1. first\n\n2. second\n\n3. third\n\nafter\n',
  listResumesAfterParagraph: '1. a\n\ntext between\n\n2. b\n\n3. c\n',
  nestedList: '- parent\n\n  - child one\n\n  - child two\n\n    continued\n\n- sibling\n\nEnd\n',
  listItemWithParagraphs: '- item\n\n  second paragraph of the item\n\n  third paragraph\n\n- next item\n',
  fencedWithBlankLines: 'Before\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n\n# not a heading\n\n- not a list\n```\n\nAfter\n',
  tildeFence: 'x\n\n~~~\nline\n\nline two\n~~~\n\ny\n',
  longerClosingFence: 'x\n\n````\n```\ninner fence\n\n```\n````\n\ny\n',
  unclosedFenceStillStreaming: 'Intro\n\n```python\ndef f():\n    pass\n\n    # still writing',
  indentedCode: 'Text\n\n    indented code\n\n    more code\n\nBack to text\n',
  fenceInListItem: '- step\n\n  ```sh\n  npm install\n\n  npm test\n  ```\n\n- done\n',
  blockquotes: '> quoted\n> more\n\nplain\n\n> another quote\n\nend\n',
  table: 'Results\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nTrailer\n',
  thematicBreaks: 'one\n\n---\n\ntwo\n\n***\n\nthree\n',
  spacedThematicBreak: 'one\n\n- - -\n\ntwo\n',
  setext: 'Title\n=====\n\nBody\n\nSub\n---\n\nMore\n',
  taskList: '- [x] done\n- [ ] todo\n\nnote\n',
  autolinks: 'See https://example.com/a_b_c and www.example.org.\n\nNext https://x.y/z\n',
  inlineEverything: 'Some *emphasis*, **strong**, ~~gone~~, `code`, and [a link](https://example.com).\n\nAnd a second paragraph.\n',
  windowsLineEndings: 'One\r\n\r\nTwo\r\n\r\n- a\r\n- b\r\n\r\nThree\r\n',
  trailingBlankLines: 'Only paragraph.\n\n\n\n',
  leadingBlankLines: '\n\n\nStarts late.\n\nThen more.\n',
  noNewlineAtAll: 'just one line',
  empty: '',
  // Constructs whose meaning crosses blocks: splitting must stay off, so behaviour is untouched.
  referenceLinks: 'See [the docs][docs] for more.\n\nAnother paragraph.\n\n[docs]: https://example.com/docs\n',
  footnotes: 'A claim.[^1]\n\nAnother paragraph.\n\n[^1]: The note.\n',
  htmlComment: 'Before\n\n<!-- a comment\n\nthat spans blank lines -->\n\nAfter\n',
  htmlPre: 'Before\n\n<pre>\nraw\n\nblock\n</pre>\n\nAfter\n',
  htmlBlocks: 'Before\n\n<details>\n<summary>More</summary>\n\nInside\n\n</details>\n\nAfter\n',
  autolinkAtLineStart: 'See\n\n<https://example.com/a>\n\nthen more text.\n',
};

const norm = (text) => text.replace(/\r\n/g, '\n');

for (const [name, source] of Object.entries(SAMPLES)) {
  test(`sample "${name}" splits losslessly and renders the same as one document`, () => {
    const blocks = splitMarkdownBlocks(source);
    assert.equal(blocks.join(''), source, 'the blocks are a partition of the source');
    assert.equal(byBlock(source), whole(source), 'block-by-block rendering matches whole-document rendering');
    for (const cut of new Set([1, 2, 3, 5, 8, 13, 21, 34, 55, 89].map((n) => Math.min(n, source.length)))) {
      const prefix = source.slice(0, cut);
      assert.equal(splitMarkdownBlocks(prefix).join(''), prefix);
      assert.equal(byBlock(prefix), whole(prefix), `a stream stopped at ${cut} characters renders the same either way`);
    }
    void norm;
  });
}

test('documents that reach across blocks are never split', () => {
  for (const name of ['referenceLinks', 'footnotes', 'htmlComment', 'htmlPre', 'htmlBlocks']) {
    assert.equal(splitMarkdownBlocks(SAMPLES[name]).length, 1, name);
  }
});

test('ordinary documents do split, so the optimisation is actually in effect', () => {
  assert.equal(splitMarkdownBlocks(SAMPLES.paragraphs).length, 3);
  assert.equal(splitMarkdownBlocks(SAMPLES.headings).length, 6, 'each heading and each paragraph is its own block');
  assert.deepEqual(splitMarkdownBlocks('a\n\nb\n\nc\n'), ['a\n\n', 'b\n\n', 'c\n']);
});

test('lists, fences and indented content are never cut apart', () => {
  assert.equal(splitMarkdownBlocks(SAMPLES.looseList).length, 2, 'a loose list stays one block (only "Intro" and the list+outro split)');
  assert.equal(splitMarkdownBlocks(SAMPLES.nestedList).join(''), SAMPLES.nestedList);
  const fenced = splitMarkdownBlocks(SAMPLES.fencedWithBlankLines);
  assert.ok(fenced.some((block) => block.includes('const a = 1;') && block.includes('const b = 2;') && block.includes('not a list')), 'the code block is whole');
  assert.equal(splitMarkdownBlocks(SAMPLES.unclosedFenceStillStreaming).length, 2, 'an open fence runs to the end of the text');
  assert.equal(splitMarkdownBlocks(SAMPLES.indentedCode).length, 2, 'indented code stays with what precedes it; only the flush-left paragraph after it starts a block');
});

/** Real documents from this repository: lists, tables, fences, HTML, links — the natural corpus. */
async function repositoryDocuments() {
  const files = ['README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', join('apps', 'website', 'README.md')];
  const docs = [];
  for (const file of files) docs.push([file, await readFile(resolve(file), 'utf8').catch(() => null)]);
  for (const entry of await readdir(resolve('docs')).catch(() => [])) {
    if (entry.endsWith('.md')) docs.push([join('docs', entry), await readFile(resolve('docs', entry), 'utf8')]);
  }
  return docs.filter(([, text]) => text);
}

test('real documents render identically block-by-block at every point of a simulated stream', async () => {
  const docs = await repositoryDocuments();
  assert.ok(docs.length >= 3, 'the corpus is present');
  let splitDocuments = 0;
  for (const [file, text] of docs) {
    const blocks = splitMarkdownBlocks(text);
    if (blocks.length > 1) splitDocuments += 1;
    assert.equal(blocks.join(''), text, `${file} is partitioned exactly`);
    assert.equal(byBlock(text), whole(text), `${file} renders the same block-by-block`);
    // A stream stopped anywhere renders the same too.
    const step = Math.max(37, Math.floor(text.length / 60));
    for (let cut = step; cut < text.length; cut += step) {
      const prefix = text.slice(0, cut);
      assert.equal(byBlock(prefix), whole(prefix), `${file} stopped at ${cut} characters`);
    }
  }
  assert.ok(splitDocuments >= 2, 'the corpus actually exercises splitting');
});

test('a block that has been followed by another never changes as the stream grows', async () => {
  // Documents that later gain a cross-block construct (a `[ref]:` definition, a footnote) legitimately
  // become one block when it arrives — rendering stays correct, it just re-renders once — so they
  // are checked for equivalence above and left out of this memoisation guarantee.
  const crossBlock = new Set(['referenceLinks', 'footnotes', 'htmlComment', 'htmlPre', 'htmlBlocks']);
  const docs = [...Object.entries(SAMPLES).filter(([name]) => !crossBlock.has(name)).map(([, text]) => text), ...(await repositoryDocuments()).map(([, text]) => text)];
  for (const text of docs) {
    const full = splitMarkdownBlocks(text);
    // Repository documents can also acquire a cross-block construct. A final
    // single block has no finalized split blocks whose identity can be tested.
    if (full.length === 1) continue;
    const step = Math.max(1, Math.floor(text.length / 80));
    for (let cut = 1; cut <= text.length; cut += step) {
      const partial = splitMarkdownBlocks(text.slice(0, cut));
      // Everything but the block still being written is already final.
      assert.deepEqual(partial.slice(0, -1), full.slice(0, partial.length - 1), `stopped at ${cut}`);
    }
  }
});

test('splitting a very long reply stays fast', () => {
  const long = Array.from({ length: 2000 }, (_, n) => `Paragraph ${n} with some words in it.\n\n- item ${n}\n- item ${n + 1}\n\n`).join('');
  const started = performance.now();
  for (let i = 0; i < 20; i += 1) splitMarkdownBlocks(long);
  const per = (performance.now() - started) / 20;
  assert.ok(per < 25, `split of ${long.length} characters took ${per.toFixed(2)}ms`);
});

// A seeded fuzz: random mixes of every construct that interacts with block boundaries. If the
// splitter ever cuts where CommonMark would not, the block-by-block markup stops matching.
function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
const FRAGMENTS = [
  'A plain paragraph line.', 'Another line with *emphasis* and `code`.', '', '', '', '- bullet', '* star bullet', '+ plus bullet', '1. numbered', '2) paren numbered', '10. ten',
  '  - nested bullet', '    - deeper', '   continued text', '    indented code', '\ttab code', '```', '```js', '~~~', '````', '  ```', '> quote line', '>', '# Heading',
  '## Heading two', '| a | b |', '|---|---|', '| 1 | 2 |', '---', '***', '- - -', '===', 'Setext', '[link](https://example.com)', '**bold**', '<https://example.com>', 'https://auto.link/x',
  '- [ ] task', '- [x] done', '  more', '1. item one', '   1. nested ordered', '    ', ' ', 'Trailing spaces  ', '\\', '&amp; entity',
  '| :-: | --: |', '> - quoted bullet', '> ```', '>> nested quote', '* * *', '_ _ _', '   1. three-space numbered', '- item with `code` and [ref]', 'Hard break\\',
  '![image](https://example.com/i.png)', '\t- tab bullet', '  ~~~', '1.', '-', '#', '#hashtag', '    - four-space bullet', '   > indented quote', '<https://autolink.example>',
];
// The same vocabulary plus everything that reaches across blocks (mostly left unsplit, and must still be equivalent).
const CROSS_FRAGMENTS = [...FRAGMENTS,
  '<details>', '</details>', '<summary>Summary</summary>', '<br/>', '<div>', '</div>', '<!-- comment -->', '[ref]: https://example.com/ref', '[^1]: a footnote', 'Claim[^1]', '<span>inline html</span>',
];
test('fuzz: random documents render identically whole and block-by-block, at several stream cut points', () => {
  // MARKDOWN_FUZZ_SEED / MARKDOWN_FUZZ_DOCS widen the search when changing the splitter.
  const next = random(Number(process.env.MARKDOWN_FUZZ_SEED ?? 20260929));
  const pick = () => FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
  const documents = Number(process.env.MARKDOWN_FUZZ_DOCS ?? 700);
  let splitDocuments = 0;
  for (let n = 0; n < documents; n += 1) {
    const lines = Array.from({ length: 4 + Math.floor(next() * 28) }, pick);
    const doc = lines.join('\n') + (next() < 0.5 ? '\n' : '');
    const blocks = splitMarkdownBlocks(doc);
    if (blocks.length > 1) splitDocuments += 1;
    assert.equal(blocks.join(''), doc);
    for (const fraction of [1, 0.75, 0.5, 0.25]) {
      const prefix = doc.slice(0, Math.floor(doc.length * fraction));
      assert.equal(byBlock(prefix), whole(prefix), `fuzz document ${n} at ${Math.round(fraction * 100)}%:\n${JSON.stringify(prefix)}`);
    }
  }
  assert.ok(splitDocuments > documents / 8, `the fuzz actually splits documents (${splitDocuments}/${documents})`);
});

test('fuzz: a block that has been followed by another never changes as the document grows', () => {
  const next = random(7);
  const pick = () => FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
  for (let n = 0; n < 300; n += 1) {
    const doc = Array.from({ length: 6 + Math.floor(next() * 24) }, pick).join('\n') + '\n';
    const full = splitMarkdownBlocks(doc);
    for (let cut = 1; cut <= doc.length; cut += 1 + Math.floor(doc.length / 40)) {
      const partial = splitMarkdownBlocks(doc.slice(0, cut));
      // A cross-block construct arriving late turns the document into one block (see above).
      if (full.length === 1 && partial.length > 1) continue;
      assert.deepEqual(partial.slice(0, -1), full.slice(0, partial.length - 1), `fuzz ${n} stopped at ${cut}:\n${JSON.stringify(doc)}`);
    }
  }
});

test('fuzz: documents mixing in cross-block constructs still render identically', () => {
  const next = random(Number(process.env.MARKDOWN_FUZZ_SEED ?? 20260929) + 1);
  const pick = () => CROSS_FRAGMENTS[Math.floor(next() * CROSS_FRAGMENTS.length)];
  const documents = Math.floor(Number(process.env.MARKDOWN_FUZZ_DOCS ?? 700) / 2);
  for (let n = 0; n < documents; n += 1) {
    const doc = Array.from({ length: 4 + Math.floor(next() * 28) }, pick).join('\n') + (next() < 0.5 ? '\n' : '');
    for (const fraction of [1, 0.6, 0.3]) {
      const prefix = doc.slice(0, Math.floor(doc.length * fraction));
      assert.equal(splitMarkdownBlocks(prefix).join(''), prefix);
      assert.equal(byBlock(prefix), whole(prefix), `cross-block fuzz document ${n} at ${Math.round(fraction * 100)}%:\n${JSON.stringify(prefix)}`);
    }
  }
});
