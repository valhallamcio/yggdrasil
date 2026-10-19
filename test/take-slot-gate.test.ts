import './helpers/env.ts';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { Db } from 'mongodb';

import { BiforestingController } from '../src/domains/biforesting/biforesting.controller.ts';
import { opDispatcher, opsStore } from '../src/plugins/biforesting-link/ops-runtime.ts';
import { serverResolver } from '../src/plugins/biforesting-link/server-resolver.ts';
import { FEATURE_BITS, setPolicyDbProvider } from '../src/plugins/biforesting-link/policy-store.ts';
import { ForbiddenError } from '../src/shared/errors/index.ts';

/**
 * The proxy's trade settlement reads a refused take_slot create as "never ran". That holds only
 * when a refusal proves no op exists under the idempotency key, so a key that has an op replays it
 * even after the bit is gone.
 */

const KEY = 'trade:t0000000000000000000000000000001:take:a:0';
const OP = { _id: '01JTAKESLOT0000000000000000', type: 'take_slot', state: 'completed', idempotencyKey: KEY };

const restores: Array<() => void> = [];
function stub<T extends object, K extends keyof T>(obj: T, key: K, impl: T[K]): void {
  const original = obj[key];
  obj[key] = impl;
  restores.push(() => { obj[key] = original; });
}
afterEach(() => { while (restores.length) restores.pop()!(); });

function policyDb(enabledFeatures: number): () => Db {
  const col = {
    createIndex: async () => 'ok',
    findOne: async () => (enabledFeatures ? { instanceKey: 'evol-1', enabledFeatures } : null),
  };
  return () => ({ collection: () => col }) as unknown as Db;
}

function setup(existing: typeof OP | null, enabledFeatures: number): { created: unknown[] } {
  const created: unknown[] = [];
  stub(serverResolver, 'resolve', (async () => ({ resolved: true, instanceKey: 'evol-1', tag: 'evol' })) as never);
  stub(opsStore, 'getByIdempotencyKey', (async () => existing) as never);
  stub(opsStore, 'create', (async (input: unknown) => {
    created.push(input);
    return existing ? { op: existing, replayed: true } : { op: { ...OP, state: 'pending' }, replayed: false };
  }) as never);
  stub(opsStore, 'get', (async () => existing ?? { ...OP, state: 'pending' }) as never);
  stub(opDispatcher, 'onOpCreated', (async () => undefined) as never);
  setPolicyDbProvider(policyDb(enabledFeatures));
  return { created };
}

function request(): Request {
  return {
    params: { server: 'e7575fc9' },
    body: {
      type: 'take_slot',
      params: { slot: 3, id: 'minecraft:diamond_pickaxe', count: 1 },
      target: { uuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'Alpha' },
      idempotencyKey: KEY,
    },
    headers: {},
  } as unknown as Request;
}

function response(): Response & { code?: number; body?: unknown } {
  const res = {
    code: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) { res.code = code; return res; },
    json(body: unknown) { res.body = body; return res; },
  };
  return res as unknown as Response & { code?: number; body?: unknown };
}

test('take_slot create: a server without the bit is refused with a 403, and no op is created', async () => {
  const s = setup(null, FEATURE_BITS['ops']!);
  await assert.rejects(
    new BiforestingController().createOp(request(), response()),
    (err: unknown) => err instanceof ForbiddenError && /feature 'take_slot' is not granted/.test(err.message),
  );
  assert.equal(s.created.length, 0);
});

test('take_slot create: with the bit, the op is created', async () => {
  const s = setup(null, FEATURE_BITS['ops']! | FEATURE_BITS['take_slot']!);
  const res = response();
  await new BiforestingController().createOp(request(), res);
  assert.equal(res.code, 201);
  assert.equal(s.created.length, 1);
});

test('take_slot create: a key that already has an op replays it after the bit is gone, so a 403 always means no op', async () => {
  const s = setup(OP, FEATURE_BITS['ops']!);
  const res = response();
  await new BiforestingController().createOp(request(), res);
  assert.equal(res.code, 200);
  assert.deepEqual((res.body as { data: { op: unknown; replayed: boolean } }).data, { op: OP, replayed: true });
  assert.equal(s.created.length, 1, 'the store replays it: no second op');
});
