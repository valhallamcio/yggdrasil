import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogEntry } from '../src/domains/biforesting/ops-catalog.ts';
import { FEATURE_BITS, featureNamesForMask } from '../src/plugins/biforesting-link/policy-store.ts';

/** give_item's nbt param and the take_item and take_slot ops the proxy's trade settlement sends. */

test('take_slot: a slot offer parses, needs a target, and is gated on its own feature bit', () => {
  const entry = catalogEntry('take_slot');
  assert.ok(entry);
  assert.equal(entry.serverGlobal, false);
  assert.equal(entry.requiresFeature, 'take_slot');
  assert.equal(entry.requiresDryRunConfirm, undefined);
  assert.equal(entry.requiresConfirm, undefined);
  assert.equal(entry.autoSnapshot, undefined);
  assert.equal(FEATURE_BITS['take_slot'], 0x400000, 'mirrors the mod bit PlayProtocol.CAP_TAKE_SLOT');
  assert.deepEqual(featureNamesForMask(0x400000), ['take_slot']);
  assert.equal(entry.params.safeParse({ slot: 0, id: 'minecraft:diamond_pickaxe', count: 1 }).success, true);
  assert.equal(entry.params.safeParse({ slot: 35, id: 'minecraft:arrow', count: 2304, num: 802 }).success, true);
});

test('take_slot: slot 0-35 and count 1-2304 only, num is a non-negative int, unknown keys are refused', () => {
  const p = (params: unknown): boolean => catalogEntry('take_slot')!.params.safeParse(params).success;
  const ok = { slot: 3, id: 'minecraft:diamond_pickaxe', count: 1 };
  assert.equal(p({ ...ok, slot: -1 }), false);
  assert.equal(p({ ...ok, slot: 36 }), false, 'armour, offhand and ender slots are out of reach');
  assert.equal(p({ ...ok, slot: 1.5 }), false);
  assert.equal(p({ id: ok.id, count: 1 }), false, 'slot is required');
  assert.equal(p({ slot: 3, count: 1 }), false, 'id is required');
  assert.equal(p({ ...ok, id: '' }), false);
  assert.equal(p({ slot: 3, id: ok.id }), false, 'count is required');
  assert.equal(p({ ...ok, count: 0 }), false);
  assert.equal(p({ ...ok, count: 2305 }), false);
  assert.equal(p({ ...ok, num: -1 }), false);
  assert.equal(p({ ...ok, nbt: 'CgAAAA==' }), false, 'the backend reads the data, the caller never sends it');
  assert.equal(p({ ...ok, meta: 0 }), false);
});

// {"": {Damage: 3s}} as uncompressed binary NBT: 0a 0000 | 02 0006 "Damage" 0003 | 00
const NBT = Buffer.from('0a0000' + '02000644616d616765' + '0003' + '00', 'hex').toString('base64');

test('take_item: a full trade stack parses, and the entry needs a target and no dry-run', () => {
  const entry = catalogEntry('take_item');
  assert.ok(entry);
  assert.equal(entry.serverGlobal, false);
  assert.equal(entry.requiresDryRunConfirm, undefined);
  assert.equal(entry.requiresConfirm, undefined);
  assert.equal(entry.autoSnapshot, undefined);
  const parsed = entry.params.safeParse({ id: 'gregtech:gt.metaitem.01', meta: 11000, count: 64, nbt: NBT, num: 4097 });
  assert.equal(parsed.success, true);
});

test('take_item: count is required and capped at 2304, unknown keys are refused', () => {
  const entry = catalogEntry('take_item')!;
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone' }).success, false);
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', count: 0 }).success, false);
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', count: 2305 }).success, false);
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', count: 1, nbtContains: 'x' }).success, false);
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', count: 1, num: -1 }).success, false);
});

test('give_item: nbt is optional base64, anything else is refused', () => {
  const entry = catalogEntry('give_item')!;
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', count: 3 }).success, true);
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', count: 3, overflow: 'drop', nbt: NBT }).success, true);
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', nbt: '{Damage:3s}' }).success, false);
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', nbt: 'x'.repeat(262_148) }).success, false);
  assert.equal(entry.params.safeParse({ id: 'minecraft:stone', snbt: '{}' }).success, false);
});
