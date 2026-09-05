import { isRecord } from "@veyyon/utils/type-guards";
import type { PluginRuntimeConfig } from "./types";

/** Normalizes persisted plugin runtime config across legacy lockfile shapes. */
export function normalizePluginRuntimeConfig(config?: Partial<PluginRuntimeConfig> | null): PluginRuntimeConfig {
	if (!config || typeof config !== "object") {
		return { plugins: {}, settings: {} };
	}
	return {
		plugins: isRecord(config.plugins) ? (config.plugins as PluginRuntimeConfig["plugins"]) : {},
		settings: isRecord(config.settings) ? (config.settings as PluginRuntimeConfig["settings"]) : {},
	};
}
