#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const check = process.argv.includes('--check');
const output = join(root, 'apps/desktop/src-tauri/resources/THIRD_PARTY_LICENSES.txt');
const exec = promisify(execFile);

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function licenseFiles(directory) {
  try {
    const names = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of names) {
      if (!entry.isFile() || !/^(license|licence|copying)(?:[._-]|$)/i.test(entry.name)) continue;
      const path = join(directory, entry.name);
      const text = await readFile(path, 'utf8').catch(() => null);
      if (text) files.push({ name: entry.name, text: text.replace(/\r\n?/g, '\n') });
    }
    return files;
  } catch {
    return [];
  }
}

function packageSection(name, version, license, files) {
  const lines = [`\n${name}@${version}\n${'='.repeat(72)}\nLicense: ${license || 'Unknown'}`];
  if (!files.length) lines.push('No license file was found in the package.');
  for (const file of files) {
    const text = file.text.replace(/[ \t]+$/gm, '').trimEnd();
    lines.push(`\n--- ${file.name} ---\n${text}\n`);
  }
  return lines.join('\n');
}

const EXPECTED_ROWS = {
  'playwright-core': '1.64.1',
  'chromium-bidi': '12.1.0',
  '@fontsource-variable/google-sans': '5.3.2',
  '@fontsource-variable/inter': '5.3.0',
  '@tauri-apps/api': '2.12.3',
  '@tauri-apps/plugin-store': '2.5.0',
  '@tauri-apps/plugin-notification': '2.6.0',
  'lucide-react': '1.61.0',
  'thinking-orbs': '0.3.2',
  esbuild: '0.28.2',
  three: '0.186.1',
  playwright: '1.64.1',
  'tauri-plugin-single-instance': '2.5.3',
};

const lock = await json(join(root, 'package-lock.json'));
const npm = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || entry.dev === true) continue;
  const directory = join(root, path);
  npm.push({ name: entry.name ?? path.slice('node_modules/'.length), version: entry.version, license: entry.license ?? 'Unknown', files: await licenseFiles(directory) });
}
npm.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

const { stdout } = await exec('cargo', ['metadata', '--locked', '--offline', '--format-version', '1', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const metadata = JSON.parse(stdout);
const rust = [];
for (const pkg of metadata.packages) {
  if (pkg.name === 'glitter') continue;
  rust.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'Unknown', files: await licenseFiles(dirname(pkg.manifest_path)) });
}
rust.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));

const curated = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
for (const [name, version] of Object.entries(EXPECTED_ROWS)) {
  assert.ok(curated.includes(`| \`${name}\` | ${version} |`), `THIRD_PARTY_NOTICES.md needs ${name} ${version}; update its version row`);
}

const sections = [
  'GLITTER THIRD-PARTY LICENSES\nGenerated from package-lock.json and Cargo.lock. Full texts are bundled with the application.\n',
  curated.trimEnd(),
  `\n${'#'.repeat(72)}\nNPM PACKAGES\n${'#'.repeat(72)}`,
  ...npm.map((pkg) => packageSection(pkg.name, pkg.version, pkg.license, pkg.files)),
  `\n${'#'.repeat(72)}\nRUST PACKAGES\n${'#'.repeat(72)}`,
  ...rust.map((pkg) => packageSection(pkg.name, pkg.version, pkg.license, pkg.files)),
];
const generated = `${sections.join('\n').trimEnd()}\n`;
const current = await readFile(output, 'utf8').catch(() => '');
if (check) {
  assert.equal(current, generated, 'THIRD_PARTY_LICENSES.txt is stale. Run npm run notices and commit the result.');
  console.log(`✓ third-party notices current (${npm.length} npm packages, ${rust.length} Rust packages)`);
} else {
  await mkdir(dirname(output), { recursive: true });
  if (current !== generated) await writeFile(output, generated, 'utf8');
  console.log(`✓ wrote ${output} (${npm.length} npm packages, ${rust.length} Rust packages)`);
}
