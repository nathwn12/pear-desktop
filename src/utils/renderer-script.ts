/**
 * Injects the renderer IIFE into the page from the preload script.
 *
 * The previous implementation fire-and-forget the `webFrame.executeJavaScript*`
 * callback: a rejected execution was silent and a callback that never fired
 * left the preload waiting on a busy-spin flag. Both entry points also return a
 * promise, so completion is awaited here with a bounded timeout instead.
 */
export interface RendererScriptTarget {
  /** File URL the script runs under, or `null` for the page's main world. */
  path: string | null;
  script: string;
}

export interface RendererScriptExecutors {
  executeInIsolatedWorld: (
    worldId: number,
    script: { code: string; url: string },
  ) => Promise<unknown>;
  executeJavaScript: (code: string) => Promise<unknown>;
}

export const DEFAULT_RENDERER_SCRIPT_TIMEOUT_MS = 15_000;

/** Rejects once `timeoutMs` elapses; the underlying work cannot be cancelled. */
export const withTimeout = async <T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export const injectRendererScript = async (
  executors: RendererScriptExecutors,
  target: RendererScriptTarget,
  options: { timeoutMs?: number } = {},
): Promise<'isolated' | 'default'> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RENDERER_SCRIPT_TIMEOUT_MS;

  // Called synchronously so the script starts executing in the same turn the
  // preload reaches this point, exactly like the previous callback form.
  const work = target.path
    ? executors.executeInIsolatedWorld(0, {
        code: target.script,
        url: target.path,
      })
    : executors.executeJavaScript(target.script);

  await withTimeout(
    Promise.resolve(work),
    timeoutMs,
    'renderer script execution',
  );

  return target.path ? 'isolated' : 'default';
};
