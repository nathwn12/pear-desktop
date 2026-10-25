/**
 * The inert `virtual:i18n` contract shared by the headless renderer tests.
 *
 * `virtual:i18n` is a build-time module, so any test that loads a renderer entry
 * outside Vite has to answer it at the loader boundary. `virtualI18nStub` points
 * that answer at this file, so the three exports the app graph reaches are stated
 * once instead of pasted into every `registerHooks` block.
 *
 * Nothing here reads a locale bundle: these tests assert wiring, never
 * translation, so every export is inert.
 */
export const loadLanguage = () => Promise.resolve(null);
export const languageCodes: string[] = [];
export const languageMeta = {};

/** Loader-hook resolution that serves this module for `virtual:i18n`. */
export const virtualI18nStub = {
  shortCircuit: true,
  url: import.meta.url,
} as const;
