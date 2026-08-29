import type { Api, Model } from "@veyyon/ai";
import { resolveConfiguredModelPatterns } from "../../../config/model-resolver";
import { settings } from "../../../config/settings";
import type { SubagentLaneSettings } from "../../../config/settings-domains/subagents";
import { canSpawnAtDepth } from "../../../task/types";
import { configuredThinkingLevelOptions, noSelectableEffortNotice } from "../../../thinking";
import { barePickerSelector } from "./model-roles-submenu";

export const AGENT_ROW_OFFERED = "\u0000agent-offered";
export const AGENT_ROW_NESTED = "\u0000agent-nested";
export const AGENT_ROW_RESET = "\u0000agent-reset";
export const AGENT_ROW_MODEL = "\u0000subagent-model";
export const AGENT_ROW_EFFORT = "\u0000subagent-effort";

export type SubagentRosterPath = "subagent.agents" | "subagent.model" | "subagent.thinkingLevel";

export type SubagentEffortScope =
	| { kind: "model"; model: Model }
	| { kind: "unresolved"; pattern: string }
	| { kind: "blanket" };

export function effortScopeForPattern(
	models: ReadonlyArray<Model> | undefined,
	head: string | undefined,
	sessionModel: Model | undefined,
): SubagentEffortScope {
	if (!head) return sessionModel ? { kind: "model", model: sessionModel } : { kind: "blanket" };
	const bare = models ? barePickerSelector(head, models as Model<Api>[]) : head;
	const found = models?.find(candidate => `${candidate.provider}/${candidate.id}` === bare);
	return found ? { kind: "model", model: found } : { kind: "unresolved", pattern: head };
}

export function subagentEffortScope(
	models: ReadonlyArray<Model> | undefined,
	sessionModel: Model | undefined,
): SubagentEffortScope {
	return effortScopeForPattern(
		models,
		resolveConfiguredModelPatterns(settings.get("subagent.model"), settings)[0],
		sessionModel,
	);
}

export function subagentEffortOptions(
	scope: SubagentEffortScope,
	catalog: ReadonlyArray<Model> | undefined,
): { options: Array<{ value: string; label: string; description: string }>; notice: string | undefined } {
	if (scope.kind === "unresolved") {
		return {
			options: configuredThinkingLevelOptions({
				inheritLabel: "Inherit",
				inheritDescription: "Follow the session's effort",
			}).map(option => ({ ...option })),
			notice: `No model in this session matches \`${scope.pattern}\`, so its effort levels are unknown. Inherit is the only choice that means anything until the chain resolves.`,
		};
	}
	const options = configuredThinkingLevelOptions({
		model: scope.kind === "model" ? scope.model : undefined,
		scope: scope.kind === "blanket" ? catalog : undefined,
		inheritLabel: "Inherit",
		inheritDescription: "Follow the session's effort",
	}).map(option => ({ ...option }));
	if (options.length > 1) return { options, notice: undefined };
	return {
		options,
		notice:
			scope.kind === "model"
				? noSelectableEffortNotice()
				: "No model in this session declares a selectable effort, so only Inherit applies.",
	};
}

export function laneSpawnEnabled(lane: SubagentLaneSettings, depth: number, resolvedMax: number): boolean {
	return lane.enabled ?? canSpawnAtDepth(resolvedMax, depth);
}

export function lanePath(name: string, depth: number): string {
	return `subagent.agents.${name}${".subagents".repeat(depth)}`;
}

export function pruneLane(lane: SubagentLaneSettings): SubagentLaneSettings | undefined {
	const cleaned: SubagentLaneSettings = {};
	if (lane.enabled !== undefined) cleaned.enabled = lane.enabled;
	if (lane.model !== undefined && (Array.isArray(lane.model) ? lane.model.length > 0 : lane.model.trim().length > 0)) {
		cleaned.model = lane.model;
	}
	if (lane.thinkingLevel !== undefined && lane.thinkingLevel.trim().length > 0) {
		cleaned.thinkingLevel = lane.thinkingLevel;
	}
	const child = lane.subagents === undefined ? undefined : pruneLane(lane.subagents);
	if (child !== undefined) cleaned.subagents = child;
	if (lane.maxNestedSpawnDepth !== undefined && child === undefined) {
		cleaned.maxNestedSpawnDepth = lane.maxNestedSpawnDepth;
	}
	return Object.keys(cleaned).length === 0 ? undefined : cleaned;
}
