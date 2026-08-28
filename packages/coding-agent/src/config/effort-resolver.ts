/** The one place that answers "what effort applies right now". Effort used to live in three stores with the precedence written inline at the */

import { logger } from "@veyyon/utils";
import {
	AUTO_THINKING,
	CLI_THINKING_LEVELS,
	type ConfiguredThinkingLevel,
	parseConfiguredThinkingLevel,
} from "../thinking";

/** The row key matching every model, i.e. the profile-wide default. */
export const ANY_MODEL_EFFORT_KEY = "*";

/** Where the saved default lives, appended by `/effort` (alias `/thinking`). The command changes THIS session only. Saying so, and saying where the durable */
export const DEFAULT_EFFORT_POINTER =
	'To change the saved default, use /settings → Model → Default Effort, or run: veyyon config set defaultEffort \'{"*":"high"}\'.';

/** The stored shape of `defaultEffort`: selector (or `*`) to configured effort. */
export type DefaultEffortList = Record<string, string>;

/** Where a resolved effort came from. Rendered by the status line, which marks a
 *  session override so a temporary choice never looks like a saved default. */
export type EffortSource = "session" | "selector" | "model-row" | "any-row" | "model-default";

export interface ResolvedEffort {
	level: ConfiguredThinkingLevel | undefined;
	source: EffortSource;
}

export interface EffortInputs {
	/** This session's override: `/effort` (alias `/thinking`), or the cycle keybinding. */
	sessionOverride?: ConfiguredThinkingLevel | undefined;
	/** An explicit `:level` on the selector the active role resolved through. */
	selectorLevel?: ConfiguredThinkingLevel | undefined;
	/** `provider/id` of the model about to run. */
	modelSelector?: string | undefined;
	/** The profile's `defaultEffort` rows, as stored. */
	defaultEffort?: DefaultEffortList | undefined;
}

/** Effort values already reported as unusable, so the warning is said once per process instead of once per read. `resolveEffort` runs on every status-line */
const reportedUnusableEfforts = new Set<string>();

/** Parse a persisted effort value, reporting one that names no level. Every settings-borne effort goes through here, so one typo is answered the */
export function parseConfiguredEffortSetting(setting: string, value: unknown): ConfiguredThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const parsed = parseConfiguredThinkingLevel(trimmed);
	if (parsed !== undefined) return parsed;
	const key = `${setting}=${trimmed}`;
	if (reportedUnusableEfforts.has(key)) return undefined;
	reportedUnusableEfforts.add(key);
	logger.warn(
		`Settings: ${setting} is "${trimmed}", which is not an effort level, so it is being ignored and the session's effort is inherited. ` +
			`Accepted values: ${CLI_THINKING_LEVELS.join(", ")}.`,
		{ setting, value: trimmed, accepted: CLI_THINKING_LEVELS },
	);
	return undefined;
}

/** Normalize a stored row value. Rows are hand-editable in `settings.json`, so a junk value is dropped rather than trusted: an unparseable effort must not */
function rowLevel(raw: string | undefined, setting?: string): ConfiguredThinkingLevel | undefined {
	if (raw === undefined) return undefined;
	return setting === undefined ? parseConfiguredThinkingLevel(raw.trim()) : parseConfiguredEffortSetting(setting, raw);
}

/** Resolve the effort for a run, with its origin. Order, highest first: */
export function resolveEffort(inputs: EffortInputs): ResolvedEffort {
	if (inputs.sessionOverride !== undefined) {
		return { level: inputs.sessionOverride, source: "session" };
	}
	if (inputs.selectorLevel !== undefined) {
		return { level: inputs.selectorLevel, source: "selector" };
	}
	const rows = inputs.defaultEffort ?? {};
	if (inputs.modelSelector) {
		const own = rowLevel(rows[inputs.modelSelector], `defaultEffort["${inputs.modelSelector}"]`);
		if (own !== undefined) return { level: own, source: "model-row" };
	}
	const any = rowLevel(rows[ANY_MODEL_EFFORT_KEY], `defaultEffort["${ANY_MODEL_EFFORT_KEY}"]`);
	if (any !== undefined) return { level: any, source: "any-row" };
	return { level: undefined, source: "model-default" };
}

/** Read the retired profile-wide `defaultThinkingLevel` as a `*` row only when the replacement `defaultEffort` setting is absent. */
export function withLegacyDefaultEffort(
	rows: DefaultEffortList | undefined,
	legacyLevel: string | null | undefined,
): DefaultEffortList {
	if (rows !== undefined) return { ...rows };
	const parsed = rowLevel(legacyLevel ?? undefined);
	return parsed === undefined ? {} : { [ANY_MODEL_EFFORT_KEY]: parsed };
}

/** The rows to store when something asks to persist an effort, i.e. the row that governs `modelSelector` set to `level` with every other row untouched. */
export function withPersistedEffort(
	rows: DefaultEffortList | undefined,
	legacyLevel: string | null | undefined,
	level: ConfiguredThinkingLevel,
	modelSelector?: string,
): DefaultEffortList {
	const migrated = withLegacyDefaultEffort(rows, legacyLevel);
	const governedByOwnRow =
		modelSelector !== undefined && resolveEffort({ modelSelector, defaultEffort: migrated }).source === "model-row";
	return { ...migrated, [governedByOwnRow ? modelSelector : ANY_MODEL_EFFORT_KEY]: level };
}

/** Human summary of a row's value for a settings list, e.g. `high` or `auto`. */
export function formatEffortRow(selector: string, raw: string): string {
	const level = rowLevel(raw) ?? raw;
	const label = selector === ANY_MODEL_EFFORT_KEY ? "any model" : selector;
	return `${label} · ${level === AUTO_THINKING ? "auto" : level}`;
}
