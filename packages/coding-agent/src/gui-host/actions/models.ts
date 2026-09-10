import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { errorMessage, logger } from "@veyyon/utils";
import { ModelRegistry } from "../../config/model-registry";
import { parseModelString } from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../../config/model-roles";
import { Settings } from "../../config/settings";
import { writeFrame } from "../frames";
import { getOrCreateAgentSession } from "../turns";
import type { ModelRef, ModelsView, ModelView } from "../wire";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

const VALID_THINKING_LEVELS: readonly string[] = Object.values(ThinkingLevel);

async function buildModelsView(ctx: ActionContext): Promise<ModelsView> {
	const registry =
		ctx.clientState.agentSession?.modelRegistry ??
		new ModelRegistry(await ctx.authStorage(), path.join(ctx.agentDir, "models.yml"));
	// The models a turn can actually run: `getAvailable()` keeps a provider that
	// holds a credential or needs none, and drops the rest of the bundled
	// catalog. `getAll()` offers four fifths of the catalog as choices that fail
	// at the first prompt, and `SelectModel` persists whichever is picked.
	const offered = registry.getAvailable();
	const models: ModelView[] = offered.map(m => ({
		provider: m.provider,
		id: m.id,
		name: m.name ?? m.id,
		reasoning: m.reasoning === true,
		input: m.input,
		context_window: m.contextWindow ?? 0,
		max_output: m.maxTokens ?? 0,
	}));

	let currentModel: Model | undefined = ctx.clientState.agentSession?.model;
	if (!currentModel) {
		try {
			const settings = await Settings.loadIsolated({ cwd: ctx.cwd, agentDir: ctx.agentDir });
			const defaultSlot = settings.getModelRole(DEFAULT_MODEL_SLOT);
			if (defaultSlot) {
				const parsed = parseModelString(defaultSlot);
				if (parsed) {
					currentModel = registry.find(parsed.provider, parsed.id);
				}
			}
		} catch {
			// Fall back to no active model
		}
	}

	const current: ModelRef | null = currentModel ? { provider: currentModel.provider, id: currentModel.id } : null;

	const thinking_level = ctx.clientState.agentSession?.thinkingLevel ?? null;

	let thinking_levels: string[] = [];
	if (currentModel?.reasoning) {
		const efforts = getSupportedEfforts(currentModel);
		const supportsOff = currentModel.thinking?.requiresEffort !== true;
		thinking_levels = [...(supportsOff ? [ThinkingLevel.Off] : []), ...efforts];
	}

	return {
		models,
		current,
		thinking_level,
		thinking_levels,
	};
}

const handleRefreshModels: ActionHandler = async ctx => {
	try {
		const view = await buildModelsView(ctx);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Models: view,
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Provider",
			code: "MODEL_REGISTRY_ERROR",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

interface SelectModelPayload {
	provider?: string;
	model?: string;
}

const handleSelectModel: ActionHandler<SelectModelPayload | undefined> = async (ctx, payload) => {
	if (!payload?.provider || !payload?.model) {
		ctx.reply.failure({
			scope: "Provider",
			code: "INVALID_ARGUMENTS",
			message: "SelectModel requires provider and model parameters",
			retryable: false,
		});
		return;
	}

	try {
		const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		const found = session.modelRegistry.find(payload.provider, payload.model);
		if (!found) {
			ctx.reply.failure({
				scope: "Provider",
				code: "MODEL_NOT_FOUND",
				message: `Model '${payload.provider}/${payload.model}' not found in registry`,
				retryable: false,
			});
			return;
		}
		// A model whose provider holds no credential runs no turn. Refusing it
		// here keeps the failure at the click, rather than persisting it as the
		// default role and surfacing it as a failed prompt later.
		if (!session.modelRegistry.hasConfiguredAuth(found)) {
			ctx.reply.failure({
				scope: "Provider",
				code: "MODEL_NOT_AUTHENTICATED",
				message: `No credentials are stored for provider '${payload.provider}'`,
				retryable: false,
			});
			return;
		}

		await session.setModel(found, DEFAULT_MODEL_SLOT, { persist: true });
		const view = await buildModelsView(ctx);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Models: view,
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Provider",
			code: "MODEL_SELECTION_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

interface SetThinkingLevelPayload {
	level?: string;
}

const handleSetThinkingLevel: ActionHandler<SetThinkingLevelPayload | undefined> = async (ctx, payload) => {
	if (!payload?.level) {
		ctx.reply.failure({
			scope: "Provider",
			code: "INVALID_ARGUMENTS",
			message: "SetThinkingLevel requires a level parameter",
			retryable: false,
		});
		return;
	}

	if (!VALID_THINKING_LEVELS.includes(payload.level)) {
		ctx.reply.failure({
			scope: "Provider",
			code: "INVALID_ARGUMENTS",
			message: `Invalid thinking level '${payload.level}'. Valid levels: ${VALID_THINKING_LEVELS.join(", ")}`,
			retryable: false,
		});
		return;
	}

	try {
		const session = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);
		session.setThinkingLevel(payload.level as ThinkingLevel);
		const view = await buildModelsView(ctx);
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Models: view,
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Provider",
			code: "SET_THINKING_LEVEL_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

/**
 * Sends the model list after a provider's credentials changed.
 *
 * The list is filtered by credential, so the models a provider contributes
 * appear the moment it authenticates and stay absent while it has not. A
 * provider whose models are discovered from its own endpoint contributes none
 * until the registry has fetched from it, which is the refresh the terminal
 * also runs when a sign-in completes.
 *
 * Called from the authentication paths, which have already reported the
 * outcome of the sign-in: a discovery or catalog failure here leaves the
 * previous list drawn and is logged, never reported as a failed sign-in.
 */
export async function publishModelsAfterAuthChange(ctx: ActionContext): Promise<void> {
	try {
		await ctx.clientState.agentSession?.modelRegistry.refresh();
	} catch (error) {
		logger.warn("GUI host: model discovery failed after authentication", { error: errorMessage(error) });
	}
	try {
		writeFrame(ctx.socket, { Snapshot: { Models: await buildModelsView(ctx) } });
		ctx.clientState.revision += 1;
	} catch (error) {
		logger.warn("GUI host: model list unavailable after authentication", { error: errorMessage(error) });
	}
}

export const modelsActionHandlers: ActionHandlersMap = {
	RefreshModels: handleRefreshModels as ActionHandler<never>,
	SelectModel: handleSelectModel as ActionHandler<never>,
	SetThinkingLevel: handleSetThinkingLevel as ActionHandler<never>,
};
