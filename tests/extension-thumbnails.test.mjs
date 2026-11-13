import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary = await mkdtemp(join(tmpdir(), 'glitter-thumbs-'));
async function bundle(entry) {
  const outfile = join(temporary, `${entry.replace(/\W+/g, '_')}.mjs`);
  await build({ entryPoints: [resolve(entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}
const { skillIcon } = await bundle('packages/glitter-harness/src/harness/skills.ts');
const { listingImage } = await bundle('apps/desktop/src/lib/pluginLibrary.ts');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const put = async (root, path, content) => {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
};

test('a skill shows the logo its agents/openai.yaml names, large before small', async (t) => {
  const root = await mkdtemp(join(temporary, 'skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, 'agents/openai.yaml', 'interface:\n  display_name: "Sentry"\n  icon_small: "./assets/sentry-small.svg"\n  icon_large: "./assets/sentry.png"\ndependencies:\n  icon_large: "./elsewhere.png"\n');
  await put(root, 'assets/sentry.png', PNG);
  await put(root, 'assets/sentry-small.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#f00"/></svg>');
  assert.equal(skillIcon(root), `data:image/png;base64,${PNG.toString('base64')}`);
});

test('a currentColor glyph is skipped, since an image would draw it black', async (t) => {
  const root = await mkdtemp(join(temporary, 'glyph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(root, 'agents/openai.yaml', 'interface:\n  icon_small: "./assets/small.svg"\n');
  await put(root, 'assets/small.svg', '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M0 0h1v1z"/></svg>');
  assert.equal(skillIcon(root), null);
  await put(root, 'assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#123"/></svg>');
  assert.match(skillIcon(root), /^data:image\/svg\+xml;base64,/, 'a conventional colour icon is the fallback');
});

test('a skill icon must be a real image inside the skill folder', async (t) => {
  const root = await mkdtemp(join(temporary, 'escape-'));
  const outside = await mkdtemp(join(temporary, 'outside-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await put(outside, 'secret.png', PNG);
  await put(root, 'agents/openai.yaml', `interface:\n  icon_large: "../${outside.split('/').pop()}/secret.png"\n  icon_small: "./assets/fake.png"\n`);
  await put(root, 'assets/fake.png', 'not an image');
  await mkdir(join(root, 'assets'), { recursive: true });
  await symlink(join(outside, 'secret.png'), join(root, 'assets', 'icon.png'));
  assert.equal(skillIcon(root), null, 'a path or symlink out of the folder and a non-image are all refused');
  assert.equal(skillIcon(join(root, 'missing')), null);
});

test('a source listing shows its own owner avatar, else none', () => {
  const origin = { owner: 'Anthropics', repo: 'market', ref: null, path: '', commit: 'x', plugin: null, spec: 'anthropics/market', url: '' };
  const source = { id: 'm', name: 'm', origin, plugins: [] };
  const library = { plugins: [], marketplaces: [source], pluginsRoot: '', problems: [], avatars: { acme: 'data:acme' }, avatarsPending: false };
  const row = (location) => ({ name: 'p', location });
  assert.equal(listingImage(library, source, row('Acme/tools')), 'data:acme');
  assert.equal(listingImage(library, source, row('anthropics/other')), null, "the source's own owner is the badge");
  assert.equal(listingImage(library, source, row('This repository')), null);
  assert.equal(listingImage(library, source, row('Not on GitHub')), null);
  assert.equal(listingImage(library, source, row('ghost/kit')), null, 'not fetched yet');
  assert.equal(listingImage(library, source, row('ghost/kit'), { icon: 'data:logo' }), 'data:logo', 'an installed copy shows its own logo');
  assert.equal(listingImage(null, source, row('Acme/tools')), null);
});
