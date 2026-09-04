import { t } from '@/i18n';
import { createPlugin } from '@/utils';

import style from './style.css?inline';

const BODY_CLASS = 'show-volume-slider';
const SLIDER_SELECTORS = ['#volume-slider', '#expand-volume-slider'];

let observer: MutationObserver | null = null;

const keepSlidersVisible = () => {
  for (const selector of SLIDER_SELECTORS) {
    document.querySelector(selector)?.classList.add('on-hover');
  }
};

export default createPlugin({
  name: () => t('plugins.show-volume-slider.name'),
  description: () => t('plugins.show-volume-slider.description'),
  restartNeeded: false,
  config: {
    enabled: false,
  },
  stylesheets: [style],
  renderer: {
    start: () => {
      document.body.classList.add(BODY_CLASS);
      keepSlidersVisible();

      observer = new MutationObserver(keepSlidersVisible);
      observer.observe(
        document.querySelector('ytmusic-player-bar') ?? document.body,
        {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        },
      );
    },
    stop: () => {
      observer?.disconnect();
      observer = null;
      document.body.classList.remove(BODY_CLASS);
      for (const selector of SLIDER_SELECTORS) {
        document.querySelector(selector)?.classList.remove('on-hover');
      }
    },
  },
});
