import { debounce } from '@/providers/decorators';

import { type PreciseVolumePluginConfig } from './index';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';

function $<E extends Element = Element>(selector: string) {
  return document.querySelector<E>(selector);
}

let api: MusicPlayer;

export const moveVolumeHud = debounce((showVideo: boolean) => {
  const volumeHud = $<HTMLElement>('#volumeHud');
  if (!volumeHud) {
    return;
  }

  volumeHud.style.top = showVideo
    ? `${($('ytmusic-player')!.clientHeight - $('video')!.clientHeight) / 2}px`
    : '0';
}, 250);

let options: PreciseVolumePluginConfig;

/**
 * Everything the current activation registered. `onPlayerApiReady` empties it
 * before registering, and `onUnload` empties it when the plugin is disabled:
 * a stopped plugin owns no listener, observer or injected node, and a re-enable
 * owns exactly one set.
 */
let disposers: (() => void)[] = [];

/**
 * Bumped by every activation and every stop. Initialisation awaits (config,
 * the video-toggle probe) can resolve after the plugin was stopped or
 * re-enabled, so each continuation checks it is still the live activation
 * before registering anything.
 */
let generation = 0;

const listen = <E extends Event>(
  target: EventTarget,
  type: string,
  listener: (event: E) => void,
) => {
  target.addEventListener(type, listener as EventListener);
  disposers.push(() =>
    target.removeEventListener(type, listener as EventListener),
  );
};

/** Tear down the current activation; safe to call when nothing is registered. */
export const onUnload = () => {
  generation += 1;

  const pending = disposers;
  disposers = [];

  for (const dispose of pending) {
    dispose();
  }
};

export const onPlayerApiReady = async (
  playerApi: MusicPlayer,
  context: RendererContext<PreciseVolumePluginConfig>,
) => {
  // Re-init owns exactly one set of registrations, not one more than before.
  onUnload();
  const activation = generation;

  const config = await context.getConfig();
  // A stop during getConfig abandons this attempt: no config, no api, no
  // registration, so the plugin stays fully unloaded.
  if (activation !== generation) {
    return;
  }
  options = config;
  api = playerApi;

  // Without this function it would rewrite config 20 time when volume change by 20
  const writeOptions = debounce(() => {
    context.setConfig(options);
  }, 1000);

  const hideVolumeHud = debounce((volumeHud: HTMLElement) => {
    volumeHud.style.opacity = '0';
  }, 2000);

  const hideVolumeSlider = debounce((slider: HTMLElement) => {
    slider.classList.remove('on-hover');
  }, 2500);

  /** Restore saved volume and setup tooltip */
  async function firstRun() {
    if (typeof options.savedVolume === 'number') {
      // Set saved volume as tooltip
      setTooltip(options.savedVolume);

      if (api.getVolume() !== options.savedVolume) {
        setVolume(options.savedVolume);
      }
    }

    setupPlaybar();

    setupLocalArrowShortcuts();

    // Workaround: computedStyleMap().get(string) returns CSSKeywordValue instead of CSSStyleValue
    const noVid =
      ($('#main-panel')?.computedStyleMap().get('display') as CSSKeywordValue)
        ?.value === 'none';
    injectVolumeHud(noVid);
    disposers.push(() => {
      $('#volumeHud')?.remove();
    });
    if (!noVid) {
      setupVideoPlayerOnwheel();
      const videoToggleEnabled =
        await window.mainConfig.plugins.isEnabled('video-toggle');
      // A stop during the probe abandons the rest of this activation.
      if (activation !== generation) {
        return;
      }
      if (!videoToggleEnabled) {
        // Video-toggle handles hud positioning on its own
        const videoMode = () =>
          api.getPlayerResponse().videoDetails?.musicVideoType !==
          'MUSIC_VIDEO_TYPE_ATV';
        const video = $('video');
        if (video) {
          listen(video, 'peard:src-changed', () => moveVolumeHud(videoMode()));
        }
      }
    }
  }

  function injectVolumeHud(noVid: boolean) {
    if (noVid) {
      const position = 'top: 18px; right: 60px;';
      const mainStyle = 'font-size: xx-large;';

      $('.center-content.ytmusic-nav-bar')?.insertAdjacentHTML(
        'beforeend',
        `<span id="volumeHud" style="${position + mainStyle}"></span>`,
      );
    } else {
      const position = 'top: 10px; left: 10px;';
      const mainStyle =
        'font-size: xxx-large; webkit-text-stroke: 1px black; font-weight: 600;';

      $('#song-video')?.insertAdjacentHTML(
        'afterend',
        `<span id="volumeHud" style="${position + mainStyle}"></span>`,
      );
    }
  }

  function showVolumeHud(volume: number) {
    const volumeHud = $<HTMLElement>('#volumeHud');
    if (!volumeHud) {
      return;
    }

    volumeHud.textContent = `${volume}%`;
    volumeHud.style.opacity = '1';

    hideVolumeHud(volumeHud);
  }

  /** Add onwheel event to video player */
  function setupVideoPlayerOnwheel() {
    const panel = $<HTMLElement>('#main-panel');
    if (!panel) return;

    listen<WheelEvent>(panel, 'wheel', (event) => {
      event.preventDefault();
      // Event.deltaY < 0 means wheel-up
      changeVolume(event.deltaY < 0);
    });
  }

  function saveVolume(volume: number) {
    options.savedVolume = volume;
    writeOptions();
  }

  /** Add onwheel event to play bar and also track if play bar is hovered */
  function setupPlaybar() {
    const playerbar = $<HTMLElement>('ytmusic-player-bar');
    if (!playerbar) return;

    listen<WheelEvent>(playerbar, 'wheel', (event) => {
      event.preventDefault();
      // Event.deltaY < 0 means wheel-up
      changeVolume(event.deltaY < 0);
    });

    // Keep track of mouse position for showVolumeSlider()
    listen(playerbar, 'mouseenter', () => {
      playerbar.classList.add('on-hover');
    });

    listen(playerbar, 'mouseleave', () => {
      playerbar.classList.remove('on-hover');
    });

    setupSliderObserver();
  }

  /** Save volume + Update the volume tooltip when volume-slider is manually changed */
  function setupSliderObserver() {
    const sliderObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.target.nodeName === 'TP-YT-PAPER-SLIDER') {
          // This checks that volume-slider was manually set
          const target = mutation.target as HTMLInputElement;
          const targetValueNumeric = Number(target.value);
          if (
            mutation.oldValue !== target.value &&
            (typeof options.savedVolume !== 'number' ||
              Math.abs(options.savedVolume - targetValueNumeric) > 4)
          ) {
            // Diff>4 means it was manually set
            setTooltip(targetValueNumeric);
            saveVolume(targetValueNumeric);
          }
        }
      }
    });

    const slider = $('#volume-slider');
    if (!slider) return;

    // Observing only changes in 'value' of volume-slider
    sliderObserver.observe(slider, {
      attributeFilter: ['value'],
      attributeOldValue: true,
    });
    disposers.push(() => sliderObserver.disconnect());
  }

  function setVolume(value: number) {
    api.setVolume(value);
    // Save the new volume
    saveVolume(value);

    // Change slider position (important)
    updateVolumeSlider();

    // Change tooltips to new value
    setTooltip(value);
    // Show volume slider
    showVolumeSlider();
    // Show volume HUD
    showVolumeHud(value);
  }

  /** If (toIncrease = false) then volume decrease */
  function changeVolume(toIncrease: boolean) {
    // Apply volume change if valid
    const steps = Number(options.steps || 1);
    setVolume(
      toIncrease
        ? Math.min(api.getVolume() + steps, 100)
        : Math.max(api.getVolume() - steps, 0),
    );
  }

  function updateVolumeSlider() {
    const savedVolume = options.savedVolume ?? 0;
    // Slider value automatically rounds to multiples of 5
    for (const slider of ['#volume-slider', '#expand-volume-slider']) {
      const silderElement = $<HTMLInputElement>(slider);
      if (silderElement) {
        silderElement.value = String(
          savedVolume > 0 && savedVolume < 5 ? 5 : savedVolume,
        );
      }
    }
  }

  function showVolumeSlider() {
    const slider = $<HTMLElement>('#volume-slider');
    if (!slider) return;

    // This class display the volume slider if not in minimized mode
    slider.classList.add('on-hover');

    hideVolumeSlider(slider);
  }

  // Set new volume as tooltip for volume slider and icon + expanding slider (appears when window size is small)
  const tooltipTargets = [
    '#volume-slider',
    'tp-yt-paper-icon-button.volume',
    '#expand-volume-slider',
    '#expand-volume',
  ];

  function setTooltip(volume: number) {
    for (const target of tooltipTargets) {
      const tooltipTargetElement = $<HTMLElement>(target);
      if (tooltipTargetElement) {
        tooltipTargetElement.title = `${volume}%`;
      }
    }
  }

  function setupLocalArrowShortcuts() {
    if (options.arrowsShortcut) {
      listen<KeyboardEvent>(window, 'keydown', (event) => {
        if (
          $<HTMLElement & { opened: boolean }>('ytmusic-search-box')?.opened
        ) {
          return;
        }

        switch (event.code) {
          case 'ArrowUp': {
            event.preventDefault();
            changeVolume(true);
            break;
          }

          case 'ArrowDown': {
            event.preventDefault();
            changeVolume(false);
            break;
          }
        }
      });
    }
  }

  context.ipc.on('changeVolume', (toIncrease: boolean) =>
    changeVolume(toIncrease),
  );
  context.ipc.on('setVolume', (value: number) => setVolume(value));
  disposers.push(() => {
    context.ipc.removeAllListeners('changeVolume');
    context.ipc.removeAllListeners('setVolume');
  });

  await firstRun();
};

export const onConfigChange = (config: PreciseVolumePluginConfig) => {
  options = config;
};
