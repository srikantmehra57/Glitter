import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Least-privilege regression test for the Tauri capability file (SEC-08).
 * Every renderer-reachable plugin command must be justified by a real call
 * site; broadening this set re-opens direct mailto:/tel:/reveal, dialog, or
 * event-forgery primitives that bypass the checked native wrappers.
 */
const capability = JSON.parse(readFileSync(resolve('apps/desktop/src-tauri/capabilities/default.json'), 'utf8'));

test('main window grants the exact minimal plugin surface', () => {
  assert.deepEqual(capability.permissions, [
    // bridge.ts + Composer listen/unlisten; never emit (bridge-line is not forgeable).
    'core:event:allow-listen',
    'core:event:allow-unlisten',
    // data-tauri-drag-region: dragging and native double-click maximize/restore.
    'core:window:allow-start-dragging',
    'core:window:allow-internal-toggle-maximize',
    // LazyStore get/set/save/entries (+ implicit load) on glitter.json. `entries` is what
    // the atomic writer serializes: without it every save fails with "not allowed by ACL".
    'store:allow-load',
    'store:allow-get',
    'store:allow-set',
    'store:allow-save',
    'store:allow-entries',
    // notify.ts only: permission check, one-time ask, send.
    'notification:allow-is-permission-granted',
    'notification:allow-request-permission',
    'notification:allow-notify',
  ]);
});

test('no default permission set survives minimization', () => {
  for (const permission of capability.permissions) {
    assert.doesNotMatch(permission, /:default$/, `${permission} re-broadens the surface`);
  }
  assert.deepEqual(capability.windows, ['main']);
});

// The store plugin is stubbed in every other test, so a call the ACL forbids only fails in the
// packaged app (this once silently broke *all* local persistence). Tie each renderer call to its grant.
test('every store-plugin method the renderer calls is granted', () => {
  const source = readFileSync(resolve('apps/desktop/src/lib/store.ts'), 'utf8');
  const grants = { get: 'store:allow-get', set: 'store:allow-set', save: 'store:allow-save', entries: 'store:allow-entries', keys: 'store:allow-keys', values: 'store:allow-values', has: 'store:allow-has', delete: 'store:allow-delete', clear: 'store:allow-clear', reset: 'store:allow-reset', reload: 'store:allow-reload', length: 'store:allow-length' };
  const used = new Set([...source.matchAll(/\bpersist\.(\w+)\s*[<(]/g)].map((match) => match[1]));
  assert.ok(used.has('entries') && used.has('get') && used.has('set'), 'the scan found the store call sites');
  for (const method of used) {
    assert.ok(grants[method], `persist.${method}() has no known permission mapping`);
    assert.ok(capability.permissions.includes(grants[method]), `persist.${method}() needs ${grants[method]}`);
  }
});
