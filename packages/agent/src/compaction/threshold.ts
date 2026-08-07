/**
 * The one owner of "when does auto-compaction trigger?", which now includes the settings shape the
 * decision reads and the reserve policy the auto behaviour needs.
 *
 * THE SECOND HALF ARRIVED LATE, and why it had to is worth recording. `CompactionSettings`,
 * `resolveBudgetReserveTokens`, `shouldCompact` and the three threshold wrappers lived in
 * `./compaction.ts`, the module that RUNS a compaction: it imports the `@veyyon/ai` barrel, the provider
 * dialects, the prompt registry and the tokenizer, because summarizing a conversation needs all of that.
 * Asking "is 170k over the trigger?" needs none of it. So every host that only wanted the trigger paid
 * for the engine: `packages/coding-agent/src/config/compaction-strategy.ts` named
 * `@veyyon/agent-core/compaction` for `resolveThresholdTokens` alone, and through it `config/settings.ts`
 * -- the most imported module in that package, 528 test files -- reached `@veyyon/ai/stream.ts`. An
 * architecture gate there asserted the opposite and passed, because its resolution table did not know
 * this package's name (see `packages/utils/src/module-reach-workspace.ts`).
 *
 * Everything here is arithmetic over primitives and imports two clamps. `./compaction.ts` re-exports all
 * of it, so no caller changed.
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
	/**
	 * True when the configured amount exceeds the current window, so the
	 * resolver capped it. Strictly greater only: at equality the amount fits
	 * the window, and the one-token reduction to `window - 1` is the
	 * resolver's below-window invariant, not lost headroom — a notice that
	 * claims "larger than" there is wrong.
	 */
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
		// `clamped` is strict `>`, not `tokens < spec.tokens`: at equality the
		// cap removes exactly one token (the below-window invariant), which no
		// display precision even shows, and callers word the notice "larger
		// than the window" — false at equality.
		return { tokens, origin: "tokens", configured: spec.tokens, clamped: spec.tokens > contextWindow, legacyKey };
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

export interface CompactionSettings {
	enabled: boolean;
	/**
	 * How compaction reduces the context: summarize in place, or hand off to a
	 * new session. There are exactly two.
	 *
	 * It used to admit `"context-full"`, `"shake"` and `"off"` as well. The first
	 * two are engine actions, not user strategies, and were folded into `summary`
	 * when the settings enum collapsed to these two; `"off"` was a third way to
	 * spell `enabled: false`, which meant two fields could disagree about whether
	 * compaction runs. The host normalizes every stored and legacy value before
	 * constructing this (`normalizeCompactionStrategy`), and a legacy `"off"`
	 * migrates to `strategy: "handoff"` plus `enabled: false`, so the off-ness is
	 * carried by the field that owns it.
	 */
	strategy?: "handoff" | "summary";
	/**
	 * The compaction trigger, unit included: `auto`, `85%`, or `170000`. The one
	 * threshold surface — see {@link resolveCompactionThreshold}.
	 */
	threshold?: string;
	/** Retired; read only by the migration in {@link withLegacyCompactionThreshold}. */
	thresholdPercent?: number;
	/** Retired; read only by the migration in {@link withLegacyCompactionThreshold}. */
	thresholdTokens?: number;
	midTurnEnabled?: boolean;
	/**
	 * Tokens reserved below the context window for the next prompt + response.
	 *
	 * Leave unset to use {@link DEFAULT_RESERVE_TOKENS}; the unset state is the
	 * provenance signal that lets small-window recovery replace the default with
	 * a proportional reserve (see {@link resolveBudgetReserveTokens}). An
	 * explicit value — even one equal to the default — is always honored.
	 */
	reserveTokens?: number;
	keepRecentTokens: number;
	autoContinue?: boolean;
	/**
	 * Optional summarizer endpoint. This is still the `summary` strategy — the
	 * endpoint returns real summary TEXT that veyyon stores and can read. It is
	 * not a provider-native compaction path and grants no provider a private
	 * history format.
	 */
	remoteEndpoint?: string;
}

/** Reserve applied when {@link CompactionSettings.reserveTokens} is unset. */
export const DEFAULT_RESERVE_TOKENS = 16384;

// reserveTokens is deliberately absent: an unset reserve is what marks it as
// defaulted, which resolveBudgetReserveTokens needs to distinguish "user never
// chose a reserve" from "user explicitly configured the default value".
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	strategy: "summary",
	threshold: AUTO_COMPACTION_THRESHOLD,
	thresholdPercent: -1,
	thresholdTokens: -1,
	midTurnEnabled: true,
	keepRecentTokens: 10000,
	autoContinue: true,
};

/**
 * Effective reserve: at least 15% of context window or the configured floor
 * (defaulting to {@link DEFAULT_RESERVE_TOKENS} when unset), whichever is larger.
 */
export function effectiveReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	return Math.max(Math.floor(contextWindow * 0.15), settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS);
}

/**
 * Reserve used when deciding whether a prompt still fits inside the model window.
 *
 * The default absolute reserve predates small bundled windows and can leave no
 * practical budget there; recover a DEFAULTED reserve that is impossible for
 * the window with the 15% proportional reserve (clamped to >= 1 so the derived
 * threshold stays strictly below the window even for tiny test windows).
 * Explicit valid reserves — including one that happens to equal the default —
 * still win, because they intentionally shrink the usable prompt budget;
 * provenance is carried by `settings.reserveTokens` being unset, never by
 * comparing values against the default.
 */
export function resolveBudgetReserveTokens(contextWindow: number, settings: CompactionSettings): number {
	const reserveTokens = effectiveReserveTokens(contextWindow, settings);
	const proportionalReserveTokens = Math.max(1, Math.floor(contextWindow * 0.15));
	const reserveWasDefaulted = settings.reserveTokens === undefined;
	const defaultReserveIsEffectivelyImpossible =
		reserveWasDefaulted && reserveTokens >= contextWindow - proportionalReserveTokens;
	const reserveExceedsWindow = reserveTokens >= contextWindow;

	return defaultReserveIsEffectivelyImpossible || reserveExceedsWindow ? proportionalReserveTokens : reserveTokens;
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	// `enabled` is the only off switch. The `strategy === "off"` clause that also
	// stood here was the second one, and two fields that can each disable a
	// feature can disagree about whether it is disabled.
	if (!settings.enabled || contextWindow <= 0) return false;
	const thresholdTokens = resolveThresholdTokens(contextWindow, settings);
	return contextTokens > thresholdTokens;
}

/**
 * Resolve the compaction trigger for a window, with its provenance.
 *
 * The choice between units (auto / percent / absolute) and the migration off the
 * two retired keys belong to {@link resolveCompactionThreshold}; what stays here
 * is the RESERVE policy the auto behavior needs. The default absolute reserve can
 * exceed bundled small-context windows, or nearly consume a 16k-class window; in
 * those known-impossible default configurations `resolveBudgetReserveTokens`
 * substitutes the proportional reserve so threshold/recovery-band checks stay
 * usable, while explicit configured reserves still define the usable budget.
 */
export function resolveThresholdWithOrigin(
	contextWindow: number,
	settings: CompactionSettings,
): ResolvedCompactionThreshold {
	return resolveCompactionThreshold(
		contextWindow,
		settings,
		() => contextWindow - resolveBudgetReserveTokens(contextWindow, settings),
	);
}

/** Context tokens above which compaction triggers. See {@link resolveThresholdWithOrigin}. */
export function resolveThresholdTokens(contextWindow: number, settings: CompactionSettings): number {
	return resolveThresholdWithOrigin(contextWindow, settings).tokens;
}

/**
 * True when the operator configured an absolute token threshold that this model's
 * window cannot hold, so the resolver had to cap it below the configured value.
 * Callers surface this loudly: the absolute amount is honored up to
 * `contextWindow - 1` and never silently reinterpreted, so the operator learns
 * their model-independent amount was capped for the current (smaller) model.
 */
export function isThresholdTokensClampedForWindow(contextWindow: number, settings: CompactionSettings): boolean {
	const resolved = resolveThresholdWithOrigin(contextWindow, settings);
	return resolved.origin === "tokens" && resolved.clamped;
}
