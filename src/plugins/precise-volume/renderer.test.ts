import { registerHooks } from 'node:module';

import { expect, test } from '@playwright/test';

import type { PreciseVolumePluginConfig } from './index';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

/**
 * `index.ts` reaches main-process modules and build-time virtuals; stub them at
 * the loader boundary so the real plugin entry runs headless over happy-dom.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'virtual:i18n') {
      return {
        url: 'data:text/javascript,export const languageResources = async () => ({});',
        shortCircuit: true,
      };
    }
    if (specifier === 'electron') {
      return {
        url: 'data:text/javascript,export const globalShortcut = { register: () => {} };',
        shortCircuit: true,
      };
    }
    if (specifier === 'custom-electron-prompt') {
      return {
        url: 'data:text/javascript,export default () => undefined;',
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('?inline')) {
      return {
        url: 'data:text/javascript,export default "";',
        shortCircuit: true,
      };
    }
    if (specifier.includes('?asset')) {
      return {
        url: 'data:text/javascript,export default "";',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

type RendererLifecycle = {
  onPlayerApiReady: (
    playerApi: MusicPlayer,
    context: RendererContext<PreciseVolumePluginConfig>,
  ) => Promise<void>;
  stop?: () => void;
};

type LiveListeners = {
  count: (type: string) => number;
  total: () => number;
};

/** Count live listeners on one target by wrapping its own registration pair. */
function trackListeners(target: EventTarget): LiveListeners {
  const live = new Map<string, Set<EventListener>>();

  const record = (type: string) => {
    let listeners = live.get(type);
    if (!listeners) {
      listeners = new Set<EventListener>();
      live.set(type, listeners);
    }
    return listeners;
  };

  const nativeAdd = target.addEventListener.bind(target);
  const nativeRemove = target.removeEventListener.bind(target);

  const patched = target as unknown as {
    addEventListener: (type: string, listener: EventListener) => void;
    removeEventListener: (type: string, listener: EventListener) => void;
  };

  patched.addEventListener = (type, listener) => {
    record(type).add(listener);
    nativeAdd(type, listener);
  };
  patched.removeEventListener = (type, listener) => {
    live.get(type)?.delete(listener);
    nativeRemove(type, listener);
  };

  return {
    count: (type) => live.get(type)?.size ?? 0,
    total: () =>
      [...live.values()].reduce((sum, listeners) => sum + listeners.size, 0),
  };
}

type MainConfigStub = {
  plugins: { isEnabled: (name: string) => Promise<boolean> };
};

/** A promise the test settles by hand, to hold an init `await` open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const defaultConfig = (): PreciseVolumePluginConfig => ({
  enabled: true,
  steps: 1,
  arrowsShortcut: true,
  globalShortcuts: { volumeUp: '', volumeDown: '' },
  savedVolume: undefined,
});

async function createEnv() {
  const { Window } = await import('happy-dom');
  const win = new Window();

  const globals = globalThis as unknown as Record<string, unknown>;
  globals.window = win;
  globals.document = win.document;
  globals.CustomEvent = win.CustomEvent;
  globals.Event = win.Event;
  globals.KeyboardEvent = win.KeyboardEvent;
  globals.MutationObserver = win.MutationObserver;
  globals.Node = win.Node;
  globals.Element = win.Element;
  globals.HTMLElement = win.HTMLElement;
  globals.HTMLInputElement = win.HTMLInputElement;
  globals.WheelEvent = win.WheelEvent;

  win.document.body.innerHTML = `
    <div id="main-panel"></div>
    <video></video>
    <ytmusic-player-bar></ytmusic-player-bar>
    <tp-yt-paper-slider id="volume-slider"></tp-yt-paper-slider>
    <div id="song-video"></div>
  `;

  // happy-dom has no `computedStyleMap`; state the video-less branch explicitly.
  (
    win.Element.prototype as unknown as Record<string, unknown>
  ).computedStyleMap = () => ({ get: () => ({ value: 'block' }) });

  const mainConfig: MainConfigStub = {
    plugins: { isEnabled: () => Promise.resolve(false) },
  };
  (win as unknown as Record<string, unknown>).mainConfig = mainConfig;

  // Track every observer the plugin creates, so a disconnected one is visible.
  const observers = new Set<unknown>();
  const NativeMutationObserver =
    win.MutationObserver as unknown as typeof MutationObserver;

  class TrackedMutationObserver extends NativeMutationObserver {
    override observe(target: Node, options?: MutationObserverInit) {
      observers.add(this);
      super.observe(target, options);
    }

    override disconnect() {
      observers.delete(this);
      super.disconnect();
    }
  }

  globals.MutationObserver = TrackedMutationObserver;

  const registries = [
    ...[...win.document.querySelectorAll('*')].map((element) =>
      trackListeners(element as unknown as EventTarget),
    ),
    trackListeners(win as unknown as EventTarget),
  ];

  const listeners = {
    count: (type: string) =>
      registries.reduce((sum, registry) => sum + registry.count(type), 0),
    total: () =>
      registries.reduce((sum, registry) => sum + registry.total(), 0),
  };

  const { default: plugin } = await import('./index');

  const slider = () =>
    win.document.querySelector('#volume-slider') as unknown as HTMLElement & {
      value: string;
    };

  return {
    doc: win.document,
    listeners,
    mainConfig,
    win,
    observerCount: () => observers.size,
    lifecycle: plugin.renderer as unknown as RendererLifecycle,
    wheel(deltaY: number) {
      win.document
        .querySelector('#main-panel')!
        .dispatchEvent(
          new win.WheelEvent('wheel', { deltaY, cancelable: true }),
        );
    },
    key(code: string) {
      win.dispatchEvent(new win.KeyboardEvent('keydown', { code }));
    },
    slideTo(value: number) {
      slider().value = String(value);
      slider().setAttribute('value', String(value));
    },
    slider,
    async tick() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

let env: Awaited<ReturnType<typeof createEnv>> | undefined;
const boot = async () => (env ??= await createEnv());

function createPlayer() {
  let volume = 50;

  return {
    api: {
      getVolume: () => volume,
      setVolume: (value: number) => {
        volume = value;
      },
      getPlayerResponse: () => ({
        videoDetails: { musicVideoType: 'MUSIC_VIDEO_TYPE_ATV' },
      }),
    } as unknown as MusicPlayer,
    volume: () => volume,
  };
}

type VolumeListener = (toIncrease: boolean) => void;

function createIpc(
  overrides: { getConfig?: () => Promise<PreciseVolumePluginConfig> } = {},
) {
  const channels = new Map<string, Set<VolumeListener>>();

  return {
    context: {
      getConfig:
        overrides.getConfig ?? (() => Promise.resolve(defaultConfig())),
      setConfig: () => Promise.resolve(),
      ipc: {
        send: () => {},
        invoke: () => Promise.resolve(undefined),
        on: (event: string, listener: CallableFunction) => {
          let listeners = channels.get(event);
          if (!listeners) {
            listeners = new Set<VolumeListener>();
            channels.set(event, listeners);
          }
          listeners.add(listener as VolumeListener);
        },
        removeAllListeners: (event: string) => {
          channels.delete(event);
        },
      },
    } as unknown as RendererContext<PreciseVolumePluginConfig>,
    count: (event: string) => channels.get(event)?.size ?? 0,
    fire(event: string, toIncrease: boolean) {
      for (const listener of [...(channels.get(event) ?? [])]) {
        listener(toIncrease);
      }
    },
  };
}

test('stopping the plugin leaves no listener, observer or HUD behind', async () => {
  const app = await boot();
  const player = createPlayer();
  const ipc = createIpc();

  expect(typeof app.lifecycle.stop).toBe('function');

  await app.lifecycle.onPlayerApiReady(player.api, ipc.context);

  expect(app.listeners.count('wheel')).toBe(2);
  expect(app.listeners.count('mouseenter')).toBe(1);
  expect(app.listeners.count('mouseleave')).toBe(1);
  expect(app.listeners.count('keydown')).toBe(1);
  expect(app.listeners.count('peard:src-changed')).toBe(1);
  expect(app.observerCount()).toBe(1);
  expect(app.doc.querySelectorAll('#volumeHud')).toHaveLength(1);

  app.wheel(-100);
  expect(player.volume()).toBe(51);

  app.lifecycle.stop?.();

  expect(app.listeners.total()).toBe(0);
  expect(app.observerCount()).toBe(0);
  expect(app.doc.querySelectorAll('#volumeHud')).toHaveLength(0);

  const sliderBefore = app.slider().title;
  app.slideTo(80);
  await app.tick();
  expect(app.slider().title).toBe(sliderBefore);
  expect(app.slider().getAttribute('title')).toBe('51%');

  // Each source of volume change must be gone, not merely quiet.
  app.wheel(-100);
  expect(player.volume()).toBe(51);

  app.key('ArrowUp');
  expect(player.volume()).toBe(51);

  ipc.fire('changeVolume', false);
  expect(player.volume()).toBe(51);
  expect(ipc.count('changeVolume')).toBe(0);
  expect(ipc.count('setVolume')).toBe(0);
});

test('re-enabling after a stop owns exactly one registration set', async () => {
  const app = await boot();
  const player = createPlayer();
  const ipc = createIpc();

  await app.lifecycle.onPlayerApiReady(player.api, ipc.context);
  app.lifecycle.stop?.();
  await app.lifecycle.onPlayerApiReady(player.api, ipc.context);

  expect(app.listeners.count('wheel')).toBe(2);
  expect(app.listeners.count('mouseenter')).toBe(1);
  expect(app.listeners.count('mouseleave')).toBe(1);
  expect(app.listeners.count('keydown')).toBe(1);
  expect(app.listeners.count('peard:src-changed')).toBe(1);
  expect(app.observerCount()).toBe(1);
  expect(app.doc.querySelectorAll('#volumeHud')).toHaveLength(1);

  // One wheel tick is one step: a duplicated registration would add two.
  app.wheel(-100);
  expect(player.volume()).toBe(51);

  app.key('ArrowUp');
  expect(player.volume()).toBe(52);

  ipc.fire('changeVolume', false);
  expect(player.volume()).toBe(51);

  app.slideTo(90);
  await app.tick();
  expect(app.slider().getAttribute('title')).toBe('90%');

  app.lifecycle.stop?.();
  expect(app.listeners.total()).toBe(0);
  expect(app.observerCount()).toBe(0);
});

test('a repeated initialisation without a stop still owns one set', async () => {
  const app = await boot();
  const player = createPlayer();
  const ipc = createIpc();

  app.lifecycle.stop?.();
  await app.lifecycle.onPlayerApiReady(player.api, ipc.context);
  await app.lifecycle.onPlayerApiReady(player.api, ipc.context);

  expect(app.listeners.count('wheel')).toBe(2);
  expect(app.listeners.count('keydown')).toBe(1);
  expect(app.observerCount()).toBe(1);
  expect(app.doc.querySelectorAll('#volumeHud')).toHaveLength(1);

  app.wheel(-100);
  expect(player.volume()).toBe(51);
});

test('a stop while getConfig is in flight registers nothing when it resolves', async () => {
  const app = await boot();
  const player = createPlayer();
  const config = deferred<PreciseVolumePluginConfig>();
  const ipc = createIpc({ getConfig: () => config.promise });

  app.lifecycle.stop?.();
  const init = app.lifecycle.onPlayerApiReady(player.api, ipc.context);

  // Stop lands before the first await resolves, then the config arrives.
  app.lifecycle.stop?.();
  config.resolve({ ...defaultConfig(), savedVolume: 45 });
  await init;
  await app.tick();

  // The stopped activation owns nothing: no listener, observer, HUD or IPC.
  expect(app.listeners.total()).toBe(0);
  expect(app.observerCount()).toBe(0);
  expect(app.doc.querySelectorAll('#volumeHud')).toHaveLength(0);
  expect(ipc.count('changeVolume')).toBe(0);
  expect(ipc.count('setVolume')).toBe(0);

  // The stale continuation must not have applied its saved volume either.
  expect(player.volume()).toBe(50);

  app.lifecycle.stop?.();
});

test('a stop while the video-toggle probe is in flight registers nothing when it resolves', async () => {
  const app = await boot();
  const player = createPlayer();
  const ipc = createIpc();
  const probe = deferred<boolean>();

  app.mainConfig.plugins.isEnabled = () => probe.promise;

  try {
    app.lifecycle.stop?.();
    const init = app.lifecycle.onPlayerApiReady(player.api, ipc.context);

    // getConfig resolves on a microtask; let init reach the second await.
    await app.tick();
    expect(app.listeners.count('wheel')).toBe(2);
    expect(app.observerCount()).toBe(1);

    app.lifecycle.stop?.();
    probe.resolve(false);
    await init;
    await app.tick();

    // The continuation after the probe must not add its listener back.
    expect(app.listeners.total()).toBe(0);
    expect(app.listeners.count('peard:src-changed')).toBe(0);
    expect(app.observerCount()).toBe(0);
    expect(app.doc.querySelectorAll('#volumeHud')).toHaveLength(0);
    expect(ipc.count('changeVolume')).toBe(0);
    expect(ipc.count('setVolume')).toBe(0);
  } finally {
    app.mainConfig.plugins.isEnabled = () => Promise.resolve(false);
    app.lifecycle.stop?.();
  }
});

test('a stopped initialisation still lets the next enable own one set', async () => {
  const app = await boot();
  const player = createPlayer();
  const config = deferred<PreciseVolumePluginConfig>();
  const staleIpc = createIpc({ getConfig: () => config.promise });
  const liveIpc = createIpc();

  app.lifecycle.stop?.();
  const stale = app.lifecycle.onPlayerApiReady(player.api, staleIpc.context);
  app.lifecycle.stop?.();

  // Re-enable completes while the first attempt is still awaiting config.
  await app.lifecycle.onPlayerApiReady(player.api, liveIpc.context);

  config.resolve({ ...defaultConfig(), savedVolume: 45 });
  await stale;
  await app.tick();

  // The stale attempt stays abandoned; the live one owns exactly one set.
  expect(staleIpc.count('changeVolume')).toBe(0);
  expect(staleIpc.count('setVolume')).toBe(0);
  expect(app.listeners.count('wheel')).toBe(2);
  expect(app.listeners.count('mouseenter')).toBe(1);
  expect(app.listeners.count('mouseleave')).toBe(1);
  expect(app.listeners.count('keydown')).toBe(1);
  expect(app.listeners.count('peard:src-changed')).toBe(1);
  expect(app.observerCount()).toBe(1);
  expect(app.doc.querySelectorAll('#volumeHud')).toHaveLength(1);

  // One wheel tick is still one step, and the stale config never applied.
  expect(player.volume()).toBe(50);
  app.wheel(-100);
  expect(player.volume()).toBe(51);

  app.lifecycle.stop?.();
  expect(app.listeners.total()).toBe(0);
  expect(app.observerCount()).toBe(0);
});
