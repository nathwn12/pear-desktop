import { expect, test } from '@playwright/test';

import { injectRendererScript } from './renderer-script';

const script = { path: 'file:///renderer/index.js', script: 'console.log(1);' };

const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test.describe('renderer script injection', () => {
  test('awaits the isolated-world promise and reports it was used', async () => {
    const settled = deferred();
    const calls: string[] = [];

    const result = injectRendererScript(
      {
        executeInIsolatedWorld: (worldId, payload) => {
          calls.push(`isolated:${worldId}:${payload.url}`);
          return settled.promise;
        },
        executeJavaScript: () => {
          calls.push('default');
          return Promise.resolve();
        },
      },
      script,
      { timeoutMs: 1_000 },
    );

    // Not resolved until the returned promise settles: the old callback-only
    // wiring could return here and leave the preload ordering barrier open.
    await Promise.resolve();
    expect(calls).toEqual(['isolated:0:file:///renderer/index.js']);

    settled.resolve('done');
    await expect(result).resolves.toBe('isolated');
  });

  test('uses the plain executor when there is no script path', async () => {
    const result = injectRendererScript(
      {
        executeInIsolatedWorld: () => {
          throw new Error('isolated world must not be used');
        },
        executeJavaScript: (code) => Promise.resolve(`ran:${code}`),
      },
      { path: null, script: 'x()' },
      { timeoutMs: 1_000 },
    );

    await expect(result).resolves.toBe('default');
  });

  test('propagates an async rejection from the executor', async () => {
    const result = injectRendererScript(
      {
        executeInIsolatedWorld: () => Promise.reject(new Error('boom')),
        executeJavaScript: () => Promise.resolve(undefined),
      },
      script,
      { timeoutMs: 1_000 },
    );

    await expect(result).rejects.toThrow('boom');
  });

  test('propagates a synchronous throw from the executor', async () => {
    const result = injectRendererScript(
      {
        executeInIsolatedWorld: () => {
          throw new Error('sync boom');
        },
        executeJavaScript: () => Promise.resolve(undefined),
      },
      script,
      { timeoutMs: 1_000 },
    );

    await expect(result).rejects.toThrow('sync boom');
  });

  test('rejects with a bounded timeout instead of hanging forever', async () => {
    const started = Date.now();
    const result = injectRendererScript(
      {
        executeInIsolatedWorld: () => new Promise(() => {}),
        executeJavaScript: () => Promise.resolve(undefined),
      },
      script,
      { timeoutMs: 30 },
    );

    await expect(result).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
