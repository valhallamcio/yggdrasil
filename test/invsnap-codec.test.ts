import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';
import { decodeInvSnap } from '../src/plugins/biforesting-link/decoders.ts';

/** invsnap wire: [varint ver=1][utf json header][varint gzLen][gz bytes] — mirrors shared InvSnapshots. */

test('invsnap codec: envelope decodes header + opaque gz bytes', () => {
  const headerJson = JSON.stringify({
    uuid: 'u-1',
    name: 'Steve',
    reason: 'death',
    dim: 'minecraft:overworld',
    pos: [1.5, 64, -3.25],
    dataVersion: 3955,
    items: [{ slot: 0, id: 'minecraft:diamond', count: 12 }],
  });
  const gz = Buffer.from([31, 139, 8, 0, 42]);
  const w = new Writer().varInt(1).utf(headerJson).varInt(gz.length);
  const payload = Buffer.concat([w.build(), gz]);

  const snap = decodeInvSnap(payload);
  assert.equal(snap.header.name, 'Steve');
  assert.equal(snap.header.reason, 'death');
  assert.equal(snap.header.dataVersion, 3955);
  assert.equal(snap.header.items[0]?.id, 'minecraft:diamond');
  assert.deepEqual([...snap.gz], [...gz], 'gz bytes verbatim');
});

test('invsnap codec: unsupported version and truncated gz are rejected', () => {
  const bad = new Writer().varInt(2).utf('{}').build();
  assert.throws(() => decodeInvSnap(bad), /unsupported invsnap version/);

  const truncated = new Writer().varInt(1).utf(JSON.stringify({ uuid: 'u', name: 'n' })).varInt(10).build();
  assert.throws(() => decodeInvSnap(truncated), /exceeds payload/);
});
