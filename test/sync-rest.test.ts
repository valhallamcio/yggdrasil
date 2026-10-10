import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { createRateLimiters, isSyncApiPath, SYNC_API_PREFIX } from '../src/middleware/rate-limit.ts';
import type { Request, Response } from 'express';
import {
  shadowMoveBodySchema,
  syncForceReleaseBodySchema,
  syncGroupPutBodySchema,
  syncMoveListQuerySchema,
  syncMoveParamsSchema,
  syncMoveStartBodySchema,
  syncMoveWaitQuerySchema,
  syncPlayerParamsSchema,
  syncQuestActionBodySchema,
  syncQuestMergeBodySchema,
  syncReseedBodySchema,
  syncSnapshotListQuerySchema,
} from '../src/domains/biforesting/sync.schema.ts';
import { OPS_CATALOG, QUEST_RECORD_MAX_CHARS } from '../src/domains/biforesting/ops-catalog.ts';
import { BiforestingController } from '../src/domains/biforesting/biforesting.controller.ts';
import { ValidationError } from '../src/shared/errors/index.ts';

/** Player sync REST: request schemas and the separate sync rate limiter (player-sync spec 7). */

test('sync schemas: group PUT takes known fields only, at least one', () => {
  assert.equal(syncGroupPutBodySchema.safeParse({ mode: 'shadow' }).success, true);
  assert.equal(syncGroupPutBodySchema.safeParse({ frozen: true, freezeReason: 'pack update' }).success, true);
  assert.equal(syncGroupPutBodySchema.safeParse({ freezeReason: null }).success, true);
  assert.equal(syncGroupPutBodySchema.safeParse({}).success, false, 'empty body');
  assert.equal(syncGroupPutBodySchema.safeParse({ mode: 'on' }).success, false, 'unknown mode');
  assert.equal(syncGroupPutBodySchema.safeParse({ freeze: true }).success, false, 'unknown field');
  assert.equal(syncGroupPutBodySchema.safeParse({ holdMs: 20_000 }).success, false, 'over the long-poll cap');
});

test('sync schemas: player uuid is lowercased, shadow-move needs two different instances', () => {
  const p = syncPlayerParamsSchema.parse({ group: 'evol', uuid: '0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9' });
  assert.equal(p.uuid, '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9');
  assert.equal(syncPlayerParamsSchema.safeParse({ group: 'evol', uuid: 'Steve' }).success, false);

  assert.equal(shadowMoveBodySchema.safeParse({ from: 'e7575fc9', to: '1ae705e3' }).success, true);
  assert.equal(shadowMoveBodySchema.safeParse({ from: 'e7575fc9', to: 'e7575fc9' }).success, false);
  assert.equal(syncSnapshotListQuerySchema.safeParse({ kind: 'invsnap' }).success, false);
});

test('rate limit: only paths under the sync mount count as sync, in any case', () => {
  assert.equal(isSyncApiPath(SYNC_API_PREFIX), true);
  assert.equal(isSyncApiPath('/v1/biforesting/sync/evol/players/x'), true);
  assert.equal(isSyncApiPath('/V1/Biforesting/SYNC/evol'), true);
  assert.equal(isSyncApiPath('/v1/biforesting/syncx'), false);
  assert.equal(isSyncApiPath('/v1/biforesting/evol/ops'), false);
});

test('rate limit: sync routes count per API key and never against the per-IP limit', async () => {
  const { global, sync } = createRateLimiters({ windowMs: 60_000, max: 2, syncWindowMs: 60_000, syncMax: 3, apiKeyHeader: 'X-API-Key', apiKeys: ['key-a', 'key-b'] });
  const app = express();
  app.use(global);
  app.use(SYNC_API_PREFIX, sync);
  app.use((_req, res) => {
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, key?: string): Promise<number> =>
    (await fetch(`${base}${path}`, key ? { headers: { 'X-API-Key': key } } : {})).status;

  try {
    const syncPath = `${SYNC_API_PREFIX}/evol/players/0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9`;
    for (let i = 0; i < 3; i++) assert.equal(await get(syncPath, 'key-a'), 200, `key-a request ${i + 1}`);
    assert.equal(await get(syncPath, 'key-a'), 429, 'key-a is over the sync limit');
    assert.equal(await get(syncPath, 'key-b'), 200, 'key-b has its own bucket');

    // Five sync requests from this IP so far. The per-IP limit of 2 has not counted any of them.
    assert.equal(await get('/v1/servers', 'key-a'), 200);
    assert.equal(await get('/v1/servers', 'key-a'), 200);
    assert.equal(await get('/v1/servers', 'key-a'), 429, 'the per-IP limit still holds for other routes');
    assert.equal(await get(syncPath, 'key-b'), 200, 'sync routes stay open after the per-IP limit trips');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('rate limit: unknown API keys share the per-IP sync bucket; only a valid key gets its own', async () => {
  const { sync } = createRateLimiters({ windowMs: 60_000, max: 100, syncWindowMs: 60_000, syncMax: 3, apiKeyHeader: 'X-API-Key', apiKeys: ['key-a'] });
  const app = express();
  app.use(SYNC_API_PREFIX, sync);
  app.use((_req, res) => {
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (key?: string): Promise<number> =>
    (await fetch(`${base}${SYNC_API_PREFIX}/evol`, key ? { headers: { 'X-API-Key': key } } : {})).status;

  try {
    assert.equal(await get('guess-1'), 200);
    assert.equal(await get('guess-2'), 200);
    assert.equal(await get(), 200, 'no key counts against the IP too');
    assert.equal(await get('guess-3'), 429, 'a fresh unknown key gets no fresh bucket');
    assert.equal(await get('key-a'), 200, 'a valid key has its own bucket');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('sync schemas: move start, long poll, list and force-release', () => {
  const ok = syncMoveStartBodySchema.safeParse({ from: 'e7575fc9', to: '1ae705e3', name: 'Steve', reason: 'switch' });
  assert.equal(ok.success, true);
  assert.equal(syncMoveStartBodySchema.safeParse({ from: 'e7575fc9', to: 'e7575fc9' }).success, false, 'same instance');
  assert.equal(syncMoveStartBodySchema.safeParse({ from: 'e7575fc9' }).success, false, 'no target');
  assert.equal(syncMoveStartBodySchema.safeParse({ from: 'a', to: 'b', owner: 'x' }).success, false, 'unknown field');

  assert.deepEqual(syncMoveWaitQuerySchema.parse({}), { waitMs: 0 });
  assert.deepEqual(syncMoveWaitQuerySchema.parse({ waitMs: '10000', step: 'prepare' }), { waitMs: 10_000, step: 'prepare' });
  assert.equal(syncMoveWaitQuerySchema.safeParse({ waitMs: '15001' }).success, false, 'over the 15 s cap');
  assert.equal(syncMoveWaitQuerySchema.safeParse({ waitMs: '-1' }).success, false);
  assert.equal(syncMoveWaitQuerySchema.safeParse({ step: 'teleport' }).success, false);

  assert.equal(syncMoveListQuerySchema.parse({}).limit, 20);
  assert.equal(syncMoveListQuerySchema.safeParse({ limit: '0' }).success, false);
  assert.equal(syncForceReleaseBodySchema.safeParse({ to: '1ae705e3' }).success, true);
  assert.equal(syncForceReleaseBodySchema.safeParse({ to: '1ae705e3', snapshotId: '' }).success, false);
  assert.equal(syncMoveParamsSchema.safeParse({ group: 'evol', uuid: 'nope', moveId: 'M' }).success, false);
});

test('sync schemas: reseed takes one serverId and nothing else', () => {
  assert.deepEqual(syncReseedBodySchema.parse({ serverId: 'e7575fc9' }), { serverId: 'e7575fc9' });
  assert.equal(syncReseedBodySchema.safeParse({}).success, false, 'no serverId');
  assert.equal(syncReseedBodySchema.safeParse({ serverId: '' }).success, false, 'empty serverId');
  assert.equal(syncReseedBodySchema.safeParse({ serverId: 'e7575fc9', force: true }).success, false, 'unknown field');
});

test('ops catalog: every sync op needs player_sync and is internal', () => {
  const types = ['sync_probe', 'sync_prepare', 'sync_release', 'sync_apply', 'sync_commit', 'sync_abort', 'sync_kick', 'sync_disown', 'sync_own', 'sync_lock'];
  for (const type of types) {
    const entry = OPS_CATALOG[type];
    assert.ok(entry, type);
    assert.equal(entry.requiresFeature, 'player_sync', type);
    assert.equal(entry.internal, true, type);
  }
  assert.equal(OPS_CATALOG['sync_disown']!.serverGlobal, true);
  const entries = Array.from({ length: 501 }, (_, i) => ({ u: `u${i}`, v: 1, to: 'a', toLabel: 'Instance 1' }));
  assert.equal(OPS_CATALOG['sync_disown']!.params.safeParse({ group: 'evol', entries }).success, false, 'over 500 entries');
  assert.equal(OPS_CATALOG['sync_disown']!.params.safeParse({ group: 'evol', entries: entries.slice(0, 500) }).success, true);

  const own = OPS_CATALOG['sync_own']!;
  assert.equal(own.serverGlobal, true);
  const owned = Array.from({ length: 501 }, (_, i) => ({ u: `u${i}`, v: 2 }));
  assert.equal(own.params.safeParse({ group: 'evol', entries: owned }).success, false, 'over 500 entries');
  assert.equal(own.params.safeParse({ group: 'evol', entries: owned.slice(0, 500) }).success, true);
  assert.equal(own.params.safeParse({ group: 'evol', entries: [] }).success, false, 'no entries');
  assert.equal(own.params.safeParse({ group: 'evol', entries: [{ u: 'u1', v: 2, to: 'a' }] }).success, false, 'an entry is {u, v} only');

  const lock = OPS_CATALOG['sync_lock']!;
  assert.equal(lock.serverGlobal, true);
  const records = Array.from({ length: 501 }, (_, i) => ({ h: 'sophisticatedbackpacks', key: `k${i}`, to: 'bbbb0002', toLabel: 'Instance 2' }));
  assert.equal(lock.params.safeParse({ group: 'evol', entries: records }).success, false, 'over 500 entries');
  assert.equal(lock.params.safeParse({ group: 'evol', entries: records.slice(0, 500) }).success, true);
  assert.equal(lock.params.safeParse({ group: 'evol', entries: [] }).success, false, 'no entries');
  assert.equal(lock.params.safeParse({ group: 'evol', entries: [{ h: 'a:b', key: 'k', to: '', toLabel: '' }] }).success, false, 'no colon in a handler id');
  assert.equal(lock.params.safeParse({ group: 'evol', entries: [{ h: 'sb', key: 'k', to: '', toLabel: '', u: 'x' }] }).success, false, 'an entry is {h, key, to, toLabel} only');
});

test('quest schemas: action body rules, party-merge body, pre_action snapshot kind', () => {
  const ok = (b: unknown): boolean => syncQuestActionBodySchema.safeParse(b).success;
  assert.equal(ok({ action: 'pref', value: 'separate' }), true);
  assert.equal(ok({ action: 'pref' }), false, 'pref needs a value');
  assert.equal(ok({ action: 'pref', value: 'both' }), false, 'unknown pref');
  assert.equal(ok({ action: 'fresh' }), true);
  assert.equal(ok({ action: 'fresh', value: 'merge' }), false, 'fresh takes no value');
  assert.equal(ok({ action: 'leave', backupId: 'x' }), false, 'only undo takes a backupId');
  assert.equal(ok({ action: 'undo' }), true);
  assert.equal(ok({ action: 'undo', backupId: '20261010T193000Z-fresh' }), true);
  assert.equal(ok({ action: 'undo', backupId: '../x' }), false, 'no path in a backupId');
  assert.equal(ok({ action: 'undo', backupId: '..' }), false);
  assert.equal(ok({ action: 'reset' }), false, 'unknown action');
  assert.equal(ok({ action: 'fresh', uuid: 'x' }), false, 'unknown field');

  const merge = syncQuestMergeBodySchema.parse({ fromServer: '1ae705e3', teamId: '6F9D029B-0000-4000-8000-000000000001' });
  assert.equal(merge.teamId, '6f9d029b-0000-4000-8000-000000000001');
  assert.equal(syncQuestMergeBodySchema.safeParse({ fromServer: '1ae705e3', teamId: 'Max_Automation' }).success, false);
  assert.equal(syncQuestMergeBodySchema.safeParse({ fromServer: '1ae705e3', teamId: merge.teamId, toServer: 'x' }).success, false);

  assert.equal(syncSnapshotListQuerySchema.safeParse({ kind: 'pre_action' }).success, true);
});

test('ops catalog: quest ops need player_sync, are internal and strict', () => {
  const U = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';
  const T = '6f9d029b-0000-4000-8000-000000000001';
  for (const type of ['quests_status', 'quests_action', 'quests_party_candidates', 'quests_export_party', 'quests_import_party']) {
    const entry = OPS_CATALOG[type];
    assert.ok(entry, type);
    assert.equal(entry.requiresFeature, 'player_sync', type);
    assert.equal(entry.internal, true, type);
  }
  const p = (type: string, params: unknown): boolean => OPS_CATALOG[type]!.params.safeParse(params).success;
  assert.equal(p('quests_status', { group: 'evol', uuid: U }), true);
  assert.equal(p('quests_status', { group: 'evol', uuid: U, extra: 1 }), false, 'strict');
  assert.equal(p('quests_status', { group: 'evol', uuid: 'Steve' }), false);
  assert.equal(p('quests_action', { group: 'evol', uuid: U, action: 'pref', value: 'merge' }), true);
  assert.equal(p('quests_action', { group: 'evol', uuid: U, action: 'pref' }), false);
  assert.equal(p('quests_action', { group: 'evol', uuid: U, action: 'undo', backupId: 'b-1' }), true);
  assert.equal(p('quests_party_candidates', { group: 'evol', uuid: U }), true);
  assert.equal(OPS_CATALOG['quests_export_party']!.serverGlobal, true, 'export names a team, no player');
  assert.equal(p('quests_export_party', { group: 'evol', teamId: T }), true);
  assert.equal(p('quests_export_party', { group: 'evol', teamId: T, uuid: U }), false);
  const imp = { group: 'evol', uuid: U, record: { teamId: T, done: ['a'] }, sourceServerId: '1ae705e3', sourceTeamId: T };
  assert.equal(p('quests_import_party', imp), true);
  assert.equal(p('quests_import_party', { ...imp, record: 'H4sIAAAA' }), true, 'a string record passes as is');
  assert.equal(p('quests_import_party', { ...imp, record: null }), false);
  assert.equal(p('quests_import_party', { ...imp, record: [] }), false, 'a record is an object or a string');
  assert.equal(p('quests_import_party', { ...imp, record: { big: 'x'.repeat(QUEST_RECORD_MAX_CHARS) } }), false, 'over the record cap');
  assert.equal(p('quests_import_party', { ...imp, sourceServerId: '' }), false);
});

test('generic op route: sync op types are refused with a 400', async () => {
  const controller = new BiforestingController();
  for (const type of ['sync_apply', 'sync_disown', 'sync_kick', 'sync_own', 'sync_lock', 'quests_action', 'quests_import_party']) {
    const req = { params: { server: 'evol' }, body: { type, params: {} }, headers: {} } as unknown as Request;
    await assert.rejects(
      controller.createOp(req, {} as Response),
      (err: unknown) => err instanceof ValidationError && err.statusCode === 400 && /player sync runner/.test(err.message),
      type,
    );
  }
});
