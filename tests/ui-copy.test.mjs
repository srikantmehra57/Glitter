import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'muse-ui-copy-'));
let sequence = 0;
async function bundle(entry) {
  const outfile = join(temporary, `${sequence++}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const types = await bundle('apps/desktop/src/lib/types.ts');
const format = await bundle('apps/desktop/src/lib/format.ts');

test('approval picker exposes every MSP mode with a label and description', () => {
  assert.deepEqual([...types.APPROVAL_ORDER].sort(), ['allowAll', 'denyUnmatched', 'onRequest', 'promptUnmatched']);
  assert.equal(new Set(types.APPROVAL_ORDER).size, types.APPROVAL_ORDER.length);
  for (const mode of types.APPROVAL_ORDER) {
    assert.ok(types.APPROVAL_LABELS[mode]?.length > 0, `${mode} has a label`);
    assert.ok(types.APPROVAL_DESCRIPTIONS[mode]?.length > 0, `${mode} has a description`);
  }
});

test('permission labels match the Muse CLI picker exactly', () => {
  assert.deepEqual(types.APPROVAL_LABELS, {
    denyUnmatched: 'Read only',
    promptUnmatched: 'Ask me',
    onRequest: 'Auto-review',
    allowAll: 'Unrestricted',
  });
  assert.deepEqual(types.APPROVAL_ORDER, ['denyUnmatched', 'promptUnmatched', 'onRequest', 'allowAll']);
  assert.equal(types.APPROVAL_DESCRIPTIONS.denyUnmatched, 'Reads files only.');
  assert.equal(types.APPROVAL_DESCRIPTIONS.promptUnmatched, 'Edits workspace and temporary files; requires approval for protected writes, new network targets, and other restricted actions.');
  assert.equal(types.APPROVAL_DESCRIPTIONS.onRequest, 'Same access as Ask me; AI reviews eligible actions; trusted permission hooks may decide approval requests first.');
  assert.equal(types.APPROVAL_DESCRIPTIONS.allowAll, 'No filesystem sandbox or approval prompts; local commands have direct network access; project trust is unchanged.');
});

test('shortcut labels follow the platform and the metaKey||ctrlKey handler', () => {
  assert.equal(format.isMacPlatform('MacIntel'), true);
  assert.equal(format.isMacPlatform('Win32'), false);
  assert.equal(format.isMacPlatform('Linux x86_64'), false);
  assert.equal(format.modGlyph('MacIntel'), '⌘');
  assert.equal(format.modGlyph('Win32'), 'Ctrl');
  assert.equal(format.shortcutLabel('K', 'MacIntel'), '⌘K');
  assert.equal(format.shortcutLabel('K', 'Win32'), 'Ctrl+K');
  assert.equal(format.shortcutLabel(',', 'Win32'), 'Ctrl+,');
  // No navigator in this runner: must fall back to the non-Mac shape, never crash.
  assert.match(format.shortcutLabel('K'), /^(⌘.|Ctrl\+.)$/);
});

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i + 1, i + 3), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function themeBlock(css, selector) {
  const match = css.match(new RegExp(`${selector}\\s*{([^}]*)}`));
  assert.ok(match, `${selector} block exists in styles.css`);
  const vars = {};
  for (const [, name, value] of match[1].matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[name] = value;
  return vars;
}

test('tertiary text meets WCAG AA (4.5:1) on surfaces in both themes', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  for (const selector of [':root', 'html\\[data-theme="light"\\]']) {
    const vars = themeBlock(css, selector);
    assert.ok(vars.tertiary && vars.secondary && vars.surface && vars.bg, `${selector} defines text tokens`);
    assert.notEqual(vars.tertiary.toLowerCase(), vars.secondary.toLowerCase(), `${selector} keeps tertiary distinct from secondary`);
    for (const bg of ['surface', 'bg']) {
      const ratio = contrast(vars.tertiary, vars[bg]);
      assert.ok(ratio >= 4.5, `${selector} tertiary on --${bg} is ${ratio.toFixed(2)}:1, want ≥ 4.5:1`);
    }
  }
});

/** Every declaration block whose selector is exactly `selector`, joined. */
function rules(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...css.matchAll(new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, 'g'))].map((match) => match[1]);
  assert.ok(blocks.length, `${selector} has a rule in styles.css`);
  return blocks.join('\n');
}

test('the shell is one surface: the sidebar has no fill or edge of its own', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  // The sidebar is the shell itself: a fill, a border or a blur of its own would
  // stop the tint and the window's translucency reaching it.
  assert.doesNotMatch(rules(css, '.sidebar'), /border-right|background|backdrop-filter/);
  // Plain opacity on a layer: WebKit in the desktop app did not paint a color-mix() with a custom-property percentage.
  assert.doesNotMatch(rules(css, '.app'), /background/);
  assert.match(rules(css, '.app::before'), /background:\s*var\(--shell\);\s*opacity:\s*var\(--shell-opacity\);/);
  assert.match(css, /html\[data-sidebar-accent="true"\] \{ --shell: /);
  assert.match(css, /html\[data-translucent="true"\][^{]*#root \{ background: transparent; \}/);
});

test('the main pane is flush, split from the sidebar by a hairline', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  // No floating card: the pane meets the window edges, and a single hairline
  // against the sidebar is the only seam.
  const main = rules(css, '.main');
  assert.doesNotMatch(main, /margin|border-radius|box-shadow/);
  assert.match(main, /background:\s*var\(--surface\);/);
  assert.match(main, /border-left:\s*1px solid var\(--border\);/);
  assert.doesNotMatch(css, /--r-panel|--shell-gap/);
});

test('the title bar is the top of the main pane', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  // One row across the window holds the window controls, the sidebar's buttons,
  // the title and the pane's actions. The pane's content starts below it.
  const app = rules(css, '.app');
  assert.match(app, /grid-template-rows:\s*var\(--titlebar-height\) minmax\(0, 1fr\);/);
  const bar = rules(css, '.topbar');
  assert.match(bar, /grid-row:\s*1;/);
  assert.match(rules(css, '.main'), /grid-row:\s*2;/);
  // It continues the pane's surface and hairline, so the pane reads as one column.
  assert.match(bar, /background:\s*var\(--surface\);/);
  assert.match(bar, /border-left:\s*1px solid var\(--border\);/);
  assert.doesNotMatch(bar, /backdrop-filter/);
  // The window controls share its centre line. macOS 27 centres them 2pt above the configured inset.
  const conf = JSON.parse(await readFile(resolve('apps/desktop/src-tauri/tauri.conf.json'), 'utf8'));
  const height = Number(app.match(/--titlebar-height:\s*(\d+)px;/)[1]);
  assert.equal(conf.app.windows[0].trafficLightPosition.y - 2, height / 2);
});

test('the accent lights the shell\'s own glow layer', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  // The tint's glow is the shell's own layer, under everything else.
  assert.match(rules(css, '.app::after'), /background:\s*var\(--shell-glow\);/);
  assert.match(rules(css, 'html[data-sidebar-accent="true"] .app::after'), /opacity:\s*1;/);
});

test('the sidebar never scrolls sideways; a clipped thread name rolls on hover', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  assert.match(rules(css, '.sidebar-tree'), /overflow-x:\s*hidden/);
  // The roll shifts the text by its hidden distance — the title box is the
  // inline-size container, the inner span's own width is the full name.
  assert.match(rules(css, '.thread .title'), /container-type:\s*inline-size/);
  assert.match(css, /\.thread:hover \.title-text, \.thread:focus-visible \.title-text \{ transform: translateX\(min\(0px, calc\(100cqw - 100%\)\)\); \}/);
});

test('accent-filled controls keep their fill on hover', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  // Under the ember accent the fill is a gradient. Swapping it for a flat hover
  // colour drops the image at once while the colour fades up from nothing, which
  // flickers; the hover colour fades in on a ::before layer instead.
  for (const selector of ['.primary', '.send', '.nav-row.new-thread']) {
    const escaped = selector.replace(/[.]/g, '\\.');
    assert.doesNotMatch(css, new RegExp(`${escaped}(?:\\.accent)?:hover[^{]*\\{[^}]*background`), `${selector} swaps its background on hover`);
    assert.match(css, new RegExp(`${escaped}:hover:not\\(:disabled\\)::before`), `${selector} fades its hover layer in`);
  }
  // The plain row hover and press must not reach the accent-filled row either.
  assert.match(css, /\.nav-row:not\(\.new-thread\):hover:not\(:disabled\) \{ background: var\(--hover\); \}/);
  assert.match(css, /\.nav-row:not\(\.new-thread\):active:not\(:disabled\) \{ background: var\(--active\); \}/);
  // Tinting the sidebar recolours row icons, but not the one on the accent fill.
  assert.match(css, /html\[data-sidebar-accent="true"\] \.sidebar \.nav-row:not\(\.new-thread\) svg/);
});

test('row and control highlights are capsules; menu items keep the small radius', async () => {
  const css = await readFile(resolve('apps/desktop/src/styles.css'), 'utf8');
  // Single-line controls and rows take fully rounded ends; menu and option
  // items can carry a second line, where a capsule reads as a bubble.
  for (const selector of ['.icon-btn', '.nav-row', '.workspace-row', '.thread', '.picker-trigger']) {
    assert.match(rules(css, selector), /border-radius:\s*var\(--r-pill\);/, `${selector} highlight radius`);
  }
  assert.match(rules(css, '.menu button, .select-option'), /border-radius:\s*var\(--r-sm\);/);
});
