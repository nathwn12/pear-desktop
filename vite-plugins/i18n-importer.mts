import { readFileSync } from 'node:fs';
import { basename, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { globSync } from 'glob';
import { Project } from 'ts-morph';

const __dirname = dirname(fileURLToPath(import.meta.url));
const globalProject = new Project({
  tsConfigFilePath: resolve(__dirname, '..', 'tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
  skipLoadingLibFiles: true,
  skipFileDependencyResolution: true,
});

interface LocaleInfo {
  code: string;
  path: string;
  language: {
    'name'?: string;
    'local-name'?: string;
    'code'?: string;
  } | null;
}

export const i18nImporter = () => {
  const rootPath = resolve(__dirname, '..');
  const locales: LocaleInfo[] = globSync(['src/i18n/resources/*.json']).map(
    (path) => {
      const nameWithExt = basename(path);
      const code = nameWithExt.replace(extname(nameWithExt), '');
      const language = (
        JSON.parse(readFileSync(resolve(rootPath, path), 'utf8')) as {
          language?: LocaleInfo['language'];
        }
      ).language;

      return {
        code,
        path: resolve(rootPath, path).replace(/\\/g, '/'),
        language: language ?? null,
      };
    },
  );

  const languageMeta = Object.fromEntries(
    locales.map(({ code, language }) => [
      code,
      {
        name: language?.name ?? null,
        localName: language?.['local-name'] ?? null,
        code: language?.code ?? code,
      },
    ]),
  );

  const src = globalProject.createSourceFile(
    'vm:i18n',
    (writer) => {
      writer.writeLine(
        `export const languageCodes = ${JSON.stringify(locales.map(({ code }) => code))};`,
      );
      writer.blankLine();
      writer.writeLine(
        `export const languageMeta = ${JSON.stringify(languageMeta)};`,
      );
      writer.blankLine();

      writer.writeLine('const languageImporters = {');
      for (const { code, path } of locales) {
        writer.writeLine(`  ${JSON.stringify(code)}: () => import('${path}'),`);
      }
      writer.writeLine('};');
      writer.blankLine();

      writer.writeLine(
        '/** Loads a single locale, or `null` when it does not exist. */',
      );
      writer.writeLine('export const loadLanguage = async (language) => {');
      writer.writeLine('  const importer = languageImporters[language];');
      writer.writeLine('  if (!importer) return null;');
      writer.writeLine('');
      writer.writeLine('  const mod = await importer();');
      writer.writeLine('');
      writer.writeLine(
        '  return { [language]: { translation: mod.default } };',
      );
      writer.writeLine('};');
    },
    { overwrite: true },
  );

  return src.getText();
};
