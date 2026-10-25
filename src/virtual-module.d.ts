declare module 'virtual:plugins' {
  import type { PluginConfig, PluginDef } from '@/types/plugins';

  type Plugin = PluginDef<unknown, unknown, unknown, PluginConfig>;
  type PluginStub = Omit<Plugin, 'backend' | 'preload' | 'renderer'>;

  export interface PluginMetadata {
    backend: boolean;
    preload: boolean;
    renderer: boolean;
    platform: number | null;
    platformResolved: boolean;
    /** Default `config.enabled`, `null` when it cannot be known without importing. */
    enabled: boolean | null;
  }

  export interface PluginModule {
    default?: Plugin;
    pluginStub?: PluginStub;
  }

  /** Static, build-time metadata: reading it never evaluates a plugin. */
  export const pluginMeta: Record<string, PluginMetadata>;
  export const pluginIds: string[];

  /** Imports a single plugin module (undefined for an unknown id). */
  export const importPlugin: (
    id: string,
  ) => Promise<PluginModule | undefined> | undefined;

  export const isPluginSupported: (plugin: {
    platform?: number | null;
  }) => boolean;

  export const pluginIdsFor: (
    kind: 'backend' | 'preload' | 'renderer',
  ) => string[];

  export const mainPlugins: () => Promise<Record<string, Plugin>>;
  export const preloadPlugins: () => Promise<Record<string, Plugin>>;
  export const rendererPlugins: () => Promise<Record<string, Plugin>>;

  export const allPlugins: () => Promise<Record<string, PluginStub>>;
}

declare module 'virtual:i18n' {
  import type { LanguageResources } from '@/i18n/resources/@types';

  export const languageCodes: string[];
  export const languageMeta: Record<
    string,
    { name: string | null; localName: string | null; code: string }
  >;

  export const loadLanguage: (
    language: string,
  ) => Promise<LanguageResources | null>;
}
