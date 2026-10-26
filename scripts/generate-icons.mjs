import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const brand = join(root, 'docs/brand');
const icons = join(root, 'apps/desktop/src-tauri/icons');
const mark = await readFile(join(brand, 'glitter-mark.svg'), 'utf8');
const inner = mark.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1];
if (!inner) throw new Error('The Glitter mark must contain SVG content.');

for (const app of ['desktop', 'website']) {
  await writeFile(join(root, `apps/${app}/public/spark.svg`), mark);
}

// The mark's gradient ids must be unique inside each icon document.
function markContent(suffix) {
  let svg = inner;
  for (const id of inner.matchAll(/id="([^"]+)"/g)) {
    svg = svg.split(`id="${id[1]}"`).join(`id="${id[1]}-${suffix}"`);
    svg = svg.split(`url(#${id[1]})`).join(`url(#${id[1]}-${suffix})`);
  }
  return svg;
}

for (const [mode, from, to, edge] of [
  // Frosted silver/platinum tile with subtle rim highlight.
  ['light', '#F8F8FA', '#DCDCE2', '0.7'],
  // Space-black brushed titanium tile with subtle rim highlight.
  ['dark', '#24242C', '#121216', '0.22'],
]) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <defs>
    <linearGradient id="tile-${mode}" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${from}"/>
      <stop offset="100%" stop-color="${to}"/>
    </linearGradient>
    <linearGradient id="rim-${mode}" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="${edge}"/>
      <stop offset="100%" stop-color="#FFFFFF" stop-opacity="0.04"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="64" height="64" rx="14" fill="url(#tile-${mode})"/>
  <rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="url(#rim-${mode})" stroke-width="1"/>
  <g transform="translate(8 8) scale(0.75)">${markContent(mode)}</g>
</svg>
`;
  await writeFile(join(brand, `glitter-icon-${mode}.svg`), svg);
  await sharp(Buffer.from(svg), { density: 1152 }).resize(1024, 1024).png().toFile(join(icons, `glitter-${mode}.png`));
}

// Run the installed CLI through Node directly rather than through a shell shim.
const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
execFileSync(process.execPath, [cli, 'icon', join(brand, 'glitter-icon-dark.svg'), '--output', icons], { cwd: root, stdio: 'inherit' });
