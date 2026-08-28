import { stripEffortTierSuffix } from "@veyyon/catalog/variant-collapse";
import { advisorStatusNextStep, describeAdvisorToggle } from "../../advisor/messages";
import { DEFAULT_EFFORT_POINTER } from "../../config/effort-resolver";
import type { AgentSession } from "../../session/agent-session";
import { configuredThinkingLevelsForModel, parseConfiguredThinkingLevel } from "../../thinking";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "../helpers/parse";
import { refreshStatusLine } from "./shared";
import type { HandlerSetFor } from "./types";

function formatThinkingLevelChoices(session: AgentSession): string {
	return configuredThinkingLevelsForModel(session.model).join(", ");
}

function noThinkingControlMessage(session: AgentSession): string {
	const model = session.model;
	if (!model) return "No model selected.";
	if (!model.reasoning) {
		return `${model.provider}/${model.id} does not reason; there is no effort to set.`;
	}
	const tierBase = stripEffortTierSuffix(model.id);
	if (tierBase !== undefined) {
		const tier = model.id.slice(tierBase.length + 1);
		return `${model.provider}/${model.id} has effort "${tier}" baked into the model id; /effort has nothing to set. Select ${tierBase} to choose an effort.`;
	}
	return `${model.provider}/${model.id} manages reasoning itself; there is no effort to set.`;
}

export const MODEL_HANDLERS = {
	model: {
		getTuiAutocompleteDescription: runtime => {
			const model = runtime.ctx.session.model;
			return model ? `Switch model · now ${model.provider}/${model.id}` : "Switch model";
		},
		handle: async (command, runtime) => {
			if (command.args) {
				const modelId = command.args.trim();
				const availableModels = runtime.session.getAvailableModels?.() ?? [];
				const match = availableModels.find(
					model => model.id === modelId || `${model.provider}/${model.id}` === modelId,
				);
				if (!match) {
					return usage(
						`Unknown model: ${modelId}. Use ACP \`session/setModel\` for picker-driven selection or list available models with /model.`,
						runtime,
					);
				}
				try {
					await runtime.session.setModel(match);
					await runtime.output(`Model set to ${match.provider}/${match.id}.`);
					await runtime.notifyTitleChanged?.();
					await runtime.notifyConfigChanged?.();
					return commandConsumed();
				} catch (err) {
					return usage(`Failed to set model: ${errorMessage(err)}`, runtime);
				}
			}

			const model = runtime.session.model;
			await runtime.output(
				model ? `Current model: ${model.provider}/${model.id}` : "No model is currently selected.",
			);
			return commandConsumed();
		},
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector();
			runtime.ctx.editor.setText("");
		},
	},
	switch: {
		handleTui: (_command, runtime) => {
			runtime.ctx.showModelSelector({ temporaryOnly: true });
			runtime.ctx.editor.setText("");
		},
	},
	effort: {
		getTuiAutocompleteDescription: runtime => {
			const level = runtime.ctx.session.configuredThinkingLevel();
			return level ? `Set thinking effort · now ${level}` : "Set thinking effort";
		},
		handle: async (command, runtime) => {
			const arg = command.args.trim();
			const choices = configuredThinkingLevelsForModel(runtime.session.model);
			if (choices.length === 0) {
				await runtime.output(noThinkingControlMessage(runtime.session));
				return commandConsumed();
			}
			const available = formatThinkingLevelChoices(runtime.session);
			if (!arg) {
				const current = runtime.session.configuredThinkingLevel();
				await runtime.output(
					`Effort: ${current ?? "auto"} (this session). Choose one of: ${available}. Usage: /effort <level>. ${DEFAULT_EFFORT_POINTER}`,
				);
				return commandConsumed();
			}
			const level = parseConfiguredThinkingLevel(arg);
			if (level === undefined) {
				return usage(`Unknown thinking level: ${arg}. Choose one of: ${available}.`, runtime);
			}
			if (!choices.includes(level)) {
				return usage(
					`${runtime.session.model?.provider}/${runtime.session.model?.id} does not accept ${level}. Choose one of: ${available}.`,
					runtime,
				);
			}

			runtime.session.setThinkingLevel(level, false);
			await runtime.output(`Effort set to ${level} for this session. ${DEFAULT_EFFORT_POINTER}`);
			await runtime.notifyConfigChanged?.();
			return commandConsumed();
		},
		handleTui: (command, runtime) => {
			const arg = command.args.trim();
			runtime.ctx.editor.setText("");
			if (!arg) {
				runtime.ctx.showThinkingSelector();
				return;
			}
			const choices = configuredThinkingLevelsForModel(runtime.ctx.session.model);
			if (choices.length === 0) {
				runtime.ctx.showStatus(noThinkingControlMessage(runtime.ctx.session));
				return;
			}
			const available = formatThinkingLevelChoices(runtime.ctx.session);
			const level = parseConfiguredThinkingLevel(arg);
			if (level === undefined) {
				runtime.ctx.showStatus(`Unknown thinking level: ${arg}. Choose one of: ${available}.`);
				return;
			}
			if (!choices.includes(level)) {
				runtime.ctx.showStatus(
					`${runtime.ctx.session.model?.provider}/${runtime.ctx.session.model?.id} does not accept ${level}. Choose one of: ${available}.`,
				);
				return;
			}
			runtime.ctx.session.setThinkingLevel(level, false);
			refreshStatusLine(runtime.ctx);
			runtime.ctx.updateEditorBorderColor();
			runtime.ctx.showStatus(`Effort set to ${level} for this session. ${DEFAULT_EFFORT_POINTER}`);
		},
	},
	force: {
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0
				? "Force the next turn to use a tool · none active"
				: `Force the next turn to use a tool · ${count} active`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			if (prompt) return { prompt };
		},
	},
	retry: {
		handleTui: async (_command, runtime) => {
			const didRetry = await runtime.ctx.session.retry();
			if (!didRetry) {
				runtime.ctx.showStatus("Nothing to retry");
			}
			runtime.ctx.editor.setText("");
		},
	},
	advisor: {
		getTuiAutocompleteDescription: runtime => {
			const stats = runtime.ctx.session.getAdvisorStats();
			if (!stats.configured) return "Advisor · off";
			if (!stats.active) return "Advisor · on, but no model resolved";
			if (stats.advisors.length > 1) return `Advisor · ${stats.advisors.length} running`;
			return `Advisor · ${stats.advisors[0].model.id}`;
		},
		handle: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			if (!verb || verb === "status") {
				const stats = runtime.session.getAdvisorStats();
				await runtime.output(
					`${runtime.session.formatAdvisorStatus()}\n${advisorStatusNextStep(stats.configured, stats.active)}`,
				);
				return commandConsumed();
			}
			if (verb === "on" || verb === "off") {
				const running = runtime.session.setAdvisorEnabled(verb === "on");
				await runtime.output(describeAdvisorToggle(verb === "on", running));
				return commandConsumed();
			}
			if (verb === "dump") {
				const dump = runtime.session.formatAdvisorHistoryAsText({ compact: true });
				await runtime.output(dump ?? "No advisor is running, so there is no advisor transcript to show.");
				return commandConsumed();
			}
			if (verb === "configure") {
				await runtime.output(
					"/advisor configure needs the interactive TUI. Edit WATCHDOG.yml to change the roster from here.",
				);
				return commandConsumed();
			}
			return usage("Usage: /advisor [status|configure|on|off|dump]", runtime);
		},
		handleTui: async (command, runtime) => {
			const { verb } = parseSubcommand(command.args);
			runtime.ctx.editor.setText("");
			if (verb === "status") {
				await runtime.ctx.handleAdvisorStatusCommand();
				return;
			}
			if (verb === "configure") {
				await runtime.ctx.showAdvisorConfigure();
				return;
			}
			if (verb === "on" || verb === "off") {
				const running = runtime.ctx.session.setAdvisorEnabled(verb === "on");
				runtime.ctx.showStatus(describeAdvisorToggle(verb === "on", running));
				return;
			}
			if (verb === "dump") {
				runtime.ctx.handleAdvisorDumpCommand();
				return;
			}
			runtime.ctx.showStatus("Usage: /advisor [status|configure|on|off|dump]");
		},
	},
} satisfies {
	model: HandlerSetFor<"model">;
	switch: HandlerSetFor<"switch">;
	effort: HandlerSetFor<"effort">;
	force: HandlerSetFor<"force">;
	retry: HandlerSetFor<"retry">;
	advisor: HandlerSetFor<"advisor">;
};
