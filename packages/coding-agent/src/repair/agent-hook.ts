/**
 * Adapter from coding-agent schema repair to the agent loop hook.
 */

import type { AgentTool, AgentToolCall, ToolCallRepairResult } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai/types";
import { isRecord } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import { isRepairEnabledForModel } from "../harness/model-profile";
import { formatRepairCoachingHints, isToolCallRepairDisabled, repairToolCallArguments } from "./schema-repair";

export type ModelResolver = () => Model | undefined;

export function createRepairToolCallArgumentsHook(
	settings: Settings,
	getModel: ModelResolver,
): (tool: AgentTool, toolCall: AgentToolCall) => ToolCallRepairResult {
	return (tool, toolCall) => {
		if (isToolCallRepairDisabled() || !isRepairEnabledForModel(settings, getModel())) {
			const args = isRecord(toolCall.arguments) ? (toolCall.arguments as Record<string, unknown>) : {};
			return { status: "clean", arguments: args, hints: [] };
		}

		const outcome = repairToolCallArguments(tool, toolCall);
		if (outcome.status === "unrepairable") {
			return {
				status: "unrepairable",
				arguments: {},
				hints: outcome.hints,
				reason: outcome.reason,
			};
		}
		return {
			status: outcome.status,
			arguments: outcome.arguments,
			hints: outcome.hints,
		};
	};
}

export function formatUnrepairableToolError(reason: string | undefined, hints: readonly string[]): string {
	const coaching = formatRepairCoachingHints(hints);
	if (coaching) return `${reason ?? "Tool arguments could not be repaired."}\n\n${coaching}`;
	return reason ?? "Tool arguments could not be repaired.";
}
