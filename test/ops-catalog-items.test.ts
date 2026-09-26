import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catalogEntry } from '../src/domains/biforesting/ops-catalog.ts';

/** give_item's nbt param and the take_item op the proxy's trade settlement sends. */

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
