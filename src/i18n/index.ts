import i18next, { init, t as i18t, changeLanguage } from 'i18next';
import { loadLanguage } from 'virtual:i18n';

import type { LanguageResources } from './resources/@types';

export const APPLICATION_NAME =
  '\u0059\u006f\u0075\u0054\u0075\u0062\u0065\u0020\u004d\u0075\u0073\u0069\u0063';

/**
 * Locale codes to load for `language`, most specific first.
 *
 * i18next resolves a missing key through the locale hierarchy
 * (`be-Latn` -> `be`), but only for bundles that are actually loaded. Loading
 * just `be-Latn` would therefore fall straight through to `en`, which is a
 * regression from the previous "load every locale" behaviour.
 */
export const localeFallbackChain = (language: string): string[] => {
  const chain: string[] = [];
  const seen = new Set<string>();
  const push = (code: string) => {
    const normalized = code.trim();
    const identity = normalized.toLowerCase();
    if (!normalized || seen.has(identity)) return;
    seen.add(identity);
    chain.push(normalized);
  };

  let code = language ?? '';
  while (code.includes('-')) {
    push(code);
    code = code.slice(0, code.lastIndexOf('-'));
  }
  push(code);
  push('en');

  return chain;
};

const loadBundles = async (language: string): Promise<LanguageResources> => {
  const bundles = await Promise.all(
    localeFallbackChain(language).map((code) => loadLanguage(code)),
  );

  const resources: LanguageResources = {};
  for (const bundle of bundles) {
    if (bundle) Object.assign(resources, bundle);
  }

  return resources;
};

/**
 * Loads the requested locale plus its parent locales and the `en` fallback.
 * `lng` stays `en` so that missing keys fall back exactly like the previous
 * "load every locale" behaviour; call `setLanguage` with the configured
 * language afterwards.
 */
export const loadI18n = async (language: string = 'en') =>
  await init({
    resources: await loadBundles(language),
    lng: 'en',
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false,
    },
  });

/** Adds every bundle in the locale's fallback chain, awaited before switching. */
const ensureLanguageBundles = async (language: string) => {
  await Promise.all(
    localeFallbackChain(language).map(async (code) => {
      if (i18next.hasResourceBundle(code, 'translation')) return;

      const resources = await loadLanguage(code);
      const translation = resources?.[code]?.translation;
      if (translation) {
        i18next.addResourceBundle(
          code,
          'translation',
          translation,
          true,
          false,
        );
      }
    }),
  );
};

export const setLanguage = async (language: string) => {
  await ensureLanguageBundles(language);
  await changeLanguage(language);
};

/**
 * Switches language and only then rebuilds UI that renders translated labels
 * (the application menu). Refresh callbacks must never see a half-loaded
 * language, which is what happened when `setLanguage` was not awaited.
 */
export const applyLanguage = async (
  language: string,
  refresh: () => void | Promise<void>,
) => {
  await setLanguage(language);
  await refresh();
};

export const t = i18t.bind(i18next);
