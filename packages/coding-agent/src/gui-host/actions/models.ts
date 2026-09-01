import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { ModelRegistry } from "../../config/model-registry";
import { parseModelString } from "../../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../../config/model-roles";
import { Settings } from "../../config/settings";
import { getOrCreateAgentSession } from "../turns";
import type { ModelRef, ModelsView, ModelView } from "../wire";
import type { ActionContext, ActionHandler, ActionHandlersMap } from "./types";

const VALID_THINKING_LEVELS: readonly string[] = Object.values(ThinkingLevel);

async function buildModelsView(ctx: ActionContext): Promise<ModelsView> {
	const registry = ctx.clientState.agentSession?.modelRegistry ?? new ModelRegistry(await ctx.authStorage());
	const allModels = registry.getAll();
	const models: ModelView[] = allModels.map(m => ({
		provider: m.provider,
		id: m.id,
		name: m.name ?? m.id,
		reasoning: m.reasoning === true,
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
			message: error instanceof Error ? error.message : String(error),
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
			message: error instanceof Error ? error.message : String(error),
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
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

export const modelsActionHandlers: ActionHandlersMap = {
	RefreshModels: handleRefreshModels as ActionHandler<never>,
	SelectModel: handleSelectModel as ActionHandler<never>,
	SetThinkingLevel: handleSetThinkingLevel as ActionHandler<never>,
};
