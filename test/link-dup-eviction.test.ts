import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { biforestingLinkManager } from '../src/plugins/biforesting-link/link-manager.ts';
import { Writer } from '../src/plugins/biforesting-link/frame-codec.ts';

/**
 * D3: duplicate identity → NEWEST register wins, the older session is closed. Runs without Mongo:
 * the resolver fails soft (unresolved identity keyed by the raw serverId), which is exactly the
 * duplicate-detection path a half-open zombie session hits after a backend restart.
 */

function registerPayload(serverId: string, bootNonce: bigint): Buffer {
  return new Writer()
    .varInt(2) // register message-format v2
    .utf(serverId)
    .utf('dup-test')
    .varInt(0x10)
    .utf('node-1')
    .utf('127.0.0.1:25565')
    .long(bootNonce)
    .varInt(2) // linkProtocolVersion
    .build();
}

function mkTransport() {
  const state = { closed: false, sends: 0 };
  return {
    state,
    transport: {
      writable: () => !state.closed,
      send: () => {
        state.sends++;
      },
      close: () => {
        state.closed = true;
      },
    },
  };
}

test('link-manager: second register with the same serverId evicts the older session (newest wins)', async () => {
  const a = mkTransport();
  const b = mkTransport();
  biforestingLinkManager.registerSession('dup#1', a.transport, '10.0.0.1:1111');
  biforestingLinkManager.registerSession('dup#2', b.transport, '10.0.0.1:2222');

  await biforestingLinkManager.dispatch('dup#1', 'biforesting:register', registerPayload('dup-server', 1n));
  assert.equal(a.state.closed, false, 'first register holds the identity');
  assert.ok(a.state.sends >= 1, 'first session got its reg_ack');

  await biforestingLinkManager.dispatch('dup#2', 'biforesting:register', registerPayload('dup-server', 2n));
  assert.equal(a.state.closed, true, 'older session closed on duplicate identity');
  assert.ok(b.state.sends >= 1, 'newest session got its reg_ack');

  const snapshot = biforestingLinkManager.getSnapshot();
  const bound = snapshot.sessions.filter((s) => s.identity?.linkServerId === 'dup-server');
  assert.equal(bound.length, 1, 'exactly one live session holds the identity');
  assert.equal(bound[0]!.sessionId, 'dup#2');

  // cleanup so other tests see no leftover sessions
  biforestingLinkManager.removeSession('dup#2');
});

test('link-manager: distinct serverIds coexist (no false eviction)', async () => {
  const a = mkTransport();
  const b = mkTransport();
  biforestingLinkManager.registerSession('co#1', a.transport, '10.0.0.2:1111');
  biforestingLinkManager.registerSession('co#2', b.transport, '10.0.0.2:2222');

  await biforestingLinkManager.dispatch('co#1', 'biforesting:register', registerPayload('server-one', 1n));
  await biforestingLinkManager.dispatch('co#2', 'biforesting:register', registerPayload('server-two', 1n));
  assert.equal(a.state.closed, false);
  assert.equal(b.state.closed, false);

  biforestingLinkManager.removeSession('co#1');
  biforestingLinkManager.removeSession('co#2');
});
