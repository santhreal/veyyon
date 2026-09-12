import { ThinkingLevel } from "@veyyon/agent-core";
import { errorMessage, logger } from "@veyyon/utils";
import { DEFAULT_MODEL_SLOT } from "../../config/model-roles";
import { buildModelsView, offeredModelsFor, publishModelsView } from "../models-view";
import { getOrCreateAgentSession } from "../turns";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

const VALID_THINKING_LEVELS: readonly string[] = Object.values(ThinkingLevel);

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
		// `enabledModels` is the scope the session honours, so a model outside it
		// is not one this client was offered and would not be the model a turn
		// runs on either.
		const offered = await offeredModelsFor(ctx);
		if (!offered.some(model => model.provider === found.provider && model.id === found.id)) {
			ctx.reply.failure({
				scope: "Provider",
				code: "MODEL_NOT_ENABLED",
				message: `Model '${payload.provider}/${payload.model}' is outside the enabledModels scope`,
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
	await publishModelsView(ctx.socket, ctx);
}

export const modelsActionHandlers: ActionHandlersMap = {
	RefreshModels: handleRefreshModels as ActionHandler<never>,
	SelectModel: handleSelectModel as ActionHandler<never>,
	SetThinkingLevel: handleSetThinkingLevel as ActionHandler<never>,
};
