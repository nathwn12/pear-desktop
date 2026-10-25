/**
 * Central audio readiness snapshot.
 *
 * Plugin modules are imported lazily, so a plugin enabled mid-song is loaded
 * *after* the app announced that the shared audio graph is ready (and after
 * `peard:audio-can-play` fired for the current video). A module-scope listener
 * inside the plugin therefore never runs in time and the plugin misses the
 * graph for the rest of the song.
 *
 * This module lives in the app's startup graph: it records the latest
 * announcement and replays it to any subscriber, so a newly loaded plugin can
 * always observe the existing graph without changing when the graph is built.
 */
export interface AudioGraphReadyDetail {
  audioContext: AudioContext;
  audioSource: MediaElementAudioSourceNode;
}

export const AUDIO_GRAPH_READY_EVENT = 'peard:audio-can-play';

let latest: AudioGraphReadyDetail | null = null;
const listeners = new Set<(detail: AudioGraphReadyDetail) => void>();

/** Records the announcement, re-dispatches the DOM event, notifies subscribers. */
export const publishAudioGraphReady = (detail: AudioGraphReadyDetail): void => {
  latest = detail;

  // Kept for existing document-level listeners (the plugin's audio handler and
  // any user plugin that listens for the event on future videos).
  document.dispatchEvent(new CustomEvent(AUDIO_GRAPH_READY_EVENT, { detail }));

  for (const listener of [...listeners]) {
    listener(detail);
  }
};

/** The most recent announcement, replayable at any time. */
export const getAudioGraphReady = (): AudioGraphReadyDetail | null => latest;

/**
 * Subscribes to announcements, replaying the current snapshot immediately when
 * one already exists. Returns an unsubscribe function.
 */
export const onAudioGraphReady = (
  listener: (detail: AudioGraphReadyDetail) => void,
): (() => void) => {
  listeners.add(listener);
  if (latest) listener(latest);

  return () => {
    listeners.delete(listener);
  };
};
