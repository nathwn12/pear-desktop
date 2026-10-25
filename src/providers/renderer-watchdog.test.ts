import { expect, test } from '@playwright/test';

import { createRendererWatchdog } from './renderer-watchdog';

test.describe('renderer watchdog unresponsive handling', () => {
  test('reports once per renderer generation and never reloads', () => {
    let notified = 0;
    let reloads = 0;

    const watchdog = createRendererWatchdog({
      // A reload hook is present at runtime on purpose: the policy must never
      // reach for it, whatever a caller hands over.
      reload: () => {
        reloads += 1;
      },
      notifyUnresponsive: () => {
        notified += 1;
      },
    } as unknown as Parameters<typeof createRendererWatchdog>[0]);

    watchdog.handleUnresponsive();
    watchdog.handleUnresponsive();

    expect(notified).toBe(1);
    expect(reloads).toBe(0);

    // A new renderer generation may report again.
    watchdog.markRendererGeneration();
    watchdog.handleUnresponsive();

    expect(notified).toBe(2);
    expect(reloads).toBe(0);
  });

  test('a high working set does not reload or read player state', () => {
    let reloads = 0;
    let reads = 0;
    let notified = 0;

    const watchdog = createRendererWatchdog({
      getWorkingSetMb: () => 4_096,
      readPlaybackPaused: () => {
        reads += 1;
        return Promise.resolve(true);
      },
      isRendererAlive: () => true,
      reload: () => {
        reloads += 1;
      },
      notifyUnresponsive: () => {
        notified += 1;
      },
    } as unknown as Parameters<typeof createRendererWatchdog>[0]);

    for (let index = 0; index < 5; index += 1) {
      watchdog.handleUnresponsive();
    }

    // The watchdog exposes no sampling entry point and touched no player state.
    expect(Object.keys(watchdog).sort()).toEqual([
      'handleUnresponsive',
      'markRendererGeneration',
    ]);
    expect(reads).toBe(0);
    expect(reloads).toBe(0);
    expect(notified).toBe(1);
  });

  test('creates no background timer', () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const nativeSetInterval = globalThis.setInterval;
    let scheduled = 0;

    globals.setInterval = ((...args: Parameters<typeof setInterval>) => {
      scheduled += 1;
      return nativeSetInterval(...args);
    }) as typeof setInterval;

    try {
      const watchdog = createRendererWatchdog({
        notifyUnresponsive: () => undefined,
      });
      watchdog.handleUnresponsive();
      watchdog.markRendererGeneration();
    } finally {
      globals.setInterval = nativeSetInterval;
    }

    expect(scheduled).toBe(0);
  });
});
