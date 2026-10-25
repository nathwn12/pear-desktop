import { expect, test } from '@playwright/test';

import { resolvePluginEnabled, type PluginConfig } from './plugins';

interface LoaderLog {
  calls: number;
}

const loader = (
  module: { default?: { config?: PluginConfig } } | undefined,
  log: LoaderLog,
) => {
  return () => {
    log.calls += 1;
    return Promise.resolve(module);
  };
};

test.describe('shared plugin enabled-state policy', () => {
  test('a stored true/false override wins over a known default', async () => {
    const log = { calls: 0 };

    expect(
      await resolvePluginEnabled(
        true,
        { enabled: false },
        loader(undefined, log),
      ),
    ).toBe(false);
    expect(
      await resolvePluginEnabled(
        false,
        { enabled: true },
        loader(undefined, log),
      ),
    ).toBe(true);
    // The override is decisive, so the plugin module is never loaded.
    expect(log.calls).toBe(0);
  });

  test('a known default is used when nothing is stored', async () => {
    const log = { calls: 0 };

    expect(
      await resolvePluginEnabled(true, undefined, loader(undefined, log)),
    ).toBe(true);
    expect(await resolvePluginEnabled(false, {}, loader(undefined, log))).toBe(
      false,
    );
    expect(log.calls).toBe(0);
  });

  test('an unknown default loads the plugin and reads its config', async () => {
    const log = { calls: 0 };

    expect(
      await resolvePluginEnabled(
        null,
        undefined,
        loader({ default: { config: { enabled: true } } }, log),
      ),
    ).toBe(true);
    expect(
      await resolvePluginEnabled(
        null,
        {},
        loader({ default: { config: { enabled: false } } }, log),
      ),
    ).toBe(false);
    expect(log.calls).toBe(2);
  });

  test('an unknown default with a stored override still skips the import', async () => {
    const log = { calls: 0 };

    expect(
      await resolvePluginEnabled(
        null,
        { enabled: true },
        loader(undefined, log),
      ),
    ).toBe(true);
    expect(
      await resolvePluginEnabled(
        null,
        { enabled: false },
        loader(undefined, log),
      ),
    ).toBe(false);
    expect(log.calls).toBe(0);
  });

  test('a plugin without a config, or no module at all, is disabled', async () => {
    const log = { calls: 0 };

    expect(
      await resolvePluginEnabled(null, undefined, loader({ default: {} }, log)),
    ).toBe(false);
    expect(
      await resolvePluginEnabled(null, undefined, loader(undefined, log)),
    ).toBe(false);
  });

  test('coerces a stored non-boolean to a boolean, like the old merge result', async () => {
    const log = { calls: 0 };
    const stored = { enabled: 1 } as unknown as PluginConfig;

    expect(
      await resolvePluginEnabled(null, stored, loader(undefined, log)),
    ).toBe(true);
    expect(log.calls).toBe(0);
  });

  test('a stored undefined counts as unset, like the merge it replaces', async () => {
    const log = { calls: 0 };
    const stored = { enabled: undefined } as unknown as PluginConfig;

    // The merge dropped undefined, so the default still decides.
    expect(
      await resolvePluginEnabled(true, stored, loader(undefined, log)),
    ).toBe(true);
    expect(
      await resolvePluginEnabled(
        null,
        stored,
        loader({ default: { config: { enabled: true } } }, log),
      ),
    ).toBe(true);
    expect(log.calls).toBe(1);
  });
});
