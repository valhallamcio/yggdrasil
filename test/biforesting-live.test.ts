import './helpers/env.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId, type Db } from 'mongodb';

import { biforestingLinkManager } from '../src/plugins/biforesting-link/link-manager.ts';
import { decodeFrame, parseSingleOuterUnit, Writer } from '../src/plugins/biforesting-link/frame-codec.ts';
import { getAuthKey } from '../src/plugins/biforesting-link/auth-key.ts';
import { FEATURE_BITS, maskForFeatures, setPolicyDbProvider } from '../src/plugins/biforesting-link/policy-store.ts';
import { serverResolver } from '../src/plugins/biforesting-link/server-resolver.ts';
import {
  LIVE_CHANNEL,
  LIVE_MAX_PAYLOAD,
  LIVE_UP_BURST,
  decodeLive,
  encodeLive,
  type LiveMsg,
  type LiveUpMsg,
} from '../src/plugins/biforesting-link/live.ts';

/**
 * `biforesting:live` relay: codec, policy gate both ways, size cap, rate cap, `"*"` fan-out and
 * unknown-server drops. No Mongo: the resolver and policy store read in-memory fakes.
 */

const LIVE_ON = maskForFeatures(['play_transport', 'live']);
const LIVE_OFF = maskForFeatures(['play_transport']);
const CAPS = FEATURE_BITS['play_transport']! | FEATURE_BITS['live']!;
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const servers = [
  { tag: 'arc', serverId: 'srv-arc' },
  { tag: 'pri', serverId: 'srv-pri1' },
  { tag: 'pri', serverId: 'srv-pri2' },
  { tag: 'off', serverId: 'srv-off' },
  { tag: 'rate', serverId: 'srv-rate' },
  { tag: 'gone', serverId: 'srv-gone' },
].map((s) => ({ _id: new ObjectId(), name: s.tag, ...s }));

const policies = new Map<string, number>([
  ['arc', LIVE_ON],
  ['pri:srv-pri1', LIVE_ON],
  ['pri:srv-pri2', LIVE_ON],
  ['off', LIVE_OFF],
  ['rate', LIVE_ON],
  ['gone', LIVE_ON],
]);

const fakePolicyDb = {
  collection: () => ({
    createIndex: async () => 'instanceKey_1',
    findOne: async (q: { instanceKey: string }) => {
      const mask = policies.get(q.instanceKey);
      return mask === undefined
        ? null
        : { instanceKey: q.instanceKey, enabledFeatures: mask, metricsHz: 0, questHz: 0, chunkHz: 0, enabledFixes: [] };
    },
  }),
} as unknown as Db;

function registerPayload(serverId: string): Buffer {
  return new Writer()
    .varInt(2)
    .utf(serverId)
    .utf('live-test')
    .varInt(CAPS)
    .utf('node-1')
    .utf('127.0.0.1:25565')
    .long(1n)
    .varInt(2)
    .build();
}

/** Fake transport that decodes every DOWN unit and keeps the live payloads. */
function mkTransport() {
  const state = { closed: false, live: [] as LiveMsg[] };
  return {
    state,
    transport: {
      writable: () => !state.closed,
      send: (unit: Buffer) => {
        const { channel, frame } = parseSingleOuterUnit(unit);
        if (channel !== LIVE_CHANNEL) return;
        const decoded = decodeFrame(channel, frame, Date.now(), getAuthKey());
        assert.ok(decoded, 'live DOWN frame verifies');
        state.live.push(decodeLive(decoded.payload));
      },
      close: () => {
        state.closed = true;
      },
    },
  };
}

const links = new Map<string, ReturnType<typeof mkTransport>>();
const upSeen: LiveUpMsg[] = [];
let proxyUp = true;

before(async () => {
  serverResolver.setSource(async () => servers);
  setPolicyDbProvider(() => fakePolicyDb);
  biforestingLinkManager.setLiveUpSink((m) => {
    if (!proxyUp) return false;
    upSeen.push(m);
    return true;
  });
  for (const s of servers) {
    const t = mkTransport();
    links.set(s.serverId, t);
    biforestingLinkManager.registerSession(`live#${s.serverId}`, t.transport, '10.0.0.9:1');
    await biforestingLinkManager.dispatch(`live#${s.serverId}`, 'biforesting:register', registerPayload(s.serverId));
  }
});

function dropped(reason: keyof ReturnType<typeof biforestingLinkManager.getLiveStats>['dropped']): number {
  return biforestingLinkManager.getLiveStats().dropped[reason];
}

function liveCount(serverId: string): number {
  return links.get(serverId)!.state.live.length;
}

test('live: FEATURE_BITS mirrors the mod bit', () => {
  assert.equal(FEATURE_BITS['live'], 0x200000);
});

test('live codec: round trip and the mod byte layout', () => {
  const msg: LiveMsg = { topic: 'herobrine.encounter', player: UUID, data: { x: 1, s: 'é' } };
  const buf = encodeLive(msg);
  assert.equal(buf[0], 1, 'version varint');
  const json = JSON.stringify({ t: msg.topic, p: UUID, d: msg.data });
  assert.equal(buf.subarray(buf.length - Buffer.byteLength(json)).toString('utf8'), json);
  assert.deepEqual(decodeLive(buf), msg);

  const serverWide = new Writer().varInt(1).utf('{"t":"event.tick","p":"","d":{}}').build();
  assert.deepEqual(decodeLive(serverWide), { topic: 'event.tick', player: null, data: {} });
  assert.deepEqual(decodeLive(encodeLive({ topic: 'a.b', player: null, data: {} })), { topic: 'a.b', player: null, data: {} });
});

test('live codec: rejects bad version, topic, player and data', () => {
  const bad = (json: string, ver = 1) => () => decodeLive(new Writer().varInt(ver).utf(json).build());
  assert.throws(bad('{"t":"a.b","p":"","d":{}}', 2));
  assert.throws(bad('{"t":"A.B","p":"","d":{}}'));
  assert.throws(bad('{"t":"a..b","p":"","d":{}}'));
  assert.throws(bad('{"t":"a.b","p":"not-a-uuid","d":{}}'));
  assert.throws(bad('{"t":"a.b","p":"","d":[1]}'));
  assert.throws(bad('{"t":"a.b","p":""}'));
  assert.throws(bad('[]'));
});

test('live UP: a granted session forwards as live.up with its identity', async () => {
  upSeen.length = 0;
  await biforestingLinkManager.dispatch('live#srv-pri1', LIVE_CHANNEL, encodeLive({ topic: 'herobrine.encounter', player: UUID, data: { n: 1 } }));
  assert.equal(upSeen.length, 1);
  const up = upSeen[0]!;
  assert.equal(up.instanceKey, 'pri:srv-pri1');
  assert.equal(up.serverId, 'srv-pri1');
  assert.equal(up.tag, 'pri');
  assert.equal(up.topic, 'herobrine.encounter');
  assert.equal(up.player, UUID);
  assert.deepEqual(up.data, { n: 1 });
  assert.equal(typeof up.at, 'number');
});

test('live: bit off drops both ways', async () => {
  upSeen.length = 0;
  const before = dropped('bit_off');
  await biforestingLinkManager.dispatch('live#srv-off', LIVE_CHANNEL, encodeLive({ topic: 'a.b', player: null, data: {} }));
  assert.equal(upSeen.length, 0, 'UP not forwarded');
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'srv-off', topic: 'a.b', player: null, data: {} }), 0);
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'off', topic: 'a.b', player: null, data: {} }), 0);
  assert.equal(liveCount('srv-off'), 0, 'nothing written DOWN');
  assert.equal(dropped('bit_off'), before + 3);
});

test('live DOWN: "*" fans out to every session with the bit', () => {
  const counts = new Map(servers.map((s) => [s.serverId, liveCount(s.serverId)]));
  const n = biforestingLinkManager.sendLiveDown({ server: '*', topic: 'herobrine.scare', player: UUID, data: { k: 'v' } });
  assert.equal(n, 5);
  for (const s of servers) {
    const want = s.serverId === 'srv-off' ? 0 : 1;
    assert.equal(liveCount(s.serverId) - counts.get(s.serverId)!, want, s.serverId);
  }
  assert.deepEqual(links.get('srv-arc')!.state.live.at(-1), { topic: 'herobrine.scare', player: UUID, data: { k: 'v' } });
});

test('live DOWN: serverId, instanceKey and tag all resolve', () => {
  const before = liveCount('srv-pri2');
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'srv-pri2', topic: 'a.b', data: {} }), 1);
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'pri:srv-pri2', topic: 'a.b', player: '', data: {} }), 1);
  assert.equal(liveCount('srv-pri2'), before + 2);
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'arc', topic: 'a.b', player: null, data: {} }), 1);
});

test('live: oversize frames drop both ways', async () => {
  upSeen.length = 0;
  const before = dropped('oversize');
  const big = { blob: 'x'.repeat(LIVE_MAX_PAYLOAD) };
  const arcBefore = liveCount('srv-arc');
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'arc', topic: 'a.b', player: null, data: big }), 0);
  assert.equal(liveCount('srv-arc'), arcBefore);
  await biforestingLinkManager.dispatch('live#srv-arc', LIVE_CHANNEL, encodeLive({ topic: 'a.b', player: null, data: big }));
  assert.equal(upSeen.length, 0);
  assert.equal(dropped('oversize'), before + 2);
});

test('live DOWN: unknown server and malformed bodies drop', () => {
  const unknown = dropped('unknown_server');
  const malformed = dropped('malformed');
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'nope', topic: 'a.b', player: null, data: {} }), 0);
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'arc', topic: 'Bad Topic', data: {} }), 0);
  assert.equal(biforestingLinkManager.sendLiveDown(undefined), 0);
  assert.equal(dropped('unknown_server'), unknown + 1);
  assert.equal(dropped('malformed'), malformed + 2);
});

test('live UP: per-session rate cap drops the excess', async () => {
  upSeen.length = 0;
  const before = dropped('rate');
  const frame = encodeLive({ topic: 'spam.tick', player: null, data: {} });
  await Promise.all(Array.from({ length: LIVE_UP_BURST + 20 }, () => biforestingLinkManager.dispatch('live#srv-rate', LIVE_CHANNEL, frame)));
  assert.ok(upSeen.length >= LIVE_UP_BURST && upSeen.length < LIVE_UP_BURST + 20, `forwarded ${upSeen.length}`);
  assert.equal(dropped('rate') - before, LIVE_UP_BURST + 20 - upSeen.length);
});

test('live UP: no connected proxy drops the frame', async () => {
  upSeen.length = 0;
  const before = dropped('no_proxy');
  proxyUp = false;
  try {
    await biforestingLinkManager.dispatch('live#srv-arc', LIVE_CHANNEL, encodeLive({ topic: 'a.b', player: null, data: {} }));
  } finally {
    proxyUp = true;
  }
  assert.equal(upSeen.length, 0);
  assert.equal(dropped('no_proxy'), before + 1);
});

test('live DOWN: a closed session is gone and drops as unknown', () => {
  biforestingLinkManager.removeSession('live#srv-gone');
  const before = dropped('unknown_server');
  assert.equal(biforestingLinkManager.sendLiveDown({ server: 'srv-gone', topic: 'a.b', player: null, data: {} }), 0);
  assert.equal(dropped('unknown_server'), before + 1);
  const snap = biforestingLinkManager.getSnapshot();
  assert.ok(snap.live.down > 0 && snap.live.up > 0);
  const arc = snap.sessions.find((s) => s.identity?.serverId === 'srv-arc')!;
  assert.equal(arc.grantedFeatures, CAPS);
});
