/**
 * Extension system for lifecycle events and custom tools.
 */

export type { SlashCommandInfo, SlashCommandLocation, SlashCommandSource } from "../slash-commands";
// Named rather than a star: `loader.ts` exports a class `ExtensionRuntime` and
// `types.ts` an unrelated interface of the same name, and only the interface is
// part of the public surface.
export {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	ExtensionRuntimeNotInitializedError,
	type ExtensionTrustOptions,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader";
export * from "./runner";
// Type guards
export * from "./types";
export * from "./wrapper";
