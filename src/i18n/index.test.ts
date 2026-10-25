import { registerHooks } from 'node:module';

import { expect, test } from '@playwright/test';
import i18next from 'i18next';

/**
 * `src/i18n/index.ts` reaches `virtual:i18n`, a build-time module. The hook
 * below serves a controllable stand-in so the real init/changeLanguage path runs
 * while the test decides which locale bundles exist and when they resolve.
 */
interface I18nStub {
  bundles: Record<string, Record<string, unknown>>;
  calls: string[];
  gates: Record<string, Promise<void>>;
}

const stub: I18nStub = { bundles: {}, calls: [], gates: {} };
(globalThis as unknown as { __i18nStub: I18nStub }).__i18nStub = stub;

const stubSource = `
const stub = globalThis.__i18nStub;
export const loadLanguage = async (code) => {
  stub.calls.push(code);
  const gate = stub.gates[code];
  if (gate) await gate;
  const bundle = stub.bundles[code];
  return bundle ? { [code]: { translation: bundle } } : null;
};
export const languageCodes = [];
export const languageMeta = {};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'virtual:i18n') {
      return {
        url: `data:text/javascript,${encodeURIComponent(stubSource)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const TITLE = 'main.dialog.need-to-restart.title';
const LOADED = 'main.console.i18n.loaded';

const bundles: Record<string, Record<string, unknown>> = {
  'be': {
    main: {
      dialog: { 'need-to-restart': { title: 'BE-TITLE' } },
      console: { i18n: { loaded: 'BE-LOADED' } },
    },
  },
  'be-Latn': {
    main: { console: { i18n: { loaded: 'LATN-LOADED' } } },
  },
  'en': {
    main: {
      dialog: { 'need-to-restart': { title: 'EN-TITLE' } },
      console: { i18n: { loaded: 'EN-LOADED' } },
    },
    only: { en: 'EN-ONLY' },
  },
};

const removeBundles = () => {
  // i18next installs the store API during init(), so a fresh instance has none.
  if (typeof i18next.hasResourceBundle !== 'function') return;

  for (const code of Object.keys(bundles)) {
    if (i18next.hasResourceBundle(code, 'translation')) {
      i18next.removeResourceBundle(code, 'translation');
    }
  }
};

test.beforeEach(() => {
  removeBundles();
  stub.bundles = bundles;
  stub.calls = [];
  stub.gates = {};
});

test.describe('locale fallback chain', () => {
  test('regional codes fall back through their parent locale to en', async () => {
    const { localeFallbackChain } = await import('./index');

    expect(localeFallbackChain('be-Latn')).toEqual(['be-Latn', 'be', 'en']);
    expect(localeFallbackChain('pt-BR')).toEqual(['pt-BR', 'pt', 'en']);
    expect(localeFallbackChain('zh-TW')).toEqual(['zh-TW', 'zh', 'en']);
    expect(localeFallbackChain('be')).toEqual(['be', 'en']);
    expect(localeFallbackChain('en')).toEqual(['en']);
  });

  test('a Belarusian regional lookup uses be, not English', async () => {
    const { loadI18n, setLanguage, t } = await import('./index');

    await loadI18n('be-Latn');
    await setLanguage('be-Latn');

    expect(i18next.language).toBe('be-Latn');
    // `be-Latn` has no such key, `be` does: the parent bundle must win over en.
    expect(t(TITLE)).toBe('BE-TITLE');
    // Keys present in the regional bundle still win over the parent.
    expect(t(LOADED)).toBe('LATN-LOADED');
    // English remains the last resort.
    expect(t('only.en')).toBe('EN-ONLY');
    expect(stub.calls).toEqual(expect.arrayContaining(['be-Latn', 'be', 'en']));
  });
});

test.describe('setLanguage completion', () => {
  test('awaits the parent bundle before changeLanguage resolves', async () => {
    const { loadI18n, setLanguage, t } = await import('./index');
    await loadI18n('en');

    let release!: () => void;
    stub.gates.be = new Promise<void>((resolve) => {
      release = resolve;
    });

    const switching = setLanguage('be-Latn');
    await Promise.resolve();
    expect(i18next.hasResourceBundle('be', 'translation')).toBe(false);
    expect(t(TITLE)).toBe('EN-TITLE');

    release();
    await switching;

    expect(i18next.hasResourceBundle('be', 'translation')).toBe(true);
    expect(t(TITLE)).toBe('BE-TITLE');
  });

  test('applyLanguage finishes loading before refreshing translated UI', async () => {
    const { applyLanguage, loadI18n } = await import('./index');
    await loadI18n('en');

    const seen: { language: string; title: string }[] = [];
    await applyLanguage('be-Latn', () => {
      seen.push({
        language: i18next.language,
        title: i18next.t(TITLE),
      });
    });

    expect(seen).toEqual([{ language: 'be-Latn', title: 'BE-TITLE' }]);
  });

  test('a refresh callback is not reached when loading fails', async () => {
    const { applyLanguage, loadI18n } = await import('./index');
    await loadI18n('en');

    stub.gates.be = Promise.reject(new Error('bundle unavailable'));
    let refreshed = false;

    await expect(
      applyLanguage('be-Latn', () => {
        refreshed = true;
      }),
    ).rejects.toThrow('bundle unavailable');
    expect(refreshed).toBe(false);
  });
});
