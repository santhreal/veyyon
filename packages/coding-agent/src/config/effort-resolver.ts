import { logger } from "@veyyon/utils";
import {
	AUTO_THINKING,
	CLI_THINKING_LEVELS,
	type ConfiguredThinkingLevel,
	parseConfiguredThinkingLevel,
} from "../thinking";

export const ANY_MODEL_EFFORT_KEY = "*";

export const DEFAULT_EFFORT_POINTER =
	'To change the saved default, use /settings → Model → Default Effort, or run: veyyon config set defaultEffort \'{"*":"high"}\'.';

export type DefaultEffortList = Record<string, string>;

export type EffortSource = "session" | "selector" | "model-row" | "any-row" | "model-default";

export interface ResolvedEffort {
	level: ConfiguredThinkingLevel | undefined;
	source: EffortSource;
}

export interface EffortInputs {
	sessionOverride?: ConfiguredThinkingLevel | undefined;
	selectorLevel?: ConfiguredThinkingLevel | undefined;
	modelSelector?: string | undefined;
	defaultEffort?: DefaultEffortList | undefined;
}

const reportedUnusableEfforts = new Set<string>();

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

function rowLevel(raw: string | undefined, setting?: string): ConfiguredThinkingLevel | undefined {
	if (raw === undefined) return undefined;
	return setting === undefined ? parseConfiguredThinkingLevel(raw.trim()) : parseConfiguredEffortSetting(setting, raw);
}

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

export function withLegacyDefaultEffort(
	rows: DefaultEffortList | undefined,
	legacyLevel: string | null | undefined,
): DefaultEffortList {
	if (rows !== undefined) return { ...rows };
	const parsed = rowLevel(legacyLevel ?? undefined);
	return parsed === undefined ? {} : { [ANY_MODEL_EFFORT_KEY]: parsed };
}

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

export function formatEffortRow(selector: string, raw: string): string {
	const level = rowLevel(raw) ?? raw;
	const label = selector === ANY_MODEL_EFFORT_KEY ? "any model" : selector;
	return `${label} · ${level === AUTO_THINKING ? "auto" : level}`;
}
