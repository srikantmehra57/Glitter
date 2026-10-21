import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { checksumMap, NODE_RELEASE_FINGERPRINT, verifySignedChecksums } from '../packages/glitter-bridge/scripts/verify-node-release.mjs';

test('the vendored Node release key verifies the pinned v26.8.2 checksums', async () => {
  const asc = resolve('tests/fixtures/node-v26.8.2-SHASUMS256.txt.asc');
  const text = await verifySignedChecksums(asc);
  const sums = checksumMap(text);
  assert.equal(sums['node-v26.8.2-darwin-arm64.tar.gz'], '974b6d5fb2fc7c33ff2354db0902b4e91c2de01ec8acc6de48e543c97e18c9e1');
  assert.equal(sums['node-v26.8.2-darwin-x64.tar.gz'], 'adb8feb2d4987df3d72d2ec46f4fc4b58039c859b8c3f0e3cc2d3c6cbaf8629c');
  assert.equal(NODE_RELEASE_FINGERPRINT, '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356');
});

test('a tampered Node checksum signature is refused', async () => {
  const asc = resolve('tests/fixtures/node-v26.8.2-SHASUMS256.txt.asc');
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'muse-sums-'));
  try {
    const forged = join(dir, 'SHASUMS256.txt.asc');
    writeFileSync(forged, readFileSync(asc, 'utf8').replace('974b6d5f', '00000000'));
    await assert.rejects(() => verifySignedChecksums(forged), /Refusing to stage Node/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
