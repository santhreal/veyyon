import type { AgentEvent } from "@veyyon/agent-core";
import type { AuthStorage } from "@veyyon/coding-agent";
import { discoverAuthStorage, ModelRegistry, Settings } from "@veyyon/coding-agent";

export type InProcessEventListener = (event: AgentEvent) => void;

export interface InProcessClientOptions {
	cwd: string;
	model: string;
	appendSystemPrompt?: string;
	tools?: string[];
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
	shared?: SharedInfra;
}

export interface SharedInfra {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

export interface DiscoverSharedInfraOptions {
	cwd?: string;
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
}

export async function discoverSharedInfra(options: DiscoverSharedInfraOptions = {}): Promise<SharedInfra> {
	const authStorage = await discoverAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage);

		const overrides: Record<string, unknown> = {};
		if (options.editVariant && options.editVariant !== "auto") {
			overrides["edit.mode"] = options.editVariant;
		}
		if (options.editFuzzy !== undefined && options.editFuzzy !== "auto") {
			overrides["edit.fuzzyMatch"] = options.editFuzzy;
		}
		if (options.editFuzzyThreshold !== undefined && options.editFuzzyThreshold !== "auto") {
			overrides["edit.fuzzyThreshold"] = options.editFuzzyThreshold;
		}
		await Settings.init({ cwd: options.cwd, overrides });

		return { authStorage, modelRegistry };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}
