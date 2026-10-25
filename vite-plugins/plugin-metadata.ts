import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Project,
  ts,
  type Node,
  type ObjectLiteralElementLike,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'ts-morph';

// HACK: DO NOT USE @ ALIAS IN THIS FILE, IT WILL CAUSE PROBLEMS
import { Platform } from '../src/types/plugins';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Metadata that can be derived from a plugin's source without evaluating it.
 * `enabled: null` means "the default cannot be known statically" — the loaders
 * then fall back to importing the module and reading its `config` (the previous
 * behaviour), so laziness never changes which plugins are enabled.
 */
export interface PluginMetadata {
  /** The plugin has a `backend`/`preload`/`renderer` context. */
  backend: boolean;
  preload: boolean;
  renderer: boolean;
  /** Statically resolved `platform` bitmask, `null` when absent. */
  platform: number | null;
  /** `false` when `platform` exists but could not be resolved statically. */
  platformResolved: boolean;
  /** Default `config.enabled`, `null` when it cannot be resolved statically. */
  enabled: boolean | null;
}

const PLATFORM_VALUES: Record<string, number> = {
  Windows: Platform.Windows,
  macOS: Platform.macOS,
  Linux: Platform.Linux,
  Freebsd: Platform.Freebsd,
};

const UNWRAP_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.TypeAssertionExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.ParenthesizedExpression,
]);

// Created on first cross-module lookup so importing this module (tests, the
// vite config) never parses the project's tsconfig eagerly.
let project: Project | undefined;
const getProject = (): Project => {
  project ??= new Project({
    tsConfigFilePath: resolve(__dirname, '..', 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
    skipFileDependencyResolution: true,
  });
  return project;
};

/** Drops `as const`, `satisfies T`, `<T>x`, `x!` and `(x)` wrappers. */
const unwrapExpression = (node: Node): Node => {
  if (!UNWRAP_KINDS.has(node.getKind())) return node;

  const wrapped = node as Node & { getExpression: () => Node };
  return unwrapExpression(wrapped.getExpression());
};

type KeyResolution = { key: string } | { computed: true } | null;

/**
 * Resolves the key a property assigns. Statically known computed keys behave
 * like plain keys; anything else may be the requested key, so callers mark it
 * unknown instead of guessing.
 */
const propertyKey = (prop: ObjectLiteralElementLike): KeyResolution => {
  const nameNode = (
    prop as ObjectLiteralElementLike & { getNameNode?: () => Node }
  ).getNameNode?.();
  if (!nameNode) return null;

  if (nameNode.getKind() === ts.SyntaxKind.ComputedPropertyName) {
    const expression = unwrapExpression(
      nameNode
        .asKindOrThrow(ts.SyntaxKind.ComputedPropertyName)
        .getExpression(),
    );
    const kind = expression.getKind();
    if (
      kind === ts.SyntaxKind.StringLiteral ||
      kind === ts.SyntaxKind.NumericLiteral ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      return {
        key: expression.getText().replace(/^['"`]|['"`]$/g, ''),
      };
    }
    return { computed: true };
  }

  return { key: nameNode.getText().replace(/^['"]|['"]$/g, '') };
};

type PropertyResolution =
  | { kind: 'absent' }
  | { kind: 'unknown' }
  | { kind: 'value'; node: Node };

const ABSENT: PropertyResolution = { kind: 'absent' };
const UNKNOWN: PropertyResolution = { kind: 'unknown' };

const resolveModuleFile = (
  sourceFile: SourceFile,
  specifier: string,
): SourceFile | undefined => {
  const base = resolve(sourceFile.getDirectoryPath(), specifier);
  for (const suffix of ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx']) {
    const path = (base + suffix).replace(/\\/g, '/');
    const resolved = getProject().addSourceFileAtPathIfExists(path);
    if (resolved) return resolved;
  }
  return undefined;
};

/** Walks `import { x } from './y'` / same-file consts down to an initializer node. */
const resolveIdentifier = (
  node: Node,
  name: string,
  depth: number,
): Node | undefined => {
  if (depth > 6) return undefined;

  const sourceFile = node.getSourceFile();
  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      if (declaration.getName() === name) {
        return declaration.getInitializer();
      }
    }
  }

  for (const declaration of sourceFile.getImportDeclarations()) {
    for (const named of declaration.getNamedImports()) {
      const importedName = named.getNameNode().getText();
      if ((named.getAliasNode()?.getText() ?? importedName) !== name) continue;

      const specifier = declaration.getModuleSpecifierValue();
      if (!specifier.startsWith('.')) return undefined;

      const moduleFile = resolveModuleFile(sourceFile, specifier);
      if (!moduleFile) return undefined;

      for (const statement of moduleFile.getVariableStatements()) {
        for (const local of statement.getDeclarations()) {
          if (local.getName() === importedName) return local.getInitializer();
        }
      }

      const exported = moduleFile.getExportedDeclarations().get(importedName) ?? [];
      for (const declaration of exported) {
        if (declaration.getKind() === ts.SyntaxKind.VariableDeclaration) {
          return declaration.asKindOrThrow(ts.SyntaxKind.VariableDeclaration).getInitializer();
        }
      }

      return undefined;
    }
  }

  return undefined;
};

/** Resolves an expression to an object literal (unwrapping `as`, spreads, identifiers). */
const resolveObjectLiteral = (
  node: Node | undefined,
  depth = 0,
): ObjectLiteralExpression | undefined => {
  if (!node || depth > 6) return undefined;
  const unwrapped = unwrapExpression(node);
  if (unwrapped !== node) return resolveObjectLiteral(unwrapped, depth + 1);
  if (node.getKind() === ts.SyntaxKind.ObjectLiteralExpression) {
    return node.asKindOrThrow(ts.SyntaxKind.ObjectLiteralExpression);
  }
  if (node.getKind() === ts.SyntaxKind.Identifier) {
    return resolveObjectLiteral(
      resolveIdentifier(node, node.getText(), depth),
      depth + 1,
    );
  }

  return undefined;
};

/**
 * Resolves which value an object literal finally assigns to `name`, following
 * JavaScript overwrite order: properties are applied left to right, so a later
 * spread overwrites an earlier explicit property and vice versa.
 *
 * Anything that could override the key without being statically resolvable (an
 * unresolvable spread, a dynamic computed key) makes the result `unknown`
 * rather than falling back to an earlier, now-stale value.
 */
export const resolveProperty = (
  objExpr: ObjectLiteralExpression,
  name: string,
  depth = 0,
): PropertyResolution => {
  if (depth > 6) return UNKNOWN;

  let result: PropertyResolution = ABSENT;

  for (const property of objExpr.getProperties()) {
    const kind = property.getKind();

    if (kind === ts.SyntaxKind.SpreadAssignment) {
      const spreadSource = resolveObjectLiteral(
        property.asKindOrThrow(ts.SyntaxKind.SpreadAssignment).getExpression(),
        depth + 1,
      );
      if (!spreadSource) {
        // The spread may or may not set the key: treat it as overriding.
        result = UNKNOWN;
        continue;
      }

      const nested = resolveProperty(spreadSource, name, depth + 1);
      if (nested.kind !== 'absent') result = nested;
      continue;
    }

    if (
      kind !== ts.SyntaxKind.PropertyAssignment &&
      kind !== ts.SyntaxKind.ShorthandPropertyAssignment &&
      kind !== ts.SyntaxKind.MethodDeclaration &&
      kind !== ts.SyntaxKind.GetAccessor &&
      kind !== ts.SyntaxKind.SetAccessor
    ) {
      continue;
    }

    const key = propertyKey(property);
    if (!key) {
      result = UNKNOWN;
      continue;
    }
    if ('computed' in key) {
      // A dynamic key may be `name`: conservatively treat it as overriding.
      result = UNKNOWN;
      continue;
    }
    if (key.key !== name) continue;

    if (kind === ts.SyntaxKind.PropertyAssignment) {
      const initializer = property
        .asKindOrThrow(ts.SyntaxKind.PropertyAssignment)
        .getInitializer();
      result = initializer
        ? { kind: 'value', node: initializer }
        : UNKNOWN;
    } else if (kind === ts.SyntaxKind.ShorthandPropertyAssignment) {
      result = {
        kind: 'value',
        node: property
          .asKindOrThrow(ts.SyntaxKind.ShorthandPropertyAssignment)
          .getNameNode(),
      };
    } else {
      // Methods and accessors are not statically boolean.
      result = UNKNOWN;
    }
  }

  return result;
};

const resolveBoolean = (node: Node | undefined, depth = 0): boolean | null => {
  if (!node || depth > 6) return null;
  const unwrapped = unwrapExpression(node);
  if (unwrapped !== node) return resolveBoolean(unwrapped, depth + 1);
  if (node.getKind() === ts.SyntaxKind.TrueKeyword) return true;
  if (node.getKind() === ts.SyntaxKind.FalseKeyword) return false;

  if (node.getKind() === ts.SyntaxKind.PropertyAccessExpression) {
    const access = node.asKindOrThrow(ts.SyntaxKind.PropertyAccessExpression);
    const target = resolveObjectLiteral(access.getExpression(), depth + 1);
    if (!target) return null;
    const resolved = resolveProperty(target, access.getName(), depth + 1);
    return resolved.kind === 'value'
      ? resolveBoolean(resolved.node, depth + 1)
      : null;
  }

  if (node.getKind() === ts.SyntaxKind.Identifier) {
    return resolveBoolean(
      resolveIdentifier(node, node.getText(), depth),
      depth + 1,
    );
  }

  return null;
};

const resolvePlatform = (node: Node | undefined, depth = 0): number | null => {
  if (!node || depth > 6) return null;
  const unwrapped = unwrapExpression(node);
  if (unwrapped !== node) return resolvePlatform(unwrapped, depth + 1);

  if (node.getKind() === ts.SyntaxKind.NumericLiteral) {
    return Number(node.getText());
  }

  if (node.getKind() === ts.SyntaxKind.PropertyAccessExpression) {
    const access = node.asKindOrThrow(ts.SyntaxKind.PropertyAccessExpression);
    if (access.getExpression().getText() !== 'Platform') return null;
    return PLATFORM_VALUES[access.getName()] ?? null;
  }

  if (node.getKind() === ts.SyntaxKind.BinaryExpression) {
    const binary = node.asKindOrThrow(ts.SyntaxKind.BinaryExpression);
    if (binary.getOperatorToken().getKind() !== ts.SyntaxKind.BarToken) {
      return null;
    }
    const left = resolvePlatform(binary.getLeft(), depth + 1);
    const right = resolvePlatform(binary.getRight(), depth + 1);
    if (left === null || right === null) return null;
    return left | right;
  }

  return null;
};

/** Reads an explicit (non-spread) property of the plugin definition object. */
const getExplicitProperty = (
  objExpr: ObjectLiteralExpression,
  name: string,
): ObjectLiteralElementLike | undefined => {
  for (const prop of objExpr.getProperties()) {
    if (prop.getKind() === ts.SyntaxKind.SpreadAssignment) continue;
    const key = propertyKey(prop);
    if (key && 'key' in key && key.key === name) return prop;
  }
  return undefined;
};

/** Finds the plugin definition object literal (`export default createPlugin({...})`). */
const findPluginDefinition = (
  file: SourceFile,
): ObjectLiteralExpression | undefined => {
  const candidates: Node[] = [];
  const defaultExport = file.getExportAssignment(
    (ea) => !ea.isExportEquals(),
  );
  if (defaultExport) candidates.push(defaultExport.getExpression());
  candidates.push(...(file.getExportedDeclarations().get('default') ?? []));

  for (const expression of candidates) {
    if (expression.getKind() === ts.SyntaxKind.ObjectLiteralExpression) {
      return expression.asKindOrThrow(ts.SyntaxKind.ObjectLiteralExpression);
    }
    if (expression.getKind() === ts.SyntaxKind.CallExpression) {
      const callExpr = expression.asKindOrThrow(ts.SyntaxKind.CallExpression);
      if (callExpr.getExpression().getText() !== 'createPlugin') continue;

      const [arg] = callExpr.getArguments();
      if (arg?.getKind() === ts.SyntaxKind.ObjectLiteralExpression) {
        return arg.asKindOrThrow(ts.SyntaxKind.ObjectLiteralExpression);
      }
    }
  }

  return undefined;
};

export const readPluginMetadata = (
  file: SourceFile,
): PluginMetadata | undefined => {
  const definition = findPluginDefinition(file);
  if (!definition) return undefined;

  const configProperty = getExplicitProperty(definition, 'config');
  let enabled: boolean | null = false;

  if (configProperty) {
    if (configProperty.getKind() === ts.SyntaxKind.PropertyAssignment) {
      const configObject = resolveObjectLiteral(
        configProperty
          .asKindOrThrow(ts.SyntaxKind.PropertyAssignment)
          .getInitializer(),
      );
      if (configObject) {
        const resolved = resolveProperty(configObject, 'enabled');
        if (resolved.kind === 'absent') {
          enabled = false;
        } else if (resolved.kind === 'unknown') {
          enabled = null;
        } else {
          enabled = resolveBoolean(resolved.node);
        }
      } else {
        enabled = null;
      }
    } else {
      enabled = null;
    }
  }

  const platformProperty = getExplicitProperty(definition, 'platform');
  const platform = platformProperty
    ? resolvePlatform(
        platformProperty.getKind() === ts.SyntaxKind.PropertyAssignment
          ? platformProperty
              .asKindOrThrow(ts.SyntaxKind.PropertyAssignment)
              .getInitializer()
          : platformProperty,
      )
    : null;

  return {
    backend: getExplicitProperty(definition, 'backend') !== undefined,
    preload: getExplicitProperty(definition, 'preload') !== undefined,
    renderer: getExplicitProperty(definition, 'renderer') !== undefined,
    platform,
    platformResolved: !platformProperty || platform !== null,
    enabled,
  };
};

