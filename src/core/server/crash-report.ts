import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { recentLines } from '../logger/recent-lines.js';

/** `logs/` in the working dir. On prod that is the server volume, which survives a restart. */
export const CRASH_REPORT_DIR = resolve('logs');

/** An error that repeats during the shutdown writes this many reports, then no more. */
export const MAX_CRASH_REPORTS = 5;

let written = 0;

const mib = (bytes: number): number => Math.round(bytes / 1048576);

/**
 * Write a fatal error and the last log lines to `<dir>/crash-<time>.log`. Wings recreates the
 * container when it restarts a crashed server, so the console of the dead process is gone. This
 * file stays. The write is sync because the process can exit before an async write lands.
 * It never throws. Returns the file path, or null when it wrote nothing.
 */
export function writeCrashReport(kind: string, error: unknown, dir: string = CRASH_REPORT_DIR): string | null {
  if (written >= MAX_CRASH_REPORTS) return null;
  try {
    const now = new Date();
    const lines = recentLines();
    const mem = process.memoryUsage();
    const body = [
      `time: ${now.toISOString()}`,
      `kind: ${kind}`,
      `pid: ${process.pid}, uptime: ${Math.round(process.uptime())} s, node: ${process.version}`,
      `memory: rss ${mib(mem.rss)} MiB, heap ${mib(mem.heapUsed)}/${mib(mem.heapTotal)} MiB`,
      '',
      inspect(error, { depth: 6, breakLength: 120 }),
      '',
      `last ${lines.length} log lines:`,
      ...lines,
      '',
    ].join('\n');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `crash-${now.toISOString().replace(/[:.]/g, '-')}.log`);
    appendFileSync(file, body);
    written++;
    return file;
  } catch {
    return null;
  }
}
