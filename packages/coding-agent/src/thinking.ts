// The owner, not the `@veyyon/agent-core` barrel. The barrel is the agent loop: 406 modules, including the
// whole `@veyyon/ai` streaming engine. `@veyyon/agent-core/thinking` is the six-entry ladder and a clamp.
// This file was RECORDED at 6 modules and was 407, because the gate that pinned it could not resolve this
// package's name; see `packages/utils/src/module-reach-workspace.ts`.
import { type ResolvedThinkingLevel, ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Model } from "@veyyon/ai";
// The effort ladder from the module that OWNS it, not through the `@veyyon/ai` barrel that
// re-exports it. `@veyyon/catalog/effort` imports nothing; the barrel is 325 modules, and this
// file is on `config/settings`'s path through the settings schema, which ~530 test files import.
import { Effort, THINKING_EFFORTS } from "@veyyon/catalog/effort";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@veyyon/catalog/model-thinking";

/**
 * Metadata used to render thinking selector values in the coding-agent UI.
 */
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
	// Accept unambiguous abbreviations (`xhi` → xhigh, `med` → medium) so every
	// selector surface (`--thinking`, `:suffix`, role values) parses alike.
	// Two-character minimum keeps single letters (`m`) from guessing.
	if (value.length < 2) return undefined;
	const matches = Object.keys(selectors).filter(selector => selector.startsWith(value));
	return matches.length === 1 ? selectors[matches[0]] : undefined;
}

/**
 * Parses a provider-facing effort value. Accepts unambiguous abbreviations.
 */
export function parseEffort(value: string | null | undefined): Effort | undefined {
	return getOwnSelector(EFFORT_BY_SELECTOR, value);
}

/**
 * Parses an agent-local thinking selector. Accepts unambiguous abbreviations.
 */
export function parseThinkingLevel(value: string | null | undefined): ThinkingLevel | undefined {
	return getOwnSelector(THINKING_LEVEL_BY_SELECTOR, value);
}

/**
 * Returns display metadata for a thinking selector.
 */
export function getThinkingLevelMetadata(level: ThinkingLevel): ThinkingLevelMetadata {
	return THINKING_LEVEL_METADATA[level];
}

/**
 * Converts an agent-local selector into the effort sent to providers.
 */
export function toReasoningEffort(level: ThinkingLevel | undefined): Effort | undefined {
	if (level === undefined || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) {
		return undefined;
	}
	return level;
}

/**
 * True when a selector explicitly requests provider-side reasoning disablement.
 */
export function shouldDisableReasoning(level: ThinkingLevel | undefined): boolean {
	return level === ThinkingLevel.Off;
}

/**
 * Resolves a selector against the current model while preserving explicit "off".
 */
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

/**
 * Sentinel selector for the coding-agent "auto" thinking mode. Kept entirely
 * inside the coding-agent layer: it is never an {@link Effort} or
 * {@link ThinkingLevel}, so provider mapping/clamping keeps seeing concrete
 * efforts. The session resolves `auto` to a concrete effort each turn.
 */
export const AUTO_THINKING = "auto" as const;

/** A thinking selector as configured by the user — a concrete level or `auto`. */
export type ConfiguredThinkingLevel = ThinkingLevel | typeof AUTO_THINKING;

/** Maps the session-level `auto` sentinel to `undefined`; concrete levels pass through. */
export function concreteThinkingLevel(level: ConfiguredThinkingLevel | undefined): ThinkingLevel | undefined {
	return level === AUTO_THINKING ? undefined : level;
}

/** Metadata used to render the `auto` selector value alongside concrete levels. */
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

/**
 * Parses a configured thinking selector, accepting `auto` in addition to every
 * value {@link parseThinkingLevel} accepts. {@link parseThinkingLevel} itself
 * stays strict so model-suffix parsing (`model:high`) keeps rejecting `auto`.
 */
export function parseConfiguredThinkingLevel(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	if (value === AUTO_THINKING) return AUTO_THINKING;
	return parseThinkingLevel(value);
}

/** Returns display metadata for a configured selector, including `auto`. */
export function getConfiguredThinkingLevelMetadata(level: ConfiguredThinkingLevel): ConfiguredThinkingLevelMetadata {
	return level === AUTO_THINKING ? AUTO_THINKING_METADATA : getThinkingLevelMetadata(level);
}

/** True when the model exposes named effort variants rather than fixed reasoning. */
export function hasConfigurableThinkingEffort(model: Model | undefined): model is Model {
	return model?.reasoning === true && getSupportedEfforts(model).length > 0;
}

/**
 * The complete configuration vocabulary.
 *
 * Model pickers narrow this vocabulary to the variants the active model
 * actually exposes. This follows OpenCode's variant contract: one mechanism,
 * model-specific valid names, and no silently clamped choices.
 */
export const CONFIGURED_THINKING_LEVELS: readonly ConfiguredThinkingLevel[] = [
	ThinkingLevel.Off,
	AUTO_THINKING,
	...THINKING_EFFORTS,
];

/** Return the valid configured choices for one model, in cycle order. */
export function configuredThinkingLevelsForModel(model: Model | undefined): readonly ConfiguredThinkingLevel[] {
	if (!model) return CONFIGURED_THINKING_LEVELS;
	const supported = getSupportedEfforts(model);
	if (supported.length === 0) return [];
	// On a routed row (effort lives in sibling model ids, not a wire field),
	// `off` and `auto` only mean something when an off sibling exists: without
	// an `off` route both silently send the default wire id with thinking
	// state unchanged, which reads as "off" doing nothing at all.
	const routing = model.thinking?.effortRouting;
	const offRoutable = routing === undefined || routing.off !== undefined;
	const offerOff = offRoutable && model.thinking?.requiresEffort !== true;
	return [...(offerOff ? [ThinkingLevel.Off] : []), ...(offRoutable ? [AUTO_THINKING] : []), ...supported];
}

/**
 * Bracketed argument hint for `/effort` listing the choices the model
 * actually accepts (`[off|auto|high|max]`), derived from the same row read as
 * every other surface. Undefined when the model exposes no effort control.
 */
export function thinkingLevelArgHint(model: Model | undefined): string | undefined {
	if (!model) return undefined;
	const levels = configuredThinkingLevelsForModel(model);
	return levels.length === 0 ? undefined : `[${levels.join("|")}]`;
}

/**
 * Thinking selectors accepted by the `--thinking` CLI flag. The CLI, settings,
 * model hub, chain editor, and cycle key all read the same ordered vocabulary.
 */
export const CLI_THINKING_LEVELS: readonly string[] = CONFIGURED_THINKING_LEVELS;

/** The value an effort picker stores for "no effort of my own — inherit". */
export const INHERIT_EFFORT_OPTION_VALUE = "";

/**
 * Why an effort picker has a single row, said in one sentence with one owner.
 *
 * A model whose effort lives in sibling model ids (or that has no effort field
 * at all) narrows to nothing, so the only honest row left is the inherit row. A
 * one-row list with no explanation reads as a broken screen, and every picker
 * has to say the same thing or the same model reads as differently broken on
 * each surface — which is the class this whole area exists to close. The label
 * is a parameter because the inherit row is called "Inherit" on the settings
 * rows and "Model default" in the model-selector step.
 */
export function noSelectableEffortNotice(inheritLabel = "Inherit"): string {
	return `This model exposes no selectable effort, so only ${inheritLabel} applies.`;
}

export interface ConfiguredThinkingLevelOptions {
	model?: Model;
	includeInherit?: boolean;
	inheritLabel?: string;
	inheritDescription?: string;
}

function effortDescription(level: ConfiguredThinkingLevel, model: Model | undefined): string {
	const metadata = getConfiguredThinkingLevelMetadata(level);
	if (level !== AUTO_THINKING || !model) return metadata.description;
	const supported = getSupportedEfforts(model);
	return `Choose per prompt from ${supported.join(", ")}`;
}

/**
 * Picker rows for the active model's named effort variants.
 *
 * Like OpenCode's variant selector, this shows only valid model-specific
 * choices plus Veyyon's `auto` and `off` controls. The base model remains the
 * first, suffix-free row when inheritance is enabled.
 *
 * With no model in scope the full vocabulary is offered rather than nothing.
 * Two real rows have no model and never will: `defaultEffort`'s any-model `*`
 * row and the blanket `subagent.thinkingLevel`. Both store a level that is
 * clamped against whatever model later runs, so a picker that went empty here
 * would turn every pick into a row deletion.
 */
export function configuredThinkingLevelOptions(
	options: ConfiguredThinkingLevelOptions = {},
): ReadonlyArray<{ value: string; label: string; description: string }> {
	const rows = configuredThinkingLevelsForModel(options.model).map(level => {
		const metadata = getConfiguredThinkingLevelMetadata(level);
		return {
			value: level,
			label: metadata.label,
			description: effortDescription(level, options.model),
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

/**
 * Parses a `--thinking` CLI value. Accepts every {@link parseConfiguredThinkingLevel}
 * selector (`off`, `auto`, `minimal`..`max`) but rejects
 * `inherit`: an explicit `inherit` on the command line would suppress the
 * settings/scoped-model fallback during startup resolution only to resolve back
 * to the provider default, which is never what the user means.
 */
export function parseCliThinkingLevel(value: string | null | undefined): ConfiguredThinkingLevel | undefined {
	const level = parseConfiguredThinkingLevel(value);
	return level === ThinkingLevel.Inherit ? undefined : level;
}

/**
 * Resolves an auto-classified effort against the active model's supported
 * range. Unlike {@link clampThinkingLevelForModel}, `auto` never resolves below
 * {@link Effort.Low}: the eligible pool is the model's supported efforts at or
 * above Low (falling back to the full supported set only when the model maxes
 * out below Low). Within that pool the request snaps to the highest level not
 * exceeding it, or the pool minimum when the request is below the pool.
 *
 * Returns `undefined` for reasoning-capable models without a controllable
 * effort surface (`thinking.efforts` empty — e.g. devin-agent models, where
 * Cascade selects effort by routing to sibling model ids). Matches
 * {@link clampThinkingLevelForModel}: with no effort to pick, `auto` must not
 * forward a concrete effort that would then trip {@link requireSupportedEffort}
 * downstream.
 */
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

/**
 * The provisional concrete level shown while `auto` is configured but before a
 * turn has been classified. Prefers the model's `defaultLevel`, otherwise High,
 * clamped into the auto range. Auto never provisions {@link Effort.Max} (the
 * classifier ceiling is XHigh; only an explicit user request reaches Max), so a
 * `defaultLevel` of `max` is capped at XHigh before clamping. Returns
 * `undefined` for non-reasoning models.
 */
export function resolveProvisionalAutoLevel(model: Model | undefined): Effort | undefined {
	if (!model?.reasoning) return undefined;
	const preferred = model.thinking?.defaultLevel ?? Effort.High;
	return clampAutoThinkingEffort(model, preferred === Effort.Max ? Effort.XHigh : preferred);
}
