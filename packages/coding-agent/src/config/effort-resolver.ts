/**
 * The one place that answers "what effort applies right now".
 *
 * Effort used to live in three stores with the precedence written inline at the
 * call site, so nothing could tell you which one was in effect: a profile-wide
 * `defaultThinkingLevel` enum, a `:level` suffix on a model selector, and the
 * session's own level. The operator's verdict was "effort level is very muddled"
 * (2026-07-24).
 *
 * There is now one persisted, user-visible store — the `defaultEffort` list of
 * model to effort rows, per profile — and one ordered rule, below. A `*` row
 * carries what the old global enum meant, so the global default is a member of
 * the same list instead of a separate setting, and because the list is
 * structured rather than a selector string, `auto` is a legal row value. That is
 * what let the third store go away: `auto` never fit in a `model:high` suffix,
 * which is the only reason the enum existed.
 */

import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";

/** The row key matching every model, i.e. the profile-wide default. */
export const ANY_MODEL_EFFORT_KEY = "*";

/**
 * Where the saved default lives, appended by `/effort` (alias `/thinking`).
 *
 * The command changes THIS session only. Saying so, and saying where the durable
 * setting is, is what keeps one axis from feeling like two: before this, typing
 * the command silently rewrote the profile default while the cycle keybinding did
 * not, so the same change stuck or evaporated depending on how you made it.
 *
 * BOTH REMEDIES, because `/effort` is a text-mode command and this sentence
 * reaches ACP, where `/settings` is neither advertised nor dispatchable. Naming
 * only the settings screen sent a client without a terminal to a command it
 * cannot type, with nothing else to do.
 */
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

/**
 * Normalize a stored row value. Rows are hand-editable in `settings.json`, so a
 * junk value is dropped rather than trusted: an unparseable effort must not
 * silently become `off` (which would quietly disable thinking) nor throw at
 * request time.
 */
function rowLevel(raw: string | undefined): ConfiguredThinkingLevel | undefined {
	return raw === undefined ? undefined : parseConfiguredThinkingLevel(raw.trim());
}

/**
 * Resolve the effort for a run, with its origin.
 *
 * Order, highest first:
 *  1. the session override — you asked for it just now, in this session
 *  2. an explicit `:level` on the role's selector — a deliberate per-role pin
 *  3. the `defaultEffort` row for this model
 *  4. the `*` row (the profile-wide default)
 *  5. nothing set: the model's own default
 *
 * `auto` is legal at every level; callers map it to a concrete effort per turn.
 */
export function resolveEffort(inputs: EffortInputs): ResolvedEffort {
	if (inputs.sessionOverride !== undefined) {
		return { level: inputs.sessionOverride, source: "session" };
	}
	if (inputs.selectorLevel !== undefined) {
		return { level: inputs.selectorLevel, source: "selector" };
	}
	const rows = inputs.defaultEffort ?? {};
	if (inputs.modelSelector) {
		const own = rowLevel(rows[inputs.modelSelector]);
		if (own !== undefined) return { level: own, source: "model-row" };
	}
	const any = rowLevel(rows[ANY_MODEL_EFFORT_KEY]);
	if (any !== undefined) return { level: any, source: "any-row" };
	return { level: undefined, source: "model-default" };
}

/**
 * Read the retired profile-wide `defaultThinkingLevel` as a `*` row only when
 * the replacement `defaultEffort` setting is absent.
 *
 * Presence is authoritative, including an explicitly stored empty object. That
 * distinction is what lets deleting the Any Model row stick: folding the legacy
 * enum into every present object would immediately recreate a row the operator
 * just removed.
 */
export function withLegacyDefaultEffort(
	rows: DefaultEffortList | undefined,
	legacyLevel: string | null | undefined,
): DefaultEffortList {
	if (rows !== undefined) return { ...rows };
	const parsed = rowLevel(legacyLevel ?? undefined);
	return parsed === undefined ? {} : { [ANY_MODEL_EFFORT_KEY]: parsed };
}

/**
 * The rows to store when something asks to persist an effort, i.e. the row that
 * governs `modelSelector` set to `level` with every other row untouched.
 *
 * This exists because a durable write has to land in the SAME setting the
 * resolver reads. Persisting used to write the retired `defaultThinkingLevel`
 * enum, and {@link withLegacyDefaultEffort} consults that key only when
 * `defaultEffort` is absent, so for anyone who had opened the settings screen
 * once the write reached `settings.json` and then changed nothing, forever. A
 * write whose value is silently discarded on the next read is worse than a
 * write that fails.
 *
 * Writing the `*` row unconditionally is the same defect one precedence step
 * later. A per-model row outranks `*`, so pinning an effort while a row exists
 * for the model you are on stores a value {@link resolveEffort} never reaches:
 * with `{"anthropic/claude-opus-4":"low"}` stored, persisting `high` on that
 * model leaves it resolving `low`. Which row governs is asked of `resolveEffort`
 * rather than restated here, so this cannot drift from the precedence table --
 * and it answers correctly for a row holding an unparseable value, which does
 * NOT govern and must not be the one written.
 *
 * Folding the legacy value in first is deliberate: it migrates a profile that
 * still carries only the retired enum, instead of dropping that operator's
 * saved level the first time anything persists.
 */
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
