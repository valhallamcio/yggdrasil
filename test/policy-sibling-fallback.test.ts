import './helpers/env.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { ObjectId, type Db } from 'mongodb';

import { BiforestingController } from '../src/domains/biforesting/biforesting.controller.ts';
import { biforestingLinkManager } from '../src/plugins/biforesting-link/link-manager.ts';
import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';
import { maskForFeatures, setPolicyDbProvider } from '../src/plugins/biforesting-link/policy-store.ts';
import { serverResolver } from '../src/plugins/biforesting-link/server-resolver.ts';

/**
 * A second server doc with the same tag moves both keys to `tag:serverId`. A key with no doc of
 * its own reads the tag doc, at register and after a tag doc change. No Mongo: the resolver and
 * the policy store read in-memory fakes.
 */

const CAPS = maskForFeatures(['play_transport', 'metrics', 'ops', 'live']);
const GRANT = maskForFeatures(['play_transport', 'metrics', 'ops']);
const OWN = maskForFeatures(['play_transport']);

const servers = [
  { tag: 'arc', serverId: 'srv-arc' },
  { tag: 'onyx', serverId: 'srv-o1' },
  { tag: 'onyx', serverId: 'srv-o2' },
  { tag: 'evol', serverId: 'srv-e1' },
  { tag: 'evol', serverId: 'srv-e2' },
].map((s) => ({ _id: new ObjectId(), name: s.tag, ...s }));

type Doc = Record<string, unknown> & { instanceKey: string };
const docs = new Map<string, Doc>();
function put(instanceKey: string, enabledFeatures: number): void {
  docs.set(instanceKey, { instanceKey, enabledFeatures, metricsHz: 0, questHz: 0, chunkHz: 0, enabledFixes: [] });
}

const fakePolicyDb = {
  collection: () => ({
    createIndex: async () => 'instanceKey_1',
    findOne: async (q: { instanceKey: string }) => docs.get(q.instanceKey) ?? null,
    updateOne: async (q: { instanceKey: string }, u: { $set: object; $setOnInsert: object }) => {
      const cur = docs.get(q.instanceKey);
      if (cur) Object.assign(cur, u.$set);
      else docs.set(q.instanceKey, { ...u.$setOnInsert, ...u.$set, instanceKey: q.instanceKey });
    },
  }),
} as unknown as Db;

function registerPayload(serverId: string): Buffer {
  return new Writer()
    .varInt(2)
    .utf(serverId)
    .utf('sibling-test')
    .varInt(CAPS)
    .utf('node-1')
    .utf('127.0.0.1:25565')
    .long(1n)
    .varInt(2)
    .build();
}

function granted(serverId: string): number {
  const s = biforestingLinkManager.getSnapshot().sessions.find((x) => x.identity?.serverId === serverId);
  assert.ok(s, `session for ${serverId}`);
  return s.grantedFeatures;
}

function keyOf(serverId: string): string | undefined {
  return biforestingLinkManager.getSnapshot().sessions.find((x) => x.identity?.serverId === serverId)?.identity?.instanceKey;
}

async function call(method: 'getPolicy' | 'putPolicy', server: string, body: object = {}): Promise<Record<string, unknown>> {
  let out: { data: Record<string, unknown> } | undefined;
  const req = { params: { server }, body, headers: {} } as unknown as Request;
  const res = { json: (b: { data: Record<string, unknown> }) => { out = b; } } as unknown as Response;
  await new BiforestingController()[method](req, res);
  assert.ok(out, `${method} answered`);
  return out.data;
}

before(async () => {
  serverResolver.setSource(async () => servers);
  setPolicyDbProvider(() => fakePolicyDb);
  put('arc', GRANT);
  put('onyx', GRANT);
  put('evol', GRANT);
  put('evol:srv-e1', OWN);
  for (const s of servers) {
    const transport = { writable: () => true, send: () => undefined, close: () => undefined };
    biforestingLinkManager.registerSession(`sib#${s.serverId}`, transport, '10.0.0.9:1');
    await biforestingLinkManager.dispatch(`sib#${s.serverId}`, 'biforesting:register', registerPayload(s.serverId));
  }
});

test('sibling fallback: a single instance keeps its plain tag key and grant', () => {
  assert.equal(keyOf('srv-arc'), 'arc');
  assert.equal(granted('srv-arc'), GRANT);
});

test('sibling fallback: both keys of a sibling pair get the tag grant at register', () => {
  assert.equal(keyOf('srv-o1'), 'onyx:srv-o1');
  assert.equal(keyOf('srv-o2'), 'onyx:srv-o2');
  assert.equal(granted('srv-o1'), GRANT);
  assert.equal(granted('srv-o2'), GRANT);
});

test('sibling fallback: an own per-instance doc wins over the tag doc', () => {
  assert.equal(granted('srv-e1'), OWN);
  assert.equal(granted('srv-e2'), GRANT);
});

test('sibling fallback: GET names the tag doc an inheriting key reads', async () => {
  const inheriting = await call('getPolicy', 'srv-o2');
  assert.equal(inheriting['instanceKey'], 'onyx:srv-o2');
  assert.equal(inheriting['inheritedFrom'], 'onyx');
  assert.equal(inheriting['enabledFeatures'], GRANT);

  const own = await call('getPolicy', 'srv-e1');
  assert.equal(own['inheritedFrom'], null);
  assert.equal(own['enabledFeatures'], OWN);

  assert.equal((await call('getPolicy', 'srv-arc'))['inheritedFrom'], null);
});

test('sibling fallback: a PUT on the tag doc re-acks the inheriting siblings only', async () => {
  const next = maskForFeatures(['play_transport', 'metrics']);
  const data = await call('putPolicy', 'evol', { features: ['play_transport', 'metrics'] });
  assert.equal(data['instanceKey'], 'evol');
  assert.equal(data['reAckedInheriting'], 1);
  assert.equal(granted('srv-e2'), next, 'the inheriting sibling follows the tag doc at once');
  assert.equal(granted('srv-e1'), OWN, 'the sibling with its own doc keeps it');
});

test('sibling fallback: a PUT on an inheriting key seeds its own doc from the tag doc', async () => {
  const data = await call('putPolicy', 'srv-o1', { metricsHz: 5 });
  assert.equal(data['instanceKey'], 'onyx:srv-o1');
  assert.equal(data['enabledFeatures'], GRANT, 'a cadence-only write keeps the inherited bits');
  assert.equal(data['metricsHz'], 5);
  assert.equal(data['reAckedInheriting'], 0);
  assert.equal(granted('srv-o1'), GRANT);
  assert.equal((await call('getPolicy', 'srv-o1'))['inheritedFrom'], null);
});
