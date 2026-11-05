/**
 * The reader for `agent.helpers`: the model and effort each helper runs.
 *
 * A helper is a model call a feature makes on its own behalf, listed in the
 * Helpers section of the Roster page beside the subagents. Every helper follows
 * one rule, the same one an unconfigured agent follows: a helper that names no
 * model runs the session's model, and one that names no effort runs the
 * session's effort. A helper that names a model nothing can resolve returns no
 * model rather than quietly running the session's, so the feature can report
 * the setting that is wrong.
 *
 * Import this instead of reading `agent.helpers` directly.
 */

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Effort, Model } from "@veyyon/ai";
import { isRecord } from "@veyyon/utils";
import { parseConfiguredEffortSetting } from "../config/effort-resolver";
import { namesInheritedModel, normalizeModelPatternList } from "../config/model-pattern-list";
import { getModelMatchPreferences, resolveModelSelectorValue } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { HelperLaneSettings } from "../config/settings-domains/agents";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	concreteThinkingLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../thinking";

/** Every helper, in the order the Roster page lists them. */
export const HELPER_IDS = [
	"advisor",
	"plan",
	"vision",
	"commit",
	"title",
	"memory",
	"autoThinking",
	"unexpectedStop",
	"speech",
	"completion",
] as const;

export type HelperId = (typeof HELPER_IDS)[number];

/** What a helper row shows on the Roster page. */
export interface HelperInfo {
	label: string;
	description: string;
}

export const HELPERS: Record<HelperId, HelperInfo> = {
	advisor: { label: "Advisor", description: "Reviews the session's turns while the advisor is on." },
	plan: { label: "Plan", description: "Runs the session while plan mode is on." },
	vision: {
		label: "Vision",
		description: "Describes images for inspect_image and for a session model without image input.",
	},
	commit: { label: "Commit", description: "Writes commit messages and changelog entries for `veyyon commit`." },
	title: { label: "Session Title", description: "Names each session from its first messages." },
	memory: { label: "Memory", description: "Extracts and consolidates memories when memory is on." },
	autoThinking: { label: "Auto Thinking", description: "Rates each prompt's difficulty for the `auto` effort." },
	unexpectedStop: {
		label: "Unexpected Stop",
		description: "Checks whether a turn stopped before it finished, when detection is on.",
	},
	speech: { label: "Speech", description: "Rewrites a reply for speech before it is spoken aloud." },
	completion: { label: "Eval Completion", description: "Answers `completion()` calls from the eval tool." },
};

const HELPER_ID_SET: ReadonlySet<string> = new Set(HELPER_IDS);

/** Whether `id` names a helper. */
export function isHelperId(id: string): id is HelperId {
	return HELPER_ID_SET.has(id);
}

/** The settings path of one helper field, as reports and the settings page name it. */
export function helperSettingPath(id: HelperId, field: keyof HelperLaneSettings): string {
	return `agent.helpers.${id}.${field}`;
}

/**
 * The `agent.helpers` row for `id`, or an empty row when unconfigured. The file
 * is hand-editable, so a field of the wrong type reads as unset.
 */
export function helperSettingsFor(settings: Settings, id: HelperId): HelperLaneSettings {
	const rows: unknown = settings.get("agent.helpers");
	const row: unknown = isRecord(rows) ? rows[id] : undefined;
	if (!isRecord(row)) return {};
	const model = row.model;
	const thinkingLevel = row.thinkingLevel;
	return {
		...(typeof model === "string" ||
		(Array.isArray(model) && model.every((entry): entry is string => typeof entry === "string"))
			? { model }
			: {}),
		...(typeof thinkingLevel === "string" ? { thinkingLevel } : {}),
	};
}

/** The model chain a helper names, or `[]` when it runs the session's model. */
export function helperModelPatterns(settings: Settings, id: HelperId): string[] {
	const model = helperSettingsFor(settings, id).model;
	return namesInheritedModel(model) ? [] : normalizeModelPatternList(model);
}

/** The effort a helper names, or undefined when it runs the session's effort. */
export function helperThinkingLevel(settings: Settings, id: HelperId): ConfiguredThinkingLevel | undefined {
	return parseConfiguredEffortSetting(
		helperSettingPath(id, "thinkingLevel"),
		helperSettingsFor(settings, id).thinkingLevel,
	);
}

/** The model a helper runs and the effort it runs at. */
export interface HelperModelSelection {
	model: Model<Api>;
	/** The effort to run at, fitted to `model`; undefined runs the session's effort. */
	thinkingLevel?: ConfiguredThinkingLevel;
	/** Whether the helper names no model and runs the session's. */
	inherited: boolean;
}

function fitThinkingLevel(
	model: Model<Api>,
	level: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel | undefined {
	if (level === undefined || level === AUTO_THINKING) return level;
	return resolveThinkingLevelForModel(model, level);
}

/**
 * Resolve the model and effort `id` runs.
 *
 * A configured chain answers with its first entry that matches an available
 * model. A `:level` suffix on that entry outranks the row's effort. A
 * configured chain that matches nothing returns undefined.
 *
 * An unset model runs `liveModel`, the session's current model. A caller with
 * no session (`veyyon commit`, a headless title) passes none, and the
 * persisted `defaultModel` answers instead.
 */
export function resolveHelperModel(
	settings: Settings,
	id: HelperId,
	availableModels: readonly Model<Api>[],
	liveModel?: Model<Api>,
): HelperModelSelection | undefined {
	const level = helperThinkingLevel(settings, id);
	const matchPreferences = getModelMatchPreferences(settings);
	const patterns = helperModelPatterns(settings, id);
	if (patterns.length > 0) {
		const resolved = resolveModelSelectorValue(patterns, availableModels, { settings, matchPreferences });
		if (!resolved.model) return undefined;
		return {
			model: resolved.model,
			thinkingLevel: resolved.explicitThinkingLevel
				? resolved.thinkingLevel
				: fitThinkingLevel(resolved.model, level),
			inherited: false,
		};
	}
	const model =
		liveModel ??
		resolveModelSelectorValue(settings.get("defaultModel"), availableModels, { settings, matchPreferences }).model;
	if (!model) return undefined;
	return { model, thinkingLevel: fitThinkingLevel(model, level), inherited: true };
}

/** The reasoning fields of a helper's one-shot request. */
export interface HelperReasoningOptions {
	reasoning: Effort | undefined;
	disableReasoning: boolean;
}

/**
 * The reasoning a helper's request to `model` sends: the helper's own effort, else the session's
 * effective effort, fitted to the efforts `model` offers. `off` disables reasoning; no effort at
 * all sends none, so the provider's default applies.
 */
export function helperReasoningOptions(
	model: Model<Api>,
	helperLevel: ConfiguredThinkingLevel | undefined,
	sessionLevel: ThinkingLevel | undefined,
): HelperReasoningOptions {
	const level = resolveThinkingLevelForModel(model, concreteThinkingLevel(helperLevel) ?? sessionLevel);
	return { reasoning: toReasoningEffort(level), disableReasoning: shouldDisableReasoning(level) };
}

/**
 * The output cap of a helper's one-shot request whose answer fits in `answerTokens`. A request that
 * sends an effort has none: a provider that takes an effort counts its reasoning inside the cap, so an
 * answer-sized cap cuts the reasoning off before any answer arrives.
 */
export function helperMaxTokens(options: HelperReasoningOptions, answerTokens: number | undefined): number | undefined {
	return options.reasoning === undefined ? answerTokens : undefined;
}
