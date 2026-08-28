import { type ResolvedThinkingLevel, ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Model } from "@veyyon/ai";
import { Effort, THINKING_EFFORTS } from "@veyyon/catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@veyyon/catalog/model-thinking";

export interface ThinkingLevelMetadata {
	value: ThinkingLevel;
	label: string;
	description: string;
}

const THINKING_LEVEL_METADATA: Record<ThinkingLevel, ThinkingLevelMetadata> = {
	[ThinkingLevel.Inherit]: {
		value: ThinkingLevel.Inherit,
		label: "inherit",
		description: "Inherit session default",
	},
	[ThinkingLevel.Off]: { value: ThinkingLevel.Off, label: "off", description: "No reasoning" },
	[ThinkingLevel.Minimal]: {
		value: ThinkingLevel.Minimal,
		label: "minimal",
		description: "Very brief reasoning (~1k tokens)",
	},
	[ThinkingLevel.Low]: { value: ThinkingLevel.Low, label: "low", description: "Light reasoning (~2k tokens)" },
	[ThinkingLevel.Medium]: {
		value: ThinkingLevel.Medium,
		label: "medium",
		description: "Moderate reasoning (~8k tokens)",
	},
	[ThinkingLevel.High]: { value: ThinkingLevel.High, label: "high", description: "Deep reasoning (~16k tokens)" },
	[ThinkingLevel.XHigh]: {
		value: ThinkingLevel.XHigh,
		label: "xhigh",
		description: "Extended reasoning (~32k tokens)",
	},
	[ThinkingLevel.Max]: {
		value: ThinkingLevel.Max,
		label: "max",
		description: "Maximum reasoning the model supports",
	},
};

const EFFORT_BY_SELECTOR: Readonly<Record<string, Effort>> = {
	[Effort.Minimal]: Effort.Minimal,
	[Effort.Low]: Effort.Low,
	[Effort.Medium]: Effort.Medium,
	[Effort.High]: Effort.High,
	[Effort.XHigh]: Effort.XHigh,
	[Effort.Max]: Effort.Max,
};
const THINKING_LEVEL_BY_SELECTOR: Readonly<Record<string, ThinkingLevel>> = {
	[ThinkingLevel.Inherit]: ThinkingLevel.Inherit,
	[ThinkingLevel.Off]: ThinkingLevel.Off,
	[ThinkingLevel.Minimal]: ThinkingLevel.Minimal,
	[ThinkingLevel.Low]: ThinkingLevel.Low,
	[ThinkingLevel.Medium]: ThinkingLevel.Medium,
	[ThinkingLevel.High]: ThinkingLevel.High,
	[ThinkingLevel.XHigh]: ThinkingLevel.XHigh,
	[ThinkingLevel.Max]: ThinkingLevel.Max,
};

function getOwnSelector<T>(selectors: Readonly<Record<string, T>>, value: string | null | undefined): T | undefined {
	if (value === undefined || value === null) return undefined;
	if (Object.hasOwn(selectors, value)) return selectors[value];
	if (value.length < 2) return undefined;
	const matches = Object.keys(selectors).filter(selector => selector.startsWith(value));
	return matches.length === 1 ? selectors[matches[0]] : undefined;
}

export function parseEffort(value: string | null | undefined): Effort | undefined {
	return getOwnSelector(EFFORT_BY_SELECTOR, value);
}

export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	return getOwnSelector(THINKING_LEVEL_BY_SELECTOR, value);
}

export function getThinkingLevelMetadata(level: ThinkingLevel): ThinkingLevelMetadata {
	return THINKING_LEVEL_METADATA[level];
}

export function toReasoningEffort(level: ThinkingLevel | undefined): Effort | undefined {
	if (level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	return level;
}

export function shouldDisableReasoning(level: ThinkingLevel | undefined): boolean {
	return level === ThinkingLevel.Off;
}

export function resolveThinkingLevelForModel(
	model: Model | undefined,
	level: ThinkingLevel | undefined,
): ResolvedThinkingLevel | undefined {
	if (level === undefined || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	if (level === ThinkingLevel.Off) {
		return ThinkingLevel.Off;
	}
	return clampThinkingLevelForModel(model, level);
}

export const AUTO_THINKING = "auto" as const;

export type ConfiguredThinkingLevel = ThinkingLevel | typeof AUTO_THINKING;

export function concreteThinkingLevel(level: ConfiguredThinkingLevel | undefined): ThinkingLevel | undefined {
	return level === AUTO_THINKING ? undefined : level;
}

export interface ConfiguredThinkingLevelMetadata {
	value: ConfiguredThinkingLevel;
	label: string;
	description: string;
}

const AUTO_THINKING_METADATA: ConfiguredThinkingLevelMetadata = {
	value: AUTO_THINKING,
	label: "auto",
	description: "Auto-detect per prompt (low–xhigh)",
};

export function parseConfiguredThinkingLevel(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	if (value === AUTO_THINKING) return AUTO_THINKING;
	return parseThinkingLevel(value);
}

export function getConfiguredThinkingLevelMetadata(level: ConfiguredThinkingLevel): ConfiguredThinkingLevelMetadata {
	return level === AUTO_THINKING ? AUTO_THINKING_METADATA : getThinkingLevelMetadata(level);
}

export function hasConfigurableThinkingEffort(model: Model | undefined): model is Model {
	return model?.reasoning === true && getSupportedEfforts(model).length > 0;
}

export const CONFIGURED_THINKING_LEVELS: readonly ConfiguredThinkingLevel[] = [
	ThinkingLevel.Off,
	AUTO_THINKING,
	...THINKING_EFFORTS,
];

export function configuredThinkingLevelsForModel(model: Model | undefined): readonly ConfiguredThinkingLevel[] {
	if (!model) return [];
	const supported = getSupportedEfforts(model);
	if (supported.length === 0) return [];
	const routing = model.thinking?.effortRouting;
	const offRoutable = routing === undefined || routing.off !== undefined;
	const offerOff = offRoutable && model.thinking?.requiresEffort !== true;
	return [...(offerOff ? [ThinkingLevel.Off] : []), ...(offRoutable ? [AUTO_THINKING] : []), ...supported];
}

export function configuredThinkingLevelsInScope(
	models: ReadonlyArray<Model> | undefined,
): readonly ConfiguredThinkingLevel[] {
	if (!models || models.length === 0) return [];
	const seen = new Set<ConfiguredThinkingLevel>();
	for (const model of models) {
		for (const level of configuredThinkingLevelsForModel(model)) seen.add(level);
	}
	return CONFIGURED_THINKING_LEVELS.filter(level => seen.has(level));
}

export function thinkingLevelArgHint(model: Model | undefined): string | undefined {
	if (!model) return undefined;
	const levels = configuredThinkingLevelsForModel(model);
	return levels.length === 0 ? undefined : `[${levels.join("|")}]`;
}

export const CLI_THINKING_LEVELS: readonly string[] = CONFIGURED_THINKING_LEVELS;

export const INHERIT_EFFORT_OPTION_VALUE = "";

export function noSelectableEffortNotice(inheritLabel = "Inherit"): string {
	return `This model exposes no selectable effort, so only ${inheritLabel} applies.`;
}

export interface ConfiguredThinkingLevelOptions {
	model?: Model;
	scope?: ReadonlyArray<Model>;
	includeInherit?: boolean;
	inheritLabel?: string;
	inheritDescription?: string;
}

function effortDescription(level: ConfiguredThinkingLevel, efforts: ReadonlyArray<ConfiguredThinkingLevel>): string {
	const metadata = getConfiguredThinkingLevelMetadata(level);
	if (level !== AUTO_THINKING || efforts.length === 0) return metadata.description;
	return `Choose per prompt from ${efforts.join(", ")}`;
}

export function configuredThinkingLevelOptions(
	options: ConfiguredThinkingLevelOptions = {},
): ReadonlyArray<{ value: string; label: string; description: string }> {
	const levels = options.model
		? configuredThinkingLevelsForModel(options.model)
		: configuredThinkingLevelsInScope(options.scope);
	const efforts = levels.filter(level => level !== AUTO_THINKING && level !== ThinkingLevel.Off);
	const rows = levels.map(level => {
		const metadata = getConfiguredThinkingLevelMetadata(level);
		return {
			value: level,
			label: metadata.label,
			description: effortDescription(level, efforts),
		};
	});
	if (options.includeInherit === false) return rows;
	return [
		{
			value: INHERIT_EFFORT_OPTION_VALUE,
			label: options.inheritLabel ?? "Inherit",
			description: options.inheritDescription ?? "Follow the session's effort",
		},
		...rows,
	];
}

export function parseCliThinkingLevel(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	const level = parseConfiguredThinkingLevel(value);
	return level === ThinkingLevel.Inherit ? undefined : level;
}

export function clampAutoThinkingEffort(model: Model | undefined, effort: Effort): Effort | undefined {
	const supported = model ? getSupportedEfforts(model) : THINKING_EFFORTS;
	if (supported.length === 0) return undefined;
	const lowIndex = THINKING_EFFORTS.indexOf(Effort.Low);
	const eligible = supported.filter(level => THINKING_EFFORTS.indexOf(level) >= lowIndex);
	const pool = eligible.length > 0 ? eligible : supported;
	const requestedIndex = THINKING_EFFORTS.indexOf(effort);
	let chosen = pool[0];
	for (const candidate of pool) {
		if (THINKING_EFFORTS.indexOf(candidate) > requestedIndex) break;
		chosen = candidate;
	}
	return chosen;
}

export function resolveProvisionalAutoLevel(model: Model | undefined): Effort | undefined {
	if (!model?.reasoning) return undefined;
	const preferred = model.thinking?.defaultLevel ?? Effort.High;
	return clampAutoThinkingEffort(model, preferred === Effort.Max ? Effort.XHigh : preferred);
}
