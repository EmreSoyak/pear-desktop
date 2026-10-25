import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

// Lightweight diagnostic log for the tray hover popup.
// Lines are queued and flushed at most once per second, so logging never
// touches the disk on every mouse move. The file rotates at 2MB (one backup).

const MAX_BYTES = 2 * 1024 * 1024;
const FLUSH_DELAY = 1000;

let logFile: string | null = null;
let queue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

// Local time, so the log matches the clock the user reads off the taskbar
const timestamp = () => {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `.${pad(d.getMilliseconds(), 3)}`
  );
};

export const getHoverLogPath = () => {
  if (!logFile) {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'hover-popup.log');
  }
  return logFile;
};

const flush = () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;

  const chunk = queue.join('');
  queue = [];

  try {
    const file = getHoverLogPath();
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // File doesn't exist yet
    }
    fs.appendFileSync(file, chunk);
  } catch {
    // Logging must never break the popup
  }
};

export const hoverLog = (event: string, data?: Record<string, unknown>) => {
  const line = data
    ? `${timestamp()} ${event} ${JSON.stringify(data)}\n`
    : `${timestamp()} ${event}\n`;
  queue.push(line);
  if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY);
};

export const flushHoverLog = flush;

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);
