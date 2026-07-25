/**
 * The one owner of "when does auto-compaction trigger?".
 *
 * There used to be TWO settings on this single axis — `compaction.thresholdTokens`
 * (absolute) and `compaction.thresholdPercent` (percent of window) — both labelled
 * "Compaction Threshold" in the UI, both defaulting to the `-1` sentinel, and with
 * their precedence recorded nowhere but a comment above the resolver. An operator
 * reading the settings list could not tell which one was in force, and setting the
 * one nearer the top silently did nothing when the other was already set
 * (operator review 2026-07-24).
 *
 * Now there is one value whose UNIT IS PART OF THE VALUE:
 *
 *   auto     the window minus the reserve (the historical default behavior)
 *   85%      a percent of whatever window the current model has
 *   170000   an absolute token amount, the same on every model
 *
 * The two legacy keys are folded in here, at exactly one read boundary, the same
 * way {@link withLegacyDefaultEffort} folds the retired `defaultThinkingLevel`
 * into the Default Effort list: nothing else in the codebase may consult them.
 */
import { clamp, clampLow } from "@veyyon/utils/math";

/** The value meaning "derive the threshold from the window and the reserve". */
export const AUTO_COMPACTION_THRESHOLD = "auto";

/** A parsed threshold. `invalidRaw` carries text that parsed as nothing. */
export type CompactionThresholdSpec =
	| { kind: "auto"; invalidRaw?: string }
	| { kind: "percent"; percent: number }
	| { kind: "tokens"; tokens: number };

/** Which key supplied the value the resolver used. */
export type CompactionThresholdOrigin = "auto" | "percent" | "tokens";

export interface ResolvedCompactionThreshold {
	/** Context tokens above which compaction triggers. */
	tokens: number;
	origin: CompactionThresholdOrigin;
	/**
	 * The amount the operator configured, before clamping: tokens for `tokens`,
	 * percent for `percent`, absent for `auto`.
	 */
	configured?: number;
	/** True when {@link tokens} had to be reduced to fit the current window. */
	clamped: boolean;
	/**
	 * Set when the value came from a retired key rather than `compaction.threshold`,
	 * so a migration notice can name the key the operator actually has on disk.
	 */
	legacyKey?: "thresholdTokens" | "thresholdPercent";
	/**
	 * Set when the configured text parsed as nothing and `auto` was used instead.
	 * Callers MUST surface this: a threshold that silently reverts to auto is the
	 * difference between compacting at 170k and compacting at 184k, invisibly.
	 */
	invalidRaw?: string;
}

/**
 * Parse a threshold value. Accepts `auto`, a percent (`85%`, `85 %`), or an
 * absolute token amount (`170000`, `170_000`).
 *
 * A non-positive number is `auto`: that is the `-1` sentinel the retired keys
 * used, and `0` means "no budget at all", which is never what an operator wants.
 * Anything else unparseable is `auto` WITH `invalidRaw` set, so the caller can
 * say so out loud instead of quietly compacting at a different point.
 */
export function parseCompactionThreshold(raw: string | number | undefined | null): CompactionThresholdSpec {
	if (raw === undefined || raw === null) return { kind: "auto" };

	if (typeof raw === "number") {
		if (!Number.isFinite(raw) || raw <= 0) return { kind: "auto" };
		return { kind: "tokens", tokens: raw };
	}

	const text = raw.trim().toLowerCase();
	if (text === "" || text === AUTO_COMPACTION_THRESHOLD || text === "default") return { kind: "auto" };

	if (text.endsWith("%")) {
		const percent = Number(text.slice(0, -1).trim());
		if (!Number.isFinite(percent) || percent <= 0) return { kind: "auto" };
		return { kind: "percent", percent };
	}

	const tokens = Number(text.replace(/_/g, ""));
	if (!Number.isFinite(tokens)) return { kind: "auto", invalidRaw: raw };
	if (tokens <= 0) return { kind: "auto" };
	return { kind: "tokens", tokens };
}

/** Inputs the migration needs: the current key plus the two retired ones. */
export interface LegacyThresholdInputs {
	threshold?: string | number;
	thresholdTokens?: number;
	thresholdPercent?: number;
}

/**
 * Resolve which of the three keys supplies the threshold, preserving the exact
 * precedence the retired resolver had (absolute amount, then percent, then auto)
 * so an existing config keeps compacting at the same point after the collapse.
 *
 * Never mutates its input; the retired keys are read here and nowhere else.
 */
export function withLegacyCompactionThreshold(inputs: LegacyThresholdInputs): {
	spec: CompactionThresholdSpec;
	legacyKey?: "thresholdTokens" | "thresholdPercent";
} {
	const current = parseCompactionThreshold(inputs.threshold);
	if (current.kind !== "auto" || current.invalidRaw !== undefined) return { spec: current };

	const legacyTokens = parseCompactionThreshold(inputs.thresholdTokens);
	if (legacyTokens.kind === "tokens") return { spec: legacyTokens, legacyKey: "thresholdTokens" };

	const legacyPercent = inputs.thresholdPercent;
	if (typeof legacyPercent === "number" && Number.isFinite(legacyPercent) && legacyPercent > 0) {
		return { spec: { kind: "percent", percent: legacyPercent }, legacyKey: "thresholdPercent" };
	}

	return { spec: { kind: "auto" } };
}

/** Percent thresholds are clamped here so a hand-edited `150%` cannot disable compaction. */
const MIN_THRESHOLD_PERCENT = 1;
const MAX_THRESHOLD_PERCENT = 99;

/**
 * Resolve the threshold to tokens for a given window, reporting WHERE the number
 * came from so callers can print it instead of leaving the operator to guess
 * which of three keys won.
 *
 * `autoTokens` is the auto behavior (window minus reserve), passed in rather than
 * computed here because the reserve rules live with the reserve
 * (`resolveBudgetReserveTokens`) — this module owns the choice between units, not
 * the reserve policy.
 */
export function resolveCompactionThreshold(
	contextWindow: number,
	inputs: LegacyThresholdInputs,
	autoTokens: () => number,
): ResolvedCompactionThreshold {
	const { spec, legacyKey } = withLegacyCompactionThreshold(inputs);

	if (spec.kind === "tokens") {
		// `clampLow`, not `clamp`: a degenerate window inverts the range (low 1, high 0)
		// and the LOW bound has to win, because a threshold of zero or less is above every
		// possible context size and would compact on every single turn. The two helpers
		// agree everywhere else. Non-finite and non-positive amounts never arrive here at
		// all — `parseCompactionThreshold` sends them to auto — so the helper's own
		// non-finite guard is defence in depth rather than the live path.
		const tokens = clampLow(spec.tokens, 1, contextWindow - 1);
		return { tokens, origin: "tokens", configured: spec.tokens, clamped: tokens < spec.tokens, legacyKey };
	}

	if (spec.kind === "percent") {
		const clampedPercent = clamp(spec.percent, MIN_THRESHOLD_PERCENT, MAX_THRESHOLD_PERCENT);
		return {
			tokens: Math.floor(contextWindow * (clampedPercent / 100)),
			origin: "percent",
			configured: spec.percent,
			clamped: clampedPercent !== spec.percent,
			legacyKey,
		};
	}

	return {
		tokens: clampLow(autoTokens(), 0, contextWindow - 1),
		origin: "auto",
		clamped: false,
		legacyKey,
		invalidRaw: spec.invalidRaw,
	};
}

/** Round a token count the way the status line does, for notice text. */
function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

/**
 * One-line description of a resolved threshold, including its origin, for every
 * place compaction announces itself. Reading `170k (85% of 200k)` tells the
 * operator both the trigger and which knob produced it, which is the whole point
 * of the collapse.
 */
export function formatCompactionThreshold(resolved: ResolvedCompactionThreshold, contextWindow: number): string {
	const tokens = formatTokens(resolved.tokens);
	if (resolved.origin === "percent") {
		return `${tokens} (${resolved.configured}% of ${formatTokens(contextWindow)})`;
	}
	if (resolved.origin === "tokens") {
		return resolved.clamped
			? `${tokens} (fixed ${formatTokens(resolved.configured ?? 0)}, capped to this model's ${formatTokens(contextWindow)} window)`
			: `${tokens} (fixed)`;
	}
	return `${tokens} (auto: ${formatTokens(contextWindow)} window minus reserve)`;
}
