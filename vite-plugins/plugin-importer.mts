import { readFileSync } from 'node:fs';
import { basename, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { globSync } from 'glob';
import { Project } from 'ts-morph';

import { readPluginMetadata, type PluginMetadata } from './plugin-metadata';

// HACK: DO NOT USE @ ALIAS IN THIS FILE, IT WILL CAUSE PROBLEMS
import { Platform } from '../src/types/plugins';

const kebabToCamel = (text: string) =>
  text.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase());

const __dirname = dirname(fileURLToPath(import.meta.url));
const globalProject = new Project({
  tsConfigFilePath: resolve(__dirname, '..', 'tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
  skipLoadingLibFiles: true,
  skipFileDependencyResolution: true,
});

const serialize = (value: unknown) => JSON.stringify(value);

export const pluginVirtualModuleGenerator = (
  mode: 'main' | 'preload' | 'renderer',
) => {
  const srcPath = resolve(__dirname, '..', 'src');
  const plugins = globSync([
    'src/plugins/*/index.{js,ts,jsx,tsx}',
    'src/plugins/*.{js,ts,jsx,tsx}',
    '!src/plugins/utils/**/*',
    '!src/plugins/utils/*',
  ]).map((path) => {
    let name = basename(path);
    if (
      name === 'index.ts' ||
      name === 'index.js' ||
      name === 'index.jsx' ||
      name === 'index.tsx'
    ) {
      name = basename(resolve(path, '..'));
    }

    name = name.replace(extname(name), '');

    return { name, path };
  });

  const metadata: Record<string, PluginMetadata> = {};
  for (const { name, path } of plugins) {
    const absolutePath = resolve(srcPath, '..', path).replace(/\\/g, '/');
    const sourceFile =
      globalProject.addSourceFileAtPathIfExists(absolutePath) ??
      globalProject.createSourceFile(
        absolutePath,
        readFileSync(absolutePath, 'utf8'),
        {
          overwrite: true,
        },
      );

    const pluginMetadata = readPluginMetadata(sourceFile);
    if (!pluginMetadata) {
      // Unknown shape: stay lazy-safe by deferring every decision to the module
      // itself (the loaders then import it and apply the runtime checks).
      console.warn(
        `[plugin-importer] could not read the plugin definition of ${path}; falling back to runtime resolution`,
      );
      metadata[name] = {
        backend: true,
        preload: true,
        renderer: true,
        platform: null,
        platformResolved: false,
        enabled: null,
      };
      continue;
    }

    metadata[name] = pluginMetadata;
  }

  const src = globalProject.createSourceFile(
    'vm:pluginIndexes',
    (writer) => {
      if (mode === 'main' || mode === 'preload') {
        writer.writeLine("import is from 'electron-is';");
        writer.writeLine('globalThis.electronIs = is;');
        writer.blankLine();
      }

      writer.writeLine(`export const pluginMeta = ${serialize(metadata)};`);
      writer.writeLine(
        `export const pluginIds = ${serialize(plugins.map(({ name }) => name))};`,
      );
      writer.blankLine();

      // Emitted as plain JavaScript (the virtual module is parsed as JS).
      writer.writeLine('function supportsPlatform({ platform }) {');
      writer.writeLine("  if (typeof platform !== 'number') return true;");
      writer.writeLine('  const is = globalThis.electronIs;');
      writer.writeLine(
        `  if (is.windows()) return (platform & ${Platform.Windows}) !== 0;`,
      );
      writer.writeLine(
        `  if (is.macOS()) return (platform & ${Platform.macOS}) !== 0;`,
      );
      writer.writeLine(
        `  if (is.linux()) return (platform & ${Platform.Linux}) !== 0;`,
      );
      writer.writeLine(
        `  if (is.freebsd()) return (platform & ${Platform.Freebsd}) !== 0;`,
      );
      writer.writeLine('');
      writer.writeLine('  // unknown platform');
      writer.writeLine('  return false;');
      writer.writeLine('}');
      writer.blankLine();
      writer.writeLine('export const isPluginSupported = supportsPlatform;');
      writer.blankLine();

      writer.writeLine('export const pluginIdsFor = (kind) =>');
      writer.writeLine('  pluginIds.filter((id) => {');
      writer.writeLine('    const meta = pluginMeta[id];');
      writer.writeLine('    if (!meta || !meta[kind]) return false;');
      writer.writeLine('    return meta.platformResolved');
      writer.writeLine('      ? isPluginSupported(meta)');
      writer.writeLine('      : true;');
      writer.writeLine('  });');
      writer.blankLine();

      // Per-plugin importers, keyed by id so a plugin can be loaded on its own.
      if (mode === 'main' || mode === 'renderer') {
        writer.writeLine('const pluginImporters = {');
        for (const { name, path } of plugins) {
          const absolutePath = resolve(srcPath, '..', path).replace(/\\/g, '/');
          writer.writeLine(`  "${name}": () => import('${absolutePath}'),`);
        }
        writer.writeLine('};');
      } else {
        // preload does not support dynamic import, so reuse the static imports
        for (const { name, path } of plugins) {
          const absolutePath = resolve(srcPath, '..', path).replace(/\\/g, '/');
          writer.writeLine(
            `import ${kebabToCamel(name)}PluginImport, { pluginStub as ${kebabToCamel(name)}PluginStubImport } from "${absolutePath}";`,
          );
        }
        writer.blankLine();
        writer.writeLine('const pluginImporters = {');
        for (const { name } of plugins) {
          const camelName = kebabToCamel(name);
          writer.writeLine(
            `  "${name}": () => Promise.resolve({ default: ${camelName}PluginImport, pluginStub: ${camelName}PluginStubImport }),`,
          );
        }
        writer.writeLine('};');
      }
      writer.blankLine();

      writer.writeLine(
        'export const importPlugin = (id) => pluginImporters[id]?.();',
      );
      writer.blankLine();

      // Context-specific aggregate, kept for the preload/main menus
      const checkMode = mode === 'main' ? 'backend' : mode;
      writer.writeLine(`export const ${mode}Plugins = async () => {`);
      writer.writeLine(
        `  const entries = await Promise.all(pluginIdsFor('${checkMode}').map(async (id) => {`,
      );
      writer.writeLine('    const plugin = (await importPlugin(id))?.default;');
      writer.writeLine(
        '    return plugin && isPluginSupported(plugin) ? [id, plugin] : null;',
      );
      writer.writeLine('  }));');
      writer.writeLine('  return Object.fromEntries(entries.filter(Boolean));');
      writer.writeLine('};');
      writer.blankLine();

      // All plugins export (stub only)
      writer.writeLine('export const allPlugins = async () => {');
      writer.writeLine(
        '  const entries = await Promise.all(pluginIds.map(async (id) => {',
      );
      writer.writeLine(
        '    const stub = (await importPlugin(id))?.pluginStub;',
      );
      writer.writeLine(
        '    return stub && isPluginSupported(stub) ? [id, stub] : null;',
      );
      writer.writeLine('  }));');
      writer.writeLine('  return Object.fromEntries(entries.filter(Boolean));');
      writer.writeLine('};');
    },
    { overwrite: true },
  );

  return src.getText();
};
