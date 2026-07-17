import type {
	AgentSideConnection,
	SessionConfigOption,
	SessionModeState,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { Model } from "@veyyon/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "../../thinking";

export const ACP_DEFAULT_MODE_ID = "default";
export const ACP_PLAN_MODE_ID = "plan";
export const MODE_CONFIG_ID = "mode";
export const MODEL_CONFIG_ID = "model";
export const THINKING_CONFIG_ID = "thinking";
const THINKING_OFF = "off";

/** Emit a `config_option_update` snapshot of mode/model/thinking for `session`. */
export async function pushConfigOptionUpdate(
	connection: Pick<AgentSideConnection, "sessionUpdate">,
	session: AgentSession,
): Promise<void> {
	await connection.sessionUpdate({
		sessionId: session.sessionId,
		update: {
			sessionUpdate: "config_option_update",
			configOptions: buildConfigOptions(session),
		},
	});
}

export function buildConfigOptions(session: AgentSession): SessionConfigOption[] {
	const currentModeId = getCurrentModeId(session);
	const modeOptions = getAvailableModes(session).map(mode => ({
		value: mode.id,
		name: mode.name,
		description: mode.description,
	}));
	const configOptions: SessionConfigOption[] = [
		{
			id: MODE_CONFIG_ID,
			name: "Mode",
			category: "mode",
			type: "select",
			currentValue: currentModeId,
			options: modeOptions,
		},
	];

	const models = session.getAvailableModels();
	const currentModel = session.model;
	if (models.length > 0) {
		configOptions.push({
			id: MODEL_CONFIG_ID,
			name: "Model",
			category: "model",
			type: "select",
			currentValue: currentModel ? toModelId(currentModel) : toModelId(models[0]),
			options: models.map(model => ({
				value: toModelId(model),
				name: model.name,
				description: `${model.provider}/${model.id}`,
			})),
		});
	}

	configOptions.push({
		id: THINKING_CONFIG_ID,
		name: "Thinking",
		category: "thought_level",
		type: "select",
		currentValue: toThinkingConfigValue(session.model?.reasoning ? getConfiguredThinkingLevel(session) : undefined),
		options: buildThinkingOptions(session),
	});
	return configOptions;
}

function buildThinkingOptions(session: AgentSession): Array<{ value: string; name: string; description?: string }> {
	return [
		{ value: THINKING_OFF, name: "Off" },
		{ value: AUTO_THINKING, name: "Auto", description: "Auto-detect per prompt (low–xhigh)" },
		...session.getAvailableThinkingLevels().map(level => ({
			value: level,
			name: level,
		})),
	];
}

function getConfiguredThinkingLevel(session: AgentSession): string | undefined {
	const configuredThinkingLevel = (session as { configuredThinkingLevel?: () => string | undefined })
		.configuredThinkingLevel;
	return typeof configuredThinkingLevel === "function" ? configuredThinkingLevel.call(session) : session.thinkingLevel;
}

function toThinkingConfigValue(value: string | undefined): string {
	return value && value !== "inherit" ? value : THINKING_OFF;
}

export async function setModelById(session: AgentSession, modelId: string): Promise<void> {
	const model = session.getAvailableModels().find(candidate => toModelId(candidate) === modelId);
	if (!model) {
		throw new Error(`Unknown ACP model: ${modelId}`);
	}
	await session.setModel(model);
}

export function setThinkingLevelById(session: AgentSession, value: string): void {
	const thinkingLevel = parseConfiguredThinkingLevel(value);
	if (!thinkingLevel) {
		throw new Error(`Unknown ACP thinking level: ${value}`);
	}
	session.setThinkingLevel(thinkingLevel);
}

function toModelId(model: Model): string {
	return `${model.provider}/${model.id}`;
}

export function getAvailableModes(session: AgentSession): Array<{ id: string; name: string; description: string }> {
	const modes = [{ id: ACP_DEFAULT_MODE_ID, name: "Default", description: "Standard ACP headless mode" }];
	if (session.settings.get("plan.enabled")) {
		modes.push({
			id: ACP_PLAN_MODE_ID,
			name: "Plan",
			description: "Read-only planning mode that drafts a plan to a markdown file before any code changes",
		});
	}
	return modes;
}

export function getCurrentModeId(session: AgentSession): string {
	return session.getPlanModeState()?.enabled ? ACP_PLAN_MODE_ID : ACP_DEFAULT_MODE_ID;
}

export function buildModeState(session: AgentSession): SessionModeState {
	return {
		availableModes: getAvailableModes(session),
		currentModeId: getCurrentModeId(session),
	};
}

export function buildCurrentModeUpdate(session: AgentSession): SessionUpdate {
	return {
		sessionUpdate: "current_mode_update",
		currentModeId: getCurrentModeId(session),
	};
}
