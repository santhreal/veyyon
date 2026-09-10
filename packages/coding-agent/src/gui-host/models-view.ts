import type { Socket } from "node:net";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, AuthStorage, Model } from "@veyyon/ai";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { errorMessage, logger } from "@veyyon/utils";
import { ModelRegistry } from "../config/model-registry";
import {
	getModelMatchPreferences,
	pickDefaultAvailableModel,
	resolveAllowedModels,
	resolveModelRoleValue,
} from "../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../config/model-roles";
import { Settings } from "../config/settings";
import { writeFrame } from "./frames";
import type { ClientSessionState } from "./turns";
import type { ModelRef, ModelsView, ModelView } from "./wire";

/**
 * What the model view is built from. `ActionContext` satisfies it, and so does
 * the session-creation path, which has no request to reply to.
 */
export interface ModelsViewSource {
	clientState: ClientSessionState;
	cwd: string;
	agentDir: string;
	authStorage: () => Promise<AuthStorage>;
}

/**
 * The models a turn could run: `getAvailable()` keeps a provider that holds a
 * credential or needs none, and `enabledModels` narrows that to the scope the
 * session itself will honour. `getAll()` offers four fifths of the bundled
 * catalog as choices that fail at the first prompt.
 */
async function offeredModels(registry: ModelRegistry, settings: Settings | undefined): Promise<Model<Api>[]> {
	if (!settings) return registry.getAvailable();
	return resolveAllowedModels(registry, settings, getModelMatchPreferences(settings));
}

/**
 * The model a session created right now would run on, in the order the session
 * itself resolves it: the configured default role first, then the first
 * authenticated provider default in the allowed set. Stating anything else
 * makes the composer name a model the next turn will not use.
 */
function modelANewSessionWouldRun(
	registry: ModelRegistry,
	settings: Settings,
	offered: Model<Api>[],
): Model<Api> | undefined {
	const matchPreferences = getModelMatchPreferences(settings);
	const role = resolveModelRoleValue(settings.getModelRole(DEFAULT_MODEL_SLOT), offered, {
		settings,
		matchPreferences,
	});
	if (role.model) return role.model;
	return pickDefaultAvailableModel(offered.filter(model => registry.hasConfiguredAuth(model)));
}

/** The registry the client's session reads, or one opened over the same files. */
export async function modelRegistryFor(source: ModelsViewSource): Promise<ModelRegistry> {
	return (
		source.clientState.agentSession?.modelRegistry ??
		new ModelRegistry(await source.authStorage(), path.join(source.agentDir, "models.yml"))
	);
}

/** The scope a `SelectModel` is answered against: what this client is offered. */
export async function offeredModelsFor(source: ModelsViewSource): Promise<Model<Api>[]> {
	const registry = await modelRegistryFor(source);
	return offeredModels(registry, await settingsOrNone(source));
}

/**
 * The settings the answer is resolved against: a live session's own, so a role
 * written at runtime is read back, and the files on disk before one exists.
 */
async function settingsOrNone(source: ModelsViewSource): Promise<Settings | undefined> {
	const live = source.clientState.agentSession?.settings;
	if (live) return live;
	try {
		return await Settings.loadIsolated({ cwd: source.cwd, agentDir: source.agentDir });
	} catch (error) {
		// A settings file that cannot be read narrows nothing and resolves no
		// default; the list still states what the credentials allow.
		logger.warn("GUI host: settings unavailable while building the model list", { error: errorMessage(error) });
		return undefined;
	}
}

export async function buildModelsView(source: ModelsViewSource): Promise<ModelsView> {
	const session = source.clientState.agentSession;
	const registry = await modelRegistryFor(source);
	const settings = await settingsOrNone(source);
	const offered = await offeredModels(registry, settings);
	const models: ModelView[] = offered.map(model => ({
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning: model.reasoning === true,
		input: model.input,
		context_window: model.contextWindow ?? 0,
		max_output: model.maxTokens ?? 0,
	}));

	// A live session owns the answer: its model is the one the next turn runs
	// on, whatever the configuration would resolve today.
	const currentModel: Model<Api> | undefined =
		session?.model ?? (settings ? modelANewSessionWouldRun(registry, settings, offered) : undefined);
	const current: ModelRef | null = currentModel ? { provider: currentModel.provider, id: currentModel.id } : null;

	let thinking_levels: string[] = [];
	if (currentModel?.reasoning) {
		const efforts = getSupportedEfforts(currentModel);
		const supportsOff = currentModel.thinking?.requiresEffort !== true;
		thinking_levels = [...(supportsOff ? [ThinkingLevel.Off] : []), ...efforts];
	}

	return {
		models,
		current,
		thinking_level: session?.thinkingLevel ?? null,
		thinking_levels,
	};
}

/**
 * Send the model list to a client that did not ask for it.
 *
 * Used where the model in effect changes outside a request the client made:
 * a credential is stored, or a session is created and resolves its own model.
 * The caller has already reported its own outcome, so a registry that cannot
 * answer leaves the previous list drawn and is logged.
 */
export async function publishModelsView(socket: Socket, source: ModelsViewSource): Promise<void> {
	try {
		const view = await buildModelsView(source);
		source.clientState.revision += 1;
		writeFrame(socket, { Snapshot: { Models: view } });
	} catch (error) {
		logger.warn("GUI host: model list unavailable", { error: errorMessage(error) });
	}
}
