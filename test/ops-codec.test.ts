import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeJsonPayload, decodeJsonPayload, decodeOpRes, decodePresence } from '../src/plugins/biforesting-link/decoders.ts';
import { Reader } from '../src/plugins/biforesting-link/frame-codec.ts';
import { ulid } from '../src/plugins/biforesting-link/ulid.ts';

test('ops codec: JSON payload is [varint ver=1][utf json] and round-trips', () => {
  const obj = { opId: 'X', type: 'run_command', params: { command: 'list' } };
  const buf = encodeJsonPayload(JSON.stringify(obj));
  const r = new Reader(buf);
  assert.equal(r.varInt(), 1, 'payload version prefix');
  assert.deepEqual(JSON.parse(r.utf()), obj);
  assert.deepEqual(decodeJsonPayload(buf), obj);
});

test('ops codec: decodeOpRes accepts ack + result, rejects malformed', () => {
  const ack = decodeOpRes(encodeJsonPayload(JSON.stringify({ opId: 'A', phase: 'ack' })));
  assert.equal(ack.phase, 'ack');

  const res = decodeOpRes(
    encodeJsonPayload(JSON.stringify({ opId: 'A', phase: 'result', status: 'completed', result: { out: 'x' }, durationMs: 3 })),
  );
  assert.equal(res.status, 'completed');
  assert.deepEqual(res.result, { out: 'x' });

  assert.throws(() => decodeOpRes(encodeJsonPayload(JSON.stringify({ phase: 'ack' }))), /opId/);
  assert.throws(() => decodeOpRes(encodeJsonPayload(JSON.stringify({ opId: 'A', phase: 'nope' }))), /phase/);
});

test('ops codec: decodePresence accepts join/quit/snapshot, rejects unknown events', () => {
  const join = decodePresence(
    encodeJsonPayload(JSON.stringify({ event: 'join', player: { uuid: 'u', name: 'n' } })),
  );
  assert.equal(join.event, 'join');
  assert.equal(join.player?.name, 'n');
  assert.equal(join.online, null);

  const snap = decodePresence(
    encodeJsonPayload(JSON.stringify({ event: 'snapshot', online: [{ uuid: 'u', name: 'n' }] })),
  );
  assert.equal(snap.online?.length, 1);
  assert.equal(snap.player, null);

  assert.throws(() => decodePresence(encodeJsonPayload(JSON.stringify({ event: 'teleport' }))), /unknown event/);
});

test('ops codec: ulid is 26 Crockford chars and time-ordered', () => {
  const a = ulid(1_000_000);
  const b = ulid(2_000_000);
  assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(a < b, 'earlier timestamp sorts first');
  const many = new Set(Array.from({ length: 1000 }, () => ulid()));
  assert.equal(many.size, 1000, 'no collisions in 1000 ids');
});
