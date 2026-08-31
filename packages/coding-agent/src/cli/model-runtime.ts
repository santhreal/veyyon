import { getProjectDir } from "@veyyon/utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";

/**
 * What a model-facing CLI subcommand needs before it can talk to a provider: the
 * settings for the project it was run in, a registry of the models those settings
 * and the stored credentials make available, and the handle that releases the
 * credential store afterwards.
 *
 * `settings` and `close` are optional because a test supplies its own runtime and
 * has neither.
 */
export interface CliModelRuntime {
	modelRegistry: ModelRegistry;
	settings?: Settings;
	close?: () => void;
}

/**
 * Open the credential store, load the project's settings, and build the model
 * registry from both.
 *
 * `veyyon bench` and `veyyon dry-balance` each had a byte-identical copy of this,
 * including the part that matters: if `Settings.init` or the extension-provider
 * load throws, the credential store opened one line earlier is closed before the
 * error propagates. That store holds a SQLite handle, so a copy that forgot the
 * `catch` would leak it on every failed invocation, and the failure that leaked it
 * is the one the operator is already looking at.
 */
export async function createCliModelRuntime(): Promise<CliModelRuntime> {
	const authStorage = await discoverAuthStorage();
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		const modelRegistry = new ModelRegistry(authStorage);
		await loadCliExtensionProviders(modelRegistry, settings, cwd);
		return {
			modelRegistry,
			settings,
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}
