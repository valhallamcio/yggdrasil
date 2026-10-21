import './helpers/env.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { logger } from '../src/core/logger/index.ts';
import { RECENT_LINES_MAX, recentLines, rememberLine } from '../src/core/logger/recent-lines.ts';
import { MAX_CRASH_REPORTS, writeCrashReport } from '../src/core/server/crash-report.ts';

// Under logs/, which git ignores.
const root = join(process.cwd(), 'logs', `test-crash-${process.pid}`);
const dir = join(root, 'unit');
after(() => rmSync(root, { recursive: true, force: true }));

test('the logger keeps a copy of each line it writes', () => {
  logger.error({ marker: 'keep-me' }, 'line before the crash');
  const last = recentLines().at(-1) ?? '';
  assert.match(last, /"marker":"keep-me"/);
  assert.match(last, /"msg":"line before the crash"/);
  assert.ok(!last.endsWith('\n'));
});

test('the ring keeps the newest RECENT_LINES_MAX lines', () => {
  for (let i = 0; i < RECENT_LINES_MAX + 10; i++) rememberLine(`line ${i}\n`);
  const lines = recentLines();
  assert.equal(lines.length, RECENT_LINES_MAX);
  assert.equal(lines[0], 'line 10');
  assert.equal(lines.at(-1), `line ${RECENT_LINES_MAX + 9}`);
});

test('a crash report holds the kind, the error with its stack and cause, and the last log lines', () => {
  rememberLine('{"msg":"the last line"}\n');
  const file = writeCrashReport('uncaughtException', new Error('boom', { cause: new Error('root cause') }), dir);
  assert.ok(file?.startsWith(dir));
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^time: \d{4}-\d\d-\d\dT/);
  assert.match(text, /\nkind: uncaughtException\n/);
  assert.match(text, /Error: boom\n\s+at /);
  assert.match(text, /crash-report\.test\.ts/);
  assert.match(text, /root cause/);
  assert.match(text, /last \d+ log lines:\n[\s\S]*\{"msg":"the last line"\}\n$/);
});

test('a rejection reason that is not an Error is written as is', () => {
  const file = writeCrashReport('unhandledRejection', { code: 'E_ODD', detail: 42 }, dir);
  assert.ok(file);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /\nkind: unhandledRejection\n/);
  assert.match(text, /code: 'E_ODD'/);
  assert.match(text, /detail: 42/);
});

test('a failed write returns null and does not throw', () => {
  mkdirSync(dir, { recursive: true });
  const notADir = join(dir, 'plain-file');
  writeFileSync(notADir, 'x');
  assert.equal(writeCrashReport('uncaughtException', new Error('nowhere to go'), join(notADir, 'sub')), null);
});

test('after MAX_CRASH_REPORTS reports the process writes no more', () => {
  const results = Array.from({ length: MAX_CRASH_REPORTS + 3 }, (_, i) =>
    writeCrashReport('uncaughtException', new Error(`burst ${i}`), dir),
  );
  assert.ok(results.filter((r) => r === null).length >= 3);
  assert.equal(writeCrashReport('uncaughtException', new Error('one more'), dir), null);
});

test('an uncaught exception in a real process leaves a crash report in logs/', () => {
  const cwd = join(root, 'child');
  mkdirSync(cwd, { recursive: true });
  const shutdownUrl = pathToFileURL(join(process.cwd(), 'src/core/server/graceful-shutdown.ts')).href;
  const loggerUrl = pathToFileURL(join(process.cwd(), 'src/core/logger/index.ts')).href;
  const script = `
    const { createServer } = await import('node:http');
    const { registerGracefulShutdown } = await import(${JSON.stringify(shutdownUrl)});
    const { logger } = await import(${JSON.stringify(loggerUrl)});
    registerGracefulShutdown(createServer());
    logger.error('child: the line before the throw');
    setTimeout(() => { throw new Error('boom from the child'); }, 10);
  `;
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd,
    env: { ...process.env, LOG_PRETTY: 'false' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(run.status, null, `child did not exit: ${run.stderr}`);
  const reports = readdirSync(join(cwd, 'logs')).filter((f) => /^crash-.*\.log$/.test(f));
  assert.equal(reports.length, 1, run.stderr);
  const text = readFileSync(join(cwd, 'logs', reports[0]!), 'utf8');
  assert.match(text, /\nkind: uncaughtException\n/);
  assert.match(text, /Error: boom from the child/);
  assert.match(text, /child: the line before the throw/);
});
