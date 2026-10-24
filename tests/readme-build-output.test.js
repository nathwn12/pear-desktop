import fs from 'node:fs';
import path from 'node:path';

import { test, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');

/** Normalise a build-output path so `./pack/`, `pack`, and `pack/` compare equal. */
function normalise(outputPath) {
  return outputPath.trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Read `directories.output` from electron-builder.yml (no YAML dependency needed). */
function configuredOutputDir() {
  const config = fs.readFileSync(
    path.join(root, 'electron-builder.yml'),
    'utf8',
  );
  const directories = config.match(/^directories:\s*$((?:\n[ \t]+.*)*)/m);
  expect(
    directories,
    'electron-builder.yml has a directories: block',
  ).not.toBeNull();

  const output = directories[1].match(
    /^\s+output:\s*["']?([^"'\n]+?)["']?\s*$/m,
  );
  expect(output, 'electron-builder.yml sets directories.output').not.toBeNull();

  return normalise(output[1]);
}

/** Read the folder the README tells users to collect built files from. */
function documentedOutputDir(readme) {
  const documented = readme.match(
    /Collect the built files from the `([^`]+)` folder/,
  );
  expect(
    documented,
    'README build steps name the build output folder',
  ).not.toBeNull();

  return normalise(documented[1]);
}

test('README build steps point at the electron-builder output directory', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  expect(documentedOutputDir(readme)).toBe(configuredOutputDir());
});
