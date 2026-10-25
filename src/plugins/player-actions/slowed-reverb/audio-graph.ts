import {
  getAudioGraphReady,
  type AudioGraphReadyDetail,
} from '@/providers/audio-graph-ready';

export type AudioCanPlayDetail = AudioGraphReadyDetail;

/**
 * The app's latest audio-graph announcement.
 *
 * The snapshot lives in the app (`@/providers/audio-graph-ready`), not in this
 * module: plugin modules are imported lazily, so a listener registered here
 * would miss the announcement that fired before the plugin was enabled
 * mid-song. Reading the central snapshot works whenever the plugin loads.
 */
export function getLatestAudioDetail(): AudioCanPlayDetail | null {
  return getAudioGraphReady();
}
