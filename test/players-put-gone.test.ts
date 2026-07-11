import './helpers/env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { goneUseOpsApi } from '../src/shared/utils/gone.ts';

/**
 * Phase 9: PUT /:nick/:tag/{stats,inventory,position} answer 410 Gone with a pointer at the
 * ops API — Node writing player .dat/stats over the Pterodactyl file API is banned for good
 * (the corruption incidents that killed the old admin panel).
 */
test('players PUT deprecation: the gone handler answers 410 with an ops-API pointer', () => {
  let status = 0;
  let body: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
    },
  } as unknown as Response;

  goneUseOpsApi('remove_item / give_item / inventory_clear')({} as Request, res);

  assert.equal(status, 410);
  const err = (body as { error: { code: string; message: string } }).error;
  assert.equal(err.code, 'GONE');
  assert.match(err.message, /biforesting\/:server\/ops/);
  assert.match(err.message, /inventory_clear/);
});
