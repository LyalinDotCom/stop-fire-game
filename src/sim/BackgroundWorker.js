/**
 * EMBER FRONT — Blob Web Worker Hidden-Tab Ticker
 * Keeps the Authority Host 10 Hz fire simulation ticking even when a browser tab is throttled,
 * with automatic graceful fallback to setInterval in Node or restricted CSP environments.
 */

const WORKER_SOURCE = `
let timerId = null;
self.onmessage = function(ev) {
  const msg = ev.data || {};
  if (msg.cmd === 'start') {
    if (timerId !== null) clearInterval(timerId);
    const ms = Math.max(16, Number(msg.intervalMs) || 100);
    timerId = setInterval(() => {
      self.postMessage({ type: 'tick', now: Date.now() });
    }, ms);
  } else if (msg.cmd === 'stop') {
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
  }
};
`;

/**
 * Create a resilient periodic ticker backed by a Blob Web Worker (browser)
 * or standard setInterval (Node / fallback).
 *
 * @param {number} intervalMs
 * @param {(nowMs: number) => void} onTick
 * @returns {{ start: () => void, stop: () => void, isHidden: () => boolean }}
 */
export function createBackgroundTicker(intervalMs, onTick) {
  const safeMs = Math.max(16, Number(intervalMs) || 100);
  let worker = null;
  let blobUrl = null;
  let intervalId = null;
  let running = false;

  function startFallback() {
    if (intervalId !== null) clearInterval(intervalId);
    intervalId = setInterval(() => {
      try {
        onTick(Date.now());
      } catch (err) {
        // Keep ticker alive if callback throws
        console.error('[BackgroundWorker] tick error:', err);
      }
    }, safeMs);
  }

  function start() {
    if (running) return;
    running = true;

    const canUseWorker =
      typeof Worker !== 'undefined' &&
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function';

    if (canUseWorker) {
      try {
        const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
        blobUrl = URL.createObjectURL(blob);
        worker = new Worker(blobUrl);
        worker.onmessage = (ev) => {
          if (!running) return;
          const now = ev.data?.now ?? Date.now();
          try {
            onTick(now);
          } catch (err) {
            console.error('[BackgroundWorker] tick error:', err);
          }
        };
        worker.onerror = () => {
          // Fall back seamlessly if worker errors at runtime
          cleanupWorker();
          if (running && intervalId === null) {
            startFallback();
          }
        };
        worker.postMessage({ cmd: 'start', intervalMs: safeMs });
        return;
      } catch {
        cleanupWorker();
      }
    }

    startFallback();
  }

  function cleanupWorker() {
    if (worker) {
      try {
        worker.postMessage({ cmd: 'stop' });
      } catch {
        // ignore
      }
      try {
        worker.terminate();
      } catch {
        // ignore
      }
      worker = null;
    }
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // ignore
      }
      blobUrl = null;
    }
  }

  function stop() {
    running = false;
    cleanupWorker();
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function isHidden() {
    return typeof document !== 'undefined' ? Boolean(document.hidden) : false;
  }

  return {
    start,
    stop,
    isHidden,
  };
}
