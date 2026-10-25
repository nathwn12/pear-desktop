import type {
  BackendContext,
  MenuContext,
  PreloadContext,
  RendererContext,
} from './contexts';
import type { MusicPlayer } from '@/types/music-player';

type Author = string;

export type PluginConfig = {
  enabled: boolean;
};

/** Loads a plugin module, or nothing when `await import(...)` is unavailable. */
export type PluginModuleLoader = () =>
  | Promise<{ default?: { config?: PluginConfig } } | undefined>
  | undefined;

/**
 * The single enabled-state policy, shared by the config facade and the loaders.
 *
 * 1. An explicitly stored `enabled` wins. `undefined` counts as not stored,
 *    which is what merging with the stored config computed (the merge drops
 *    undefined values, and persisted config can never contain one). For this
 *    scalar key the merge and this rule are otherwise identical, so the merge
 *    is never needed to answer it.
 * 2. Otherwise the build-time default decides, when it is statically known.
 * 3. Only an unknown default (`null`) loads the plugin to read `config.enabled`,
 *    and a plugin without a config is disabled.
 */
export const resolvePluginEnabled = async (
  defaultEnabled: boolean | null,
  storedConfig: Partial<PluginConfig> | undefined,
  loadPlugin: PluginModuleLoader,
): Promise<boolean> => {
  if (
    storedConfig &&
    Object.hasOwn(storedConfig, 'enabled') &&
    storedConfig.enabled !== undefined
  ) {
    return Boolean(storedConfig.enabled);
  }

  if (defaultEnabled !== null) return defaultEnabled;

  const plugin = await loadPlugin();
  return Boolean(plugin?.default?.config?.enabled);
};

export type PluginLifecycleSimple<Context, This> = (
  this: This,
  ctx: Context,
) => void | Promise<void>;
export type PluginLifecycleExtra<Config, Context, This> = This & {
  start?: PluginLifecycleSimple<Context, This>;
  stop?: PluginLifecycleSimple<Context, This>;
  onConfigChange?: (this: This, newConfig: Config) => void | Promise<void>;
};
export type RendererPluginLifecycleExtra<Config, Context, This> = This &
  PluginLifecycleExtra<Config, Context, This> & {
    onPlayerApiReady?: (
      this: This,
      playerApi: MusicPlayer,
      context: Context,
    ) => void | Promise<void>;
  };

export type PluginLifecycle<Config, Context, This> =
  | PluginLifecycleSimple<Context, This>
  | PluginLifecycleExtra<Config, Context, This>;
export type RendererPluginLifecycle<Config, Context, This> =
  | PluginLifecycleSimple<Context, This>
  | RendererPluginLifecycleExtra<Config, Context, This>;

export enum Platform {
  Windows = 1 << 0,
  macOS = 1 << 1,
  Linux = 1 << 2,
  Freebsd = 1 << 3,
}

export interface PluginDef<
  BackendProperties,
  PreloadProperties,
  RendererProperties,
  Config extends PluginConfig = PluginConfig,
> {
  name: () => string;
  authors?: Author[];
  description?: () => string;
  addedVersion?: string;
  config?: Config;
  platform?: Platform;

  menu?: (
    ctx: MenuContext<Config>,
  ) =>
    | Promise<Electron.MenuItemConstructorOptions[]>
    | Electron.MenuItemConstructorOptions[];
  stylesheets?: string[];
  restartNeeded?: boolean;

  backend?: {
    [Key in keyof BackendProperties]: BackendProperties[Key];
  } & PluginLifecycle<Config, BackendContext<Config>, BackendProperties>;
  preload?: {
    [Key in keyof PreloadProperties]: PreloadProperties[Key];
  } & PluginLifecycle<Config, PreloadContext<Config>, PreloadProperties>;
  renderer?: {
    [Key in keyof RendererProperties]: RendererProperties[Key];
  } & RendererPluginLifecycle<
    Config,
    RendererContext<Config>,
    RendererProperties
  >;
}
