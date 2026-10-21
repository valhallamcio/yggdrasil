/**
 * The last log lines this process wrote, kept in memory. Wings drops the container console when it
 * restarts a crashed server, so a crash report (core/server/crash-report.ts) copies these to disk.
 */
export const RECENT_LINES_MAX = 200;

const lines: string[] = [];

/** Pino `streamWrite` hook: keep a copy of the line and pass the line on unchanged. */
export function rememberLine(line: string): string {
  lines.push(line.endsWith('\n') ? line.slice(0, -1) : line);
  if (lines.length > RECENT_LINES_MAX) lines.shift();
  return line;
}

/** The kept lines, oldest first. */
export function recentLines(): string[] {
  return [...lines];
}
