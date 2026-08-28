import { getProjectDir } from "@veyyon/utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";

/** What a model-facing CLI subcommand needs before it can talk to a provider: the settings for the project it was run in, a registry of the models those settings */
export interface CliModelRuntime {
	modelRegistry: ModelRegistry;
	settings?: Settings;
	close?: () => void;
}

/** Open the credential store, load the project's settings, and build the model registry from both. */
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
