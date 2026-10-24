import { createRenderer } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { disposeReactiveRoot } from './reactive-root';
import { setConfig, setCurrentTime } from './renderer';
import { fetchLyrics } from './store';
import { selectors, tabStates } from './utils';

import type { SyncedLyricsPluginConfig } from '../types';
import type { SongInfo } from '@/providers/song-info';
import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

export let _ytAPI: MusicPlayer | null = null;
export let netFetch: (
  url: string,
  init?: RequestInit,
) => Promise<[number, string, Record<string, string>]>;

/**
 * The player API and the exact listener handed to `addEventListener`, kept in
 * module scope: `startPlugin` rebinds every function-valued property on the
 * plugin object, so a property here would not be the identity that was
 * registered and `stop` could never unregister it.
 */
let videoDataChangeApi: MusicPlayer | undefined;
let videoDataChangeListener: (() => Promise<void>) | undefined;

export const renderer = createRenderer<
  {
    observerCallback: MutationCallback;
    observer?: MutationObserver;
    videoDataChange: () => Promise<void>;
    updateTimestampInterval?: NodeJS.Timeout | string | number;
    /** Set by `stop`, cleared by `start`/`onPlayerApiReady`: a stopped plugin never polls. */
    stopped: boolean;
  },
  SyncedLyricsPluginConfig
>({
  stopped: false,

  onConfigChange(newConfig) {
    setConfig(newConfig);
  },

  observerCallback(mutations: MutationRecord[]) {
    for (const mutation of mutations) {
      const header = mutation.target as HTMLElement;

      switch (mutation.attributeName) {
        case 'disabled':
          header.removeAttribute('disabled');
          break;
        case 'aria-selected':
          tabStates[header.ariaSelected ?? 'false']();
          break;
      }
    }
  },

  async onPlayerApiReady(api: MusicPlayer) {
    _ytAPI = api;
    this.stopped = false;

    // Re-enable and re-initialisation must own exactly one registration.
    if (videoDataChangeApi && videoDataChangeListener) {
      videoDataChangeApi.removeEventListener(
        'videodatachange',
        videoDataChangeListener,
      );
    }

    videoDataChangeApi = api;
    videoDataChangeListener = this.videoDataChange.bind(this);
    api.addEventListener('videodatachange', videoDataChangeListener);

    await this.videoDataChange();
  },
  async videoDataChange() {
    // The plugin object outlives `stop` (module singleton), so a late or
    // still-registered callback must not revive the polling interval.
    if (this.stopped) return;

    if (!this.updateTimestampInterval) {
      this.updateTimestampInterval = setInterval(
        () => setCurrentTime((_ytAPI?.getCurrentTime() ?? 0) * 1000),
        100,
      );
    }

    // prettier-ignore
    this.observer ??= new MutationObserver(this.observerCallback);
    this.observer.disconnect();

    // Force the lyrics tab to be enabled at all times.
    const header = await waitForElement<HTMLElement>(selectors.head);
    {
      header.removeAttribute('disabled');
      tabStates[header.ariaSelected ?? 'false']();
    }

    this.observer.observe(header, { attributes: true });
    header.removeAttribute('disabled');
  },

  async start(ctx: RendererContext<SyncedLyricsPluginConfig>) {
    this.stopped = false;
    netFetch = ctx.ipc.invoke.bind(ctx.ipc, 'synced-lyrics:fetch');

    setConfig(await ctx.getConfig());

    ctx.ipc.on('peard:update-song-info', (info: SongInfo) => {
      fetchLyrics(info);
    });
  },

  stop() {
    this.stopped = true;

    if (videoDataChangeApi && videoDataChangeListener) {
      videoDataChangeApi.removeEventListener(
        'videodatachange',
        videoDataChangeListener,
      );
    }

    videoDataChangeApi = undefined;
    videoDataChangeListener = undefined;

    if (this.updateTimestampInterval) {
      clearInterval(this.updateTimestampInterval);
      this.updateTimestampInterval = undefined;
    }

    disposeReactiveRoot();
  },
});
