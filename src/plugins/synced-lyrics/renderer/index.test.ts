import { registerHooks } from 'node:module';

import { expect, test } from '@playwright/test';

import type { SyncedLyricsPluginConfig } from '../types';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

/**
 * `renderer/index.ts` reaches the i18n barrel (which imports `virtual:i18n`)
 * and, through the renderer entry, CSS `?inline` imports; stub both at the
 * loader boundary so the real plugin entry runs headless over happy-dom.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'virtual:i18n') {
      return {
        url: 'data:text/javascript,export const languageResources = async () => ({});',
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('?inline')) {
      return {
        url: 'data:text/javascript,export default "";',
        shortCircuit: true,
      };
    }
    // Node resolves solid-js to its server build; this test runs the client one.
    if (specifier === 'solid-js' || specifier.startsWith('solid-js/')) {
      return nextResolve(specifier, {
        ...context,
        conditions: ['browser', 'import', 'default'],
      });
    }
    return nextResolve(specifier, context);
  },
});

type TimerId = ReturnType<typeof setInterval>;

type RendererLifecycle = {
  onPlayerApiReady: (playerApi: MusicPlayer) => Promise<void>;
  start: (ctx: RendererContext<SyncedLyricsPluginConfig>) => Promise<void>;
  stop: () => void;
};

/**
 * The plugin module is a singleton (that is the point of this test), so the
 * whole file shares one window, one module instance and one timer ledger.
 */
async function createEnv() {
  const { Window } = await import('happy-dom');
  const win = new Window();

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = win;
  globals.document = win.document;
  globals.CustomEvent = win.CustomEvent;
  globals.Event = win.Event;
  globals.MutationObserver = win.MutationObserver;
  globals.Node = win.Node;
  globals.Element = win.Element;
  globals.HTMLElement = win.HTMLElement;
  globals.customElements = win.customElements;

  // The rest of the DOM constructors the plugin graph touches at import time
  // (DOMParser, HTMLVideoElement, ...). Node's own globals stay untouched.
  for (const key of Object.getOwnPropertyNames(win)) {
    if (!/^[A-Z]/.test(key) || key in globals) continue;
    const value = (win as unknown as Record<string, unknown>)[key];
    if (typeof value === 'function') globals[key] = value;
  }

  // Renderer globals the plugin graph touches at import time.
  (win as unknown as Record<string, unknown>).ipcRenderer = {
    invoke: () => Promise.resolve(undefined),
    on: () => {},
    removeAllListeners: () => {},
    send: () => {},
  };

  // The lyrics tab header, so `videoDataChange` resolves without polling.
  win.document.body.innerHTML =
    '<div id="tabsContent"><div class="tab-header"></div><div class="tab-header"></div></div>';

  const created: TimerId[] = [];
  const cleared: TimerId[] = [];
  const timers = globalThis as unknown as {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  const originalSetInterval = timers.setInterval;
  const originalClearInterval = timers.clearInterval;

  timers.setInterval = ((...args: Parameters<typeof setInterval>): TimerId => {
    const id = originalSetInterval(...args);
    created.push(id);
    return id;
  }) as typeof setInterval;
  timers.clearInterval = ((id?: TimerId) => {
    if (id !== undefined) cleared.push(id);
    originalClearInterval(id);
  }) as typeof clearInterval;

  const { renderer } = await import('./index');

  return {
    cleared,
    created,
    renderer,
    lifecycle: renderer as unknown as RendererLifecycle,
    restoreTimers: () => {
      timers.setInterval = originalSetInterval;
      timers.clearInterval = originalClearInterval;
    },
  };
}

let env: Awaited<ReturnType<typeof createEnv>> | undefined;
const boot = async () => (env ??= await createEnv());

test.afterAll(() => {
  env?.restoreTimers();
});

const liveIntervals = (created: TimerId[], cleared: TimerId[]) =>
  created.filter((id) => !cleared.includes(id));

/** A stand-in for the player API: records which listeners are live. */
function createPlayerApi() {
  const listeners = new Map<string, Set<() => Promise<void>>>();
  const registrations: Array<() => Promise<void>> = [];

  const api = {
    addEventListener(type: string, listener: () => Promise<void>) {
      registrations.push(listener);
      const registered = listeners.get(type) ?? new Set<() => Promise<void>>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: () => Promise<void>) {
      listeners.get(type)?.delete(listener);
    },
    getCurrentTime: () => 0,
  };

  return {
    playerApi: api as unknown as MusicPlayer,
    registrations,
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    async fire(type: string) {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        await listener();
      }
    },
  };
}

const createContext = () =>
  ({
    getConfig: () => Promise.resolve({ enabled: false }),
    ipc: {
      invoke: () => Promise.resolve(undefined),
      on: () => {},
      removeAllListeners: () => {},
      send: () => {},
    },
    setConfig: () => {},
  }) as unknown as RendererContext<SyncedLyricsPluginConfig>;

test('stopping the plugin clears the 100ms timestamp interval', async () => {
  const { cleared, created, lifecycle, renderer } = await boot();

  await renderer.videoDataChange();

  const interval = renderer.updateTimestampInterval;
  expect(interval).toBeDefined();
  expect(created).toContain(interval);
  expect(cleared).not.toContain(interval);

  lifecycle.stop();

  expect(renderer.updateTimestampInterval).toBeUndefined();
  expect(cleared).toContain(interval);
});

test('a videodatachange callback outliving stop() cannot restart polling', async () => {
  const { cleared, created, lifecycle, renderer } = await boot();
  const player = createPlayerApi();

  await lifecycle.start(createContext());
  await lifecycle.onPlayerApiReady(player.playerApi);

  const interval = renderer.updateTimestampInterval;
  expect(interval).toBeDefined();
  expect(player.listenerCount('videodatachange')).toBe(1);
  expect(liveIntervals(created, cleared)).toHaveLength(1);

  lifecycle.stop();

  expect(renderer.updateTimestampInterval).toBeUndefined();
  expect(cleared).toContain(interval);
  expect(liveIntervals(created, cleared)).toHaveLength(0);
  // The listener is unregistered from the player API...
  expect(player.listenerCount('videodatachange')).toBe(0);

  // ...and even a callback captured before stop() cannot revive the interval.
  const stale = player.registrations.at(-1)!;
  await stale();
  await renderer.videoDataChange();

  expect(renderer.updateTimestampInterval).toBeUndefined();
  expect(liveIntervals(created, cleared)).toHaveLength(0);
});

test('re-enabling the plugin restores exactly one interval', async () => {
  const { cleared, created, lifecycle, renderer } = await boot();

  // The previous test left the plugin stopped: nothing is polling right now.
  expect(liveIntervals(created, cleared)).toHaveLength(0);

  const player = createPlayerApi();

  await lifecycle.start(createContext());
  await lifecycle.onPlayerApiReady(player.playerApi);

  const interval = renderer.updateTimestampInterval;
  expect(interval).toBeDefined();
  expect(player.listenerCount('videodatachange')).toBe(1);
  expect(liveIntervals(created, cleared)).toHaveLength(1);

  // A further videodatachange refreshes the tab state, it does not add a timer.
  await player.fire('videodatachange');

  expect(renderer.updateTimestampInterval).toBe(interval);
  expect(player.listenerCount('videodatachange')).toBe(1);
  expect(liveIntervals(created, cleared)).toHaveLength(1);
});
