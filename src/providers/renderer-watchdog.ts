/**
 * Renderer health policy.
 *
 * A renderer that is merely using a lot of memory is never reloaded by the app.
 * A reload discards the queue, scroll position and playback state, nothing here
 * can observe or restore them, and pausing is not consent: a high working set
 * is not evidence that the renderer is degraded, and the owner's position is
 * that resources are cheap. There is therefore no memory sampler, no memory
 * limit and no reload hook in this module.
 *
 * `unresponsive` and `render-process-gone` only report. The existing dialog
 * offers wait / relaunch / quit, so restarting is always the user's explicit
 * choice; one report per renderer generation keeps it from reopening while the
 * current page is unchanged.
 */
export interface RendererWatchdogDeps {
  /** Opens/keeps the existing unresponsive dialog. */
  notifyUnresponsive: () => void;
  log?: (message: string) => void;
}

export interface RendererWatchdog {
  /** Reports a stuck renderer; never reloads. */
  handleUnresponsive: () => void;
  /** Call on `did-finish-load`: allows the next report to open the dialog. */
  markRendererGeneration: () => void;
}

export const createRendererWatchdog = (
  deps: RendererWatchdogDeps,
): RendererWatchdog => {
  const log = deps.log ?? (() => undefined);
  let notified = false;

  return {
    handleUnresponsive() {
      log(
        'renderer unresponsive: state cannot be preserved across a reload, leaving recovery to the dialog',
      );
      if (notified) return;
      notified = true;
      deps.notifyUnresponsive();
    },

    markRendererGeneration() {
      notified = false;
    },
  };
};
