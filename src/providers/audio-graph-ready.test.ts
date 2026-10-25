import { registerHooks } from 'node:module';

import { expect, test } from '@playwright/test';

import { virtualI18nStub } from '../test/virtual-i18n';

import type { SlowedReverbConfig } from '../plugins/player-actions/slowed-reverb/controller';
import type { AudioGraphReadyDetail } from './audio-graph-ready';

/**
 * The controller is the real module, which reaches the app's i18n and the
 * player-panel stylesheet. Both stubs are inert; the controller and the wiring
 * path are never replaced.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'virtual:i18n') {
      return virtualI18nStub;
    }
    if (specifier.endsWith('?inline')) {
      return {
        url: 'data:text/javascript,export default "";',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

/**
 * Reproduces the lazy-loading order that broke reverb: the app announces its
 * shared audio graph while the plugin module is still unloaded, so the plugin
 * cannot have registered its own listener yet. The central snapshot must survive
 * that gap and be replayable when the plugin finally starts.
 */
async function createDom() {
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
  globals.HTMLInputElement = win.HTMLInputElement;
  return win;
}

const fakeDetail = (counter: { reads: number }): AudioGraphReadyDetail => {
  const audioContext = { id: 'context' } as unknown as AudioContext;
  const audioSource = {
    id: 'source',
  } as unknown as MediaElementAudioSourceNode;
  return {
    // The renderer publishes lazy getters; reading them is what builds the graph.
    get audioContext() {
      counter.reads += 1;
      return audioContext;
    },
    get audioSource() {
      counter.reads += 1;
      return audioSource;
    },
  };
};

test.describe('audio graph readiness', () => {
  test('a plugin loaded after the announcement still observes the graph', async () => {
    await createDom();
    const counter = { reads: 0 };

    const central = await import('./audio-graph-ready');
    // Announcement fires first, exactly once per video / player-api-ready.
    central.publishAudioGraphReady(fakeDetail(counter));
    expect(counter.reads).toBe(0);

    // Plugin module is imported lazily, mid-song.
    const plugin =
      await import('../plugins/player-actions/slowed-reverb/audio-graph');

    const detail = plugin.getLatestAudioDetail();
    expect(detail).not.toBeNull();
    expect(detail!.audioContext).toBe(
      (central.getAudioGraphReady() as AudioGraphReadyDetail).audioContext,
    );
    expect(counter.reads).toBeGreaterThan(0);
  });

  test('the real controller wires a graph announced before it loaded', async () => {
    await createDom();
    const counter = { reads: 0 };

    const central = await import('./audio-graph-ready');

    // Fake WebAudio nodes: the controller and its wiring stay real.
    const destination = { kind: 'destination' };
    const gainConnects: unknown[] = [];
    const wetGain = {
      gain: { value: 0 },
      connect: (target: unknown) => gainConnects.push(target),
      disconnect: () => undefined,
    };
    const sourceConnects: unknown[] = [];
    const workletConnects: unknown[] = [];
    const workletPosts: unknown[] = [];

    class FakeAudioWorkletNode {
      connect(target: unknown) {
        workletConnects.push(target);
      }

      disconnect() {}

      port = {
        postMessage: (message: unknown) => workletPosts.push(message),
        close: () => undefined,
      };
    }

    const audioContext = {
      destination,
      createGain: () => wetGain,
      audioWorklet: { addModule: () => Promise.resolve() },
    } as unknown as AudioContext;
    const audioSource = {
      connect: (target: unknown) => sourceConnects.push(target),
      disconnect: () => undefined,
    } as unknown as MediaElementAudioSourceNode;

    const globals = globalThis as unknown as Record<string, unknown>;
    globals.AudioWorkletNode = FakeAudioWorkletNode;

    let published = 0;
    document.addEventListener('peard:audio-can-play', () => {
      published += 1;
    });

    // The announcement happens before the plugin module below is imported.
    central.publishAudioGraphReady({
      get audioContext() {
        counter.reads += 1;
        return audioContext;
      },
      get audioSource() {
        counter.reads += 1;
        return audioSource;
      },
    });
    expect(counter.reads).toBe(0);

    // Mid-song enable: the plugin is loaded only now, after the announcement.
    const { createSlowedReverbController } =
      await import('../plugins/player-actions/slowed-reverb/controller');
    const controller = createSlowedReverbController();
    const config: SlowedReverbConfig = {
      slow: 1,
      reverbIntensity: 0.5,
      active: true,
    };

    try {
      await controller.start({
        getConfig: () => Promise.resolve(config),
        setConfig: () => undefined,
      });
      while (controller.workletLoad) await controller.workletLoad;
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The controller read the cached snapshot instead of needing a second
      // publication: exactly one event was ever dispatched.
      expect(published).toBe(1);
      expect(counter.reads).toBeGreaterThan(0);
      expect(controller.audioContext).toBe(audioContext);
      expect(controller.audioSource).toBe(audioSource);
      expect(controller.wiredSource).toBe(audioSource);
      expect(controller.wetGain).not.toBeNull();

      // The real wet tap: source -> worklet -> wet gain -> destination.
      expect(controller.reverbNode).not.toBeNull();
      expect(sourceConnects).toEqual([controller.reverbNode]);
      expect(workletConnects).toEqual([controller.wetGain]);
      expect(gainConnects).toEqual([destination]);
      expect(workletPosts).toContainEqual(
        expect.objectContaining({ type: 'setParams' }),
      );
    } finally {
      controller.stop();
    }
  });

  test('later announcements replace the snapshot and notify subscribers', async () => {
    await createDom();
    const counter = { reads: 0 };

    const central = await import('./audio-graph-ready');
    const first = fakeDetail(counter);
    central.publishAudioGraphReady(first);

    const seen: AudioGraphReadyDetail[] = [];
    const unsubscribe = central.onAudioGraphReady((detail) => {
      seen.push(detail);
    });
    // A subscriber that arrives late receives the current snapshot immediately.
    expect(seen).toEqual([first]);

    const second = fakeDetail(counter);
    central.publishAudioGraphReady(second);
    expect(seen).toEqual([first, second]);
    expect(central.getAudioGraphReady()).toBe(second);

    unsubscribe();
    central.publishAudioGraphReady(first);
    expect(seen).toEqual([first, second]);
  });
});
