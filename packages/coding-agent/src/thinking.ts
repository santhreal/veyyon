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

/**
 * The choices ONE model accepts, in cycle order.
 *
 * No model means no choices. It used to mean the whole vocabulary, on the
 * theory that a level with nothing to narrow against is stored and clamped
 * later — but a picker cannot tell the reader that. It showed `minimal` for a
 * row whose endpoint declares `low, high, max`, and it would invent a ladder
 * for `cursor-grok-4.6-medium`, whose id IS its effort and whose row exposes no
 * control at all. A level nobody declared is never offered here; a surface with
 * genuinely no model in scope asks for {@link configuredThinkingLevelsInScope}
 * instead, which is a fact about the catalog rather than a constant.
 */
export function configuredThinkingLevelsForModel(model: Model | undefined): readonly ConfiguredThinkingLevel[] {
	if (!model) return [];
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
 * The choices a BLANKET row can offer: the union of what the models in scope
 * declare, in canonical order.
 *
 * Two rows have no single model and never will — Default Effort's any-model `*`
 * row and `subagent.thinkingLevel` with no chain — and each stores a level that
 * is clamped against whatever model later runs. They still may not invent: the
 * union is what SOME model in this session's catalog actually accepts, so every
 * row offered is addressable somewhere, and a catalog that declares nothing
 * yields nothing rather than the full vocabulary.
 */
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
	/** The one model this picker sits under. */
	model?: Model;
	/**
	 * The catalog a BLANKET row spans, used only when `model` is absent: the rows
	 * offered are the union of what these models declare. Absent as well means no
	 * scope at all, and a picker with no scope offers no levels rather than a
	 * vocabulary nothing in the session accepts.
	 */
	scope?: ReadonlyArray<Model>;
	includeInherit?: boolean;
	inheritLabel?: string;
	inheritDescription?: string;
}

/**
 * The row description for one level.
 *
 * `auto` names the efforts it will choose between, so a blanket row says what
 * its own union accepts rather than the vocabulary's `low–xhigh` shorthand — a
 * row that prints a level nothing in scope declares is the defect this module
 * exists to prevent, and a description is as visible as a label.
 */
function effortDescription(level: ConfiguredThinkingLevel, efforts: ReadonlyArray<ConfiguredThinkingLevel>): string {
	const metadata = getConfiguredThinkingLevelMetadata(level);
	if (level !== AUTO_THINKING || efforts.length === 0) return metadata.description;
	return `Choose per prompt from ${efforts.join(", ")}`;
}

/**
 * Picker rows for the effort variants something in scope actually declares.
 *
 * Like OpenCode's variant selector, this shows only valid model-specific
 * choices plus Veyyon's `auto` and `off` controls. The base model remains the
 * first, suffix-free row when inheritance is enabled.
 *
 * Nothing is offered that nothing accepts. A picker under one model shows that
 * model's declared ladder; a blanket row passes `scope` and shows the union its
 * catalog declares; a surface with neither shows only the inherit row. The
 * vocabulary constant is never a picker's answer — offering `minimal` on a row
 * that declares `low, high, max` is the whole reason this narrowing exists.
 */
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
