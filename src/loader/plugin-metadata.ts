import { importPlugin, pluginMeta } from 'virtual:plugins';

import {
  resolvePluginEnabled,
  type PluginConfig,
  type PluginDef,
} from '@/types/plugins';

/**
 * Resolves enabled state through the shared policy in `@/types/plugins`: a
 * stored override wins, the build-time default answers without evaluating the
 * module, and only an unknown default loads the plugin to read its config.
 */
export const isPluginEnabled = (
  id: string,
  storedConfigs: Record<string, PluginConfig>,
): Promise<boolean> =>
  resolvePluginEnabled(pluginMeta[id]?.enabled ?? null, storedConfigs[id], () =>
    importPlugin(id),
  );

/** Config defaults of a plugin, without evaluating the plugin's lifecycle. */
export const getPluginStub = async (id: string) => {
  return (await importPlugin(id))?.pluginStub;
};

export const getPluginDefinition = async (id: string) => {
  return (await importPlugin(id))?.default as
    | PluginDef<unknown, unknown, unknown>
    | undefined;
};
