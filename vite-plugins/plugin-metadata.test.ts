import { expect, test } from '@playwright/test';
import { Project } from 'ts-morph';

import { readPluginMetadata } from './plugin-metadata';

/**
 * The build-time reader decides `enabled` without importing the plugin. These
 * cases pin JavaScript object-literal semantics: properties apply in order, a
 * later spread overwrites an earlier explicit property, and anything that
 * cannot be resolved statically must yield `null` (runtime fallback) instead of
 * a guessed `false`.
 */
const readEnabled = (source: string): boolean | null => {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
  });
  const file = project.createSourceFile('/virtual/plugin.ts', source, {
    overwrite: true,
  });

  return readPluginMetadata(file)?.enabled ?? null;
};

const wrap = (configBody: string) =>
  `import { createPlugin } from './utils';
export default createPlugin({ config: ${configBody} });`;

test.describe('plugin default enabled resolution', () => {
  test('an explicit property is used when it is the last assignment', () => {
    expect(readEnabled(wrap('{ enabled: false }'))).toBe(false);
    expect(readEnabled(wrap('{ enabled: true }'))).toBe(true);
  });

  test('a later spread overrides an earlier explicit property', () => {
    expect(readEnabled(wrap('{ enabled: false, ...{ enabled: true } }'))).toBe(
      true,
    );
  });

  test('an explicit property overrides an earlier spread', () => {
    expect(readEnabled(wrap('{ ...{ enabled: true }, enabled: false }'))).toBe(
      false,
    );
  });

  test('the last of three ordered assignments wins', () => {
    expect(
      readEnabled(
        wrap('{ enabled: false, ...{ enabled: true }, enabled: false }'),
      ),
    ).toBe(false);
    expect(
      readEnabled(
        wrap('{ enabled: true, ...{ enabled: false }, enabled: true }'),
      ),
    ).toBe(true);
  });

  test('a later spread without the property does not override it', () => {
    expect(readEnabled(wrap('{ enabled: true, ...{ slow: 1 } }'))).toBe(true);
  });

  test('a resolvable identifier spread is followed', () => {
    expect(
      readEnabled(`const DEFAULT = { enabled: true };
export default createPlugin({ config: { enabled: false, ...DEFAULT } });`),
    ).toBe(true);
  });

  test('an unresolved spread makes the value unknown', () => {
    expect(
      readEnabled(wrap('{ enabled: false, ...unknownConfig }')),
    ).toBeNull();
    expect(
      readEnabled(wrap('{ ...{ enabled: true }, ...unknownConfig }')),
    ).toBeNull();
    expect(
      readEnabled(wrap('{ enabled: false, ...{ ...unknownInner } }')),
    ).toBeNull();
  });

  test('a computed key after the last explicit property makes the value unknown', () => {
    expect(readEnabled(wrap('{ enabled: false, [key]: true }'))).toBeNull();
    expect(readEnabled(wrap('{ [key]: false }'))).toBeNull();
  });

  test('a computed key before the last explicit property is overridden', () => {
    expect(readEnabled(wrap('{ [key]: true, enabled: false }'))).toBe(false);
  });

  test('a statically known computed key is read like a plain property', () => {
    expect(readEnabled(wrap("{ ['enabled']: false }"))).toBe(false);
    expect(readEnabled(wrap("{ enabled: false, ['enabled']: true }"))).toBe(
      true,
    );
  });

  test('a spread containing a computed key after the last assignment is unknown', () => {
    expect(
      readEnabled(wrap('{ enabled: true, ...{ [key]: false } }')),
    ).toBeNull();
  });

  test('a config without enabled defaults to disabled', () => {
    expect(readEnabled(wrap('{}'))).toBe(false);
    expect(readEnabled(wrap('{ slow: 1 }'))).toBe(false);
  });

  test('an unresolvable config object is unknown', () => {
    expect(readEnabled(wrap('configObject'))).toBeNull();
  });
});
