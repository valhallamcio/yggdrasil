import { test } from 'node:test';
import assert from 'node:assert/strict';

import { configSchema } from '../src/config/schema.ts';

// Minimum env for the schema to parse at all; each case layers plugin flags on top.
const base = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DB_NAME: 'ygg_test',
  JWT_SECRET: 'x'.repeat(32),
};

function parse(extra: Record<string, string>) {
  return configSchema.safeParse({ ...base, ...extra });
}

function issuePaths(r: ReturnType<typeof parse>): string[] {
  return r.success ? [] : r.error.issues.map((i) => i.path.join('.')).sort();
}

test('config: both plugins off is valid', () => {
  const r = parse({ PLUGIN_BIFORESTING_LINK: 'false', PLUGIN_WEBSOCKET: 'false' });
  assert.equal(r.success, true);
});

test('config: link on with websocket + a credential is valid (PSK or authkey)', () => {
  const creds: Record<string, string>[] = [{ BIFORESTING_PSK: 'secret' }, { BIFORESTING_AUTHKEY_HEX: 'ab'.repeat(32) }];
  for (const cred of creds) {
    const r = parse({ PLUGIN_BIFORESTING_LINK: 'true', PLUGIN_WEBSOCKET: 'true', ...cred });
    assert.equal(r.success, true, JSON.stringify(cred));
  }
});

test('config: link on without websocket is rejected — the /biforesting/ listener would never exist', () => {
  const r = parse({ PLUGIN_BIFORESTING_LINK: 'true', PLUGIN_WEBSOCKET: 'false', BIFORESTING_PSK: 'secret' });
  assert.equal(r.success, false);
  assert.deepEqual(issuePaths(r), ['PLUGIN_WEBSOCKET']);
});

test('config: link on without any credential is rejected', () => {
  const r = parse({ PLUGIN_BIFORESTING_LINK: 'true', PLUGIN_WEBSOCKET: 'true' });
  assert.equal(r.success, false);
  assert.deepEqual(issuePaths(r), ['BIFORESTING_PSK']);
});

test('config: both prerequisites missing reports both issues, not just the first', () => {
  const r = parse({ PLUGIN_BIFORESTING_LINK: 'true', PLUGIN_WEBSOCKET: 'false' });
  assert.equal(r.success, false);
  assert.deepEqual(issuePaths(r), ['BIFORESTING_PSK', 'PLUGIN_WEBSOCKET']);
});

test('config: websocket on without the link stays valid (ws-only deployments)', () => {
  const r = parse({ PLUGIN_WEBSOCKET: 'true', PLUGIN_BIFORESTING_LINK: 'false' });
  assert.equal(r.success, true);
});
