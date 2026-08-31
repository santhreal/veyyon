/**
 * The one owner of "this numeric setting is unset".
 *
 * Numeric settings that mean "let the provider decide" encoded that as `-1`, and
 * the encoding was written out by hand at every site: thirteen schema entries each
 * declared their own `Default` submenu option (some with the value `"-1"`, some
 * with the value `"default"` plus a hand-maintained path list in the selector to
 * translate it), and each read site re-derived unset with its own comparison
 * (`>= 0 ? … : undefined`, `> 0`, `=== -1`). Two consequences, both real:
 *
 *  - The settings list showed `Default` for one setting and a literal `-1` for the
 *    next, and `veyyon config get` printed `-1` either way, so a reader could not
 *    tell unset from a genuinely negative value.
 *  - `presencePenalty` and `repetitionPenalty` accept negative values at the
 *    providers, and the `>= 0` read dropped every one of them. Setting a negative
 *    penalty did nothing, silently.
 *
 * So: unset is the ABSENCE of a value, spelled once here and translated once by
 * {@link optionalNumber}. Nothing in a live config means unset any more —
 * `-1` was a marker in versions before the switch, and the load migration in
 * `config/settings.ts` drops it from these paths on every read (global, project,
 * and `--config` overlays alike), so no read site ever sees it. That is what
 * makes `-1` reachable as a real presence penalty.
 */

/**
 * The value these settings used to store to mean "unset".
 *
 * Kept only so the UI can still recognise it while rendering a config an older
 * version wrote, and so the migration has one name for it. Never write it.
 */
export const UNSET_NUMBER = -1;

/** The submenu value the UI uses for unset. Never the raw number. */
export const UNSET_NUMBER_OPTION_VALUE = "default";

/** The submenu label for unset. */
export const UNSET_NUMBER_OPTION_LABEL = "Default";

/**
 * The `Default` row for a numeric setting's submenu.
 *
 * Typed structurally rather than as `SubmenuOption` so this module imports nothing:
 * the schema imports IT (for `isUnsetNumberPath`) and so do the domain slices the
 * schema composes, so a type import back the other way would close a cycle.
 *
 * Every optional numeric setting builds its unset row from this, so a new setting
 * cannot introduce a fourteenth spelling of the same idea.
 */
export function unsetNumberOption(description = "Use the provider default"): {
	value: string;
	label: string;
	description: string;
} {
	return { value: UNSET_NUMBER_OPTION_VALUE, label: UNSET_NUMBER_OPTION_LABEL, description };
}

/**
 * A configured numeric setting, or `undefined` when it is unset.
 *
 * Unset is a MISSING value: `undefined`, `null`, or something that is not a finite
 * number. Every finite number is a value, including `-1` and `-0.5`. Read sites
 * must use this rather than a range test — `>= 0` also discards legitimate
 * negative values, which is how negative sampling penalties became unreachable.
 */
export function optionalNumber(value: number | undefined | null): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (!Number.isFinite(value)) return undefined;
	return value;
}

/**
 * A configured numeric setting that must be positive to mean anything (a token
 * count, a timeout, a window size), or `undefined`.
 *
 * Separate from {@link optionalNumber} because "unset" and "not a usable amount"
 * are different questions, and answering both with one range test is what left
 * `0` and `-1` indistinguishable at the call sites.
 */
export function optionalPositiveNumber(value: number | undefined | null): number | undefined {
	const configured = optionalNumber(value);
	return configured !== undefined && configured > 0 ? configured : undefined;
}

/**
 * The sampling knobs a session can carry, as the agent holds them. Named here
 * rather than in the selector so the settings schema, the SDK's session
 * construction, and the live-apply path all describe the same six values.
 */
export interface SamplingKnobs {
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
}

export type SamplingKnob = keyof SamplingKnobs;

const SAMPLING_KNOB_SETTERS: { [K in SamplingKnob]-?: (agent: SamplingKnobs, value: number | undefined) => void } = {
	temperature: (agent, value) => {
		agent.temperature = value;
	},
	topP: (agent, value) => {
		agent.topP = value;
	},
	topK: (agent, value) => {
		agent.topK = value;
	},
	minP: (agent, value) => {
		agent.minP = value;
	},
	presencePenalty: (agent, value) => {
		agent.presencePenalty = value;
	},
	repetitionPenalty: (agent, value) => {
		agent.repetitionPenalty = value;
	},
};

/** True when `id` names one of the sampling knobs. */
export function isSamplingKnob(id: string): id is SamplingKnob {
	return id in SAMPLING_KNOB_SETTERS;
}

/**
 * Apply a sampling knob to a live agent by its setting id. Typed per knob rather
 * than through an index signature, so adding a knob to {@link SamplingKnobs}
 * fails to compile until it is wired here too.
 */
export function applySamplingKnob(agent: SamplingKnobs, id: SamplingKnob, value: number | undefined): void {
	SAMPLING_KNOB_SETTERS[id](agent, value);
}

/** Coerce a settings-selector value to a number, or undefined when it is not one. */
export function toNumberOrUndefined(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
